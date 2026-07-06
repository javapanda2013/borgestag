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
  // GROUP-33-T1 (v1.46.51)：録画上限秒の設定変更を追従（CAPTURE_MAX_SEC は let、下部で定義）
  if ("videoMaxRecSec" in changes) _applyMaxRecSec(changes.videoMaxRecSec.newValue);
});

// GROUP-33-T1 (v1.46.51)：録画上限秒は設定画面「動画」タブで可変（既定 20・最小 1・上限なし）。
// content / 変換ウィンドウ / 設定画面 の 3 文脈は storage.local キー videoMaxRecSec で共有する。
function _applyMaxRecSec(v) {
  const n = parseFloat(v);
  if (Number.isFinite(n) && n >= 1) CAPTURE_MAX_SEC = n;
}
browser.storage.local.get("videoMaxRecSec").then(r => _applyMaxRecSec(r.videoMaxRecSec));

// GROUP-84 (v1.46.21)：即保存ボタンの連続押下対応 + 件数表示
// disabled 化を廃し、進行中の保存数をカウンタ表示。背後の handleInstantSave は
// v1.46.11 GROUP-69 の _saveStorageMutex で storage R-M-W が直列化されており、
// Native I/O は並列実行可能なため UI 側の阻害だけが連続押下を不可にしていた。
let _instantSavePending = 0;
let _instantSaveFlashTimer = null;
function _updateInstantBtnLabel(btn) {
  if (!btn) return;
  const n = _instantSavePending;
  btn.textContent = n <= 0 ? "⚡ 即保存" : `⚡ 即保存 (${n})`;
}

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

