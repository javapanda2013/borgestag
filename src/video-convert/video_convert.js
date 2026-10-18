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
 * 4. GROUP-166：取り出し用 video を一時停止のまま 0.1 秒刻みの各時刻へ seek し、seeked 後に
 *    1 コマずつ描画（makeVideoSeekFrameSource）→ 自前のストリーミングエンコーダ（streamEncodeGif、
 *    うごイラと共通）で GIF 化する。旧 gifshot.createGIF（実時間再生＋loop=true で取り出す方式）は撤去
 * 5. エンコーダの PROGRESS（done/total コマ）で進捗更新
 * 6. 完了時に GIF を Blob で受領（音声はプレビュー要素から並行録音）
 * 7. STASH_CONVERSION_PAYLOAD で background へ預け、既存の保存モーダル起動
 * 8. 自ウィンドウは自動 close（自動遷移 OFF 時は保存方法ボタンを表示）
 *
 * Phase 1 固定パラメータ：
 * - 長さ＝実尺（録画上限まで）
 * - fps 10（interval=0.1）
 * - 幅 480px（元動画のアスペクト比維持、元幅が 480 未満なら元幅維持）
 * - 量子化のサンプリング係数 10（gif-encoder.worker.js の SAMPLE_FAC）
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
  // GROUP-166：以下 2 つは旧 gifshot 経路のパラメータ。動画経路から gifshot を外したため現行未使用
  // （量子化係数は gif-encoder.worker.js の SAMPLE_FAC=10 が同値で担う）。
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

  window.__previewCorsFailReason = null;
  try {
    await tryLoad(true);
    window.__previewCorsLoaded = true;
  } catch (corsErr) {
    // CORS 非対応サーバーは fallback で crossOrigin なしロード（この場合は音声録音不可）
    // GROUP-166：CORS 付き読込が「読込エラー」で落ちたのか「10 秒の待ち切れ」で落ちたのかを残す
    // （init() で変換可否の判定に使う。待ち切れは遅いだけで CORS 対応の可能性があるため区別する）
    window.__previewCorsFailReason = corsErr && corsErr.message;
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
 * v1.31.5 修正：v1.31.4 で録音用の <video> を新規作成したところ gifshot 内部 video と同一 URL の
 * 多重ロードになり（大容量データの storage 経由受渡しと重なって）タブクラッシュしたため、
 * 既存プレビュー要素を流用する方式に変更。volume=0 で利用者に無音、muted=false で
 * captureStream に audio track が入る状態を保つ。
 *
 * GROUP-166：signal（AbortSignal、省略可）で録音を中断できる。中止・変換失敗・再試行で前回の録音が
 * 裏で走り続け二重録音にならないよう、abort 時は録音を止めて **null で解決**する（途中までの音声は
 * 使わない）。プレビューの状態（muted/volume/currentTime、一時停止）の復元は通常終了と同じ経路で行う。
 */
async function recordAudio(previewVideo, durationSec, signal) {
  return new Promise((resolve) => {
    if (!previewVideo) return resolve(null);
    if (signal && signal.aborted) return resolve(null);
    if (typeof previewVideo.captureStream !== "function") return resolve(null);
    // v1.31.7：CORS 非対応の場合 MediaRecorder が isolation で拒否するので早期 return。
    // Phase 1.5 の制限として、CORS を送らないサーバーの動画では音声録音不可。
    if (!window.__previewCorsLoaded) return resolve(null);

    let recorder = null;
    let resolved = false;
    let hardTimer = null;
    let chunks = [];
    const originalMuted  = previewVideo.muted;
    const originalVolume = previewVideo.volume;
    const originalTime   = previewVideo.currentTime;

    let onCanPlay = null; // canplay 待ち中の中断で外すため外側で保持
    let onAbort = null;
    const resolveOnce = (value) => {
      if (resolved) return;
      resolved = true;
      if (hardTimer !== null) { clearTimeout(hardTimer); hardTimer = null; }
      if (onCanPlay) { try { previewVideo.removeEventListener("canplay", onCanPlay); } catch (_) {} onCanPlay = null; }
      if (signal && onAbort) { try { signal.removeEventListener("abort", onAbort); } catch (_) {} onAbort = null; }
      try { previewVideo.pause(); } catch (_) {}
      try { previewVideo.muted  = originalMuted; } catch (_) {}
      try { previewVideo.volume = originalVolume; } catch (_) {}
      try { previewVideo.currentTime = originalTime; } catch (_) {}
      resolve(value);
    };

    // GROUP-157 R2：**無条件**の打切り期限。この Promise は変換完了後に await されるが、その時点では
    // 変換側の停滞検知（settle() で clearInterval 済み）はもう動いていない＝どの監視下にもない。
    // 従来は「readyState<3 のときだけ 15 秒フォールバック」で、readyState>=3 で入った場合は
    // 期限が一切無く、停止タイマーも `state === "recording"` 条件付きのため、トラック終了などで
    // onstop が来ないと Promise が永久 pending になり「変換中…」のまま無言ハングし得た。
    // 期限到達時は録音の取り込みを試みてから（chunks があれば救済）、無ければ null で確定する。
    const HARD_TIMEOUT_MS = Math.round(Math.max(1, durationSec || 0) * 1000) + 30_000;
    hardTimer = setTimeout(() => {
      console.warn(`[video_convert] audio recording hard timeout (${HARD_TIMEOUT_MS}ms)`);
      try { if (recorder && recorder.state === "recording") recorder.stop(); } catch (_) {}
      // stop() 後に onstop が来れば通常経路で resolve される。来なければ猶予後にここで確定する。
      setTimeout(() => {
        if (resolved) return;
        const salvaged = chunks.length ? new Blob(chunks, { type: "audio/webm" }) : null;
        resolveOnce(salvaged && salvaged.size > 0 ? salvaged : null);
      }, 1_000);
    }, HARD_TIMEOUT_MS);

    // GROUP-166：中断。録音中なら止めるが、onstop で届く途中までの音声は採らず null で確定する
    // （resolveOnce が先に resolved=true にするため、後着の onstop の resolveOnce(blob) は無視される）。
    if (signal) {
      onAbort = () => {
        try { if (recorder && recorder.state === "recording") recorder.stop(); } catch (_) {}
        resolveOnce(null);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const startRecording = async () => {
      if (resolved) return; // canplay 到達前に中断・期限切れで確定済み
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
        // GROUP-166：await の間に中断されていたら録音を始めない（resolveOnce 済み＝プレビュー復元済み）
        if (resolved) return;

        // 少し待って audio pipeline が安定してから captureStream
        await new Promise(r => setTimeout(r, 150));
        if (resolved) return;

        const stream = previewVideo.captureStream();
        const audioTracks = stream.getAudioTracks();
        if (!audioTracks || audioTracks.length === 0) return resolveOnce(null);
        audioTracks[0].enabled = true;

        if (!MediaRecorder.isTypeSupported(PHASE1_PARAMS.AUDIO_MIME)) return resolveOnce(null);

        const audioStream = new MediaStream(audioTracks);
        recorder = new MediaRecorder(audioStream, { mimeType: PHASE1_PARAMS.AUDIO_MIME });
        chunks = []; // 打切り期限のハンドラからも参照するため外側スコープで保持
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
      onCanPlay = () => {
        previewVideo.removeEventListener("canplay", onCanPlay);
        onCanPlay = null;
        startRecording();
      };
      previewVideo.addEventListener("canplay", onCanPlay);
      setTimeout(() => {
        if (!resolved) resolveOnce(null); // canplay リスナは resolveOnce が外す
      }, 15_000);
    }
  });
}

// GROUP-157：blobToDataUrl は音声の Blob 運搬化により未使用となったため削除。
// 音声は録音した Blob のまま stash → 保存時に分割書込へ渡す（base64 化しない）。

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

/** GROUP-151：1 コマを decode する（中断シグナル対応） */
async function _decodeImageForFrame(url, signal) {
  if (signal && signal.aborted) throw new Error("cancelled");
  const img = new Image();
  img.src = url;
  await img.decode();
  if (signal && signal.aborted) throw new Error("cancelled");
  return img;
}

/**
 * GROUP-151：うごイラ用のフレーム供給元。
 * `init()` で先頭コマをデコードして原寸を確定し（previewImg 非依存＝未デコード時の縮退競合を排除）、
 * その ImageData は `next(0)` で使い回す（先頭コマの二重デコードを避ける）。
 */
function makeUgoiraFrameSource(frameUrls, delays) {
  let canvas = null, ctx = null, size = null, firstRgba = null;
  const drawToRgba = (img) => {
    ctx.clearRect(0, 0, size.w, size.h);
    ctx.drawImage(img, 0, 0, size.w, size.h);
    return ctx.getImageData(0, 0, size.w, size.h).data.buffer;
  };
  return {
    total: frameUrls.length,
    async init(signal) {
      const img = await _decodeImageForFrame(frameUrls[0], signal);
      // 実寸が取れない画像を 1×1 に黙って縮退させない（契約どおり throw）。
      // || 1 で握り潰すと 1×1 の GIF を「成功」で作り、原因不明の空 GIF を生むだけ。
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error("うごイラ先頭コマの実寸を取得できませんでした");
      size = { w, h };
      canvas = document.createElement("canvas");
      canvas.width = size.w;
      canvas.height = size.h;
      ctx = canvas.getContext("2d", { willReadFrequently: true });
      firstRgba = drawToRgba(img);
      return size;
    },
    async next(i, signal) {
      if (i === 0 && firstRgba) {
        const buf = firstRgba;
        firstRgba = null; // transfer するので参照を手放す
        return { rgba: buf, delayMs: delays[0] };
      }
      const img = await _decodeImageForFrame(frameUrls[i], signal);
      return { rgba: drawToRgba(img), delayMs: delays[i] };
    },
    dispose() { canvas = null; ctx = null; firstRgba = null; },
  };
}

/**
 * GROUP-166：動画用のフレーム供給元（seek 方式）。streamEncodeGif の供給元インタフェースに従う。
 *
 * 旧 gifshot は内部 video を実時間再生（loop=true）しつつ「1 コマ処理後に 100ms 待って次」で取り出して
 * いたため、取り出しが遅いと動画が何周もし、GIF の中身が早回し＋繰り返しになった。ここでは再生せず、
 * 一時停止のまま各コマの目標時刻 t_i へ currentTime で移動し、seeked を待ってから描く。
 * 中身は取り出しの速さ・処理の重さに左右されず、i 番目のコマは常に元動画の t_i の画面になる。
 *
 *   t_i = max(0, min((i + 0.5) * intervalSec, 実尺 - 0.01))   … 各 0.1 秒区間の中央。単調増加
 *   delayMs = round(intervalSec * 1000)                       … 全コマ同値（10fps なら 100ms）
 *
 * - コマ数（total）と実尺（durationSec）は init() で取り出し用 video の実尺が分かった時点で確定する
 *   （total = min(numFrames, round(実尺 / intervalSec))）。呼び出し側は init 前の値を使わず、確定後の
 *   total／durationSec を読む（streamEncodeGif はループ毎に total を読み、進捗の total も同じ値になる）。
 *   実尺が指定尺より短い時に、末尾へ同じ時刻の静止コマが並ぶのを防ぐ。
 * - 長さが Infinity/NaN の webm（MediaRecorder 由来に多い）は、取り出し前に currentTime を大きな値へ
 *   移して seeked を待ち実尺を確定させる（tools/notes/frame_dup_diagnose.js と同じ手法）。それでも
 *   取れなければ seekable の終端、最後は渡された尺を使う。
 * - fastSeek は使わない（キーフレームへ丸める近似 seek のため、目標時刻の画面にならない）。
 * - 目標時刻が現在位置と実質同じなら currentTime を代入せずそのまま描く（同じ位置への代入で seeked が
 *   来ない実装があった場合に永久待ちにしない）。
 * - 取り出し用 video は gifshot 内部の要素を置き換えるもの＝プレビュー（録音用）と合わせ、gifshot 時代と
 *   同じ 2 本のまま。v1.31.4 で録音用の video を新規作成して gifshot 内部 video と同一 URL の多重ロードに
 *   なり（大容量データの storage 経由受渡しと重なって）タブクラッシュした経緯があるため、3 本にしない。
 * - 待ちはすべて AbortSignal で中断できる。時間切れによる自動打ち切りは入れない（GROUP-165：
 *   止めるのは利用者の「中止」だけ）。
 *
 * @param {string} videoUrl
 * @param {{w:number,h:number}} size  computeGifSize の結果（最大幅 480px）
 * @param {number} numFrames    指定尺から求めたコマ数（上限。実尺が短ければ init で減る）
 * @param {number} intervalSec
 * @param {number} durationSec  変換する尺（録画上限で clamp 済み）
 */
function makeVideoSeekFrameSource(videoUrl, size, numFrames, intervalSec, durationSec) {
  let video = null, canvas = null, ctx = null;
  let effDur = durationSec;
  let total = numFrames;
  const delayMs = Math.round(intervalSec * 1000);
  const SAME_TIME_EPS = 1e-6;

  /** el の okType を待つ。error / abort で reject。リスナは必ず外す */
  const waitMediaEvent = (el, okType, signal) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new Error("cancelled")); return; }
    const cleanup = () => {
      el.removeEventListener(okType, onOk);
      el.removeEventListener("error", onErr);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const onOk = () => { cleanup(); resolve(); };
    const onErr = () => {
      cleanup();
      const code = el.error && el.error.code;
      reject(new Error(`取り出し用の動画を読み込めませんでした${code ? `（code ${code}）` : ""}。CORS を返さないサーバーの動画などで起こります`));
    };
    const onAbort = () => { cleanup(); reject(new Error("cancelled")); };
    el.addEventListener(okType, onOk);
    el.addEventListener("error", onErr);
    if (signal) signal.addEventListener("abort", onAbort);
  });

  /** 位置を t へ移す。実質同じ位置なら代入しない（seeked を待たずに済む） */
  const seekTo = async (t, signal) => {
    if (Math.abs(video.currentTime - t) < SAME_TIME_EPS) return;
    const seeked = waitMediaEvent(video, "seeked", signal);
    video.currentTime = t; // 正確な seek（fastSeek は使わない）
    await seeked;
  };

  const finiteDur = (d) => Number.isFinite(d) && d > 0;

  /** 取り出し用 video の実尺を求める（取れなければ null） */
  const probeDuration = async (signal) => {
    if (finiteDur(video.duration)) return video.duration;
    // 長さ不明の webm：終端の先まで移動すると、読み進めた結果として実尺が確定する
    await seekTo(1e7, signal);
    if (finiteDur(video.duration)) return video.duration;
    try {
      const s = video.seekable;
      if (s && s.length > 0) {
        const end = s.end(s.length - 1);
        if (finiteDur(end)) return end;
      }
    } catch (_) {}
    return null;
  };

  const targetTime = (i) => Math.max(0, Math.min((i + 0.5) * intervalSec, effDur - 0.01));

  return {
    /** 取り出すコマ数（init 後に確定。streamEncodeGif がループ毎に読む） */
    get total() { return total; },
    /** 変換する尺（init 後に確定。音声の durationSec 等に使う） */
    get durationSec() { return effDur; },
    async init(signal) {
      if (signal && signal.aborted) throw new Error("cancelled");
      video = document.createElement("video");
      video.crossOrigin = "anonymous"; // canvas を汚染させない（getImageData のため）
      video.muted = true;
      video.loop = false;              // 終端で先頭へ戻らない（旧方式の巻き戻り混入の原因）
      video.preload = "auto";
      video.playsInline = true;
      video.setAttribute("playsinline", "");
      // display:none や画面外（left:-10000px 等）には置かない。Firefox は不可視と判定した video の
      // デコードを止める（背景動画の省電力機能）ことがあり、seek 後のコマが描けなくなる恐れがあるため
      // （推測。実機で要確認）。旧 gifshot が内部 video に使っていた配置（position:fixed＋opacity:0、
      // このウィンドウで実際にコマが描けていた）と同じにし、操作の邪魔にならないよう pointer-events を切る。
      video.style.cssText = "position:fixed;left:0;top:0;opacity:0;pointer-events:none;z-index:-1;"
        + `width:${size.w}px;height:${size.h}px;`;
      document.body.appendChild(video);

      canvas = document.createElement("canvas");
      canvas.width = size.w;
      canvas.height = size.h;
      ctx = canvas.getContext("2d", { willReadFrequently: true });

      // loadeddata（先頭コマのデコード完了＝メタデータも既知）を待つ。リスナ登録後に src を入れる。
      const loaded = waitMediaEvent(video, "loadeddata", signal);
      video.src = videoUrl;
      video.load();
      await loaded;
      // 実尺で終端とコマ数を確定させる（実尺が取れなければ渡された尺のまま）
      const realDur = await probeDuration(signal);
      if (realDur !== null) effDur = Math.min(durationSec, realDur);
      total = Math.min(numFrames, Math.max(1, Math.round(effDur / intervalSec)));
      return { w: size.w, h: size.h };
    },
    async next(i, signal) {
      if (signal && signal.aborted) throw new Error("cancelled");
      await seekTo(targetTime(i), signal);
      ctx.clearRect(0, 0, size.w, size.h);
      ctx.drawImage(video, 0, 0, size.w, size.h);
      return { rgba: ctx.getImageData(0, 0, size.w, size.h).data.buffer, delayMs };
    },
    dispose() {
      if (video) {
        try { video.removeAttribute("src"); video.load(); } catch (_) {}
        try { if (video.parentNode) video.parentNode.removeChild(video); } catch (_) {}
      }
      video = null; canvas = null; ctx = null;
    },
  };
}

