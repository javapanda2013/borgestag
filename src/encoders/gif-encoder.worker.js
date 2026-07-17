/*
 * gif-encoder.worker.js — うごイラ・ストリーミング GIF エンコード Worker（GROUP-150 v1.48.0）
 *
 * gifshot の images 一括方式（全コマを 1 tick で一斉デコード＋yield 無し LZW）を廃し、
 * メインスレッドから 1 コマずつ ImageData を受け取り、量子化(NeuQuant)→GifWriter.addFrame を
 * 逐次実行して出力バッファへ追記する。保持は「現コマの RGB＋累積出力バッファ」に有界化される。
 *
 * DOM 非依存（縮小/getImageData はメイン側）。type:"module" Worker として getURL で起動され、
 * omggif / neuquant を ES import する（CSP: script-src 'self'、eval/new Function 非依存）。
 *
 * プロトコル（メイン→Worker）：
 *   { type:"INIT",  width, height, loop }         … GifWriter を生成
 *   { type:"FRAME", index, total, rgba(ArrayBuffer, transfer), width, height, delayMs }
 *   { type:"FINISH" }                              … trailer を書き RESULT 返却
 * Worker→メイン：
 *   { type:"PROGRESS", done, total }
 *   { type:"RESULT", gif(ArrayBuffer, transfer) }
 *   { type:"ERROR", message }
 */

import { GifWriter } from "../vendor/omggif.js";
import { NeuQuant } from "../vendor/neuquant.js";

// NeuQuant サンプリング係数（1=最高画質/最遅 〜 30=最速）。gifshot 既定と同じ 10 を踏襲。
const SAMPLE_FAC = 10;

let writer = null;
let outBuf = null; // GifWriter の出力バッファ（プレーン配列）
let frameW = 0;
let frameH = 0;

/** RGBA → RGB（アルファ除去）。NeuQuant は 3byte/px を取る */
function dataToRGB(rgba, n) {
  const rgb = new Uint8Array(n * 3);
  let j = 0;
  for (let i = 0; i < n; i++) {
    rgb[j++] = rgba[i * 4];
    rgb[j++] = rgba[i * 4 + 1];
    rgb[j++] = rgba[i * 4 + 2];
  }
  return rgb;
}

/** 1 コマを量子化して {indexed(Uint8Array), palette(Uint32 相当の number[256])} を返す */
function quantize(rgba, n) {
  const rgb = dataToRGB(rgba, n);
  const nq = new NeuQuant(rgb, SAMPLE_FAC);
  nq.buildColormap();
  const map = nq.getColormap(); // [r,g,b, ...] length 768
  const palette = new Array(256);
  for (let i = 0; i < 256; i++) {
    palette[i] = (map[i * 3] << 16) | (map[i * 3 + 1] << 8) | map[i * 3 + 2];
  }
  const indexed = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    // dataToRGB と同じ R,G,B 順で lookup（内部変数名 b,g,r は Dekker 由来の呼称）
    indexed[i] = nq.lookupRGB(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
  }
  return { indexed, palette };
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === "INIT") {
      frameW = msg.width;
      frameH = msg.height;
      outBuf = [];
      writer = new GifWriter(outBuf, frameW, frameH, {
        loop: msg.loop === undefined ? 0 : msg.loop,
      });
      return;
    }

    if (msg.type === "FRAME") {
      if (!writer) throw new Error("INIT 前に FRAME を受信しました");
      const w = msg.width, h = msg.height;
      const n = w * h;
      const rgba = new Uint8Array(msg.rgba);
      const { indexed, palette } = quantize(rgba, n);
      writer.addFrame(0, 0, w, h, indexed, {
        palette,
        delay: Math.max(0, Math.round((msg.delayMs || 0) / 10)), // ms → centisec
        disposal: 1, // 残置（うごイラは全面不透明フレーム）
      });
      self.postMessage({ type: "PROGRESS", done: msg.index + 1, total: msg.total });
      return;
    }

    if (msg.type === "FINISH") {
      if (!writer) throw new Error("INIT 前に FINISH を受信しました");
      writer.end();
      const bytes = Uint8Array.from(outBuf);
      // 出力バッファを解放（Worker は使い捨てだが明示）
      outBuf = null;
      writer = null;
      self.postMessage({ type: "RESULT", gif: bytes.buffer }, [bytes.buffer]);
      return;
    }
  } catch (err) {
    self.postMessage({ type: "ERROR", message: (err && err.message) || String(err) });
  }
};
