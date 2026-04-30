/**
 * content.js
 * 1. 右クリックで選択された画像をbackground.jsに転送
 * 2. 画像ホバー時にクイック保存ボタン・即保存ボタンを表示
 */

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "OPEN_SAVE_MODAL") {
    browser.runtime.sendMessage({
      type:     "OPEN_MODAL_WINDOW",
      imageUrl: message.imageUrl,
      pageUrl:  message.pageUrl || location.href,
    });
  }
});

// ================================================================
// ホバーボタン（クイック保存・即保存）
// ================================================================
const DELAY_SHOW = 200;
const DELAY_HIDE = 400;
const MIN_SIZE   = 48;

// GROUP-15-impl-A-phase1 (v1.31.0)：currentImg は img / video 両方を格納しうる。
// 種別判定は tagName === "VIDEO" か currentImg._isVideo プロキシで行う。
let currentImg   = null;
let hoverWrap    = null; // ボタン群を包むラッパー
let showTimer    = null;
let hideTimer    = null;
let watchTimer   = null;
let lastMouseX   = 0;
let lastMouseY   = 0;

// v1.46.5 GROUP-66：content.js 起動時に前 context の orphan wrap を全件除去
// （拡張機能 reload / SPA DOM 入替 / 複数 inject 経路で蓄積した zombie wrap を清掃）
try {
  document.querySelectorAll("#__image-saver-wrap__").forEach(el => el.remove());
} catch (_) {}

// 即保存ボタンを表示するか（設定から取得）
let instantSaveEnabled = true;
browser.storage.local.get("instantSaveEnabled").then(r => {
  instantSaveEnabled = r.instantSaveEnabled !== false;
});
// 設定変更をリアルタイム反映
browser.storage.onChanged.addListener((changes) => {
  if ("instantSaveEnabled" in changes) {
    instantSaveEnabled = changes.instantSaveEnabled.newValue !== false;
    if (hoverWrap) updateInstantBtn();
  }
});

// GROUP-2-a: ホバーボタン一時非表示トグル（v1.29.0）
// ツールバーアイコン右クリック → contextMenu トグルで storage.local.hoverButtonsTempHidden を切替
let hoverButtonsTempHidden = false;
browser.storage.local.get("hoverButtonsTempHidden").then(r => {
  hoverButtonsTempHidden = !!r.hoverButtonsTempHidden;
});
browser.storage.onChanged.addListener((changes) => {
  if ("hoverButtonsTempHidden" in changes) {
    hoverButtonsTempHidden = !!changes.hoverButtonsTempHidden.newValue;
    if (hoverWrap) hoverWrap.style.display = hoverButtonsTempHidden ? "none" : "flex";
  }
});

// @spec 02_詳細設計書.md#3-2
function updateInstantBtn() {
  const btn = hoverWrap?.querySelector("#__image-saver-instant-btn__");
  if (btn) btn.style.display = instantSaveEnabled ? "" : "none";
}