/**
 * GROUP-150 v1.48.0 / GROUP-151 v1.49.0：ストリーミング GIF エンコード（供給元非依存）。
 * gifshot の一括方式（全コマを 1 tick で一斉に原寸デコード＋yield 無し LZW）を廃し、
 * 使い捨て Module Worker（gif-encoder.worker.js）へ 1 コマずつ ImageData を transfer で渡し、
 * Worker 側で「量子化(NeuQuant)→GifWriter.addFrame→出力追記」を逐次実行する。
 * メイン側は 1 コマ供給→送信→Worker の完了(PROGRESS)を待つ（backpressure）。
 * 保持は「現コマの ImageData＋累積出力」に有界化＝原寸・全コマでもフリーズしない。
 *
 * frameSource: { total, init(signal)->{w,h}, next(i,signal)->{rgba:ArrayBuffer, delayMs}, dispose() }
 *   ※ init/next は実寸が不明なら throw する（黙示 fallback を作らない）。
 * 中断：cancel() は Worker を即 terminate し、AbortSignal で供給ループを解く。ただし
 *   `img.decode()` の**最中**は次の await 境界まで実際の離脱が遅れる（最大 1 コマ分）。
 */
function streamEncodeGif(frameSource, onProgress) {
  let settled = false;
  let ackResolve = null;
  let worker = null;
  const ac = new AbortController();
  const cleanup = () => { try { if (worker) worker.terminate(); } catch (_) {} };
  // 保留中の backpressure ack を解放して送信ループを解く（settled 後にループが FINISH を送らず抜ける）
  const releaseAck = () => { if (ackResolve) { const r = ackResolve; ackResolve = null; r(); } };

  let doReject = null, doResolve = null;
  const promise = new Promise((resolve, reject) => { doResolve = resolve; doReject = reject; });
  const fail = (err) => {
    if (!settled) { settled = true; cleanup(); ac.abort(); releaseAck(); doReject(err); }
  };
  const succeed = (v) => { if (!settled) { settled = true; cleanup(); doResolve(v); } };
  // watchdog 等の外部から stuck Worker を terminate して中断する（Worker 累積を防ぐ）
  const cancel = () => fail(new Error("cancelled"));

  try {
    worker = new Worker(
      browser.runtime.getURL("src/encoders/gif-encoder.worker.js"),
      { type: "module" }
    );
  } catch (e) { doReject(e); return { promise, cancel }; }

  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "PROGRESS") {
      if (onProgress) onProgress(m.done, m.total);
      releaseAck();
    } else if (m.type === "RESULT") {
      succeed(m.gif); // Blob（実体コピーなしで受け取る）
    } else if (m.type === "ERROR") {
      fail(new Error(m.message));
    }
  };
  worker.onerror = (e) => fail(new Error((e && e.message) || "encoder worker error"));

  (async () => {
    try {
      const size = await frameSource.init(ac.signal);
      worker.postMessage({ type: "INIT", width: size.w, height: size.h, loop: 0 });
      for (let i = 0; i < frameSource.total && !settled; i++) {
        const { rgba, delayMs } = await frameSource.next(i, ac.signal);
        const acked = new Promise((r) => { ackResolve = r; });
        worker.postMessage({
          type: "FRAME", index: i, total: frameSource.total,
          rgba, width: size.w, height: size.h, delayMs,
        }, [rgba]);
        await acked; // backpressure：Worker が当該コマを処理し終えるまで次を送らない
      }
      if (!settled) worker.postMessage({ type: "FINISH" });
    } catch (err) {
      fail(err);
    } finally {
      try { frameSource.dispose(); } catch (_) {}
    }
  })();

  return { promise, cancel };
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

  // GROUP-150 v1.48.0：うごイラは原寸・全コマ・縮小/再エンコードなし。各コマは ZIP 内の
  // 原寸バイトをそのまま blob URL 化する（圧縮 JPEG のまま保持＝メモリはコマ数×圧縮JPEG に有界）。
  // 原寸 RGBA への展開はエンコード時に 1 コマずつ行い（streamEncodeGif の backpressure）、
  // 全コマを原寸で同時保持しない。間引き・出力縮小は行わない（サイズ・解像度を落とさない）。
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

  document.getElementById("convert-btn").addEventListener("click", () => {
    runUgoiraConversion(frameUrls, delays, pageUrl);
  });
  document.getElementById("cancel-btn").addEventListener("click", _onCancelButtonClick);
  log(`うごイラを受領しました（${frameUrls.length} コマ）。「GIF に変換」で開始します。`);
}

