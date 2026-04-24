/**
 * video_convert.js
 * ----------------------------------------------------------------
 * Phase 1 MVP：動画 → GIF 変換モーダル
 * GROUP-15-impl-A-phase1（v1.31.0 ～）
 *
 * 処理フロー：
 * 1. storage.local._pendingVideoConvert から video メタ情報を取得
 * 2. <video> 要素でプレビュー
 * 3. ユーザーが「GIF に変換」ボタンをクリック
 * 4. gifshot.createGIF({video: [videoUrl], ...fixed params}, callback) 実行
 * 5. progressCallback で進捗更新
 * 6. callback で obj.image（dataURL）取得
 * 7. _pendingModal に dataURL を格納し、OPEN_MODAL_WINDOW で既存の保存モーダル起動
 * 8. 自ウィンドウは自動 close
 *
 * Phase 1 固定パラメータ：
 * - 長さ 20 秒（numFrames=200, interval=0.1）
 * - fps 10（interval=0.1）
 * - 幅 480px（元動画のアスペクト比維持、元幅が 480 未満なら元幅維持）
 * - sampleInterval 10（gifshot 既定）
 * - numWorkers 2（gifshot 既定）
 *
 * 制限事項（Phase 2 で対応予定）：
 * - 直 mp4 URL のみ対応（blob: / MSE URL は非対応、content.js でのフレーム抽出方式は Phase 2）
 * - 変換オプション可変 UI なし（Phase 2 で settings タブに追加）
 * - 進捗永続化なし（ウィンドウ閉じると中断）
 */

// ================================================================
// 固定パラメータ（Phase 1 MVP）
// ================================================================
const PHASE1_PARAMS = {
  DURATION_SEC: 20,
  FPS: 10,
  MAX_WIDTH: 480,
  SAMPLE_INTERVAL: 10,
  NUM_WORKERS: 2,
  // Phase 1.5 GROUP-28 mvdl：音声録音パラメータ
  AUDIO_MIME: "audio/webm; codecs=opus",
  AUDIO_EXT: "webm",
};

// ================================================================
// ユーティリティ
// ================================================================
function log(msg, kind) {
  const el = document.getElementById("log");
  el.textContent = msg;
  el.className = "log" + (kind ? " " + kind : "");
  // console にも出す
  (kind === "error" ? console.error : console.log)(`[video_convert] ${msg}`);
}

function updateProgress(ratio) {
  const wrap = document.getElementById("progress-wrap");
  const bar = document.getElementById("progress-bar");
  const label = document.getElementById("progress-label");
  wrap.classList.add("active");
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  bar.style.width = pct + "%";
  label.textContent = pct + "%";
}

function hideProgress() {
  document.getElementById("progress-wrap").classList.remove("active");
}

function computeGifSize(origWidth, origHeight) {
  if (!origWidth || !origHeight) {
    return { w: PHASE1_PARAMS.MAX_WIDTH, h: Math.round(PHASE1_PARAMS.MAX_WIDTH * 9 / 16) };
  }
  const targetW = Math.min(origWidth, PHASE1_PARAMS.MAX_WIDTH);
  const scale = targetW / origWidth;
  return {
    w: Math.round(targetW),
    h: Math.max(1, Math.round(origHeight * scale)),
  };
}

// ================================================================
// Phase 1.5 GROUP-28 mvdl：音声録音（MediaRecorder + captureStream）
// ================================================================
/**
 * 既存の preview video 要素から音声を MediaRecorder で録音して Blob を返す。
 * 成功時：Blob（audio/webm）
 * 失敗時：null（audio track なし / MIME 非サポート / captureStream 非対応 / 再生失敗等）
 *
 * v1.31.5 修正：2 つの <video> を同時ロードするとタブクラッシュの原因になるため、
 * 既存プレビュー要素を流用する方式に変更。volume=0 でユーザーに無音、muted=false で
 * captureStream に audio track が入る状態を保つ。
 */