// @spec 設計書類/画面別/11_コンテキストメニュー_詳細.md
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
    // GROUP-84 (v1.46.21)：disabled 化せず連続押下対応。pending を増分しラベル更新。
    // flash 表示中は label 更新を保留（flash 終了 setTimeout が最終 count を反映する）。
    _instantSavePending++;
    if (_instantSaveFlashTimer === null) {
      _updateInstantBtnLabel(instantBtn);
    }
    const res = await browser.runtime.sendMessage({
      type: "INSTANT_SAVE",
      imageUrl,
      pageUrl: location.href,
    }).catch(() => null);
    _instantSavePending--;
    // 既存 flash があれば clear、最後の完了の結果で上書き
    if (_instantSaveFlashTimer !== null) clearTimeout(_instantSaveFlashTimer);
    instantBtn.textContent = res?.success ? "✅" : "❌";
    const flashMs = res?.success ? 1200 : 1500;
    _instantSaveFlashTimer = setTimeout(() => {
      _instantSaveFlashTimer = null;
      _updateInstantBtnLabel(instantBtn);
    }, flashMs);
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

  // GROUP-15 scope2 (v1.46.49)：動画/Canvas 用は「⏱ 時間指定録画」「✂ 切り抜き開始」の 2 ボタン。
  // 取得経路の組合せ（机上検証済み）：
  //   時間指定録画 → 尺取得 → パネルで「全取得／範囲指定」を選択
  //     全取得：video×http=従来経路 ／ video×blob=原データ fetch（不能時は先頭から自動録画へ退避）
  //             ／ canvas×pixiv=うごイラ解析 ／ canvas×他=非表示
  //     範囲指定：video=開始秒へシークして自動録画 ／ canvas=「これから N 秒」
  //   切り抜き開始 → その場で録画開始（録画中は「⏹ ここまで確定」＋「✕ 中止」）
  const timedBtn = document.createElement("button");
  timedBtn.id = "__image-saver-timed-btn__";
  timedBtn.textContent = TIMED_LABEL;
  timedBtn.title = "動画の尺を確認して「全取得」か「範囲指定」で GIF 変換";
  timedBtn.style.cssText = btnStyle("rgba(120,60,160,.9)");
  timedBtn.style.display = "none";
  timedBtn.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  timedBtn.addEventListener("mouseleave", () => { startWatch(); scheduleHide(); });
  timedBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = currentImg;
    if (!el || _captureActive) return;
    if (el.tagName !== "VIDEO" && el.tagName !== "CANVAS") return;
    _openRangePanel(el);
  });

  const clipBtn = document.createElement("button");
  clipBtn.id = "__image-saver-video-btn__"; // 旧 🎬 ボタンの id を継承（録画系の本体）
  clipBtn.textContent = CLIP_LABEL;
  clipBtn.title = "いま再生中の位置からページ内録画（録画中にもう一度押すと、そこまでで確定）";
  clipBtn.style.cssText = btnStyle("rgba(160,90,30,.9)");
  clipBtn.style.display = "none";
  clipBtn.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  clipBtn.addEventListener("mouseleave", () => { startWatch(); scheduleHide(); });
  clipBtn.addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    if (_recCtl) { _recCtl.stop(); return; } // 録画中＝ここまでで確定
    const el = currentImg;
    if (!el || (el.tagName !== "VIDEO" && el.tagName !== "CANVAS")) return;
    _closeRangePanel();
    await captureAndSend(el, clipBtn);
  });

  const cancelBtn = document.createElement("button");
  cancelBtn.id = "__image-saver-cancel-btn__";
  cancelBtn.textContent = "✕ 中止";
  cancelBtn.title = "録画を中止して破棄";
  cancelBtn.style.cssText = btnStyle("rgba(170,40,40,.9)");
  cancelBtn.style.display = "none"; // 録画中のみ表示
  cancelBtn.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  cancelBtn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    if (_recCtl) _recCtl.cancel();
  });

  // ⏱ 時間指定録画の選択パネル（ボタン列の直下に表示）
  const panel = document.createElement("div");
  panel.id = "__image-saver-range-panel__";
  panel.style.cssText = `
    position: absolute; top: calc(100% + 4px); left: 0;
    display: none; flex-direction: column; gap: 6px;
    background: rgba(25,25,25,.95); color: #fff;
    border: 1px solid rgba(255,255,255,.3); border-radius: 8px;
    padding: 8px 10px; font-size: 12px; font-family: sans-serif;
    box-shadow: 0 2px 10px rgba(0,0,0,.5); white-space: nowrap; z-index: 2147483647;
  `;
  panel.innerHTML = `
    <div id="__is-range-dur__">尺: -</div>
    <button id="__is-range-full__" type="button" style="${btnStyle("rgba(120,60,160,.9)")}">🎬 全取得</button>
    <div style="display:flex; gap:4px; align-items:center;">
      <input id="__is-range-start__" type="number" min="0" step="0.1" value="0"
             style="width:56px; padding:2px 4px; border-radius:4px; border:1px solid #888; background:#222; color:#fff;">
      <span>〜</span>
      <input id="__is-range-end__" type="number" min="0" step="0.1" value="10"
             style="width:56px; padding:2px 4px; border-radius:4px; border:1px solid #888; background:#222; color:#fff;">
      <span>秒</span>
      <button id="__is-range-go__" type="button" style="${btnStyle("rgba(160,90,30,.9)")}">範囲で取得</button>
    </div>
    <button id="__is-range-close__" type="button" style="${btnStyle("rgba(80,80,80,.9)")}">閉じる</button>
  `;
  panel.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  panel.addEventListener("mouseleave", () => { startWatch(); scheduleHide(); });
  panel.querySelector("#__is-range-close__").addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    _closeRangePanel();
  });
  panel.querySelector("#__is-range-full__").addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = _panelOpenFor;
    _closeRangePanel();
    if (el) await executeFullCapture(el, timedBtn);
  });
  panel.querySelector("#__is-range-go__").addEventListener("click", async (e) => {
    e.preventDefault(); e.stopPropagation();
    const el = _panelOpenFor;
    if (!el) return;
    const durEl = panel.querySelector("#__is-range-dur__");
    const isUgoira = el.tagName === "CANVAS" && _ugoiraReady();
    const startEnabled = !panel.querySelector("#__is-range-start__").disabled;
    const s = startEnabled ? (parseFloat(panel.querySelector("#__is-range-start__").value) || 0) : 0;
    let en = parseFloat(panel.querySelector("#__is-range-end__").value) || 0;
    if (en <= s) { durEl.textContent = "⚠ 終了は開始より後にしてください"; return; }
    // うごイラ解析はコマの切り出し（録画でない）ため録画上限を適用しない
    if (!isUgoira && en - s > CAPTURE_MAX_SEC) {
      en = s + CAPTURE_MAX_SEC;
      panel.querySelector("#__is-range-end__").value = String(en);
      durEl.textContent = `⚠ 上限 ${CAPTURE_MAX_SEC} 秒で打ち切ります`;
    }
    _closeRangePanel();
    if (isUgoira) {
      await fetchUgoiraAndSend(timedBtn, { start: s, end: en });
    } else {
      await autoRecordRange(el, clipBtn, s, en);
    }
  });

  wrap.appendChild(instantBtn);
  wrap.appendChild(saveBtn);
  wrap.appendChild(timedBtn);
  wrap.appendChild(clipBtn);
  wrap.appendChild(cancelBtn);
  wrap.appendChild(panel);
  document.body.appendChild(wrap);
  hoverWrap = wrap;
  return wrap;
}