// ================================================================
// GROUP-157：変換の多重起動ガード＋終端一本化（動画経路・うごイラ経路の共通機構）
// ================================================================
// ウォッチドッグ発火などでボタンが「再試行」に戻った後、前の変換がまだ走っているのに 2 本目を
// 開始できてしまうと、STASH_CONVERSION_PAYLOAD が後着で上書きされ先着の成果物が失われる。
// 両経路とも同じ stash を叩くため、フラグはモジュールスコープで 1 本だけ持つ。
//
// 【方式選択】クリックハンドラ側へ set/clear を引き上げる案は採らない。ハンドラは経路ごとに
// 別々（initUgoira 側と init 側の 2 箇所）で「共通の入口」にならず、しかも clear は非同期な
// 変換の終端でしか打てないため set と clear が別ファイル位置に離れる＝対で守りにくい。
// 代わりに「取得できたら { settle, fail, watch, onCancel } を返すファクトリ」を 1 つ用意し、
// フラグの set と clear をこの関数の内側だけに閉じ込める（呼び出し側は clear を書けない）。
let _conversionActive = false;

/**
 * 変換の開始権を取る。既に変換中なら null（呼び出し側は即 return）。
 * 返り値の settle() は「この変換の決着を宣言」する。初回のみ true を返し、フラグ解除と
 * 監視タイマー停止を行う。2 回目以降＝遅れて到達した経路なので false を返す。
 */