async function recordAudio(previewVideo, durationSec) {
  return new Promise((resolve) => {
    if (!previewVideo) {
      console.warn("[video_convert] no preview video element");
      return resolve(null);
    }
    if (typeof previewVideo.captureStream !== "function") {
      console.warn("[video_convert] captureStream not supported");
      return resolve(null);
    }

    let recorder = null;
    let resolved = false;
    const originalMuted  = previewVideo.muted;
    const originalVolume = previewVideo.volume;
    const originalTime   = previewVideo.currentTime;

    const resolveOnce = (value) => {
      if (resolved) return;
      resolved = true;
      try { previewVideo.pause(); } catch (_) {}
      try { previewVideo.muted  = originalMuted; } catch (_) {}
      try { previewVideo.volume = originalVolume; } catch (_) {}
      try { previewVideo.currentTime = originalTime; } catch (_) {}
      resolve(value);
    };

    const startRecording = async () => {
      try {
        // v1.31.6：確実に unmuted + volume=0 状態にしてから play → captureStream の順番で実行。
        // play() を先に呼ぶことで audio pipeline が稼働、captureStream で audio track が取得できる。
        previewVideo.muted  = false;
        previewVideo.volume = 0;

        console.log("[video_convert] preview state before play:",
          `readyState=${previewVideo.readyState}`,
          `muted=${previewVideo.muted}`,
          `volume=${previewVideo.volume}`,
          `duration=${previewVideo.duration}`);

        // まず再生を開始（audio pipeline を活性化）
        try { previewVideo.currentTime = 0; } catch (_) {}
        try {
          await previewVideo.play();
        } catch (playErr) {
          console.warn("[video_convert] preview play() failed:", playErr);
          return resolveOnce(null);
        }

        // 少し待って audio pipeline が安定してから captureStream
        await new Promise(r => setTimeout(r, 150));

        const stream = previewVideo.captureStream();
        const audioTracks = stream.getAudioTracks();
        const videoTracks = stream.getVideoTracks();
        console.log("[video_convert] stream tracks:",
          `audio=${audioTracks.length}`,
          `video=${videoTracks.length}`);
        if (!audioTracks || audioTracks.length === 0) {
          console.info("[video_convert] no audio track (probably no audio in source video or Firefox capture restriction)");
          return resolveOnce(null);
        }
        // track 状態を確認
        console.log("[video_convert] audio track[0]:",
          `kind=${audioTracks[0].kind}`,
          `enabled=${audioTracks[0].enabled}`,
          `muted=${audioTracks[0].muted}`,
          `readyState=${audioTracks[0].readyState}`);
        if (audioTracks[0].muted) {
          console.warn("[video_convert] audio track is MUTED at source, recording may be silent");
        }
        audioTracks[0].enabled = true;

        if (!MediaRecorder.isTypeSupported(PHASE1_PARAMS.AUDIO_MIME)) {
          console.warn("[video_convert] MIME not supported:", PHASE1_PARAMS.AUDIO_MIME);
          return resolveOnce(null);
        }

        const audioStream = new MediaStream(audioTracks);
        recorder = new MediaRecorder(audioStream, { mimeType: PHASE1_PARAMS.AUDIO_MIME });
        const chunks = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
            chunks.push(e.data);
            console.log(`[video_convert] dataavailable: ${e.data.size} bytes`);
          }
        };
        recorder.onstart = () => console.log("[video_convert] recorder started");
        recorder.onstop = () => {
          const totalSize = chunks.reduce((s, c) => s + c.size, 0);
          console.log(`[video_convert] recorder stopped, total ${chunks.length} chunks = ${totalSize} bytes`);
          const blob = new Blob(chunks, { type: "audio/webm" });
          resolveOnce(blob);
        };
        recorder.onerror = (e) => {
          console.error("[video_convert] recorder error:", e);
          resolveOnce(null);
        };

        recorder.start();
        setTimeout(() => {
          try {
            if (recorder && recorder.state === "recording") recorder.stop();
          } catch (_) {}
        }, durationSec * 1000);
      } catch (err) {
        console.error("[video_convert] audio recording setup failed:", err);
        resolveOnce(null);
      }
    };

    // プレビュー要素は既にロード中／済みのはず。readyState で判定。
    // HAVE_FUTURE_DATA (3) 以上なら即開始、未満なら canplay を待つ。
    if (previewVideo.readyState >= 3) {
      startRecording();
    } else {
      const onCanPlay = () => {
        previewVideo.removeEventListener("canplay", onCanPlay);
        startRecording();
      };
      previewVideo.addEventListener("canplay", onCanPlay);
      setTimeout(() => {
        if (!resolved) {
          previewVideo.removeEventListener("canplay", onCanPlay);
          console.warn("[video_convert] preview video not ready in 15s");
          resolveOnce(null);
        }
      }, 15_000);
    }
  });
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("FileReader error"));
    reader.readAsDataURL(blob);
  });
}