// GROUP-15-impl-A-phase1：video / img に応じてボタン表示を切替
function updateButtonVisibility() {
  if (!hoverWrap) return;
  if (_captureActive) return; // 録画中は録画処理側が表示を管理（確定/中止を消さない）
  // GROUP-15 scope2 (v1.46.49)：組合せ＝img=⚡💾 ／ video・canvas=⏱＋✂（机上検証済み、img 系経路は不変）
  const isMedia = currentImg && (currentImg.tagName === "VIDEO" || currentImg.tagName === "CANVAS");
  const instantBtn = hoverWrap.querySelector("#__image-saver-instant-btn__");
  const saveBtn = hoverWrap.querySelector("#__image-saver-hover-btn__");
  const timedBtn = hoverWrap.querySelector("#__image-saver-timed-btn__");
  const clipBtn = hoverWrap.querySelector("#__image-saver-video-btn__");
  const cancelBtn = hoverWrap.querySelector("#__image-saver-cancel-btn__");
  if (cancelBtn) cancelBtn.style.display = "none";
  if (isMedia) {
    if (instantBtn) instantBtn.style.display = "none";
    if (saveBtn) saveBtn.style.display = "none";
    if (timedBtn) timedBtn.style.display = "";
    if (clipBtn) clipBtn.style.display = "";
  } else {
    if (instantBtn) instantBtn.style.display = instantSaveEnabled ? "" : "none";
    if (saveBtn) saveBtn.style.display = "";
    if (timedBtn) timedBtn.style.display = "none";
    if (clipBtn) clipBtn.style.display = "none";
    _closeRangePanel();
  }
}

function btnStyle(bg) {
  // GROUP-104 (v1.46.44)：即保存ボタンの完了表示（✅/❌ 1 文字）でボタン幅が縮小し、
  // 隣接ボタンが左へズレて連続押下時に誤押下が起きるため、min-width で幅の下限を固定する。
  // 72px ≒「⚡ 即保存」表示時の幅（button は border-box、padding/border 込み）
  return `
    background: ${bg};
    color: #fff; border: 1px solid rgba(255,255,255,.3);
    border-radius: 6px; padding: 4px 8px;
    font-size: 12px; cursor: pointer; line-height: 1;
    min-width: 72px; box-sizing: border-box; text-align: center;
    box-shadow: 0 2px 8px rgba(0,0,0,.4);
    transition: opacity .15s; font-family: sans-serif;
    white-space: nowrap; user-select: none;
  `;
}

// @spec 設計書類/画面別/11_コンテキストメニュー_詳細.md
function showAt(img) {
  if (hoverButtonsTempHidden) return; // GROUP-2-a: 一時非表示中はホバーボタンを出さない
  const rect = img.getBoundingClientRect();
  const wrap = getWrap();
  currentImg = img;
  updateButtonVisibility(); // GROUP-15-impl-A-phase1：video / img でボタン切替
  // GROUP-33-T1 (v1.46.51)：ボタン群の幅は内容で変わる（動画/Canvas は「⏱ 時間指定録画」
  // 「✂ 切り抜き開始」等で 180px を超える）。固定 180 でなく wrap の実幅でクランプして
  // 画面右端のはみ出しを防ぐ（offsetWidth は opacity:0 でも display:flex なら実幅を返す）
  const bh = 28;
  const ww = wrap.offsetWidth || 180;
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
  // GROUP-15 scope2 (v1.46.49)：録画中・範囲パネル表示中はボタン群を消さない
  if (_captureActive || _panelOpenFor) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideNow, DELAY_HIDE);
}

