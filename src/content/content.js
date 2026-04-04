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

let currentImg   = null;
let hoverWrap    = null; // ボタン群を包むラッパー
let showTimer    = null;
let hideTimer    = null;
let watchTimer   = null;
let lastMouseX   = 0;
let lastMouseY   = 0;

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

function updateInstantBtn() {
  const btn = hoverWrap?.querySelector("#__image-saver-instant-btn__");
  if (btn) btn.style.display = instantSaveEnabled ? "" : "none";
}

function getWrap() {
  if (hoverWrap) return hoverWrap;

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

  wrap.appendChild(instantBtn);
  wrap.appendChild(saveBtn);
  document.body.appendChild(wrap);
  hoverWrap = wrap;
  return wrap;
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

function showAt(img) {
  const rect = img.getBoundingClientRect();
  const wrap = getWrap();
  currentImg = img;
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

    // ③ <img> も見つからないが <a href> が画像URLを持つケース（bluesky等）
    //    → <a> の href を src 代わりに使う仮想 img オブジェクトで対応
    if (!img) {
      const anchor = e.target.closest("a[href]");
      if (anchor) {
        const href = anchor.href || "";
        // 画像拡張子または画像CDNパターンを持つURLのみ対象
        if (/\.(jpe?g|png|gif|webp|avif|bmp)(\?|$)/i.test(href) ||
            /\/img\/feed_(fullsize|thumbnail)|\/images?\/|\/media\//i.test(href)) {
          // <a> の占有領域が MIN_SIZE 以上かチェック
          const rect = anchor.getBoundingClientRect();
          if (rect.width >= MIN_SIZE && rect.height >= MIN_SIZE) {
            // <a> を疑似的に img として扱うプロキシオブジェクト
            const proxy = {
              _isProxy: true,
              _imageUrl: href,
              tagName: "IMG",
              src: href,
              currentSrc: href,
              getBoundingClientRect: () => anchor.getBoundingClientRect(),
            };
            // showAt・isValidImg が proxy を受け取れるよう img に代入
            img = proxy;
          }
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

document.addEventListener("scroll", hideNow, { passive: true, capture: true });
window.addEventListener("resize",   hideNow, { passive: true });
