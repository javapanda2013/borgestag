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
 * 動画 URL から指定秒数の音声を MediaRecorder で録音して Blob を返す。
 * 成功時：Blob（audio/webm）
 * 失敗時：null（audio track なし / MIME 非サポート / CORS NG / 再生失敗等）
 */
async function recordAudio(videoUrl, durationSec) {
  return new Promise((resolve) => {
    const vid = document.createElement("video");
    vid.src = videoUrl;
    vid.crossOrigin = "anonymous";
    vid.muted = false;
    vid.playsInline = true;
    // 画面外に配置（音声キャプチャは必要だが映像は見せない）
    vid.style.position = "fixed";
    vid.style.left = "-9999px";
    vid.style.top = "0";
    vid.style.width = "1px";
    vid.style.height = "1px";
    document.body.appendChild(vid);

    let recorder = null;
    let resolved = false;
    const cleanup = () => {
      try { vid.pause(); } catch (_) {}
      try { vid.remove(); } catch (_) {}
    };
    const resolveOnce = (value) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(value);
    };

    const onReady = async () => {
      try {
        if (typeof vid.captureStream !== "function") {
          console.warn("[video_convert] captureStream not supported");
          return resolveOnce(null);
        }
        const stream = vid.captureStream();
        const audioTracks = stream.getAudioTracks();
        if (!audioTracks || audioTracks.length === 0) {
          console.info("[video_convert] no audio track");
          return resolveOnce(null);
        }

        if (!MediaRecorder.isTypeSupported(PHASE1_PARAMS.AUDIO_MIME)) {
          console.warn("[video_convert] MIME not supported:", PHASE1_PARAMS.AUDIO_MIME);
          return resolveOnce(null);
        }

        const audioStream = new MediaStream(audioTracks);
        recorder = new MediaRecorder(audioStream, { mimeType: PHASE1_PARAMS.AUDIO_MIME });
        const chunks = [];
        recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
        recorder.onstop = () => {
          const blob = new Blob(chunks, { type: "audio/webm" });
          resolveOnce(blob);
        };
        recorder.onerror = (e) => {
          console.error("[video_convert] recorder error:", e);
          resolveOnce(null);
        };

        recorder.start();
        try { vid.currentTime = 0; } catch (_) {}
        await vid.play();
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

    vid.oncanplaythrough = onReady;
    vid.onerror = () => {
      console.warn("[video_convert] video load failed for audio");
      resolveOnce(null);
    };
    // 読込タイムアウト
    setTimeout(() => {
      if (!resolved) {
        console.warn("[video_convert] audio recording load timeout");
        resolveOnce(null);
      }
    }, 10_000);

    try { vid.load(); } catch (_) {}
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
    const video = document.getElementById("preview");
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
  // gifshot が動画を内部的に処理する傍で、別 video 要素で audio を MediaRecorder 録音。
  // 両方完了を待ってから保存モーダルへ受け渡す。
  // 音声なし / 録音失敗時は associatedAudio = null で GIF のみ保存にフォールバック。
  const audioPromise = recordAudio(videoUrl, PHASE1_PARAMS.DURATION_SEC);

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

      // 既存の保存フロー起動：_pendingModal に GIF dataURL + 推奨ファイル名 + 関連音声をセットして OPEN_MODAL_WINDOW
      await browser.storage.local.set({
        _pendingModal: {
          imageUrl: obj.image,
          pageUrl: pageUrl || "",
          suggestedFilename, // v1.31.2：modal.js 側で優先採用
          associatedAudio,   // v1.31.4 Phase 1.5：null or {dataUrl, mimeType, extension, durationSec}
        },
      });
      await browser.runtime.sendMessage({
        type: "OPEN_MODAL_WINDOW",
        imageUrl: obj.image,
        pageUrl: pageUrl || "",
      });
      // 受領データクリア（次回衝突防止）
      await browser.storage.local.remove("_pendingVideoConvert");
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