// ================================================================
// 初期化
// ================================================================
async function init() {
  try {
    const { _pendingVideoConvert } = await browser.storage.local.get("_pendingVideoConvert");
    if (!_pendingVideoConvert) {
      log("受領データがありません。ウィンドウを閉じてください。", "error");
      return;
    }
    const { videoUrl, pageUrl, videoWidth, videoHeight, duration } = _pendingVideoConvert;

    // メタ情報表示
    const meta = document.getElementById("meta");
    meta.innerHTML = [
      `<div><span class="key">URL:</span> <code>${escapeHtml(videoUrl)}</code></div>`,
      `<div><span class="key">元サイズ:</span> ${videoWidth || "?"} × ${videoHeight || "?"} px / <span class="key">長さ:</span> ${duration ? duration.toFixed(1) + " 秒" : "?"}</div>`,
      `<div><span class="key">変換設定（Phase 1 固定）:</span> ${PHASE1_PARAMS.DURATION_SEC} 秒 / ${PHASE1_PARAMS.FPS} fps / 最大 ${PHASE1_PARAMS.MAX_WIDTH}px</div>`,
    ].join("");

    // プレビュー動画
    // v1.31.6 GROUP-28 mvdl hotfix：muted=true だと Firefox captureStream で audio track が
    // 取得できないため、HTML から muted 属性を外し、ここで volume=0 にしてユーザー無音にする。
    const video = document.getElementById("preview");
    video.volume = 0;
    video.muted = false;
    video.src = videoUrl;
    video.load();

    // isSupported チェック
    if (typeof gifshot === "undefined") {
      log("gifshot ライブラリの読込に失敗しました。", "error");
      document.getElementById("convert-btn").disabled = true;
      return;
    }
    if (!gifshot.isExistingVideoGIFSupported(["mp4", "webm"])) {
      log("このブラウザは mp4/webm → GIF 変換に対応していません。", "error");
      document.getElementById("convert-btn").disabled = true;
      return;
    }

    // 変換ボタン
    document.getElementById("convert-btn").addEventListener("click", () => {
      runConversion(videoUrl, pageUrl, videoWidth, videoHeight);
    });

    // キャンセル
    document.getElementById("cancel-btn").addEventListener("click", () => {
      window.close();
    });

    log("準備完了。「GIF に変換」をクリックしてください。");
  } catch (err) {
    log(`初期化エラー: ${err.message}`, "error");
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ================================================================
// 変換実行
// ================================================================
function runConversion(videoUrl, pageUrl, origWidth, origHeight) {
  const btn = document.getElementById("convert-btn");
  btn.disabled = true;
  btn.textContent = "変換中…";
  log("動画＋音声を読込中…");
  updateProgress(0);

  const size = computeGifSize(origWidth, origHeight);
  const numFrames = PHASE1_PARAMS.DURATION_SEC * PHASE1_PARAMS.FPS;

  const startTime = Date.now();
  let lastProgressAt = Date.now();
  let reached100 = false;

  // Phase 1.5 GROUP-28 mvdl：音声録音を並列開始
  // gifshot は独自 video を内部生成するが、録音は既存 preview video を流用する。
  // v1.31.5 修正：同一 URL を 2 要素で同時ロードするとタブクラッシュしたため統合。
  // 音声なし / 録音失敗時は associatedAudio = null で GIF のみ保存にフォールバック。
  const previewVideo = document.getElementById("preview");
  const audioPromise = recordAudio(previewVideo, PHASE1_PARAMS.DURATION_SEC);

  // v1.31.1 診断：100% に達してからのタイムアウト（GIF エンコードが無限に待たないよう）。
  // gifshot の progressCallback は **capture 進捗**（フレーム抽出）のみで、その後の
  // GIF エンコード段階（Web Worker）は進捗が取れない。Worker で詰まっている場合の
  // 検知のため、100% 到達後 60 秒で強制エラー表示。
  const encodeTimeout = setInterval(() => {
    if (reached100 && Date.now() - lastProgressAt > 60_000) {
      clearInterval(encodeTimeout);
      log(
        "⚠ エンコード段階でタイムアウト（60 秒）。" +
        "ブラウザコンソール（F12）で CSP 違反や Worker エラーが出ていないか確認してください。",
        "error"
      );
      btn.disabled = false;
      btn.textContent = "再試行";
    }
  }, 5_000);

  gifshot.createGIF({
    video: [videoUrl],
    gifWidth: size.w,
    gifHeight: size.h,
    numFrames,
    interval: 1 / PHASE1_PARAMS.FPS,
    sampleInterval: PHASE1_PARAMS.SAMPLE_INTERVAL,
    numWorkers: PHASE1_PARAMS.NUM_WORKERS,
    progressCallback: (captureProgress) => {
      updateProgress(captureProgress);
      lastProgressAt = Date.now();
      if (captureProgress >= 1.0) {
        if (!reached100) {
          reached100 = true;
          log("キャプチャ完了、GIF エンコード中…（Worker で処理、進捗非表示）");
        }
      } else {
        log(`キャプチャ中… ${Math.round(captureProgress * 100)}%`);
      }
    },
  }, async (obj) => {
    clearInterval(encodeTimeout);
    if (obj.error) {
      log(`変換失敗: ${obj.errorCode || ""} ${obj.errorMsg || ""}`, "error");
      btn.disabled = false;
      btn.textContent = "再試行";
      hideProgress();
      return;
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const approxSize = (obj.image.length * 0.75 / 1024 / 1024).toFixed(1);

    // Phase 1.5 GROUP-28 mvdl：音声録音完了を待つ
    log(`✅ 変換完了（${elapsed} 秒、GIF 約 ${approxSize} MB）。音声録音完了待ち…`, "success");
    updateProgress(1);

    let associatedAudio = null;
    try {
      const audioBlob = await audioPromise;
      if (audioBlob && audioBlob.size > 0) {
        const audioDataUrl = await blobToDataUrl(audioBlob);
        const audioSizeMB = (audioBlob.size / 1024 / 1024).toFixed(2);
        associatedAudio = {
          dataUrl: audioDataUrl,
          mimeType: "audio/webm",
          extension: PHASE1_PARAMS.AUDIO_EXT,
          durationSec: PHASE1_PARAMS.DURATION_SEC,
        };
        log(`✅ 変換完了（${elapsed} 秒、GIF 約 ${approxSize} MB + 音声 ${audioSizeMB} MB）。保存モーダルを起動しています…`, "success");
      } else {
        log(`✅ 変換完了（${elapsed} 秒、GIF 約 ${approxSize} MB、音声なし）。保存モーダルを起動しています…`, "success");
      }
    } catch (audioErr) {
      console.warn("[video_convert] audio promise rejected:", audioErr);
      log(`✅ 変換完了（${elapsed} 秒、GIF 約 ${approxSize} MB、音声取得失敗）。保存モーダルを起動しています…`, "success");
    }

    try {
      // v1.31.2 GROUP-15-impl-A-phase1-hotfix-ext：
      // 元動画 URL から basename を抽出して .gif 拡張子でファイル名提案。
      // dataURL のままだと guessFilename が拡張子を推定できず .jpg 扱いになり、
      // Native 側も JPEG として処理 → サムネイルのアニメーションが失われる。
      let suggestedFilename = "video-capture.gif";
      try {
        const u = new URL(videoUrl);
        const basename = (u.pathname.split("/").pop() || "").replace(/\.[^.]*$/, "");
        if (basename) {
          suggestedFilename = `${basename}.gif`;
        } else {
          // URL からパスが取れない場合はタイムスタンプで一意化
          const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
          suggestedFilename = `video-${ts}.gif`;
        }
      } catch (_) {
        const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
        suggestedFilename = `video-${ts}.gif`;
      }

      // v1.31.5 GROUP-28 mvdl hotfix：大容量 payload（imageUrl 10MB + audio 5MB）を
      // storage.local._pendingModal に入れると Firefox の onChanged broadcast で
      // 全 extension context にクローンされ 8GB 級メモリ膨張でタブクラッシュしていた。
      // → background.js のメモリに stash し、_pendingModal はフラグだけにする。
      console.log(`[video_convert] sending STASH_CONVERSION_PAYLOAD: ` +
        `imageUrl.length=${obj.image.length}, ` +
        `suggestedFilename=${suggestedFilename}, ` +
        `hasAudio=${!!associatedAudio}` +
        (associatedAudio ? `, audioDataUrl.length=${associatedAudio.dataUrl.length}` : ""));
      const stashRes = await browser.runtime.sendMessage({
        type: "STASH_CONVERSION_PAYLOAD",
        imageUrl: obj.image,
        pageUrl: pageUrl || "",
        suggestedFilename,
        associatedAudio,
      });
      console.log(`[video_convert] STASH result:`, stashRes);

      const openRes = await browser.runtime.sendMessage({ type: "OPEN_MODAL_FROM_CONVERSION" });
      console.log(`[video_convert] OPEN_MODAL_FROM_CONVERSION result:`, openRes);
      // 受領データクリア（次回衝突防止）
      await browser.storage.local.remove("_pendingVideoConvert");
      // v1.31.5：_pendingModal は background 側で既に __fromConversion フラグでセット済。
      // 自ウィンドウを閉じる（少し待って保存モーダル起動を先に）
      setTimeout(() => window.close(), 500);
    } catch (err) {
      log(`保存モーダル起動失敗: ${err.message}`, "error");
      btn.disabled = false;
      btn.textContent = "再試行";
    }
  });
}

// ================================================================
// エントリーポイント
// ================================================================
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