function beginConversion() {
  if (_conversionActive) {
    log("変換を実行中です。完了までお待ちください。");
    return null;
  }
  _conversionActive = true;

  const btn = document.getElementById("convert-btn");
  let settled = false;
  let watchTimer = null;

  // GROUP-165：変換中は「キャンセル」ボタンを「中止」へ切り替え、利用者の明示操作でだけ止める
  // （システム側の時間切れによる強制打ち切りは廃止）。中止の中身は経路ごとに onCancel で預ける。
  const cancelBtn = document.getElementById("cancel-btn");
  if (cancelBtn) cancelBtn.textContent = "中止";

  const settle = () => {
    if (settled) return false;
    settled = true;
    _conversionActive = false;
    _cancelActiveConversion = null;
    if (cancelBtn) cancelBtn.textContent = "キャンセル";
    if (watchTimer !== null) { clearInterval(watchTimer); watchTimer = null; }
    return true;
  };
  /** 経過表示タイマーを預ける（settle で必ず止める＝止め忘れを構造的に無くす） */
  const watch = (timerId) => { watchTimer = timerId; };
  /** 「中止」押下時の処理を預ける（決着前のみ有効） */
  const onCancel = (fn) => { _cancelActiveConversion = fn; };
  /** 回復可能な失敗：再試行を許す。決着済みなら何もせず false を返す */
  const fail = (message) => {
    if (!settle()) return false;
    log(message, "error");
    hideProgress();
    if (btn) { btn.disabled = false; btn.textContent = "再試行"; }
    return true;
  };
  return { settle, fail, watch, onCancel };
}