function getWrap() {
  // v1.46.5 GROUP-66：JS 参照が DOM detached（SPA 入替・page mutation）になっていれば作り直し
  if (hoverWrap && hoverWrap.isConnected) return hoverWrap;
  // 念押しの zombie 除去（id 重複の可能性に備える）
  try {
    document.querySelectorAll("#__image-saver-wrap__").forEach(el => el.remove());
  } catch (_) {}
  hoverWrap = null;

  const wrap = document.createElement("div");
  wrap.id = "__image-saver-wrap__";
  wrap.style.cssText = `
    position: fixed; z-index: 2147483647;
    display: flex; gap: 4px; align-items: center;
    pointer-events: auto;
  `;

  // 即保存ボタン
  const instantBtn = document.createElement("button");
  instantBtn.id = "__image-saver-instant-btn__";
  instantBtn.textContent = "⚡ 即保存";
  instantBtn.title = "保存ウィンドウを開かずに即時保存";
  instantBtn.style.cssText = btnStyle("rgba(20,140,80,.9)");
  instantBtn.style.display = instantSaveEnabled ? "" : "none";
  instantBtn.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  instantBtn.addEventListener("mouseleave", () => { startWatch(); scheduleHide(); });
  instantBtn.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!currentImg) return;
    const imageUrl = currentImg.src || currentImg.currentSrc;
    if (!imageUrl) return;
    instantBtn.textContent = "…";
    instantBtn.disabled = true;
    const res = await browser.runtime.sendMessage({
      type: "INSTANT_SAVE",
      imageUrl,
      pageUrl: location.href,
    }).catch(() => null);
    if (res?.success) {
      instantBtn.textContent = "✅";
      setTimeout(() => { instantBtn.textContent = "⚡ 即保存"; instantBtn.disabled = false; }, 1200);
    } else {
      instantBtn.textContent = "❌";
      setTimeout(() => { instantBtn.textContent = "⚡ 即保存"; instantBtn.disabled = false; }, 1500);
    }
  });

  // 通常保存ボタン（保存ウィンドウ起動）
  const saveBtn = document.createElement("button");
  saveBtn.id = "__image-saver-hover-btn__";
  saveBtn.textContent = "💾 保存";
  saveBtn.title = "ImageSaverWithTags で保存";
  saveBtn.style.cssText = btnStyle("rgba(30,30,30,.85)");
  saveBtn.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  saveBtn.addEventListener("mouseleave", () => { startWatch(); scheduleHide(); });
  saveBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!currentImg) return;
    const imageUrl = currentImg.src || currentImg.currentSrc;
    if (!imageUrl) return;
    browser.runtime.sendMessage({
      type:     "OPEN_MODAL_WINDOW",
      imageUrl: imageUrl,
      pageUrl:  location.href,
    });
    hideNow();
  });

  // GROUP-15-impl-A-phase1：動画 → GIF 変換ボタン（video 要素ホバー時のみ表示）
  const videoBtn = document.createElement("button");
  videoBtn.id = "__image-saver-video-btn__";
  videoBtn.textContent = "🎬 動画→GIF";
  videoBtn.title = "動画を GIF に変換して保存（Phase 1 MVP、直 mp4 URL のみ対応）";
  videoBtn.style.cssText = btnStyle("rgba(120,60,160,.9)");
  videoBtn.style.display = "none"; // 初期非表示、video ホバー時のみ show
  videoBtn.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  videoBtn.addEventListener("mouseleave", () => { startWatch(); scheduleHide(); });
  videoBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    if (!currentImg || currentImg.tagName !== "VIDEO") return;
    const videoUrl = currentImg.currentSrc || currentImg.src;
    if (!videoUrl) return;
    browser.runtime.sendMessage({
      type:        "OPEN_VIDEO_CONVERT",
      videoUrl:    videoUrl,
      pageUrl:     location.href,
      videoWidth:  currentImg.videoWidth || 0,
      videoHeight: currentImg.videoHeight || 0,
      duration:    Number.isFinite(currentImg.duration) ? currentImg.duration : 0,
    });
    hideNow();
  });

  wrap.appendChild(instantBtn);
  wrap.appendChild(saveBtn);
  wrap.appendChild(videoBtn);
  document.body.appendChild(wrap);
  hoverWrap = wrap;
  return wrap;
}

// GROUP-15-impl-A-phase1：video / img に応じてボタン表示を切替
function updateButtonVisibility() {
  if (!hoverWrap) return;
  const isVideo = currentImg && currentImg.tagName === "VIDEO";
  const instantBtn = hoverWrap.querySelector("#__image-saver-instant-btn__");
  const saveBtn = hoverWrap.querySelector("#__image-saver-hover-btn__");
  const videoBtn = hoverWrap.querySelector("#__image-saver-video-btn__");
  if (isVideo) {
    if (instantBtn) instantBtn.style.display = "none";
    if (saveBtn) saveBtn.style.display = "none";
    if (videoBtn) videoBtn.style.display = "";
  } else {
    if (instantBtn) instantBtn.style.display = instantSaveEnabled ? "" : "none";
    if (saveBtn) saveBtn.style.display = "";
    if (videoBtn) videoBtn.style.display = "none";
  }
}

function btnStyle(bg) {
  return `
    background: ${bg};
    color: #fff; border: 1px solid rgba(255,255,255,.3);
    border-radius: 6px; padding: 4px 8px;
    font-size: 12px; cursor: pointer; line-height: 1;
    box-shadow: 0 2px 8px rgba(0,0,0,.4);
    transition: opacity .15s; font-family: sans-serif;
    white-space: nowrap; user-select: none;
  `;
}

