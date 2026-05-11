// BorgesTag Image Viewer (v1.22.9)
// 保存履歴の「保存した画像を開く」で開かれる拡張ページ。
// クエリパラメータ ?path=... に指定されたローカルファイルを background 経由で読み込み、
// GIF は Blob URL で表示してアニメーションを保持する。

"use strict";

(async () => {
  const params = new URLSearchParams(location.search);
  const filePath = params.get("path") || "";
  // v1.32.0 GROUP-28 mvdl Phase 2：関連音声パラメータ
  const audioPath = params.get("audioPath") || "";
  const audioMime = params.get("audioMime") || "audio/webm";
  const imgEl    = document.getElementById("img");
  const statusEl = document.getElementById("status");
  const audioBtn = document.getElementById("audio-btn");

  function showStatus(msg) {
    statusEl.textContent = msg || "";
    statusEl.style.display = msg ? "block" : "none";
  }
  function showError(title, detail) {
    document.body.innerHTML = "";
    const div = document.createElement("div");
    div.className = "error";
    const strong = document.createElement("strong");
    strong.textContent = title;
    div.appendChild(strong);
    if (detail) {
      const p = document.createElement("p");
      p.textContent = detail;
      p.style.margin = "0";
      div.appendChild(p);
    }
    document.body.appendChild(div);
  }

  if (!filePath) {
    showError("パスが指定されていません", "viewer.html は ?path=... で開いてください。");
    return;
  }

  document.title = filePath.split(/[\\/]/).pop() || "BorgesTag Image Viewer";
  showStatus("読み込み中…");
  imgEl.classList.add("loading");

  // v1.32.2 GROUP-28 mvdl Phase 2 fix：音声ボタン有効化を**画像読込の前**に配置。
  // v1.32.0〜v1.32.1 は音声ボタン setup を IIFE 末尾に置いていたが、画像読込ブロックの
  // `return;` で IIFE が早期脱出し setup に到達しなかったため音声ボタンが表示されなかった。
  if (audioPath && audioBtn) {
    audioBtn.style.display = "flex";
    let audio = null;
    let audioBlobUrl = null;

    audioBtn.addEventListener("click", async () => {
      if (audio && !audio.paused) {
        try { audio.pause(); audio.currentTime = 0; } catch (_) {}
        audioBtn.dataset.muted = "1";
        audioBtn.textContent = "🔇";
        return;
      }
      if (!audio) {
        audioBtn.disabled = true;
        const originalText = audioBtn.textContent;
        audioBtn.textContent = "⏳";
        try {
          // READ_FILE_CHUNKS_B64 で音声ファイル（.webm 等）を PIL を迂回して取得
          const ares = await browser.runtime.sendMessage({
            type: "READ_FILE_CHUNKS_B64",
            path: audioPath,
          });
          if (!ares || !ares.ok || !Array.isArray(ares.chunksB64)) {
            console.warn("[viewer-audio] 音声読込失敗", ares?.error, { path: audioPath });
            audioBtn.textContent = originalText;
            audioBtn.disabled = false;
            return;
          }
          const arrays = [];
          for (const b64 of ares.chunksB64) {
            const bin = atob(b64);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            arrays.push(arr);
          }
          const audioBlob = new Blob(arrays, { type: audioMime });
          audioBlobUrl = URL.createObjectURL(audioBlob);
          audio = new Audio(audioBlobUrl);
          audio.loop = true;
          window.addEventListener("beforeunload", () => {
            try { if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl); } catch (_) {}
            try { if (audio) audio.pause(); } catch (_) {}
          });
        } catch (err) {
          console.warn("[viewer-audio] 音声読込エラー", err);
          audioBtn.textContent = originalText;
          audioBtn.disabled = false;
          return;
        }
      }
      try {
        await audio.play();
        audioBtn.dataset.muted = "0";
        audioBtn.textContent = "🔊";
      } catch (err) {
        console.warn("[viewer-audio] 再生エラー", err);
      } finally {
        audioBtn.disabled = false;
      }
    });
  }

  try {
    const res = await browser.runtime.sendMessage({ type: "FETCH_FILE_AS_DATAURL", path: filePath });
    if (!res?.ok) {
      showError("ファイルを開けません", res?.error || filePath);
      return;
    }

    if (res.dataUrl) {
      imgEl.src = res.dataUrl;
      imgEl.onload = () => { imgEl.classList.remove("loading"); showStatus(""); };
      imgEl.onerror = () => showError("画像の描画に失敗しました", filePath);
      return;
    }

    if (res.chunksB64 && Array.isArray(res.chunksB64)) {
      // 大容量 GIF などは base64 チャンクを受け取り、この場で Blob を組み立てる
      const arrays = [];
      let total = 0;
      for (const b64 of res.chunksB64) {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        arrays.push(arr);
        total += arr.length;
      }
      const blob = new Blob(arrays, { type: res.mime || "image/gif" });
      const blobUrl = URL.createObjectURL(blob);
      imgEl.src = blobUrl;
      imgEl.onload = () => {
        imgEl.classList.remove("loading");
        showStatus("");
      };
      imgEl.onerror = () => showError("画像の描画に失敗しました", filePath);
      // ページ破棄時に Blob URL を解放
      window.addEventListener("beforeunload", () => {
        try { URL.revokeObjectURL(blobUrl); } catch (_) {}
      });
      return;
    }

    showError("未知の応答形式です", JSON.stringify(Object.keys(res || {})));
  } catch (err) {
    showError("通信エラー", err?.message || String(err));
  }
})();