function hideNow() {
  if (_captureActive) return; // 録画中は「⏹ 確定」「✕ 中止」を残す
  clearTimeout(showTimer); clearTimeout(hideTimer); stopWatch();
  if (hoverWrap) hoverWrap.style.opacity = "0";
  _closeRangePanel();
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

// GROUP-15 範囲拡大 (v1.46.46)：canvas 要素が録画候補として有効か判定。
// アイコン・装飾用の小さい canvas を除外するため video より大きい閾値を使う
const MIN_CANVAS_SIZE = 100;
function isValidCanvas(el) {
  if (!el || el.tagName !== "CANVAS") return false;
  const rect = el.getBoundingClientRect();
  return rect.width >= MIN_CANVAS_SIZE && rect.height >= MIN_CANVAS_SIZE;
}

// ----------------------------------------------------------------
// GROUP-15 範囲拡大 (v1.46.46)：blob:/MSE 動画・Canvas のページ内録画
// blob: URL はページ文脈限定で変換ウィンドウ（拡張ページ）からロードできないため、
// captureStream + MediaRecorder でページ内録画し、webm を background 経由で渡す。
// 制約：許可なし cross-origin 素材は captureStream が SecurityError（→ボタンで明示）。
// 録画は実時間進行（再生中の内容を記録）。録画データは storage.local に載せない
// （broadcast 地雷、GROUP-35 教訓）＝ background のメモリ経由で受け渡す。
// ----------------------------------------------------------------
let CAPTURE_MAX_SEC = 20; // GROUP-33-T1：設定画面「動画」タブの videoMaxRecSec で上書き（既定 20）
const WARN_REC_SEC = 30; // GROUP-33-T1：これを超える録画は開始前にサイズ警告（上限自由化に伴う安全弁）
// 概算 GIF サイズ（10fps / 480px の粗い目安：約 0.26 MB/秒）。録画開始前の確認ダイアログ用。
function _confirmLongRecording(sec) {
  const mb = (0.26 * sec).toFixed(1);
  return window.confirm(
    "約 " + Math.round(sec) + " 秒の録画になります（GIF 概算 約 " + mb + " MB）。\n" +
    "長尺ほど GIF のサイズが大きくなります。このまま録画を開始しますか？"
  );
}
const TIMED_LABEL = "⏱ 時間指定録画";
const CLIP_LABEL  = "✂ 切り抜き開始";
let _captureActive = false;
let _recCtl = null;       // 録画中の操作（stop=確定 / cancel=破棄）
let _panelOpenFor = null; // 範囲パネルの対象要素

function _flashBtn(btn, text, resetLabel) {
  btn.textContent = text;
  setTimeout(() => { btn.textContent = resetLabel; }, 2500);
}

function _flashVideoBtn(btn, text) {
  _flashBtn(btn, text, CLIP_LABEL);
}

// ---- 範囲パネル（⏱ 時間指定録画） ----
function _openRangePanel(el) {
  const panel = hoverWrap && hoverWrap.querySelector("#__image-saver-range-panel__");
  if (!panel) return;
  const isVideo = el.tagName === "VIDEO";
  const dur = isVideo && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
  const startIn = panel.querySelector("#__is-range-start__");
  const endIn = panel.querySelector("#__is-range-end__");
  if (isVideo) {
    panel.querySelector("#__is-range-dur__").textContent =
      dur ? `動画の尺: ${dur.toFixed(1)} 秒` : "動画の尺: 不明（配信形式）";
    startIn.disabled = false;
  } else if (_pixivIllustId()) {
    // pixiv canvas＝うごイラ：解析メタから正確な尺・コマ数を表示（user 指摘反映）
    panel.querySelector("#__is-range-dur__").textContent = "うごイラの尺を取得中…";
    startIn.disabled = false;
    _loadUgoiraMetaForPanel(panel);
  } else {
    panel.querySelector("#__is-range-dur__").textContent =
      "canvas：尺の取得手段なし。「これから N 秒」で指定";
    startIn.disabled = true;
  }
  startIn.value = "0";
  endIn.value = String(Math.min(dur || 10, CAPTURE_MAX_SEC));
  const fullB = panel.querySelector("#__is-range-full__");
  const fullable = isVideo ? !!(el.currentSrc || el.src) : !!_pixivIllustId();
  fullB.style.display = fullable ? "" : "none";
  panel.style.display = "flex";
  _panelOpenFor = el;
}

function _closeRangePanel() {
  const panel = hoverWrap && hoverWrap.querySelector("#__image-saver-range-panel__");
  if (panel) panel.style.display = "none";
  _panelOpenFor = null;
}

// ---- 全取得（素材別に最適経路へ振り分け） ----
async function executeFullCapture(el, btn) {
  if (el.tagName === "VIDEO") {
    const url = el.currentSrc || el.src;
    if (/^https?:/i.test(url)) {
      // 直 URL：従来経路（変換ウィンドウが URL を直接ロード、不変）
      browser.runtime.sendMessage({
        type: "OPEN_VIDEO_CONVERT", videoUrl: url, pageUrl: location.href,
        videoWidth: el.videoWidth || 0, videoHeight: el.videoHeight || 0,
        duration: Number.isFinite(el.duration) ? el.duration : 0,
      });
      hideNow();
      return;
    }
    // blob:：原データ fetch を試行、取得不能（MSE 等）なら先頭から自動録画へ退避（仕様）
    const ok = await fetchBlobAndSend(el, btn);
    if (!ok) {
      const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : CAPTURE_MAX_SEC;
      await autoRecordRange(el, btn, 0, Math.min(dur, CAPTURE_MAX_SEC));
    }
    return;
  }
  if (el.tagName === "CANVAS") {
    if (_pixivIllustId()) {
      await fetchUgoiraAndSend(btn);
    } else {
      _flashBtn(btn, "🚫 この canvas は全取得非対応", TIMED_LABEL);
    }
  }
}

// ---- 範囲指定：開始秒へシークして自動録画（canvas は「これから N 秒」） ----
async function autoRecordRange(el, btn, startSec, endSec) {
  if (_captureActive) return;
  let synced = false;
  if (el.tagName === "VIDEO") {
    try {
      // GROUP-15（録画開始オフセット対策）：録画準備（captureStream・MediaRecorder・確認ダイアログ）
      // の間に再生が進むと開始がズレるため、一旦停止してからシーク。再生再開は captureAndSend が
      // recorder.start() の直後に行い、録画開始を currentTime=startSec にピン留めする。
      el.pause();
      el.currentTime = Math.max(0, startSec);
      await new Promise((res) => {
        const onSeek = () => { el.removeEventListener("seeked", onSeek); res(); };
        el.addEventListener("seeked", onSeek);
        setTimeout(() => { el.removeEventListener("seeked", onSeek); res(); }, 3000);
      });
      synced = true;
    } catch (_) { /* シーク不能でも現在位置から録画する */ }
  }
  const clipBtn = (hoverWrap && hoverWrap.querySelector("#__image-saver-video-btn__")) || btn;
  await captureAndSend(el, clipBtn, Math.max(0.5, endSec - startSec),
    synced ? { startSec: Math.max(0, startSec), endSec } : null);
}

// ---- blob: 動画の原データ取得（成功で true。MSE 等の object URL は fetch 不可→false） ----
async function fetchBlobAndSend(el, btn) {
  const url = el.currentSrc || el.src;
  const prevLabel = btn.textContent;
  btn.textContent = "⏳ 取得中…";
  let buf = null;
  let type = "";
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    type = blob.type || "video/mp4";
    if (!blob.size) throw new Error("empty blob");
    buf = await blob.arrayBuffer();
  } catch (err) {
    console.warn("[BorgesTag] blob fetch failed（MSE 等は仕様上 fetch 不可）:", err && err.name);
    btn.textContent = prevLabel;
    return false;
  }
  await browser.runtime.sendMessage({
    type: "OPEN_VIDEO_CONVERT_CAPTURED",
    buffer: buf, mime: type,
    pageUrl: location.href,
    videoWidth: el.videoWidth || 0, videoHeight: el.videoHeight || 0,
    duration: Number.isFinite(el.duration) ? el.duration : 0,
    sourceKind: "blob-file",
  }).catch(() => null);
  buf = null; // 巨大 payload null 代入（送信完了直後、GROUP-82 規約）
  btn.textContent = prevLabel;
  hideNow();
  return true;
}