// GROUP-165：変換中の「中止」処理（beginConversion の onCancel で預かる。変換していない時は null）
let _cancelActiveConversion = null;

/** 「キャンセル／中止」ボタン：変換中なら中止、それ以外はウィンドウを閉じる */
function _onCancelButtonClick() {
  if (_cancelActiveConversion) {
    const fn = _cancelActiveConversion;
    _cancelActiveConversion = null; // 連打で二重に中止しない
    fn();
    return;
  }
  window.close();
}

// GROUP-166：動画経路の中止に使っていた再読込方式（録画を background へ預け直してウィンドウを再読込）は、
// 動画も自前エンコーダ（enc.cancel() で本当に止まる）へ移行したため削除した。中止はうごイラと同じく
// このウィンドウのまま行い、「再試行」でもう一度変換できる。

/** 経過時間の表示（例：1分05秒） */
function _formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}分${String(s % 60).padStart(2, "0")}秒` : `${s}秒`;
}

/** うごイラ：コマ列 → GIF 変換（原寸・全コマ・per-frame delay、ストリーミングエンコード） */
function runUgoiraConversion(frameUrls, delays, pageUrl) {
  const guard = beginConversion();
  if (!guard) return;
  // GROUP-157：起動処理中（監視タイマー確立前）に例外が飛ぶとフラグが立ったまま解除されず、
  // 以後一切変換できなくなる。同期例外は必ずここで受けて guard を解放する。
  try {
    _runUgoiraConversionBody(guard, frameUrls, delays, pageUrl);
  } catch (err) {
    guard.fail(`変換の開始に失敗しました: ${(err && err.message) || err}`);
  }
}

function _runUgoiraConversionBody(guard, frameUrls, delays, pageUrl) {
  const btn = document.getElementById("convert-btn");
  btn.disabled = true;
  btn.textContent = "変換中…";
  updateProgress(0);
  const startTime = Date.now();

  // 変換完了/失敗時にフレーム blob を解放（成功終端のみ。失敗時は「再試行」のため保持し unload に委ねる）
  const cleanupFrames = () => {
    try { frameUrls.forEach((u) => URL.revokeObjectURL(u)); } catch (_) {}
  };

  // GROUP-165：システム側の時間切れによる強制打ち切りは廃止（旧：60 秒無進捗で enc.cancel()＋失敗扱い）。
  // 進捗が止まっている時は経過時間と案内を表示するだけにし、止めるかどうかは利用者が「中止」で決める。
  // こちらは enc.cancel() で Worker を本当に止められるので、中止後はこのウィンドウのまま再試行できる。
  let enc = null;
  const SLOW_NOTICE_MS = 60_000; // この時間進捗が無ければ「長引いている」旨を添える（打ち切りはしない）
  let lastProgressAt = Date.now();
  let lastLabel = "";
  guard.watch(setInterval(() => {
    const idleMs = Date.now() - lastProgressAt;
    if (idleMs > SLOW_NOTICE_MS) {
      log(`${lastLabel}（${_formatElapsed(idleMs)} 進捗がありません。止める場合は「中止」を押してください）`);
    }
  }, 5_000));
  guard.onCancel(() => {
    if (enc) enc.cancel();
    guard.fail("変換を中止しました。「再試行」でもう一度変換できます。");
  });

  enc = streamEncodeGif(makeUgoiraFrameSource(frameUrls, delays), (done, total) => {
    lastProgressAt = Date.now();
    updateProgress(done / total);
    lastLabel = `変換中… ${done}/${total} コマ`;
    log(lastLabel);
  });
  enc.promise.then(async (gifBlob) => {
    // 中止後に遅れて完了しても二重処理しない（settle が false を返す）。
    if (!guard.settle()) return;

    // GROUP-151 v1.49.0：GIF は **Blob のまま** background へ渡す。
    // 旧実装は base64 dataURL 化していたが、それが allocation overflow の発生源だった
    // （文字列 2byte/char → btoa 1.33n → 連結でピーク約 3.3n、さらに structured clone を 4 回通過）。
    // Blob の structured clone は実体をコピーしないため、巨大でもコピーが起きない。
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const approxSize = (gifBlob.size / 1024 / 1024).toFixed(1);
    log(`✅ 変換完了（${elapsed} 秒、GIF 約 ${approxSize} MB）。保存モーダルを起動しています…`, "success");
    updateProgress(1);
    try {
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      await browser.runtime.sendMessage({
        type: "STASH_CONVERSION_PAYLOAD",
        imageBlob: gifBlob,
        pageUrl: pageUrl || "",
        suggestedFilename: `ugoira-${ts}.gif`,
        associatedAudio: null,
      });
      cleanupFrames(); // 送信完了後に解放（成功終端のみ。previewImg は描画済みで frameUrls 再参照なし）
      await _routeAfterConvert(); // GROUP-33-T1：自動遷移 ON/OFF で分岐
    } catch (err) {
      // 送信失敗時は frameUrls を解放しない（「再試行」で再利用するため）。解放は unload に委ねる。
      log(`保存モーダル起動失敗: ${err.message}`, "error");
      btn.disabled = false;
      btn.textContent = "再試行";
    }
  }).catch((err) => {
    // 失敗時は frameUrls を解放しない（「再試行」で再利用するため）。解放は unload に委ねる。
    // 中止後・決着後に遅れて届いた例外は fail が false を返して何もしない。
    if (!guard.fail(`変換失敗: ${(err && err.message) || err}`)) {
      console.warn("[video_convert] 決着後に到達した例外（無視）:", err);
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
    // このウィンドウ自身の blob URL に変換して以降の既存経路（プレビュー→seek 取り出し）へ流す
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
      `<div><span class="key">変換設定:</span> 長さ＝実尺（録画上限まで） / ${PHASE1_PARAMS.FPS} fps / 最大 ${PHASE1_PARAMS.MAX_WIDTH}px</div>`,
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

    // GROUP-166：gifshot の存在・対応チェック（typeof gifshot／isExistingVideoGIFSupported）は、
    // 動画経路が gifshot を使わなくなったため削除。再生可否はプレビューの読込成否（上）で判定済み。

    // GROUP-166：直 URL の動画で、CORS 付きの読込が読込エラーで失敗した（＝サーバーが CORS に応じない）
    // 場合、取り出し用 video（crossOrigin="anonymous" で読む）も必ず失敗し、仮に読めても canvas が汚染されて
    // コマを読み取れない。変換を始めてから失敗させず、準備の時点で変換できないことを伝える。
    // ページ内録画（captured＝このウィンドウ自身の blob URL）は同一オリジンのため対象外。
    // 10 秒の待ち切れで CORS なし読込へ切り替わった場合は、遅いだけで CORS 対応の可能性があるため止めない。
    if (!captured && !window.__previewCorsLoaded && window.__previewCorsFailReason === "load error") {
      log("このサイトの動画は GIF に変換できません（動画の配信元が CORS に対応していないため、コマを読み取れません）。", "error");
      document.getElementById("convert-btn").disabled = true;
      document.getElementById("cancel-btn").addEventListener("click", _onCancelButtonClick);
      return;
    }

    // 変換ボタン
    // GROUP-15：実尺変換のため、受領した尺と録画上限（設定値）を変換へ渡す
    const { videoMaxRecSec } = await browser.storage.local.get("videoMaxRecSec");
    const capSec = (Number.isFinite(videoMaxRecSec) && videoMaxRecSec >= 1)
      ? videoMaxRecSec : PHASE1_PARAMS.DURATION_SEC;
    document.getElementById("convert-btn").addEventListener("click", () => {
      runConversion(effectiveUrl, pageUrl, videoWidth, videoHeight, duration, capSec);
    });

    // キャンセル（変換中は「中止」：GROUP-165）
    document.getElementById("cancel-btn").addEventListener("click", _onCancelButtonClick);

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
function runConversion(videoUrl, pageUrl, origWidth, origHeight, hintDuration, capSec) {
  const guard = beginConversion();
  if (!guard) return;
  // GROUP-157：起動処理中（settle 定義・監視タイマー確立前）に例外が飛ぶとフラグが立ったまま
  // 解除されず、以後一切変換できなくなる。同期例外は必ずここで受けて guard を解放する。
  try {
    _runConversionBody(guard, videoUrl, pageUrl, origWidth, origHeight, hintDuration, capSec);
  } catch (err) {
    guard.fail(`変換の開始に失敗しました: ${(err && err.message) || err}`);
  }
}

// ----------------------------------------------------------------
// GROUP-152：gifshot の単位変換バグ対策（GIF の時間情報 delay=0 の正書き）
//
// GROUP-166：**現行の動画経路では未使用**（動画も自前エンコーダへ移行し、delay は Worker が正しく書く）。
// 既存 GIF 修復ツール（tools/gif-repair/gif_delay_repair.py）との等価性検証のため残置している
// （tools/node-harness/gif_delay_rewrite.mjs が本関数を実ソースから切り出して検証する）。
//
// 旧経路での経緯：gifshot は interval（秒、0.1）を内部でミリ秒扱いの delay オプションへ流し、さらに
// ×0.1 の単位変換を掛けるため 0.1→0.01 となり、GIF 書込のビット演算で整数 0 に切り捨てられる
// ＝**全コマ GCE delay=0**（時間情報なし）の GIF が生成される。0 を「最速」と解釈する再生系
// （多くの外部アプリ・一部のブラウザ内 img 表示）では早送りになり、音声と乖離する（UAT 実害）。
// vendored minified を触らず、生成直後にブロック構造を正しく歩いて delay を 10cs=100ms に
// 正書きしていた（バイトパターンの盲目置換は LZW 圧縮データ中の偶然一致を誤爆し得るため不可）。
// ----------------------------------------------------------------
function _rewriteGifDelays(bytes, csWhenZero) {
  if (bytes.length < 13 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46) {
    throw new Error("GIF ヘッダではありません");
  }
  let p = 6;
  p += 4; // LSD: width(2) + height(2)
  const packed = bytes[p]; p += 3; // packed, bgColor, aspect
  if (packed & 0x80) p += 3 * (2 << (packed & 0x07)); // Global Color Table
  let rewritten = 0;
  const skipSubBlocks = () => {
    while (p < bytes.length && bytes[p] !== 0) p += 1 + bytes[p];
    p += 1; // block terminator
  };
  while (p < bytes.length) {
    const b = bytes[p];
    if (b === 0x3B) break; // trailer
    if (b === 0x21) { // extension
      const label = bytes[p + 1];
      p += 2;
      if (label === 0xF9) {
        // GCE: size(=4), packed, delay_lo, delay_hi, transparentIdx, terminator
        const size = bytes[p];
        const delay = bytes[p + 2] | (bytes[p + 3] << 8);
        if (delay === 0) {
          bytes[p + 2] = csWhenZero & 0xFF;
          bytes[p + 3] = (csWhenZero >> 8) & 0xFF;
          rewritten++;
        }
        p += 1 + size;
        skipSubBlocks();
      } else {
        skipSubBlocks();
      }
    } else if (b === 0x2C) { // image descriptor
      p += 9; // separator(1) + left/top/w/h(8)
      const ip = bytes[p]; p += 1;
      if (ip & 0x80) p += 3 * (2 << (ip & 0x07)); // Local Color Table
      p += 1; // LZW min code size
      skipSubBlocks();
    } else {
      throw new Error(`未知の GIF ブロック 0x${b.toString(16)} @${p}`);
    }
  }
  return rewritten;
}

function _runConversionBody(guard, videoUrl, pageUrl, origWidth, origHeight, hintDuration, capSec) {
  const btn = document.getElementById("convert-btn");
  btn.disabled = true;
  btn.textContent = "変換中…";
  log("動画を読込中…");
  updateProgress(0);

  const size = computeGifSize(origWidth, origHeight);
  // GROUP-15：実尺で変換（固定 20 秒/200 コマを廃止）。preview の duration を優先、無ければ
  // 受領 duration、上限 capSec（設定値）で clamp。GIF 長 = numFrames × interval が実尺に一致する。
  const previewVideo = document.getElementById("preview");
  const maxSec = (Number.isFinite(capSec) && capSec >= 1) ? capSec : PHASE1_PARAMS.DURATION_SEC;
  let actualDur = (Number.isFinite(previewVideo.duration) && previewVideo.duration > 0)
    ? previewVideo.duration
    : (Number.isFinite(hintDuration) && hintDuration > 0) ? hintDuration
    : PHASE1_PARAMS.DURATION_SEC;
  actualDur = Math.max(0.5, Math.min(actualDur, maxSec));
  const numFrames = Math.max(1, Math.round(actualDur * PHASE1_PARAMS.FPS));
  const intervalSec = 1 / PHASE1_PARAMS.FPS;
  // 長尺は変換前に概算（コマ数・尺）を通知。コマ数上限は設けず全取得を尊重する（自動では打ち切らない）。
  if (numFrames > 600) {
    log(`⚠ 長尺（約 ${Math.round(actualDur)} 秒・${numFrames} コマ）です。GIF のファイルが大きく、変換にも時間がかかります（自動では止まりません。止める場合は「中止」を押してください）。`);
  }

  const startTime = Date.now();

  // Phase 1.5 GROUP-28 mvdl：音声録音を並列開始（既存 preview video を流用）。
  // 取り出しは別の video 要素（makeVideoSeekFrameSource 内で 1 本生成）で行い、プレビューと合わせて
  // 2 本（旧 gifshot 内部 video と同数）。v1.31.4 で録音用 video を新規作成し gifshot 内部 video と同一 URL の
  // 多重ロードになってタブクラッシュした（v1.31.5 でプレビュー流用へ修正）経緯があるため増やさない。
  // 音声なし / 録音失敗時は associatedAudio = null で GIF のみ保存にフォールバック。
  // GROUP-166：中止・失敗時に録音を止める（再試行で二重録音にしない）ため AbortController を渡す。
  const audioAc = new AbortController();
  const audioPromise = recordAudio(previewVideo, actualDur, audioAc.signal);

  // GROUP-165/166：時間切れによる強制打ち切りはしない。進捗（1 コマごと）が長く無い時は
  // 経過時間と「中止」の案内を添えるだけにし、止めるかどうかは利用者が決める。
  let enc = null;
  const SLOW_NOTICE_MS = 60_000;
  let lastProgressAt = Date.now();
  let lastLabel = "動画を読込中…";
  guard.watch(setInterval(() => {
    const idleMs = Date.now() - lastProgressAt;
    if (idleMs > SLOW_NOTICE_MS) {
      log(`${lastLabel}（${_formatElapsed(idleMs)} 進捗がありません。止める場合は「中止」を押してください）`);
    }
  }, 5_000));
  // 中止：自前エンコーダは enc.cancel() で Worker と取り出しを本当に止められる（うごイラ経路と同型）。
  // 録音も止める。中止後はこのウィンドウのまま「再試行」できる。
  guard.onCancel(() => {
    if (enc) enc.cancel();
    audioAc.abort();
    guard.fail("変換を中止しました。「再試行」でもう一度変換できます。");
  });

  // コマ数・尺は取り出し用 video の実尺で init 時に確定する（frameSource.total／durationSec）。
  // 進捗の total・GIF のコマ数・音声の durationSec はすべて確定後の値を使う（食い違わせない）。
  const frameSource = makeVideoSeekFrameSource(videoUrl, size, numFrames, intervalSec, actualDur);
  enc = streamEncodeGif(
    frameSource,
    (done, total) => {
      lastProgressAt = Date.now();
      updateProgress(done / total);
      lastLabel = `変換中… ${done}/${total} コマ`;
      log(lastLabel);
    }
  );

  enc.promise.then(async (gifBlob) => {
    // 中止後・決着後に遅れて完了しても二重処理しない（settle が false を返す）。
    if (!guard.settle()) {
      console.warn("[video_convert] 決着後に変換完了が到達（無視）");
      return;
    }

    // GROUP-166：成功後の処理（サイズ表示・音声待ち・保存ウィンドウ起動）で想定外の例外が出ても、
    // 決着済み（guard.fail が使えない）のまま「変換中…」で固まらないよう、失敗表示と「再試行」へ戻す。
    try {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      // GROUP-166：自前エンコーダは delay（100ms/コマ）を正しく書き、GIF を Blob で返す
      // （旧 gifshot の dataURL→バイト列→delay 正書きの後処理は不要になった）。
      const approxSize = (gifBlob.size / 1024 / 1024).toFixed(1);

      // Phase 1.5 GROUP-28 mvdl：音声録音完了を待つ
      log(`✅ 変換完了（${elapsed} 秒、GIF 約 ${approxSize} MB）。音声録音完了待ち…`, "success");
      updateProgress(1);

      let associatedAudio = null;
      try {
        const audioBlob = await audioPromise;
        if (audioBlob && audioBlob.size > 0) {
          const audioSizeMB = (audioBlob.size / 1024 / 1024).toFixed(2);
          // GROUP-157：音声も GIF と同じ Blob 運搬に揃える（旧実装は base64 dataURL 化して
          // stash → modal → 保存 payload と context 間を往復させていた＝実体が複製されていた）。
          // Blob の structured clone は実体をコピーしないため、長尺音声でも安全。
          associatedAudio = {
            blob: audioBlob,
            mimeType: "audio/webm",
            extension: PHASE1_PARAMS.AUDIO_EXT,
            durationSec: frameSource.durationSec,
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
        // v1.31.2（拡張子の誤判定対策）：
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

        // v1.31.5 GROUP-28 mvdl hotfix：大容量 payload を storage.local._pendingModal に入れると
        // onChanged broadcast で全 context にクローンされ 8GB 級膨張していた → background メモリへ stash。
        // GROUP-152：GIF は **Blob** で渡す（GROUP-166 以降、delay はエンコーダが正しく書く）。Blob の structured clone は実体を
        // コピーしないため、巨大 dataURL の再送・保存時の overflow 系リスクもうごイラ同様に解消される。
        await browser.runtime.sendMessage({
          type: "STASH_CONVERSION_PAYLOAD",
          imageBlob: gifBlob,
          pageUrl: pageUrl || "",
          suggestedFilename,
          associatedAudio,
        });
        gifBlob = null; // 送信後に参照を切る（GROUP-82 規約。Blob 実体は background 側が保持）

        // GROUP-33-T1 (v1.46.51)：自動遷移 ON は保存ウィンドウへ、OFF はボタン表示
        await _routeAfterConvert();
      } catch (err) {
        log(`保存モーダル起動失敗: ${err.message}`, "error");
        btn.disabled = false;
        btn.textContent = "再試行";
      }
    } catch (postErr) {
      console.error("[video_convert] 変換後の処理で例外:", postErr);
      audioAc.abort();
      log(`変換後の処理に失敗しました: ${(postErr && postErr.message) || postErr}`, "error");
      hideProgress();
      btn.disabled = false;
      btn.textContent = "再試行";
    }
  }).catch((err) => {
    audioAc.abort(); // 失敗時は録音も止める（再試行で二重録音にしない）
    // 中止後・決着後に遅れて届いた例外（中止時の "cancelled" 等）は fail が false を返して何もしない。
    if (!guard.fail(`変換失敗: ${(err && err.message) || err}`)) {
      console.warn("[video_convert] 決着後に到達した例外（無視）:", err);
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
