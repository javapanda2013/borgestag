// =============================================================================
// gif-decoder.worker.js
// =============================================================================
// 案 Y Phase 1：GIF を Worker で decode し、ImageBitmap を main thread へ返す
//
// このファイルは Module Worker として起動される：
//   const w = new Worker(browser.runtime.getURL("src/decoders/gif-decoder.worker.js"),
//                       { type: "module" });
//
// postMessage プロトコル
// ---------------------
// main → worker：
//   { type: "INIT",     id, gifBuffer }                            // 初期 GIF binary を移譲（transferable）
//   { type: "REQ_FRAME", id, index }                                // 指定フレームを返してほしい
//   { type: "REQ_FRAME_AT", id, elapsedMs }                         // 経過時刻に該当するフレーム（ループ考慮）
//   { type: "DESTROY",  id }                                        // クリーンアップ
//
// worker → main：
//   { type: "READY",    id, frameCount, dims, totalDelayMs, loopCount }
//   { type: "FRAME",    id, index, bitmap, delay }                  // ImageBitmap は transferable
//   { type: "ERROR",    id, message }
//
// 注意：本ファイルは Phase 1 スケルトン。Phase 2 以降で：
//   - decompressFrame の合成（disposal method）を main thread と分担する設計検討
//   - LRU 上限（メモリ予算）の管理を追加
//   - 複数 GIF 同時 decode のキューイング
// =============================================================================

import { parseGIF, decompressFrame } from "../vendor/gifuct/index.js";

// ---- セッション状態 ---------------------------------------------------------
// id（タイル単位の識別子）→ セッション
const _sessions = new Map();

// セッション = { gif, rawFrames, decoded(Map index→decode結果), delays, totalDelayMs, loopCount, canvasWidth, canvasHeight }（GROUP-133-G1：オンデマンド decode）

// ---- メッセージハンドラ ------------------------------------------------------
self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    switch (msg.type) {
      case "INIT":      await handleInit(msg); break;
      case "REQ_FRAME": await handleReqFrame(msg); break;
      case "REQ_FRAME_AT": await handleReqFrameAt(msg); break;
      case "DESTROY":   handleDestroy(msg); break;
      default:
        self.postMessage({ type: "ERROR", id: msg.id, message: `unknown type: ${msg.type}` });
    }
  } catch (err) {
    self.postMessage({ type: "ERROR", id: msg.id, message: String(err && err.message || err) });
  }
};

// ---- INIT ------------------------------------------------------------------
// 設定画面パフォーマンス改善（2026-06-14 v1.46.56）：INIT は parseGIF のみ。全フレーム一括展開
//   （旧 decompressFrames）を廃止し、各フレームは REQ_FRAME 受信時に decompressFrame で
//   オンデマンド decode＋session 内 cache（_decodeFrame）。
//   狙い：① INIT が parse だけになり READY が即発火（sess.ready が早く立ち音声ゲートも改善）、
//        ② 画面外タイルは既存 viewport gate で 1 枚 decode→pause のため全フレーム decode が消える、
//        ③ 可視タイルも表示したフレームだけ decode（loop は cache で再 decode 回避）。
//   旧 INIT は表示有無に関わらず全フレーム decode していた（worker 6.8s CPU の主因、profiler 実測）。
async function handleInit({ id, gifBuffer }) {
  const gif = parseGIF(gifBuffer);
  // 描画対象フレーム（image を持つもの）。旧 decompressFrames と同じ filter で index 空間を一致させる。
  const rawFrames = gif.frames.filter(f => f.image);
  if (rawFrames.length === 0) throw new Error("GIF にフレームが含まれていません");

  // 論理画面サイズ。decompressFrames 廃止で frames[0].dims（decode 後にのみ生成）が無いため、
  // gif.lsd（Logical Screen Descriptor）優先、欠落時は先頭フレームの image descriptor（parse 直後に存在）。
  const d0 = rawFrames[0].image.descriptor;
  const canvasWidth  = gif.lsd?.width  || d0.width;
  const canvasHeight = gif.lsd?.height || d0.height;

  const loopCount = (gif.loopCount === undefined) ? 0 : gif.loopCount; // 0 = 無限ループ

  // delay は gce から（decompressFrame と同一換算：(gce.delay || 10) * 10 ms）。decode 不要で算出可能。
  const delays = rawFrames.map(f => ((f.gce && f.gce.delay ? f.gce.delay : 10) * 10));
  let totalDelayMs = 0;
  for (const d of delays) totalDelayMs += d;

  _sessions.set(id, {
    gif,                  // parse 済（gct 参照・オンデマンド decode に使用）
    rawFrames,            // 未 decode のフレーム記述子（index 空間 = 旧 frames と同一）
    decoded: new Map(),   // index → decompressFrame 結果（patch/dims）。オンデマンドで充填
    delays,
    totalDelayMs,
    loopCount,
    canvasWidth,
    canvasHeight,
  });

  self.postMessage({
    type: "READY",
    id,
    frameCount: rawFrames.length,
    dims: { width: canvasWidth, height: canvasHeight },
    totalDelayMs,
    loopCount,
  });
}