// @spec 02_詳細設計書.md#3-1
function showAt(img) {
  if (hoverButtonsTempHidden) return; // GROUP-2-a: 一時非表示中はホバーボタンを出さない
  const rect = img.getBoundingClientRect();
  const wrap = getWrap();
  currentImg = img;
  updateButtonVisibility(); // GROUP-15-impl-A-phase1：video / img でボタン切替
  const ww = 180, bh = 28;
  let left = rect.right - ww - 4;
  let top  = rect.top + 4;
  left = Math.max(4, Math.min(left, window.innerWidth  - ww - 4));
  top  = Math.max(4, Math.min(top,  window.innerHeight - bh - 4));
  wrap.style.left    = `${left}px`;
  wrap.style.top     = `${top}px`;
  wrap.style.opacity = "1";
  startWatch();
}

function startWatch() {
  stopWatch();
  watchTimer = setInterval(() => {
    if (!currentImg) { stopWatch(); return; }
    const rect = currentImg.getBoundingClientRect();
    const pad  = 8;
    const inImg = lastMouseX >= rect.left - pad && lastMouseX <= rect.right  + pad &&
                  lastMouseY >= rect.top  - pad && lastMouseY <= rect.bottom + pad;
    const wrap = hoverWrap;
    if (wrap) {
      const br = wrap.getBoundingClientRect();
      const inBtn = lastMouseX >= br.left && lastMouseX <= br.right &&
                    lastMouseY >= br.top  && lastMouseY <= br.bottom;
      if (!inImg && !inBtn) { scheduleHide(); stopWatch(); }
    } else if (!inImg) { scheduleHide(); stopWatch(); }
  }, 100);
}

function stopWatch() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideNow, DELAY_HIDE);
}

function hideNow() {
  clearTimeout(showTimer); clearTimeout(hideTimer); stopWatch();
  if (hoverWrap) hoverWrap.style.opacity = "0";
  currentImg = null;
}

function isValidImg(el) {
  // proxy オブジェクト（<a>越し検出）は tagName と getBoundingClientRect のみ保証
  if (el.tagName !== "IMG") return false;
  const src = el.src || el.currentSrc;
  if (!src || (src.startsWith("data:") && src.length < 200)) return false;
  const rect = el.getBoundingClientRect();
  return rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;
}

// GROUP-15-impl-A-phase1：video 要素が GIF 変換候補として有効か判定
function isValidVideo(el) {
  if (!el || el.tagName !== "VIDEO") return false;
  const src = el.currentSrc || el.src;
  if (!src) return false;
  const rect = el.getBoundingClientRect();
  return rect.width >= MIN_SIZE && rect.height >= MIN_SIZE;
}

let _initialMoveHandled = false;
document.addEventListener("mousemove", (e) => {
  lastMouseX = e.clientX; lastMouseY = e.clientY;
  // タブ切り替え・ページ遷移直後はカーソルが既に画像の上にあっても mouseover が発火しない。
  // 最初の mousemove 時にカーソル下の要素を確認し、mouseover をエミュレートして補完する。
  if (!_initialMoveHandled) {
    _initialMoveHandled = true;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el) el.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY })
    );
  }
}, { passive: true });