// ---- pixiv うごイラ解析（メタ＋フレーム ZIP をページ文脈で取得し変換ウィンドウへ） ----
function _pixivIllustId() {
  if (!/(^|\.)pixiv\.net$/.test(location.hostname)) return null;
  const m = location.pathname.match(/artworks\/(\d+)/);
  return m ? m[1] : null;
}

let _ugoiraMeta = null; // {id, frames, frameMime, zipUrl} のキャッシュ（パネル表示と取得で共用）

// GROUP-15-bug-ugoira-meta（v1.47.1）：ページコンテキスト fetch。
// 真因＝コンテンツスクリプトの相対 fetch（/ajax/...）はページ基準で解決されず失敗し、
// ZIP（別オリジン i.pximg.net）は Referer 必須。ページの window.fetch で取得すれば
// Referer も自然に付き、manifest の権限変更も不要。
// 方式＝script 要素を注入してページ側で fetch し、結果を window.postMessage で受領
// （ArrayBuffer は transfer で移譲）。ページ CSP 等で注入が動かない場合は
// コンテンツスクリプトの絶対 URL fetch に退避（メタは通る見込み・ZIP は Referer 不足の
// 403 リスクが残る。最終的に失敗した場合：パネルの尺表示は「これから N 秒」録画の案内へ、
// 全取得は 🚫 表示で ✂ 切り抜き（手動録画）への誘導となる＝呼出元の既存 catch どおり）。
// timeout はメタ（軽量・パネル表示の即時性が必要）と ZIP（大容量）で使い分ける。
function _pageFetch(url, kind /* "json" | "buffer" */, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const reqId = "borgestag-pgf-" + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => { cleanup(); reject(new Error("page fetch timeout")); }, timeoutMs);
    function cleanup() { clearTimeout(timer); window.removeEventListener("message", onMsg); }
    function onMsg(ev) {
      if (ev.source !== window || !ev.data || ev.data.__borgestagPgf !== reqId) return;
      cleanup();
      if (ev.data.ok) resolve(kind === "json" ? ev.data.json : ev.data.buffer);
      else reject(new Error(ev.data.error || "page fetch failed"));
    }
    window.addEventListener("message", onMsg);
    const script = document.createElement("script");
    script.textContent = `(async () => {
      const _rid = ${JSON.stringify(reqId)};
      try {
        const r = await fetch(${JSON.stringify(url)}, { credentials: "same-origin" });
        if (!r.ok) throw new Error("http " + r.status);
        if (${JSON.stringify(kind)} === "json") {
          const j = await r.json();
          window.postMessage({ __borgestagPgf: _rid, ok: true, json: j }, "*");
        } else {
          const b = await r.arrayBuffer();
          window.postMessage({ __borgestagPgf: _rid, ok: true, buffer: b }, "*", [b]);
        }
      } catch (e) {
        window.postMessage({ __borgestagPgf: _rid, ok: false, error: String(e && e.message || e) }, "*");
      }
    })();`;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  });
}

