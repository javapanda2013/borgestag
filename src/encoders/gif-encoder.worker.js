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
let outBuf = null;  // GifWriter の出力窓（固定長 Uint8Array。書かれた分を都度 chunks へ移す）
let chunks = null;  // 回収済みバイト列（Blob 構築材料）
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

/**
 * GROUP-151 v1.49.0：出力を「固定窓 Uint8Array ＋ 毎コマ flush」で回収する。
 *
 * 旧実装は GifWriter に**プレーン JS 配列**を渡していた（omggif が "for simplicity" として
 * 採る形）。SpiderMonkey の packed array は 1 要素あたり数バイトを要するため、n バイトの GIF に
 * 対して約 8n、さらに `Uint8Array.from` の瞬間に約 9n を確保する。原寸・長尺（GIF が数百 MB）で
 * 確実に破綻するため、窓をリングとして使い回し、書かれた分だけ都度 slice して chunks へ移す。
 * これでピークは「窓（1 コマ分）＋ chunks 累積 n ＋ Blob 構築時の一時 n」＝約 2n に収まる。
 *
 * 安全性：GifWriter の遡及書込（sub-block 長 `buf[cur_subblock]`）は addFrame 呼び出し内で完結し、
 * 呼び出しを跨がない。よってコマ間で flush → `setOutputBufferPosition(0)` に戻して問題ない。
 * Uint8Array は範囲外書込を**黙って捨てる**ため、窓溢れは position で必ず検知する。
 */
function _flushOutput() {
  const p = writer.getOutputBufferPosition();
  if (p > outBuf.length) {
    // 黙って切り捨てられた後なので、ここで気付けないと壊れた GIF が「成功」で返る
    throw new Error(`GIF 出力バッファ溢れ（${p} > ${outBuf.length}）`);
  }
  if (p > 0) {
    chunks.push(outBuf.slice(0, p));
    writer.setOutputBufferPosition(0);
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  try {
    if (msg.type === "INIT") {
      frameW = msg.width;
      frameH = msg.height;
      chunks = [];
      // 1 コマ分の LZW 出力＋ローカルパレット＋ヘッダに十分な窓（非圧縮でも収まる余裕を取る）
      outBuf = new Uint8Array(frameW * frameH * 2 + (1 << 20));
      writer = new GifWriter(outBuf, frameW, frameH, {
        loop: msg.loop === undefined ? 0 : msg.loop,
      });
      _flushOutput(); // ヘッダ＋論理画面記述子＋ループ拡張を回収
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
        disposal: 1, // 残置（全面不透明フレーム）
      });
      _flushOutput(); // 当該コマ分を回収して窓を再利用
      self.postMessage({ type: "PROGRESS", done: msg.index + 1, total: msg.total });
      return;
    }

    if (msg.type === "FINISH") {
      if (!writer) throw new Error("INIT 前に FINISH を受信しました");
      writer.end();
      _flushOutput(); // trailer を回収
      const blob = new Blob(chunks, { type: "image/gif" });
      // 出力を解放（Worker は使い捨てだが明示）
      chunks = null;
      outBuf = null;
      writer = null;
      // Blob は structured clone で実体をコピーしないため、巨大でも安全に渡せる
      self.postMessage({ type: "RESULT", gif: blob });
      return;
    }
  } catch (err) {
    self.postMessage({ type: "ERROR", message: (err && err.message) || String(err) });
  }
};
