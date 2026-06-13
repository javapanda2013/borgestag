/**
 * video_convert.js
 * ----------------------------------------------------------------
 * Phase 1 MVP：動画 → GIF 変換モーダル
 * GROUP-15-impl-A-phase1（v1.31.0 ～）
 *
 * 処理フロー：
 * 1. storage.local._pendingVideoConvert から video メタ情報を取得
 * 2. <video> 要素でプレビュー
 * 3. 利用者が「GIF に変換」ボタンをクリック
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
 * 対応範囲（v1.46.46 GROUP-15 範囲拡大後）：
 * - 直 mp4/webm URL：従来どおりこのウィンドウが直接ロード
 * - blob:/MSE 動画・Canvas 要素：content.js がページ内録画（captureStream+MediaRecorder）
 *   した webm を background メモリ経由で受領し、blob URL 化して同じ経路に流す
 *
 * 制限事項（Phase 2 で対応予定）：
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
// v1.31.7 GROUP-28 mvdl hotfix：プレビュー動画のロード（CORS 優先）
// ================================================================
/**
 * 2 段階ロード：
 * 1. crossOrigin="anonymous" で試行（CORS 対応サーバーならロード成功、MediaStream が
 *    isolated 扱いされず MediaRecorder で音声録音可能）
 * 2. エラー時は crossOrigin を外して再ロード（CORS 非対応、GIF のみ保存可能）
 * 結果を window.__previewCorsLoaded に格納、recordAudio で参照。
 */
async function loadPreviewVideo(video, url) {
  const tryLoad = (withCors) => new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", onLoad);
      video.removeEventListener("error", onErr);
      if (timer) clearTimeout(timer);
    };
    const onLoad = () => { cleanup(); resolve(); };
    const onErr = () => { cleanup(); reject(new Error("load error")); };
    video.addEventListener("loadedmetadata", onLoad);
    video.addEventListener("error", onErr);
    const timer = setTimeout(() => { cleanup(); reject(new Error("timeout")); }, 10_000);

    if (withCors) {
      video.crossOrigin = "anonymous";
    } else {
      video.removeAttribute("crossorigin");
      video.crossOrigin = null;
    }
    video.src = url;
    video.load();
  });

  try {
    await tryLoad(true);
    window.__previewCorsLoaded = true;
  } catch (corsErr) {
    // CORS 非対応サーバーは fallback で crossOrigin なしロード（この場合は音声録音不可）
    await tryLoad(false);
    window.__previewCorsLoaded = false;
  }
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
 * 既存プレビュー要素を流用する方式に変更。volume=0 で利用者に無音、muted=false で
 * captureStream に audio track が入る状態を保つ。
 */