async function _fetchUgoiraMeta() {
  const id = _pixivIllustId();
  if (!id) throw new Error("no illust id");
  if (_ugoiraMeta && _ugoiraMeta.id === id) return _ugoiraMeta;
  // 絶対 URL 化（相対 URL がページ基準で解決されない content script 特有問題の回避）
  const metaUrl = new URL(`/ajax/illust/${id}/ugoira_meta`, location.origin).href;
  let meta;
  try {
    // 本命：ページコンテキスト fetch。メタは軽量なので 8 秒で見切り
    // （CSP 等で注入が無応答の環境でパネル表示を長時間待たせない）
    meta = await _pageFetch(metaUrl, "json", 8000);
  } catch (_) {
    // 退避：コンテンツスクリプトの絶対 URL fetch（注入がページ CSP 等で動かない環境向け）
    const res = await fetch(metaUrl, { credentials: "same-origin" });
    if (!res.ok) throw new Error("meta http " + res.status);
    meta = await res.json();
  }
  if (!meta || meta.error || !meta.body || !Array.isArray(meta.body.frames)) {
    throw new Error("ugoira meta error");
  }
  _ugoiraMeta = {
    id,
    frames: meta.body.frames, // [{file, delay(ms)}]
    frameMime: meta.body.mime_type || "image/jpeg",
    zipUrl: meta.body.originalSrc || meta.body.src,
  };
  return _ugoiraMeta;
}

// user 指摘（2026-06-13）反映：pixiv canvas は解析メタで正確な尺・コマ数を表示し、
// 範囲指定はコマ単位の正確な切り出し（録画なし）にする
async function _loadUgoiraMetaForPanel(panel) {
  const durEl = panel.querySelector("#__is-range-dur__");
  const startIn = panel.querySelector("#__is-range-start__");
  const endIn = panel.querySelector("#__is-range-end__");
  try {
    const meta = await _fetchUgoiraMeta();
    const total = meta.frames.reduce((s, f) => s + (f.delay || 0), 0) / 1000;
    durEl.textContent = `うごイラ：尺 ${total.toFixed(1)} 秒・${meta.frames.length} コマ（範囲はコマ単位で正確に切り出し）`;
    startIn.disabled = false;
    startIn.value = "0";
    endIn.value = total.toFixed(1);
  } catch (_err) {
    durEl.textContent = "canvas：尺の取得に失敗（「これから N 秒」の録画になります）";
  }
}

function _ugoiraReady() {
  const id = _pixivIllustId();
  return !!(id && _ugoiraMeta && _ugoiraMeta.id === id);
}

async function fetchUgoiraAndSend(btn, range) {
  const prevLabel = btn.textContent;
  btn.textContent = "⏳ 取得中…";
  try {
    const meta = await _fetchUgoiraMeta();
    // range 指定時：累積 delay で該当時間帯に重なるコマだけを送る（正確な切り出し）
    let frames = meta.frames;
    if (range) {
      const sMs = range.start * 1000;
      const eMs = range.end * 1000;
      let tMs = 0;
      frames = meta.frames.filter((f) => {
        const fs = tMs;
        tMs += (f.delay || 0);
        return fs < eMs && tMs > sMs;
      });
      if (!frames.length) frames = meta.frames.slice(0, 1);
    }
    // GROUP-15-bug-ugoira-meta：ZIP は別オリジン i.pximg.net で Referer 必須のため
    // ページコンテキスト fetch を本命に、失敗時のみ従来 fetch へ退避
    let zipBuf;
    try {
      zipBuf = await _pageFetch(meta.zipUrl, "buffer");
    } catch (_) {
      const zipRes = await fetch(meta.zipUrl);
      if (!zipRes.ok) throw new Error("zip http " + zipRes.status);
      zipBuf = await zipRes.arrayBuffer();
    }
    await browser.runtime.sendMessage({
      type: "OPEN_VIDEO_CONVERT_CAPTURED",
      buffer: zipBuf, mime: "application/x-ugoira-zip",
      frames,
      frameMime: meta.frameMime,
      pageUrl: location.href,
      videoWidth: 0, videoHeight: 0,
      duration: frames.reduce((s, f) => s + (f.delay || 0), 0) / 1000,
      sourceKind: "ugoira",
    }).catch(() => null);
    zipBuf = null; // 巨大 payload null 代入（送信完了直後、GROUP-82 規約）
  } catch (err) {
    console.warn("[BorgesTag] ugoira fetch failed:", err);
    _flashBtn(btn, "🚫 全取得不可（✂ 切り抜きをご利用ください）", TIMED_LABEL);
    return;
  }
  btn.textContent = prevLabel;
  hideNow();
}

