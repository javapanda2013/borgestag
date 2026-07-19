// BorgesTag Image Viewer (v1.50.0 GROUP-142 Stage 4)
// 保存履歴の「保存した画像を開く」「原寸表示」で開かれる拡張ページ。
// クエリパラメータ ?path=... に指定されたローカルファイルを background 経由で読み込む。
//
// GIF は共有再生コア（BTGifAudio）の canvas 描画へ移行：
//   - 従来はネイティブ <img> 表示＋音声独立再生で、再生位置を制御も観測もできず
//     音声と GIF の同期が原理的に不可能だった（「原寸表示で同期しない」UAT NG の原因）。
//   - コアは音声の currentTime からフレームを毎フレーム逆算（ずれ非累積）し、
//     音声と GIF の長さが違っても両方を切らずに揃えてループする（協調ループ）。
// 非 GIF は従来どおり <img>。音声ボタンは settings タイルと同じ「再生/停止」トグル。
// 本ページの audio はページ内で完結（背景画面のボタン・音声とは独立＝Q-142-4）。

"use strict";

(async () => {
  const params = new URLSearchParams(location.search);
  const filePath = params.get("path") || "";
  // v1.32.0 GROUP-28 mvdl Phase 2：関連音声パラメータ
  const audioPath = params.get("audioPath") || "";
  const audioMime = params.get("audioMime") || "audio/webm";
  const imgEl    = document.getElementById("img");
  const canvasEl = document.getElementById("canvas");
  const statusEl = document.getElementById("status");
  const audioBtn = document.getElementById("audio-btn");

  let player = null;       // GIF のとき共有コアの player handle
  let audio = null;
  let audioBlobUrl = null;

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

  // ページ破棄時のクリーンアップ（Blob URL・音声・コア player）
  window.addEventListener("beforeunload", () => {
    try { if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl); } catch (_) {}
    try { if (audio) audio.pause(); } catch (_) {}
    try { if (player) player.destroy(); } catch (_) {}
  });

  // v1.32.2 GROUP-28 mvdl Phase 2 fix：音声ボタン有効化を**画像読込の前**に配置。
  // v1.32.0〜v1.32.1 は音声ボタン setup を IIFE 末尾に置いていたが、画像読込ブロックの
  // `return;` で IIFE が早期脱出し setup に到達しなかったため音声ボタンが表示されなかった。
  if (audioPath && audioBtn) {
    audioBtn.style.display = "flex";

    audioBtn.addEventListener("click", async () => {
      // 「再生中」判定（P1-C）：音声が鳴っている（!paused）か、追従駆動中（協調ループの
      // 待機フェーズ＝audio.paused && ended を含む）の OR。player の有無だけで分岐すると
      // 「player あり・追従前に音声だけ鳴っている」状態で停止ボタンが効かなくなる。
      const playing = (audio && !audio.paused) ||
                      (player && player.isFollowing && player.isFollowing());
      if (playing) {
        // 停止（settings タイルと同じ pause + 頭出し。currentTime=0 で ended もリセットされ、
        // コアの追従 tick が「ユーザー停止」を検知して自走へ復帰する）
        try { audio.pause(); audio.currentTime = 0; } catch (_) {}
        if (player && player.unfollow) player.unfollow();
        audioBtn.dataset.muted = "1";
        audioBtn.textContent = "🔇";
        return;
      }
      // GROUP-28（settings と同じガード、P1-C）：GIF のアニメ準備（ready）前は音声を開始しない。
      // ready 前に始めると followAudio が no-op になり「音声だけ独立再生・追従なし」で固定される。
      if (player && !player.isReady()) {
        const t0 = audioBtn.textContent;
        audioBtn.textContent = "⏳";
        setTimeout(() => { try { audioBtn.textContent = t0; } catch (_) {} }, 900);
        return;
      }
      if (!audio) {
        audioBtn.disabled = true;
        const originalText = audioBtn.textContent;
        audioBtn.textContent = "⏳";
        try {
          // 共有部品化 Stage 1：READ_FILE_CHUNKS_B64 → Blob を BTFiles に一本化（PIL 迂回）
          const audioBlob = await BTFiles.readFileChunksBlob(audioPath, audioMime);
          if (!audioBlob) {
            console.warn("[viewer-audio] 音声読込失敗", { path: audioPath });
            audioBtn.textContent = originalText;
            audioBtn.disabled = false;
            return;
          }
          audioBlobUrl = URL.createObjectURL(audioBlob);
          audio = new Audio(audioBlobUrl);
          audio.loop = true; // 非 GIF の独立再生用既定。GIF 追従時はコアが協調制御で上書きする
        } catch (err) {
          console.warn("[viewer-audio] 音声読込エラー", err);
          audioBtn.textContent = originalText;
          audioBtn.disabled = false;
          return;
        }
      }
      try {
        await audio.play();
        // GROUP-142 Stage 4：GIF なら追従駆動へ（逆算・協調ループ・停止検知はコアが担う）
        if (player) player.followAudio(audio, "viewer-audio");
        audioBtn.dataset.muted = "0";
        audioBtn.textContent = "🔊";
      } catch (err) {
        console.warn("[viewer-audio] 再生エラー", err);
      } finally {
        audioBtn.disabled = false;
      }
    });
  }

  // 非 GIF・GIF フォールバック共通：Blob URL を <img> に表示（従来経路）
  function attachImgBlob(blob) {
    canvasEl.style.display = "none";
    imgEl.style.display = "";
    const blobUrl = URL.createObjectURL(blob);
    imgEl.src = blobUrl;
    imgEl.onload = () => { imgEl.classList.remove("loading"); showStatus(""); };
    imgEl.onerror = () => showError("画像の描画に失敗しました", filePath);
    window.addEventListener("beforeunload", () => {
      try { URL.revokeObjectURL(blobUrl); } catch (_) {}
    });
  }

  try {
    // 共有部品化 Stage 1/4：dataUrl / chunksB64 の分岐吸収は BTFiles に一本化
    const r = await BTFiles.fetchFileBlob(filePath);
    if (!r.ok) {
      showError("ファイルを開けません", r.error || filePath);
      return;
    }

    const isGif = /image\/gif/i.test(r.mime || "") || /\.gif(\?|#|$)/i.test(filePath);
    if (isGif && window.BTGifAudio) {
      // GIF：共有コアの canvas 再生（音声なしでも自走。音声再生時に追従へ切替）
      const buf = await r.blob.arrayBuffer();
      imgEl.style.display = "none";
      canvasEl.style.display = "block";
      player = BTGifAudio.createGifPlayer({
        canvas: canvasEl,
        getBuffer: async () => buf,
        onReady: () => {
          imgEl.classList.remove("loading"); showStatus("");
          // P1-C：READY 時点で音声が既に鳴っていれば追従へ接続（ready gate をすり抜けた場合の保険）
          if (audio && !audio.paused) player.followAudio(audio, "viewer-audio");
        },
        onError: (err) => {
          // decode 失敗等は従来の <img> 経路へフォールバック（アニメは <img> のネイティブ再生）
          console.warn("[viewer] GIF canvas 再生失敗 → img fallback", err);
          player = null;
          attachImgBlob(r.blob);
        },
      });
    } else {
      attachImgBlob(r.blob);
    }
  } catch (err) {
    showError("通信エラー", err?.message || String(err));
  }
})();