async function recordAudio(previewVideo, durationSec) {
  return new Promise((resolve) => {
    if (!previewVideo) return resolve(null);
    if (typeof previewVideo.captureStream !== "function") return resolve(null);
    // v1.31.7：CORS 非対応の場合 MediaRecorder が isolation で拒否するので早期 return。
    // Phase 1.5 の制限として、CORS を送らないサーバーの動画では音声録音不可。
    if (!window.__previewCorsLoaded) return resolve(null);

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

        // まず再生を開始（audio pipeline を活性化）
        try { previewVideo.currentTime = 0; } catch (_) {}
        try {
          await previewVideo.play();
        } catch (playErr) {
          return resolveOnce(null);
        }

        // 少し待って audio pipeline が安定してから captureStream
        await new Promise(r => setTimeout(r, 150));

        const stream = previewVideo.captureStream();
        const audioTracks = stream.getAudioTracks();
        if (!audioTracks || audioTracks.length === 0) return resolveOnce(null);
        audioTracks[0].enabled = true;

        if (!MediaRecorder.isTypeSupported(PHASE1_PARAMS.AUDIO_MIME)) return resolveOnce(null);

        const audioStream = new MediaStream(audioTracks);
        recorder = new MediaRecorder(audioStream, { mimeType: PHASE1_PARAMS.AUDIO_MIME });
        const chunks = [];
        recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        recorder.onstop = () => {
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
// GROUP-15 scope2 (v1.46.49)：うごイラ（pixiv）解析サポート
// ================================================================
/**
 * 最小 ZIP 展開（central directory 走査）。stored(0) と deflate(8) に対応。
 * うごイラ ZIP は stored が通例だが、deflate も DecompressionStream で展開する。
 * 返値：{ファイル名: Uint8Array}
 */
async function _parseZip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  const minPos = Math.max(0, buf.byteLength - 22 - 65535);
  for (let i = buf.byteLength - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("zip: end record not found");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = {};
  const td = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error("zip: bad central header");
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = td.decode(u8.subarray(off + 46, off + 46 + nameLen));
    const lnameLen = dv.getUint16(lho + 26, true);
    const lextraLen = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lnameLen + lextraLen;
    const raw = u8.subarray(dataStart, dataStart + csize);
    if (method === 0) {
      out[name] = raw;
    } else if (method === 8) {
      const ds = new DecompressionStream("deflate-raw");
      const dec = new Response(new Blob([raw]).stream().pipeThrough(ds));
      out[name] = new Uint8Array(await dec.arrayBuffer());
    } else {
      throw new Error("zip: unsupported method " + method);
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/** うごイラ：frames（{file, delay} 列）と ZIP からフレーム blob URL 列を構築して変換フローを設定 */
async function initUgoira(cap, pageUrl) {
  const frames = cap.frames || [];
  if (!frames.length) {
    log("うごイラのコマ情報がありません。", "error");
    document.getElementById("convert-btn").disabled = true;
    return;
  }
  let entries;
  try {
    entries = await _parseZip(cap.buffer);
  } catch (zipErr) {
    log(`うごイラ ZIP の展開に失敗: ${zipErr.message}`, "error");
    document.getElementById("convert-btn").disabled = true;
    return;
  }
  cap.buffer = null; // 巨大 payload null 代入（展開後、GROUP-82 規約）
  const frameUrls = [];
  const delays = [];
  for (const f of frames) {
    const data = entries[f.file];
    if (!data) continue;
    frameUrls.push(URL.createObjectURL(new Blob([data], { type: cap.frameMime || "image/jpeg" })));
    delays.push(f.delay || 100);
  }
  entries = null;
  if (!frameUrls.length) {
    log("うごイラのコマが ZIP 内に見つかりません。", "error");
    document.getElementById("convert-btn").disabled = true;
    return;
  }
  window.__ugoiraFrameUrls = frameUrls;
  window.addEventListener("unload", () => {
    (window.__ugoiraFrameUrls || []).forEach((u) => URL.revokeObjectURL(u));
  }, { once: true });

  const totalSec = delays.reduce((a, b) => a + b, 0) / 1000;
  const avgMs = delays.reduce((a, b) => a + b, 0) / delays.length;
  const uniform = delays.every((d) => Math.abs(d - delays[0]) <= 1);

  // メタ表示（うごイラ用）
  const meta = document.getElementById("meta");
  meta.innerHTML = [
    `<div><span class="key">取得元:</span> pixiv うごイラ解析（${escapeHtml(pageUrl || "")}）</div>`,
    `<div><span class="key">コマ数:</span> ${frameUrls.length} / <span class="key">合計:</span> ${totalSec.toFixed(1)} 秒 / <span class="key">コマ間隔:</span> ${uniform ? `${Math.round(avgMs)} ms（均一）` : `平均 ${Math.round(avgMs)} ms（不均一→平均値で近似）`}</div>`,
  ].join("");

  // プレビュー：video の代わりに先頭コマを表示
  const video = document.getElementById("preview");
  video.style.display = "none";
  const pimg = document.createElement("img");
  pimg.src = frameUrls[0];
  pimg.style.maxWidth = "100%";
  pimg.style.borderRadius = "6px";
  video.parentNode.insertBefore(pimg, video);

  if (typeof gifshot === "undefined") {
    log("gifshot ライブラリの読込に失敗しました。", "error");
    document.getElementById("convert-btn").disabled = true;
    return;
  }
  document.getElementById("convert-btn").addEventListener("click", () => {
    runUgoiraConversion(frameUrls, avgMs, pageUrl, pimg);
  });
  document.getElementById("cancel-btn").addEventListener("click", () => {
    window.close();
  });
  log(`うごイラを受領しました（${frameUrls.length} コマ）。「GIF に変換」で開始します。`);
}

/** うごイラ：コマ列 → GIF 変換（コマ間隔は平均値で一律近似） */
function runUgoiraConversion(frameUrls, avgDelayMs, pageUrl, previewImg) {
  const btn = document.getElementById("convert-btn");
  btn.disabled = true;
  btn.textContent = "変換中…";
  updateProgress(0);
  const w = previewImg.naturalWidth || 480;
  const h = previewImg.naturalHeight || 360;
  const size = computeGifSize(w, h);
  const startTime = Date.now();
  gifshot.createGIF({
    images: frameUrls,
    gifWidth: size.w,
    gifHeight: size.h,
    interval: Math.max(0.02, avgDelayMs / 1000),
    numWorkers: PHASE1_PARAMS.NUM_WORKERS,
    progressCallback: (p) => {
      updateProgress(p);
      log(`変換中… ${Math.round(p * 100)}%`);
    },
  }, async (obj) => {
    if (obj.error) {
      log(`変換失敗: ${obj.errorCode || ""} ${obj.errorMsg || ""}`, "error");
      btn.disabled = false;
      btn.textContent = "再試行";
      hideProgress();
      return;
    }
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const approxSize = (obj.image.length * 0.75 / 1024 / 1024).toFixed(1);
    log(`✅ 変換完了（${elapsed} 秒、GIF 約 ${approxSize} MB）。保存モーダルを起動しています…`, "success");
    updateProgress(1);
    try {
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      await browser.runtime.sendMessage({
        type: "STASH_CONVERSION_PAYLOAD",
        imageUrl: obj.image,
        pageUrl: pageUrl || "",
        suggestedFilename: `ugoira-${ts}.gif`,
        associatedAudio: null,
      });
      await _routeAfterConvert(); // GROUP-33-T1：自動遷移 ON/OFF で分岐
    } catch (err) {
      log(`保存モーダル起動失敗: ${err.message}`, "error");
      btn.disabled = false;
      btn.textContent = "再試行";
    }
  });
}

// ================================================================
// GROUP-33-T1 (v1.46.51)：変換後の遷移（自動 ON＝保存ウィンドウへ／OFF＝保存方法ボタン表示）
// ================================================================
async function _routeAfterConvert() {
  let auto = true;
  try {
    const r = await browser.storage.local.get("videoAutoOpenModal");
    auto = r.videoAutoOpenModal !== false; // 既定 ON
  } catch (_) {}
  if (auto) {
    await browser.runtime.sendMessage({ type: "OPEN_MODAL_FROM_CONVERSION" });
    await browser.storage.local.remove("_pendingVideoConvert");
    setTimeout(() => window.close(), 500);
  } else {
    _showPostConvertActions();
  }
}

function _showPostConvertActions() {
  const cbtn = document.getElementById("convert-btn");
  const cancel = document.getElementById("cancel-btn");
  if (cbtn) cbtn.style.display = "none";
  if (cancel) cancel.style.display = "none";
  if (document.getElementById("post-convert-actions")) return;
  const box = document.createElement("div");
  box.id = "post-convert-actions";
  box.style.cssText = "display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;";
  const mk = (label, handler) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "padding:8px 14px;font-size:13px;cursor:pointer;border-radius:6px;" +
      "border:1px solid #4a90e2;background:#fff;color:#1a4d8c;font-weight:600;font-family:inherit;";
    b.addEventListener("click", handler);
    return b;
  };
  box.appendChild(mk("⚡ 即保存", async () => {
    box.querySelectorAll("button").forEach(b => { b.disabled = true; });
    log("即保存しています…");
    const res = await browser.runtime.sendMessage({ type: "INSTANT_SAVE_CONVERSION" }).catch(() => null);
    if (res && res.success) {
      log("✅ 即保存しました。ウィンドウを閉じます。", "success");
      await browser.storage.local.remove("_pendingVideoConvert");
      setTimeout(() => window.close(), 800);
    } else {
      log("❌ 即保存に失敗: " + ((res && res.error) || "不明"), "error");
      box.querySelectorAll("button").forEach(b => { b.disabled = false; });
    }
  }));
  box.appendChild(mk("💾 保存ウィンドウを開く", async () => {
    await browser.runtime.sendMessage({ type: "OPEN_MODAL_FROM_CONVERSION" });
    await browser.storage.local.remove("_pendingVideoConvert");
    setTimeout(() => window.close(), 300);
  }));
  box.appendChild(mk("🎬 動画設定タブを開く", () => {
    browser.runtime.sendMessage({ type: "OPEN_VIDEO_SETTINGS_TAB" });
  }));
  (cbtn && cbtn.parentNode ? cbtn.parentNode : document.body).appendChild(box);
  log("✅ 変換が完了しました。保存方法を選んでください（自動遷移は設定画面の動画タブで切替）。", "success");
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
    const { videoUrl, pageUrl, videoWidth, videoHeight, duration, captured, sourceKind } = _pendingVideoConvert;

    // GROUP-15 範囲拡大 (v1.46.46)：ページ内録画経路。blob: URL はページ文脈限定のため、
    // content script が録画した webm を background のメモリ経由で受領し、
    // このウィンドウ自身の blob URL に変換して以降の既存経路（プレビュー→gifshot）へ流す
    let effectiveUrl = videoUrl;
    let sourceLabel = null;
    if (captured) {
      const cap = await browser.runtime.sendMessage({ type: "GET_VIDEO_CAPTURE" }).catch(() => null);
      if (!cap || !cap.buffer) {
        log("受領データがありません。ページ側でボタンを再実行してください。", "error");
        document.getElementById("convert-btn").disabled = true;
        return;
      }
      // scope2 (v1.46.49)：うごイラ解析は専用フロー（コマ列 → GIF、動画プレビュー不使用）
      if (sourceKind === "ugoira") {
        await initUgoira(cap, pageUrl);
        return;
      }
      let capBlob = new Blob([cap.buffer], { type: cap.mime || "video/webm" });
      cap.buffer = null; // 巨大 payload null 代入（受領直後、GROUP-82 規約）
      effectiveUrl = URL.createObjectURL(capBlob);
      capBlob = null;
      window.__capturedBlobUrl = effectiveUrl;
      window.addEventListener("unload", () => {
        if (window.__capturedBlobUrl) URL.revokeObjectURL(window.__capturedBlobUrl);
      }, { once: true });
      sourceLabel = sourceKind === "canvas" ? "ページ内 Canvas を録画"
        : sourceKind === "blob-file" ? "ページ内動画の原データを取得（全体）"
        : "ページ内動画（blob/MSE）を録画";
    }

    // メタ情報表示
    const meta = document.getElementById("meta");
    meta.innerHTML = [
      sourceLabel
        ? `<div><span class="key">取得元:</span> ${escapeHtml(sourceLabel)}（${escapeHtml(pageUrl || "")}）</div>`
        : `<div><span class="key">URL:</span> <code>${escapeHtml(videoUrl)}</code></div>`,
      `<div><span class="key">元サイズ:</span> ${videoWidth || "?"} × ${videoHeight || "?"} px / <span class="key">長さ:</span> ${duration ? duration.toFixed(1) + " 秒" : "?"}</div>`,
      `<div><span class="key">変換設定（Phase 1 固定）:</span> ${PHASE1_PARAMS.DURATION_SEC} 秒 / ${PHASE1_PARAMS.FPS} fps / 最大 ${PHASE1_PARAMS.MAX_WIDTH}px</div>`,
    ].join("");

    // プレビュー動画
    // v1.31.6 GROUP-28 mvdl hotfix：muted=true だと Firefox captureStream で audio track が
    // 取得できないため、HTML から muted 属性を外し、ここで volume=0 にして利用者に無音にする。
    // v1.31.7 GROUP-28 mvdl hotfix：cross-origin 動画で captureStream 経由の MediaRecorder
    // アクセスが "isolation properties disallow access" で拒否されるため、
    // まず crossOrigin="anonymous" で試行→CORS 非対応なら crossOrigin 外して再ロード、
    // という 2 段階ロードを行う。CORS 対応サーバーなら音声録音成功、非対応なら GIF のみ。
    const video = document.getElementById("preview");
    video.volume = 0;
    video.muted = false;
    window.__previewCorsLoaded = false; // recordAudio で参照
    try {
      await loadPreviewVideo(video, effectiveUrl);
    } catch (loadErr) {
      console.error("[video_convert] preview video load failed completely:", loadErr);
      log(`⚠ 動画の読込に失敗しました: ${loadErr.message}`, "error");
      document.getElementById("convert-btn").disabled = true;
      return;
    }

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
      runConversion(effectiveUrl, pageUrl, videoWidth, videoHeight);
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
        // GROUP-15 範囲拡大 (v1.46.46)：ページ内録画（blob URL）は basename が無意味な
        // 内部 ID になるため、取得種別＋タイムスタンプで命名する
        if (window.__capturedBlobUrl && videoUrl === window.__capturedBlobUrl) {
          const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
          throw { __captured: true, name: `capture-${ts}.gif` };
        }
        const u = new URL(videoUrl);
        const basename = (u.pathname.split("/").pop() || "").replace(/\.[^.]*$/, "");
        if (basename) {
          suggestedFilename = `${basename}.gif`;
        } else {
          // URL からパスが取れない場合はタイムスタンプで一意化
          const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
          suggestedFilename = `video-${ts}.gif`;
        }
      } catch (e) {
        if (e && e.__captured) {
          suggestedFilename = e.name;
        } else {
          const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
          suggestedFilename = `video-${ts}.gif`;
        }
      }

      // v1.31.5 GROUP-28 mvdl hotfix：大容量 payload（imageUrl 10MB + audio 5MB）を
      // storage.local._pendingModal に入れると Firefox の onChanged broadcast で
      // 全 extension context にクローンされ 8GB 級メモリ膨張でタブクラッシュしていた。
      // → background.js のメモリに stash し、_pendingModal はフラグだけにする。
      await browser.runtime.sendMessage({
        type: "STASH_CONVERSION_PAYLOAD",
        imageUrl: obj.image,
        pageUrl: pageUrl || "",
        suggestedFilename,
        associatedAudio,
      });

      // GROUP-33-T1 (v1.46.51)：自動遷移 ON は保存ウィンドウへ、OFF はボタン表示
      await _routeAfterConvert();
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