function _releaseStream(stream) {
  // captureStream の track 停止は元の動画再生には影響しない（capture 側のみ解放）
  try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
}

async function captureAndSend(el, btn, fixedSec, syncOpts) {
  if (_captureActive) return;
  const isVideo = el.tagName === "VIDEO";
  // GROUP-15：全取得/範囲指定（syncOpts あり）は録画開始を動画位置に同期し、1 周の境界で停止する
  const sync = !!(isVideo && syncOpts);
  let stream = null;
  try {
    // sync 時は準備中に再生を進めない（開始オフセット 0）。録画開始後に play する
    if (isVideo && el.paused && !sync) {
      try { await el.play(); } catch (_) { /* 自動再生拒否でも録画自体は試行 */ }
    }
    stream = el.captureStream();
  } catch (_err) {
    _flashVideoBtn(btn, "🚫 取得不可（保護コンテンツ）");
    return;
  }
  // v1.46.48 GROUP-15 hotfix：audio track の有無で録画形式を選択。
  // YouTube 等の audio 入り stream を映像コーデックのみの指定で start すると
  // 「An audio track cannot be recorded」DOMException（実機ログで確定した真因）
  const hasAudio = stream.getAudioTracks().length > 0;
  const mimeCands = hasAudio
    ? ['video/webm;codecs="vp8,opus"', "video/webm"]
    : ['video/webm;codecs="vp8"', "video/webm"];
  const mime = mimeCands.find((m) => MediaRecorder.isTypeSupported(m)) || "";
  let recorder = null;
  try {
    recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (_err) {
    _releaseStream(stream);
    _flashVideoBtn(btn, "🚫 録画不可（環境非対応）");
    return;
  }
  _captureActive = true;
  let discard = false; // ✕ 中止（破棄）
  const chunks = [];
  recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  const baseLimit = isVideo && Number.isFinite(el.duration) && el.duration > 0
    ? Math.min(el.duration, CAPTURE_MAX_SEC) : CAPTURE_MAX_SEC;
  // scope2 (v1.46.49)：範囲指定（時間指定録画）からの呼出しは fixedSec が優先（上限内に clamp）
  const secLimit = fixedSec ? Math.min(fixedSec, CAPTURE_MAX_SEC) : baseLimit;
  // GROUP-33-T1 (v1.46.51)：上限自由化に伴い、長尺録画は開始前にサイズ警告（中止なら録画しない）
  if (secLimit > WARN_REC_SEC && !_confirmLongRecording(secLimit)) {
    _releaseStream(stream);
    _captureActive = false;
    _recCtl = null;
    if (sync) { try { el.play(); } catch (_) {} } // 確認キャンセル時は一時停止した動画を再生へ戻す
    updateButtonVisibility();
    return;
  }
  // v1.46.48 hotfix：終了待ちを onstop 1 本に依存させない三重ガード。
  // onstop／onerror／watchdog（上限+5 秒）のどれでも必ず解け、finally で
  // カウンタ・timer・track を確実に解放する（「録画中」無限進行の構造的防止）
  let settle = null;
  const done = new Promise((resolve) => { settle = resolve; });
  recorder.onstop = () => settle("stop");
  recorder.onerror = (ev) => {
    console.warn("[BorgesTag] capture onerror:", ev.error ? ev.error.name : ev);
    settle("error");
  };
  const watchdog = setTimeout(() => settle("watchdog"), (secLimit + 5) * 1000);
  const requestStop = () => { try { if (recorder.state !== "inactive") recorder.stop(); } catch (_) {} };
  if (isVideo) el.addEventListener("ended", requestStop, { once: true });
  // scope2 (v1.46.49)：録画中の操作（切り抜きボタン再押下=確定／中止ボタン=破棄）
  _recCtl = {
    stop: requestStop,
    cancel: () => { discard = true; requestStop(); },
  };
  const timedBtnEl = hoverWrap && hoverWrap.querySelector("#__image-saver-timed-btn__");
  const cancelBtnEl = hoverWrap && hoverWrap.querySelector("#__image-saver-cancel-btn__");
  if (timedBtnEl) timedBtnEl.style.display = "none";
  if (cancelBtnEl) cancelBtnEl.style.display = "";
  let elapsed = 0;
  const startSec = sync ? (syncOpts.startSec || 0) : 0;
  let maxT = startSec; // 実録画尺の算出用（到達した最大 currentTime）
  const tick = setInterval(() => {
    if (sync) {
      const t = el.currentTime;
      if (t > maxT) maxT = t;
      elapsed = Math.max(0, Math.round(t - startSec));
    } else {
      elapsed++;
    }
    btn.textContent = `⏹ ここまで確定 ${elapsed}/${Math.round(secLimit)}s`;
  }, 1000);
  // GROUP-15：sync 時は currentTime を監視し、1 周到達 or 巻き戻り（ループ境界）で即停止
  let monitor = null;
  if (sync) {
    let lastT = startSec;
    monitor = setInterval(() => {
      const t = el.currentTime;
      if (t > maxT) maxT = t;
      if (t >= syncOpts.endSec - 0.05 || t < lastT - 0.3) requestStop();
      lastT = t;
    }, 100);
  }
  let stopTimer = null;
  try {
    recorder.start(1000);
    btn.textContent = `⏹ ここまで確定 0/${Math.round(secLimit)}s`;
    // sync 時は録画開始の直後に再生＝開始オフセット 0。停止は monitor（境界）が主、timer は保険
    if (sync) { try { await el.play(); } catch (_) {} }
    stopTimer = setTimeout(requestStop, (secLimit + 1) * 1000);
    await done;
  } catch (err) {
    console.warn("[BorgesTag] capture start failed:", err && err.name, err && err.message);
  } finally {
    clearInterval(tick);
    if (monitor) clearInterval(monitor);
    clearTimeout(watchdog);
    if (stopTimer) clearTimeout(stopTimer);
    if (isVideo) el.removeEventListener("ended", requestStop);
    requestStop();
    _releaseStream(stream);
    _captureActive = false;
    _recCtl = null;
    if (cancelBtnEl) cancelBtnEl.style.display = "none";
    btn.textContent = CLIP_LABEL;
    updateButtonVisibility();
  }
  if (discard) {
    chunks.length = 0;
    _flashVideoBtn(btn, "✕ 中止しました");
    return;
  }
  let blob = new Blob(chunks, { type: mime || "video/webm" });
  chunks.length = 0;
  if (!blob.size) {
    blob = null;
    _flashVideoBtn(btn, "🚫 録画できませんでした");
    return;
  }
  let buf = await blob.arrayBuffer();
  blob = null;
  const rect = el.getBoundingClientRect();
  await browser.runtime.sendMessage({
    type:        "OPEN_VIDEO_CONVERT_CAPTURED",
    buffer:      buf,
    mime:        mime || "video/webm",
    pageUrl:     location.href,
    videoWidth:  isVideo ? (el.videoWidth || 0) : (el.width || Math.round(rect.width)),
    videoHeight: isVideo ? (el.videoHeight || 0) : (el.height || Math.round(rect.height)),
    duration:    sync ? Math.max(0.5, maxT - startSec) : (elapsed || secLimit),
    sourceKind:  isVideo ? "blob-video" : "canvas",
  }).catch(() => null);
  buf = null; // 巨大 payload null 代入（送信完了直後、GROUP-82 規約）
  btn.textContent = "🎬 動画→GIF";
  hideNow();
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

  // GROUP-15 範囲拡大 (v1.46.46)：canvas 要素を検知（video の次、img より先）
  const cv = e.target.closest("canvas");
  if (cv && isValidCanvas(cv) && !e.target.closest("#__image-saver-wrap__")) {
    if (cv === currentImg) { clearTimeout(hideTimer); return; }
    clearTimeout(hideTimer); clearTimeout(showTimer);
    showTimer = setTimeout(() => showAt(cv), DELAY_SHOW);
    return;
  }

  // GROUP-15 UAT 是正 (v1.46.47)：X 等はプレイヤー操作のオーバーレイ div が video を覆い、
  // closest（祖先方向）では届かない。img 用の既存対策（オーバーレイ貫通）と
  // 同型に、カーソル位置の重なり順全要素（elementsFromPoint）から video / canvas を探す
  if (!e.target.closest("#__image-saver-wrap__")) {
    const stack = document.elementsFromPoint(e.clientX, e.clientY);
    const mediaEl = stack.find((s) => s.tagName === "VIDEO" && isValidVideo(s))
                 || stack.find((s) => s.tagName === "CANVAS" && isValidCanvas(s));
    if (mediaEl) {
      if (mediaEl === currentImg) { clearTimeout(hideTimer); return; }
      clearTimeout(hideTimer); clearTimeout(showTimer);
      showTimer = setTimeout(() => showAt(mediaEl), DELAY_SHOW);
      return;
    }
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
