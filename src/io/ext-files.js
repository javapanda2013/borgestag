// BorgesTag 共通ファイル取得 IPC（GROUP-142 派生・共有部品化 Stage 1、v1.50.0）
//
// settings / modal / viewer が各自コピーしていた「Native からの分割読み → Blob 組立」を 1 本化する。
// classic script（realm ローカル）で window.BTFiles を公開＝ページ（modal 各窓・viewer・settings）
// ごとに別 realm なので状態は持たない純関数群。ESM 化はしない（3 画面とも classic script のため）。
//
// 集約元（v1.49.0 まで各所にコピペされていた同一ループ）：
//   - settings.js の履歴タイル音声ロード（READ_FILE_CHUNKS_B64 → Blob）
//   - modal.js の履歴タブ音声ロード（同上）
//   - viewer.js の音声ロード（同上）＋ローカル GIF 本体ロード（FETCH_FILE_AS_DATAURL）

"use strict";

(function () {
  /**
   * base64 chunk 配列 → Blob（各所で同一だったループの正本）。
   * 大容量 GIF/音声を一度に 1 本の巨大文字列へ連結せず、chunk ごとに Uint8Array 化して Blob へ渡す。
   */
  function chunksB64ToBlob(chunksB64, mime) {
    const arrays = [];
    for (const b64 of chunksB64) {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      arrays.push(arr);
    }
    return new Blob(arrays, { type: mime || "application/octet-stream" });
  }

  /**
   * ローカルファイルを READ_FILE_CHUNKS_B64 で取得して Blob を返す（PIL を迂回＝音声等の非画像に必須）。
   * 失敗時は null を返す（呼び出し側で warn/UI 復帰する。既存 3 画面と同じ「握って null」方針）。
   * @param {string} path 絶対パス
   * @param {string} [mime] Blob の type（音声なら "audio/webm" 等）
   * @returns {Promise<Blob|null>}
   */
  async function readFileChunksBlob(path, mime) {
    if (!path) return null;
    let res;
    try {
      res = await browser.runtime.sendMessage({ type: "READ_FILE_CHUNKS_B64", path });
    } catch (_) {
      return null;
    }
    if (!res || !res.ok || !Array.isArray(res.chunksB64)) return null;
    return chunksB64ToBlob(res.chunksB64, mime);
  }

  /**
   * ローカル画像/GIF 本体を FETCH_FILE_AS_DATAURL で取得して Blob 化する。
   * background は小容量なら dataUrl、大容量 GIF なら chunksB64 を返す（両方を Blob 化して吸収）。
   * viewer の原寸 GIF 表示・共有再生コアの getBuffer 供給に使う。
   * 失敗時は error 文字列を返す（「大きすぎて原寸プレビュー不可」等の background 側の
   * 明示エラーを UI まで失わず届けるため。readFileChunksBlob の null 方針とは別）。
   * @param {string} path 絶対パス
   * @returns {Promise<{ok: true, blob: Blob, mime: string}|{ok: false, error: string}>}
   */
  async function fetchFileBlob(path) {
    if (!path) return { ok: false, error: "パスが指定されていません" };
    let res;
    try {
      res = await browser.runtime.sendMessage({ type: "FETCH_FILE_AS_DATAURL", path });
    } catch (err) {
      return { ok: false, error: (err && err.message) || "通信エラー" };
    }
    if (!res || !res.ok) return { ok: false, error: res?.error || "取得失敗" };
    // 小容量：dataUrl 直返し（data: を fetch して Blob 化＝手書きデコードを避ける）
    if (res.dataUrl) {
      try {
        const blob = await (await fetch(res.dataUrl)).blob();
        return { ok: true, blob, mime: blob.type || "image/gif" };
      } catch (err) {
        return { ok: false, error: (err && err.message) || "dataUrl の Blob 化に失敗" };
      }
    }
    // 大容量 GIF：分割 chunk を組み立て
    if (Array.isArray(res.chunksB64)) {
      const mime = res.mime || "image/gif";
      return { ok: true, blob: chunksB64ToBlob(res.chunksB64, mime), mime };
    }
    return { ok: false, error: "未知の応答形式" };
  }

  window.BTFiles = { chunksB64ToBlob, readFileChunksBlob, fetchFileBlob };
})();