document.addEventListener("mouseover", (e) => {
  // GROUP-15-impl-A-phase1：video 要素を優先検知（img より先に）
  const video = e.target.closest("video");
  if (video && isValidVideo(video) && !e.target.closest("#__image-saver-wrap__")) {
    if (video === currentImg) { clearTimeout(hideTimer); return; }
    clearTimeout(hideTimer); clearTimeout(showTimer);
    showTimer = setTimeout(() => showAt(video), DELAY_SHOW);
    return;
  }

  // ① 通常ケース：<img> 要素に直接マウスが乗っている
  let img = e.target.closest("img");

  // ② フォールバック：透明な <a> 等のオーバーレイが <img> を覆っているケース
  //    ターゲットが <img> でなく、かつ自前のボタン要素でもない場合に座標検索
  if (!img && !e.target.closest("#__image-saver-wrap__")) {
    // オーバーレイ要素を一時的に pointer-events:none にして下の要素を取得
    const overlays = [];
    let el = e.target;
    while (el && el !== document.body) {
      if (el.tagName !== "IMG" && el !== document.body && el !== document.documentElement) {
        overlays.push({ el, pe: el.style.pointerEvents });
        el.style.pointerEvents = "none";
      }
      el = el.parentElement;
    }
    const found = document.elementFromPoint(e.clientX, e.clientY);
    // pointer-events を元に戻す
    for (const { el: oel, pe } of overlays) oel.style.pointerEvents = pe;

    if (found && found.tagName === "IMG") img = found;

    // ③ <img> も見つからないが <a> 内に画像を持つケース（X / bluesky 等）
    if (!img) {
      const anchor = e.target.closest("a[href]");
      if (anchor) {
        // 優先: <a> 内の実 <img> を採用（X photo ページ等：href は /photo/1 形式で画像URLでない）
        const innerImg = anchor.querySelector("img");
        if (innerImg && isValidImg(innerImg)) {
          img = innerImg;
        } else {
          // フォールバック: href が画像URL パターン（bluesky 等）→ 仮想 img プロキシ
          const href = anchor.href || "";
          if (/\.(jpe?g|png|gif|webp|avif|bmp)(\?|$)/i.test(href) ||
              /\/img\/feed_(fullsize|thumbnail)|\/images?\/|\/media\//i.test(href)) {
            const rect = anchor.getBoundingClientRect();
            if (rect.width >= MIN_SIZE && rect.height >= MIN_SIZE) {
              const proxy = {
                _isProxy: true,
                _imageUrl: href,
                tagName: "IMG",
                src: href,
                currentSrc: href,
                getBoundingClientRect: () => anchor.getBoundingClientRect(),
              };
              img = proxy;
            }
          }
        }
      }
    }

    // ④ v1.24.1 BUG-x-photo-2: ①②③ がすべて失敗した場合の最終フォールバック
    //    発動例：X の /status/.../photo/N 拡大ページは <a> ラッパーが撤廃され、
    //    <div aria-label="画像"> の子に「背景画像 <div>」と「実 <img>」が兄弟配置される
    //    blur-up パターンを採用しているため、従来③（<a> 経由）では捕捉できない。
    //    ①②③で捕まらない＝祖先に <a> も <img> も無い構造に限定されるため、
    //    誤爆リスクは小さい（通常ページの画像は <a> でラップされ③が先に捕まえる）。
    if (!img) {
      // ④a: aria-label の画像マーカー優先（X の日英ローカライズ両対応、将来の構造変更にも追従しやすい）
      const xPicContainer = e.target.closest('[aria-label="画像"], [aria-label="Image"]');
      if (xPicContainer) {
        const cand = xPicContainer.querySelector("img");
        if (cand && isValidImg(cand)) img = cand;
      }
      // ④b: 汎用 depth walk（5 階層まで祖先を遡り、子孫の有効 <img> を探す）
      if (!img) {
        let ancestor = e.target.parentElement;
        for (let depth = 0; ancestor && depth < 5; depth++, ancestor = ancestor.parentElement) {
          const cand = ancestor.querySelector("img");
          if (cand && isValidImg(cand)) { img = cand; break; }
        }
      }
    }
  }

  if (!img || !isValidImg(img)) return;
  if (img === currentImg) { clearTimeout(hideTimer); return; }
  clearTimeout(hideTimer); clearTimeout(showTimer);
  showTimer = setTimeout(() => showAt(img), DELAY_SHOW);
}, { passive: true });

document.addEventListener("mouseout", (e) => {
  const img = e.target.closest("img");
  if (!img || img !== currentImg) return;
  const to = e.relatedTarget;
  if (to && hoverWrap && (to === hoverWrap || hoverWrap.contains(to))) return;
}, { passive: true });

// v1.24.2 BUG-x-photo-2 真因対応: scroll 発火で即 hideNow すると、X の /photo/N
// 拡大モーダルが持つ内部スクロール可能コンテナ（data-testid="swipe-to-dismiss" 等）
// での連続 scroll イベントにより、showAt 直後に opacity=0 に戻されてしまい
// 「ボタンは作られているが常に透明」という状態になっていた。
// 対策：scroll 時は img 位置を再評価し、マウスがまだ img 上なら showAt で位置再計算
// のみ（opacity=1 維持）、マウスが img から離れていれば従来通り hideNow。
document.addEventListener("scroll", () => {
  if (!currentImg || !hoverWrap) return;
  const rect = currentImg.getBoundingClientRect();
  const pad  = 8;
  const inImg = lastMouseX >= rect.left - pad && lastMouseX <= rect.right  + pad &&
                lastMouseY >= rect.top  - pad && lastMouseY <= rect.bottom + pad;
  if (inImg) {
    showAt(currentImg); // img がまだマウス下なら位置のみ再計算（スクロール追従）
  } else {
    hideNow();          // img から外れていれば従来通り hide
  }
}, { passive: true, capture: true });
window.addEventListener("resize", hideNow, { passive: true });
