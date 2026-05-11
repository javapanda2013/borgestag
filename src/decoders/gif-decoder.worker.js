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

import { parseGIF, decompressFrames } from "../vendor/gifuct/index.js";

// ---- セッション状態 ---------------------------------------------------------
// id（タイル単位の識別子）→ セッション
const _sessions = new Map();

// セッション = { frames, totalDelayMs, loopCount, canvasWidth, canvasHeight, prevImageData }

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
async function handleInit({ id, gifBuffer }) {
  // gifuct で全フレーム展開（patch=true で RGBA 配列付き）
  const gif = parseGIF(gifBuffer);
  const frames = decompressFrames(gif, /* buildImagePatches */ true);

  if (frames.length === 0) throw new Error("GIF にフレームが含まれていません");

  // GROUP-56 案 A (v1.46.0): patch 生成後の `frame.pixels`（gifuct decompressFrames が
  // 中間生成する JS Array）は renderFrame で使用しない。SpiderMonkey の Native Array は
  // 1 element あたり ~8 byte の GC tag を持ち、大型 GIF（600x600 級 × 数十フレーム）で
  // session 1 件あたり 200MB+ の retain を生じさせていた（postmortem §1〜§5）。
  // patch のみ保持すれば render 経路に影響なく、6 sessions 構成で 1+GB 削減見込み。
  for (const f of frames) f.pixels = null;

  // 論理画面サイズ（GIF 全体のキャンバスサイズ）
  // gif.lsd は Logical Screen Descriptor。frames[0].dims はサブフレームサイズ
  const canvasWidth  = gif.lsd?.width  || frames[0].dims.width;
  const canvasHeight = gif.lsd?.height || frames[0].dims.height;

  // ループカウント（Netscape Application Extension）
  // gifuct は parsedGif.loopCount として直接公開しないため、frames から間接取得
  const loopCount = (gif.loopCount === undefined) ? 0 : gif.loopCount; // 0 = 無限ループ

  let totalDelayMs = 0;
  for (const f of frames) totalDelayMs += (f.delay || 100);

  _sessions.set(id, {
    frames,
    totalDelayMs,
    loopCount,
    canvasWidth,
    canvasHeight,
    prevImageData: null, // disposal method 3 (restore previous) のため保持
  });

  self.postMessage({
    type: "READY",
    id,
    frameCount: frames.length,
    dims: { width: canvasWidth, height: canvasHeight },
    totalDelayMs,
    loopCount,
  });
}

// ---- REQ_FRAME -------------------------------------------------------------
async function handleReqFrame({ id, index }) {
  const sess = _sessions.get(id);
  if (!sess) throw new Error(`session not found: ${id}`);
  if (index < 0 || index >= sess.frames.length) {
    throw new Error(`index out of range: ${index}/${sess.frames.length}`);
  }
  const bitmap = await renderFrame(sess, index);
  self.postMessage({
    type: "FRAME",
    id,
    index,
    bitmap,
    delay: sess.frames[index].delay || 100,
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
  let pickIndex = sess.frames.length - 1;
  for (let i = 0; i < sess.frames.length; i++) {
    acc += (sess.frames[i].delay || 100);
    if (t < acc) { pickIndex = i; break; }
  }

  const bitmap = await renderFrame(sess, pickIndex);
  self.postMessage({
    type: "FRAME",
    id,
    index: pickIndex,
    bitmap,
    delay: sess.frames[pickIndex].delay || 100,
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
  const f = sess.frames[index];
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