// 指定 index のフレームをオンデマンド decode（cache 済ならそれを返す）。
// GROUP-56：patch 生成後に pixels（中間 JS Array）を null 化して SpiderMonkey の retain を回避。
function _decodeFrame(sess, index) {
  let fr = sess.decoded.get(index);
  if (!fr) {
    fr = decompressFrame(sess.rawFrames[index], sess.gif.gct, /* buildImagePatch */ true);
    if (fr) fr.pixels = null;
    sess.decoded.set(index, fr);
  }
  return fr;
}

// ---- REQ_FRAME -------------------------------------------------------------
async function handleReqFrame({ id, index }) {
  const sess = _sessions.get(id);
  if (!sess) throw new Error(`session not found: ${id}`);
  if (index < 0 || index >= sess.rawFrames.length) {
    throw new Error(`index out of range: ${index}/${sess.rawFrames.length}`);
  }
  const bitmap = await renderFrame(sess, index);
  self.postMessage({
    type: "FRAME",
    id,
    index,
    bitmap,
    delay: sess.delays[index] || 100,
  }, [bitmap]); // transferable
}

// ---- REQ_FRAME_AT ----------------------------------------------------------
// elapsedMs から「今表示すべきフレーム」を逆算（無限ループ前提）
async function handleReqFrameAt({ id, elapsedMs }) {
  const sess = _sessions.get(id);
  if (!sess) throw new Error(`session not found: ${id}`);

  let t = elapsedMs;
  if (sess.totalDelayMs > 0) t = elapsedMs % sess.totalDelayMs;

  let acc = 0;
  let pickIndex = sess.rawFrames.length - 1;
  for (let i = 0; i < sess.rawFrames.length; i++) {
    acc += (sess.delays[i] || 100);
    if (t < acc) { pickIndex = i; break; }
  }

  const bitmap = await renderFrame(sess, pickIndex);
  self.postMessage({
    type: "FRAME",
    id,
    index: pickIndex,
    bitmap,
    delay: sess.delays[pickIndex] || 100,
  }, [bitmap]);
}

// ---- DESTROY ---------------------------------------------------------------
function handleDestroy({ id }) {
  _sessions.delete(id);
}

// ---- フレーム合成 -----------------------------------------------------------
// disposal method を考慮した正確な合成を行うのが本来だが、Phase 1 では
// 「単純に該当フレームの patch を canvas にそのまま描画」する素朴実装。
// disposal method の合成（method 2 = restore to bg、method 3 = restore previous）は
// Phase 2 以降で追加。多くの動画変換 GIF では disposal=2 で問題なく見える。
async function renderFrame(sess, index) {
  const f = _decodeFrame(sess, index);  // GROUP-133-G1：オンデマンド decode（cache 済なら再利用）
  if (!f) throw new Error(`frame decode failed: ${index}`);
  const off = new OffscreenCanvas(sess.canvasWidth, sess.canvasHeight);
  const ctx = off.getContext("2d");

  // 現状：単純に該当フレームの patch を貼る
  const imageData = new ImageData(
    new Uint8ClampedArray(f.patch),  // patch は ImageData の clamp 形式そのもの
    f.dims.width,
    f.dims.height,
  );
  // OffscreenCanvas の putImageData → drawImage 経由で位置オフセット
  const tmp = new OffscreenCanvas(f.dims.width, f.dims.height);
  tmp.getContext("2d").putImageData(imageData, 0, 0);
  ctx.drawImage(tmp, f.dims.left, f.dims.top);

  return off.transferToImageBitmap();
}
