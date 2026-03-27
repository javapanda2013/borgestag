/**
 * modal.js
 * 別ウィンドウ表示モーダルの UI スクリプト。
 * background.js が browser.windows.create() で開く modal.html から読み込まれる。
 * storage.local の _pendingModal から imageUrl / pageUrl を取得して初期化する。
 */

// ウィンドウが開いたら即座に初期化
document.addEventListener("DOMContentLoaded", () => {
  initModal();
  initZoomMonitor();
});

// background.js から新しい画像が届いた場合（ウィンドウ再利用）
browser.runtime.onMessage.addListener((message) => {
  if (message.type === "MODAL_NEW_IMAGE") {
    initModal();
  }
});

// ----------------------------------------------------------------
// 表示倍率モニター
// タイトルバーに「Image Saver [150%]」のように表示し、
// Ctrl+0 でリセット（Firefox は zoom リセットを直接 API で行えないため
// window.location.reload() + meta viewport で対応）
// ----------------------------------------------------------------
function initZoomMonitor() {
  function getZoomPct() {
    // devicePixelRatio はシステムDPI × ブラウザズームの合成値
    // ズームのみを取り出すため screen.deviceXDPI は使えないので
    // window.outerWidth / window.innerWidth で近似する
    const ratio = window.outerWidth > 0 && window.innerWidth > 0
      ? window.outerWidth / window.innerWidth
      : window.devicePixelRatio;
    return Math.round(ratio * 100);
  }

  function updateTitle() {
    const pct = getZoomPct();
    document.title = pct === 100
      ? "Image Saver"
      : `Image Saver [${pct}%]`;
  }

  updateTitle();
  window.addEventListener("resize", updateTitle);

  // Ctrl+0 でズームリセット
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "0") {
      // Firefox: ズームAPIがないため zoom CSS プロパティで対応
      document.body.style.zoom = "";
      document.documentElement.style.zoom = "";
      // カードを強制再描画
      const card = document.querySelector(".card");
      if (card) {
        card.style.width  = "";
        card.style.height = "";
      }
      setTimeout(updateTitle, 100);
    }
  });
}

// モーダルUI - 別ウィンドウ版

// ----------------------------------------------------------------
// モーダルを開く
// ----------------------------------------------------------------
async function initModal() {
  // 画像情報を storage から取得
  const { _pendingModal } = await browser.storage.local.get("_pendingModal");
  if (!_pendingModal) { window.close(); return; }
  const { imageUrl, pageUrl } = _pendingModal;
  // 使用済みフラグをクリア（別ウィンドウ開くときの再初期化用に残す）

  // 必要なデータを並列取得
  const [
    { tags: existingTags },
    { lastSaveDir },
    { tagDestinations },
    { recentTags },
    { viewMode: savedViewMode, rootPath: explorerRootPath, startPriority, folderSort: savedFolderSort },
    { bookmarks },
    { modalSize },
    { saveHistory },
    { continuousSession },
    { recentSubTags: recentSubTagsList },
    { authors: globalAuthors },
    { recentAuthors },
    { authorDestinations },
  ] = await Promise.all([
    browser.runtime.sendMessage({ type: "GET_ALL_TAGS" }),
    browser.runtime.sendMessage({ type: "GET_LAST_SAVE_DIR" }),
    browser.runtime.sendMessage({ type: "GET_TAG_DESTINATIONS" }),
    browser.runtime.sendMessage({ type: "GET_RECENT_TAGS" }),
    browser.runtime.sendMessage({ type: "GET_EXPLORER_SETTINGS" }),
    browser.runtime.sendMessage({ type: "GET_BOOKMARKS" }),
    browser.runtime.sendMessage({ type: "GET_MODAL_SIZE" }),
    browser.runtime.sendMessage({ type: "GET_SAVE_HISTORY" }),
    browser.runtime.sendMessage({ type: "GET_CONTINUOUS_SESSION" }),
    browser.runtime.sendMessage({ type: "GET_RECENT_SUBTAGS" }),
    browser.runtime.sendMessage({ type: "GET_GLOBAL_AUTHORS" }),
    browser.runtime.sendMessage({ type: "GET_RECENT_AUTHORS" }),
    browser.runtime.sendMessage({ type: "GET_AUTHOR_DESTINATIONS" }),
  ]);


  const defaultFilename = guessFilename(imageUrl);

  // HTMLを #modal-root に書き込む
  document.getElementById("modal-root").innerHTML = buildModalHTML(defaultFilename);

  setupModalEvents(
    document, null, imageUrl, pageUrl, defaultFilename,
    existingTags, lastSaveDir, tagDestinations,
    recentTags, savedViewMode, explorerRootPath, bookmarks, modalSize, startPriority,
    saveHistory, continuousSession || null, savedFolderSort || "name-asc",
    recentSubTagsList || [],
    null,
    globalAuthors || [], recentAuthors || [], authorDestinations || {}
  );
}

// ----------------------------------------------------------------
// HTML / CSS
// ----------------------------------------------------------------
function buildModalHTML(defaultFilename) {
  return `
  <style>
    *, *::before, *::after {
      box-sizing: border-box; margin: 0; padding: 0;
    }
    body, #modal-root {
      color: #1a1a1a;
      font-family: "Segoe UI", -apple-system, sans-serif;
      font-size: 13px;
      line-height: 1.4;
    }

    /* ================================================================
       オーバーレイ・カード
       ================================================================ */
    .overlay {
      display: contents;
    }

    /* カード：ウィンドウ全体を占める */
    .card {
      background: #fff;
      width: 100%; height: 100%;
      min-width: 600px; min-height: 360px;
      display: flex; flex-direction: column;
    }

    /* ================================================================
       ヘッダー（固定）
       ================================================================ */
    .header {
      display: flex; align-items: center;
      padding: 7px 12px; flex-shrink: 0;
      border-bottom: 1px solid #ebebeb;
      background: #fff; position: relative;
    }
    .header-left { display: flex; flex-direction: column; gap: 1px; flex: 0 0 auto; overflow: hidden; max-width: 30%; }
    .header h2 { font-size: 12px; font-weight: 700; color: #1a1a1a; white-space: nowrap; }
    .header-path {
      font-size: 10px; color: #888; font-family: "Consolas", monospace;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .header-path.unset { color: #ccc; font-family: inherit; font-style: italic; }
    /* 中央ゾーン：ファイル名入力 + 保存ボタン */
    .header-actions {
      display: flex; align-items: center; gap: 6px;
      position: absolute; left: 50%; transform: translateX(-50%);
    }
    .header-filename-input {
      border: 1px solid #d0d0d0; border-radius: 5px;
      padding: 4px 8px; font-size: 12px; outline: none; font-family: inherit;
      width: 260px; background: #fafafa;
    }
    .header-filename-input:focus { border-color: #4a90e2; background: #fff; }

    /* ================================================================
       ボディ：左右2カラム（flex）
       ================================================================ */
    .body {
      display: flex; flex: 1; min-height: 0;
    }

    /* ---- 左カラム（2/10）---- */
    .col-left {
      width: 22%; min-width: 120px; max-width: 50%; flex-shrink: 0;
      display: flex; flex-direction: column; min-height: 0;
    }
    /* ---- カラムリサイザー ---- */
    .col-resizer {
      width: 5px; flex-shrink: 0; cursor: col-resize;
      background: #ebebeb;
      transition: background .15s;
      position: relative;
    }
    .col-resizer:hover, .col-resizer.dragging { background: #4a90e2; }
    /* 左カラム内：スクロール可能なコンテンツ領域 */
    .col-left-scroll {
      flex: 1; overflow-y: auto; padding: 14px 12px;
      display: flex; flex-direction: column; gap: 12px; min-height: 0;
    }
    .col-left-scroll::-webkit-scrollbar { width: 4px; }
    .col-left-scroll::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }

    /* ---- 右カラム（8/10）---- */
    .col-right {
      flex: 1; display: flex; flex-direction: column; min-height: 0;
    }
    /* 右カラム内：スクロール可能なコンテンツ領域 */
    .col-right-inner {
      flex: 1; overflow-y: auto; display: flex; flex-direction: column; min-height: 0;
    }
    .col-right-inner::-webkit-scrollbar { width: 5px; }
    .col-right-inner::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }

    /* ================================================================
       フォーム要素（左カラム内）
       ================================================================ */
    .field-label {
      display: block; font-size: 10px; font-weight: 700; color: #666;
      text-transform: uppercase; letter-spacing: .05em; margin-bottom: 4px;
    }
    input[type="text"] {
      width: 100%; border: 1px solid #d0d0d0; border-radius: 6px;
      padding: 7px 9px; font-size: 13px; outline: none;
      font-family: inherit; transition: border-color .15s;
    }
    input[type="text"]:focus {
      border-color: #4a90e2;
      box-shadow: 0 0 0 3px rgba(74,144,226,.12);
    }

    /* プレビュー */
    .preview {
      width: 100%; height: 120px; min-height: 40px; max-height: 400px; object-fit: contain;
      border-radius: 6px; border: 1px solid #e8e8e8; background: #f6f6f6;
      flex-shrink: 0;
    }
    .preview-resizer {
      height: 5px; flex-shrink: 0; cursor: row-resize;
      background: #ebebeb; border-radius: 3px;
      transition: background .15s; margin: 1px 0;
    }
    .preview-resizer:hover, .preview-resizer.dragging { background: #4a90e2; }

    /* ================================================================
       タグエリア
       ================================================================ */
    .tag-area {
      border: 1px solid #d0d0d0; border-radius: 6px;
      padding: 5px 7px; display: flex; flex-wrap: wrap;
      gap: 4px; align-items: center; min-height: 36px; cursor: text;
    }
    .tag-area:focus-within {
      border-color: #4a90e2;
      box-shadow: 0 0 0 3px rgba(74,144,226,.12);
    }
    .tag-chip {
      display: inline-flex; align-items: center; gap: 3px;
      background: #e8f0fe; color: #1a56db;
      border-radius: 4px; padding: 2px 6px;
      font-size: 11px; font-weight: 600;
    }
    .tag-chip button {
      background: none; border: none; cursor: pointer;
      color: #1a56db; font-size: 12px; line-height: 1; padding: 0;
    }
    .tag-chip button:hover { color: #c0392b; }
    .tag-input {
      border: none; outline: none; font-size: 12px;
      min-width: 60px; flex: 1; padding: 2px 3px; font-family: inherit;
    }
    .suggestions {
      border: 1px solid #e0e0e0; border-radius: 6px;
      background: #fff; max-height: 110px; overflow-y: auto;
      box-shadow: 0 4px 12px rgba(0,0,0,.1); display: none;
      position: absolute; z-index: 100; min-width: 180px;
      top: calc(100% + 2px); left: 0;
    }
    .suggestions.visible { display: block; }
    .suggestion-item { padding: 6px 10px; cursor: pointer; font-size: 12px; }
    .suggestion-item:hover, .suggestion-item.active { background: #f0f4ff; }

    /* suggestions の位置基準 */
    .dest-tabbar-tag-wrap {
      position: relative; display: flex; flex-direction: column; flex: 1; max-width: 340px;
    }
    /* サブタグ入力欄：タグ入力欄より少し幅狭 */
    .dest-tabbar-subtag-wrap {
      position: relative; display: flex; flex-direction: column; flex: 1; max-width: 240px;
    }
    .dest-tabbar-subtag-wrap .dest-tabbar-tag-area {
      border-color: #d0c8f0; /* 薄紫でタグ欄と区別 */
    }
    .dest-tabbar-subtag-wrap .dest-tabbar-tag-area:focus-within {
      border-color: #7c5cbf;
    }

    /* ================================================================
       右カラム：フォルダエクスプローラー
       ================================================================ */
    .right-header {
      display: flex; align-items: center;
      padding: 0 10px; background: #f7f9ff;
      border-bottom: 1px solid #e4eaf8; min-height: 34px; flex-shrink: 0;
      gap: 6px;
    }
    .right-header-title {
      font-size: 10px; font-weight: 700; color: #666;
      text-transform: uppercase; letter-spacing: .05em;
    }

    /* right-header 右端：新規フォルダ作成エリア */
    .right-header-folder-create {
      display: flex; align-items: center; gap: 4px;
      margin: 0 auto; /* 中央寄せ・幅は内容に合わせて自動 */
    }
    .right-header-folder-create .new-folder-input {
      width: 120px; padding: 3px 6px; font-size: 11px;
      border: 1px solid #d0d0d0; border-radius: 4px; outline: none; font-family: inherit;
    }
    .right-header-folder-create .new-folder-input:focus { border-color: #4a90e2; }
    .right-header-folder-create .new-folder-btn {
      padding: 3px 8px; font-size: 11px;
    }

    /* 戻る・進むボタン */
    .btn-nav {
      background: none; border: 1px solid transparent;
      border-radius: 4px; cursor: pointer;
      padding: 2px 6px; font-size: 13px; line-height: 1; color: #999;
      transition: color .1s, background .1s, border-color .1s;
    }
    .btn-nav:hover:not(:disabled) { color: #4a90e2; background: #eef3ff; border-color: #b0c8f0; }
    .btn-nav:disabled { color: #ddd; cursor: default; }

    /* ブックマーク追加ボタン（現在のフォルダを即登録） */
    .btn-bookmark-add {
      background: none; border: 1px solid transparent;
      border-radius: 4px; cursor: pointer;
      padding: 2px 6px; font-size: 13px; line-height: 1;
      color: #ccc; transition: color .1s, background .1s, border-color .1s;
    }
    .btn-bookmark-add:hover:not(.bookmarked) { color: #e8a000; background: #fff8e0; border-color: #f5d080; }
    /* ブックマーク済み：金色背景で強調 */
    .btn-bookmark-add.bookmarked {
      color: #e8a000; background: #fff8e0; border-color: #f5d080;
    }
    .btn-bookmark-add:disabled { color: #e0e0e0; cursor: default; }

    /* 候補追加ボタン */
    .btn-add-candidate {
      background: none; border: 1px solid transparent;
      border-radius: 4px; cursor: pointer;
      padding: 2px 7px; font-size: 11px; font-weight: 600;
      color: #4a90e2; transition: color .1s, background .1s, border-color .1s;
      flex-shrink: 0; white-space: nowrap;
    }
    .btn-add-candidate:hover:not(:disabled) { background: #eef3ff; border-color: #b0c8f0; }
    .btn-add-candidate:disabled { color: #ccc; cursor: default; }

    /* タグ絞込ボタン */
    .btn-tag-filter {
      background: none; border: 1px solid transparent;
      border-radius: 4px; cursor: pointer;
      padding: 2px 7px; font-size: 11px; font-weight: 600;
      color: #888; transition: color .1s, background .1s, border-color .1s;
      flex-shrink: 0; white-space: nowrap;
    }
    .btn-tag-filter:hover:not(:disabled) { background: #eef3ff; border-color: #b0c8f0; color: #4a90e2; }
    .btn-tag-filter.active { background: #ddeaff; border-color: #4a90e2; color: #1a56db; }
    .btn-tag-filter:disabled { color: #ccc; cursor: default; }

    .explorer { display: flex; flex-direction: column; flex: 1; min-height: 0; }

    /* ツールバー：パンくず＋表示切り替え */
    .explorer-toolbar {
      display: flex; align-items: center;
      padding: 4px 8px 4px 10px; background: #f0f5ff;
      border-bottom: 1px solid #d8e4f8; gap: 6px; min-height: 32px; flex-shrink: 0;
    }
    .breadcrumb {
      display: flex; align-items: center; flex-wrap: nowrap; gap: 2px;
      font-size: 11px; flex: 1; overflow: hidden;
    }
    .breadcrumb-item {
      cursor: pointer; color: #1a56db; font-weight: 500;
      padding: 1px 4px; border-radius: 3px; white-space: nowrap;
    }
    .breadcrumb-item:hover { background: #dce8ff; }
    .breadcrumb-sep { color: #aaa; flex-shrink: 0; }
    .breadcrumb-item.current { color: #333; font-weight: 700; cursor: default; }
    .breadcrumb-item.current:hover { background: none; }

    .view-switcher { display: flex; gap: 2px; flex-shrink: 0; }
    .view-btn {
      background: none; border: 1px solid transparent;
      border-radius: 4px; cursor: pointer; padding: 2px 5px;
      font-size: 12px; color: #888; line-height: 1;
      transition: background .1s, border-color .1s;
    }
    .view-btn:hover { background: #e0e8ff; border-color: #b0c8f0; }
    .view-btn.active { background: #ddeaff; border-color: #4a90e2; color: #1a56db; }

    /* コンテンツエリア（スクロール） */
    .tree-view {
      flex: 1; overflow-y: auto; background: #fafafa; min-height: 0;
    }
    .tree-view::-webkit-scrollbar { width: 5px; }
    .tree-view::-webkit-scrollbar-thumb { background: #ccc; border-radius: 3px; }

    /* リスト表示 */
    .tree-row {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 12px; cursor: pointer;
      border-bottom: 1px solid #f0f0f0;
      transition: background .1s; user-select: none;
    }
    .tree-row:hover { background: #eef3ff; }
    .tree-row.selected { background: #ddeaff; }
    .tree-row .row-icon { font-size: 14px; flex-shrink: 0; }
    .tree-row .row-name {
      font-size: 12px; flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .tree-row.selected .row-name { font-weight: 600; color: #1a56db; }
    .tree-row .row-arrow { font-size: 10px; color: #bbb; flex-shrink: 0; }
    .tree-row .row-path {
      font-size: 10px; color: #aaa; display: none;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }

    /* 詳細表示 */
    .tree-view.view-detail .tree-row { padding: 7px 12px; }
    .tree-view.view-detail .tree-row .row-icon { font-size: 18px; }
    .tree-view.view-detail .tree-row .row-path { display: block; }
    .tree-view.view-detail .tree-row .row-text { display: flex; flex-direction: column; flex: 1; overflow: hidden; }

    /* タイル表示 */
    .tree-view.view-tile {
      display: flex; flex-wrap: wrap; align-content: flex-start;
      gap: 4px; padding: 8px;
    }
    .tree-view.view-tile .tree-row {
      flex-direction: column; align-items: center; justify-content: center;
      width: 72px; height: 72px; padding: 5px 3px;
      border: 1px solid transparent; border-radius: 6px; border-bottom: none; gap: 3px;
    }
    .tree-view.view-tile .tree-row:hover { border-color: #b0c8f0; background: #eef3ff; }
    .tree-view.view-tile .tree-row.selected { border-color: #4a90e2; background: #ddeaff; }
    .tree-view.view-tile .tree-row .row-icon { font-size: 24px; }
    .tree-view.view-tile .tree-row .row-name {
      font-size: 10px; text-align: center;
      word-break: break-all; white-space: normal; max-height: 28px; overflow: hidden;
    }
    .tree-view.view-tile .tree-row .row-arrow { display: none; }
    .tree-view.view-tile .tree-row .row-path  { display: none; }
    .tree-view.view-tile .tree-message { width: 100%; }

    @keyframes spin { to { transform: rotate(360deg); } }
    .row-arrow.loading { animation: spin .8s linear infinite; }

    .tree-message { padding: 18px; text-align: center; font-size: 11px; color: #999; }
    .tree-message.error { color: #c0392b; }

    /* 新規フォルダ行 */
    .new-folder-row {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px; border-top: 1px solid #e0e0e0; background: #fff; flex-shrink: 0;
    }
    .new-folder-input {
      flex: 1; border: 1px solid #d0d0d0; border-radius: 5px;
      padding: 4px 8px; font-size: 11px; outline: none; font-family: inherit;
    }
    .new-folder-input:focus { border-color: #4a90e2; }
    .new-folder-btn {
      background: #4a90e2; color: #fff; border: none;
      border-radius: 5px; padding: 4px 10px;
      font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap;
    }
    .new-folder-btn:hover { background: #3a7fd5; }
    .new-folder-tag-btn {
      background: #27ae60; color: #fff; border: none; border-radius: 4px;
      padding: 3px 8px; font-size: 11px; font-weight: 600; cursor: pointer;
      white-space: nowrap; font-family: inherit; flex-shrink: 0;
    }
    .new-folder-tag-btn:hover { background: #219150; }
    .new-folder-tag-btn:disabled { background: #a0bfa8; cursor: not-allowed; opacity: .7; }

    /* タグ名フォルダ作成ダイアログ */
    .tag-folder-dialog {
      background: #fff; border: 1px solid #4a90e2; border-radius: 6px;
      padding: 10px 12px; margin: 6px 0; box-shadow: 0 2px 12px rgba(0,0,0,.12);
    }
    .tfd-title { font-size: 11px; font-weight: 700; color: #1a56db; margin-bottom: 8px; }
    .tfd-list { display: flex; flex-direction: column; gap: 5px; margin-bottom: 8px; }
    .tfd-item {
      display: flex; align-items: center; gap: 6px;
      font-size: 12px; cursor: pointer; padding: 2px 0;
    }
    .tfd-item input { accent-color: #4a90e2; cursor: pointer; }
    .tfd-actions { display: flex; gap: 6px; }
    .tfd-btn {
      padding: 4px 12px; border-radius: 5px; font-size: 11px; font-weight: 600;
      cursor: pointer; border: none; font-family: inherit;
    }
    .tfd-btn.confirm { background: #4a90e2; color: #fff; }
    .tfd-btn.confirm:hover { background: #3a7fd5; }
    .tfd-btn.cancel  { background: #f0f0f0; color: #555; border: 1px solid #d0d0d0; }
    .tfd-btn.cancel:hover { background: #e0e0e0; }

    /* ================================================================
       右カラム：タブバー＋排他パネル構造
       ================================================================ */
    .col-right { flex: 1; display: flex; flex-direction: column; min-height: 0; }

    /* タブバー（タグ追加後に表示、初期は非表示） */
    .dest-tabbar {
      display: none; flex-shrink: 0;
      background: #eef4ff; border-bottom: 1px solid #b8d0f8;
      padding: 0 8px; gap: 0; min-height: 36px;
      align-items: center;
    }
    .dest-tabbar.visible { display: flex; }

    /* dest-tabbar 中央：タグ入力エリア */
    .dest-tabbar-center {
      flex: 1; display: flex; align-items: center;
      justify-content: center; gap: 5px; padding: 0 8px; min-width: 0;
    }
    .dest-tabbar-tag-area {
      display: flex; align-items: center; flex-wrap: wrap; gap: 3px;
      background: #fff; border: 1px solid #d0d8f0; border-radius: 5px;
      padding: 2px 6px; min-width: 0; flex: 1; max-width: 340px;
      cursor: text;
    }
    .dest-tabbar-tag-area .tag-chip {
      font-size: 10px; padding: 1px 4px;
    }
    .dest-tabbar-tag-input {
      border: none; outline: none; font-size: 11px;
      background: transparent; min-width: 60px; flex: 1; font-family: inherit;
    }

    .dest-tab {
      background: none; border: none;
      border-bottom: 2px solid transparent;
      padding: 6px 14px; font-size: 11px; font-weight: 600;
      cursor: pointer; color: #888; font-family: inherit;
      transition: color .15s, border-color .15s; white-space: nowrap;
    }
    .dest-tab:hover { color: #4a90e2; }
    .dest-tab.active { color: #1a56db; border-bottom-color: #4a90e2; }

    /* 候補パネル：タブ選択時に flex:1 で全体を占有 */
    .dest-panel {
      display: none; flex-direction: column; flex: 1; min-height: 0;
    }
    .dest-panel.visible { display: flex; }

    /* エクスプローラー：flex:1 で全体を占有（候補表示時は非表示） */
    #explorer-wrapper {
      display: flex; flex-direction: column; flex: 1; min-height: 0;
    }

    .dest-candidates {
      flex: 1; overflow-y: auto; background: #fff; min-height: 0;
    }
    .dest-candidates::-webkit-scrollbar { width: 5px; }
    .dest-candidates::-webkit-scrollbar-thumb { background: #ccc; border-radius: 3px; }

    .dest-candidate-item {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 12px; cursor: pointer;
      border-bottom: 1px solid #f2f2f2;
      transition: background .1s; user-select: none;
    }
    .dest-candidate-item:last-child { border-bottom: none; }
    .dest-candidate-item:hover { background: #eef3ff; }
    .dest-candidate-item.selected { background: #ddeaff; }
    .dest-candidate-item.editing { background: #f8f9ff; cursor: default; }

    /* インライン編集フォーム */
    .dest-cand-edit-form {
      flex: 1; display: flex; flex-direction: column; gap: 4px; padding: 2px 0;
    }
    .dest-cand-edit-input {
      border: 1px solid #4a90e2; border-radius: 4px;
      padding: 3px 7px; font-size: 11px; outline: none; font-family: "Consolas", monospace;
      width: 100%; background: #fff;
    }
    .dest-cand-edit-actions { display: flex; gap: 4px; }
    .dest-cand-edit-btn {
      background: #4a90e2; color: #fff; border: none; border-radius: 4px;
      padding: 2px 8px; font-size: 10px; font-weight: 600; cursor: pointer; font-family: inherit;
    }
    .dest-cand-edit-btn.cancel { background: #f0f0f0; color: #555; }

    /* チェックボックス風インジケーター */
    .dest-cand-check {
      width: 16px; height: 16px; border-radius: 4px;
      border: 2px solid #ccc; flex-shrink: 0;
      display: flex; align-items: center; justify-content: center;
      font-size: 10px; transition: border-color .1s, background .1s;
    }
    .dest-candidate-item.selected .dest-cand-check {
      background: #4a90e2; border-color: #4a90e2; color: #fff;
    }

    /* 候補複数選択フッター */
    .dest-multi-footer {
      flex-shrink: 0; border-top: 1px solid #e0e8f8;
      background: #f0f5ff; padding: 6px 12px;
      display: flex; align-items: center; gap: 8px;
    }
    .dest-multi-count {
      flex: 1; font-size: 11px; color: #3a6abf; font-weight: 600;
    }
    .btn-multi-save {
      background: #4a90e2; color: #fff; border: none;
      border-radius: 5px; padding: 5px 14px;
      font-size: 11px; font-weight: 600; cursor: pointer; font-family: inherit;
    }
    .btn-multi-save:hover { background: #3a7fd5; }
    .btn-multi-save:disabled { background: #a0c0e8; cursor: not-allowed; }
    .dest-cand-icon { font-size: 15px; flex-shrink: 0; }
    .dest-cand-text { flex: 1; overflow: hidden; }
    .dest-cand-label {
      font-size: 12px; font-weight: 600; color: #1a56db;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .dest-cand-label.no-label { font-weight: 400; color: #333; }
    .dest-cand-path {
      font-size: 10px; color: #999;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font-family: "Consolas", monospace;
    }
    .dest-cand-tags { display: flex; gap: 3px; flex-wrap: wrap; margin-top: 2px; }
    .dest-cand-tag {
      font-size: 10px; background: #e8f0fe; color: #1a56db;
      border-radius: 3px; padding: 1px 5px; font-weight: 600;
    }
    .dest-empty { padding: 24px; text-align: center; font-size: 11px; color: #bbb; }

    /* ================================================================
       左カラム：直近タグ・ブックマーク
       ================================================================ */
    /* 左カラム内の直近タグセクション（スクロール可能） */
    .recent-tags-section {
      border-top: 1px solid #ebebeb; padding-top: 10px;
      flex: 1; display: flex; flex-direction: column; min-height: 0;
    }
    .recent-tags-list {
      display: flex; flex-direction: row; flex-wrap: wrap; gap: 4px;
      align-content: flex-start;
      overflow-y: auto; min-height: 0;
    }
    .recent-tags-list::-webkit-scrollbar { width: 3px; }
    .recent-tags-list::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }

    .recent-tag-item {
      display: inline-flex; align-items: center; gap: 3px;
      padding: 3px 8px; border-radius: 12px; cursor: pointer;
      font-size: 11px; user-select: none;
      transition: background .1s, border-color .1s; border: 1px solid transparent;
    }
    .recent-tag-item:hover { background: #eef3ff; border-color: #c8d8f8; }
    .recent-tag-item.active { background: #ddeaff; border-color: #4a90e2; color: #1a56db; font-weight: 600; }
    .recent-tag-icon { font-size: 10px; flex-shrink: 0; }

    /* ブックマーク（左カラム下部） */
    .bookmark-section {
      border-top: 1px solid #ebebeb; padding-top: 10px; background: #fffdf5;
      flex: 1; display: flex; flex-direction: column; min-height: 0;
    }
    .bookmark-header {
      display: flex; align-items: center; padding: 0 0 5px 0;
      font-size: 10px; font-weight: 700; color: #888;
      text-transform: uppercase; letter-spacing: .04em; gap: 4px; flex-shrink: 0;
    }
    .bookmark-list {
      flex: 1; overflow-y: auto; min-height: 0;
      display: flex; flex-direction: row; flex-wrap: wrap; gap: 2px;
      align-content: flex-start;
    }
    .bookmark-list::-webkit-scrollbar { width: 3px; }
    .bookmark-list::-webkit-scrollbar-thumb { background: #ddd; border-radius: 2px; }
    .bookmark-row {
      display: flex; align-items: center; gap: 5px;
      width: calc(50% - 1px); box-sizing: border-box;
      padding: 4px 6px; cursor: pointer; border-radius: 5px;
      border: 1px solid transparent;
      transition: background .1s; user-select: none;
    }
    .bookmark-row:hover { background: #fff8e8; border-color: #f5d080; }
    .bookmark-row.selected { background: #fff3cc; border-color: #e8a000; }
    .bookmark-row .bm-icon { font-size: 12px; flex-shrink: 0; }
    .bookmark-row .bm-label {
      font-size: 11px; font-weight: 600; color: #7a5500; flex: 1;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .bookmark-row .bm-path { display: none; }
    .bookmark-empty { padding: 4px 6px; font-size: 10px; color: #bbb; }

    /* ================================================================
       フッター（固定）
       ================================================================ */
    .hint { font-size: 10px; color: #aaa; font-weight: 400; }

    /* ヘッダー内保存ボタン */
    .btn {
      padding: 4px 14px; border-radius: 6px; font-size: 12px; font-weight: 600;
      cursor: pointer; border: 1px solid transparent;
      transition: opacity .15s; font-family: inherit;
      white-space: nowrap; line-height: 1.4;
    }
    .btn:hover { opacity: .85; }
    .btn-save   { background: #4a90e2; color: #fff; }
    .btn-save:disabled { background: #a0c0e8; cursor: not-allowed; opacity: 1; }

    /* 連続保存モード */
    .continuous-toggle {
      display: flex; align-items: center; gap: 5px;
      margin-left: 8px; cursor: pointer; user-select: none;
    }
    .continuous-toggle input[type="checkbox"] {
      width: 14px; height: 14px; accent-color: #e67e22; cursor: pointer; flex-shrink: 0;
    }
    .continuous-toggle .ct-label {
      font-size: 11px; font-weight: 600; color: #e67e22; white-space: nowrap;
    }
    .continuous-toggle input:not(:checked) ~ .ct-label { color: #999; }
    .continuous-badge {
      display: none; align-items: center; gap: 4px;
      background: #fff3e0; border: 1px solid #e67e22; border-radius: 12px;
      padding: 2px 8px; font-size: 10px; font-weight: 700; color: #e67e22;
      white-space: nowrap;
    }
    .continuous-badge.active { display: flex; }

    .hint { font-size: 10px; color: #aaa; font-weight: 400; }

    /* ================================================================
       右カラム：メインタブ（保存先 / 保存履歴）
       ================================================================ */
    .main-tabbar {
      display: flex; flex-shrink: 0;
      background: #f3f4f8; border-bottom: 1px solid #dde2f0;
      padding: 0 10px; gap: 0; min-height: 32px; align-items: flex-end;
    }
    .main-tab {
      background: none; border: none;
      border-bottom: 2px solid transparent;
      padding: 5px 14px; font-size: 11px; font-weight: 600;
      cursor: pointer; color: #888; font-family: inherit;
      transition: color .15s, border-color .15s; white-space: nowrap;
    }
    .main-tab:hover { color: #4a90e2; }
    .main-tab.active { color: #1a56db; border-bottom-color: #4a90e2; background: #fff; }

    /* 作者チップ */
    .history-author {
      display: inline-flex; align-items: center;
      background: #f3e8ff; color: #7c3aed;
      border-radius: 4px; padding: 1px 6px; font-size: 10px;
      cursor: pointer; font-weight: 600;
    }
    .history-author:hover { background: #e9d5ff; }
    .history-author.filter-active { background: #7c3aed; color: #fff; }

    /* 履歴タグ絞り込み入力欄 */
    .history-filter-wrap {
      display: none; align-items: center; gap: 3px; flex-wrap: wrap;
      margin: 0 auto; padding-bottom: 4px;
    }
    .history-filter-wrap.visible { display: flex; }
    .history-filter-wrap input[type="text"] {
      width: 120px; border: 1px solid #d0d0d0; border-radius: 5px;
      padding: 3px 7px; font-size: 11px; outline: none; font-family: inherit;
    }
    .history-filter-wrap input[type="text"]:focus { border-color: #4a90e2; }
    .history-filter-mode-select {
      font-size: 10px; border: 1px solid #dde; border-radius: 4px;
      padding: 2px 4px; cursor: pointer; font-family: inherit; background: #fff; color: #444;
    }
    .history-filter-clear {
      background: none; border: none; cursor: pointer;
      font-size: 11px; color: #aaa; padding: 2px 4px; border-radius: 3px;
      display: none;
    }
    .history-filter-clear.visible { display: block; }
    .history-filter-clear:hover { color: #e74c3c; }

    /* メインタブのコンテンツパネル */
    .main-tab-panel { display: none; flex: 1; flex-direction: column; min-height: 0; }
    .main-tab-panel.active { display: flex; }

    /* ================================================================
       保存履歴パネル（タイル表示）
       ================================================================ */
    .history-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; }

    /* 容量・件数インフォバー */
    .history-infobar {
      flex-shrink: 0; padding: 4px 12px;
      background: #f3f4f8; border-bottom: 1px solid #dde2f0;
      font-size: 10px; color: #999;
      display: flex; gap: 10px; align-items: center;
    }
    .history-infobar span { color: #4a90e2; font-weight: 600; }

    .history-pager {
      flex-shrink: 0; display: flex; align-items: center; justify-content: center;
      gap: 6px; padding: 4px 12px; background: #f8f9fd;
      border-bottom: 1px solid #e8ecf5; font-size: 10px; color: #666;
    }
    .history-pager:empty { display: none; }
    .history-pager-btn {
      background: #fff; border: 1px solid #c8d0e8; border-radius: 4px;
      padding: 2px 8px; font-size: 10px; cursor: pointer; color: #4a90e2;
    }
    .history-pager-btn:disabled { opacity: .4; cursor: default; }
    .history-pager-btn:not(:disabled):hover { background: #eef2ff; }
    .history-pager-info { color: #888; white-space: nowrap; }
    .history-page-size-select {
      border: 1px solid #c8d0e8; border-radius: 4px; padding: 1px 3px;
      font-size: 10px; background: #fff; color: #444; cursor: pointer; font-family: inherit;
    }

    .history-panel { display: flex; flex-direction: column; flex: 1; min-height: 0;
      container-type: size; container-name: history-panel; }

    /* 縦スクロール・複数行 */
    .history-list {
      flex: 1; overflow-y: auto; overflow-x: hidden; background: #f5f6fa;
      display: flex; flex-wrap: wrap;
      align-items: flex-start; align-content: flex-start;
      gap: 8px; padding: 8px;
    }
    .history-list::-webkit-scrollbar { width: 5px; }
    .history-list::-webkit-scrollbar-thumb { background: #ccc; border-radius: 3px; }

    /* タイル：パネル高さの2/3・幅は縦横比から自動・最大3列 */
    .history-item {
      display: flex; flex-direction: column;
      flex: 0 0 auto;
      height: calc(100cqh * 2 / 3);
      position: relative; /* オーバーレイの基準 */
      background: #fff; border: 1px solid #e8e8e8;
      border-radius: 8px; overflow: hidden; cursor: default;
      transition: box-shadow .15s, border-color .15s;
      user-select: none;
    }
    .history-item:hover { box-shadow: 0 2px 10px rgba(0,0,0,.1); border-color: #c8d4f0; }

    /* グループラッパー：幅固定で子タイル列に引きずられない */
    .history-group-wrapper {
      display: flex; flex-direction: column; gap: 0;
      flex: 0 0 auto;
      /* 先頭タイルの幅に揃え、展開エリアがはみ出してもラッパーは広がらない */
      width: fit-content;
      max-width: calc(100cqh * 2 / 3 * 1.5); /* 高さの1.5倍を上限に */
      align-self: flex-start;
    }
    .history-group-wrapper .history-item-group-card {
      border-color: #e67e22 !important;
      /* 先頭タイルを正方形ではなくアスペクト比を保った固定高さに */
      max-width: calc(100cqh * 2 / 3 * 1.5) !important;
    }
    .history-group-wrapper .history-item-group-card:hover { border-color: #e67e22 !important; }
    /* グループ先頭タイルのサムネイル：object-fit:containで縦横比を保ちながら枠に収める */
    .history-item-group-card .history-thumb {
      height: 100% !important;
      width: 100% !important;
      max-width: calc(100cqh * 2 / 3 * 1.5) !important;
      object-fit: contain !important;
      background: #1a1a1a !important;
    }
    /* 展開ボタン（ラッパー内・カードの直下） */
    .history-group-expand-btn {
      background: #fff8f0; border: 1px solid #e67e22; border-top: 2px solid #e67e22;
      color: #c0622a; font-size: 11px; font-weight: 600; cursor: pointer;
      padding: 5px 10px; text-align: center; font-family: inherit;
      border-radius: 0 0 8px 8px; width: 100%;
      transition: background .15s; flex-shrink: 0;
    }
    .history-group-expand-btn:hover { background: #fde8d0; }
    /* 展開エリア：折り返しあり・縦スクロール可能・ラッパー幅で折り返す */
    .history-group-children {
      display: none; flex-direction: row; flex-wrap: wrap;
      gap: 6px; padding: 8px;
      border: 1px solid #e67e22; border-top: none;
      background: #fff8f0; border-radius: 0 0 8px 8px;
      max-height: 600px; overflow-y: auto; overflow-x: hidden;
      width: 100%; box-sizing: border-box;
    }
    .history-group-children .history-item {
      flex: 0 0 auto !important;
      height: calc(100cqh * 2 / 3) !important;
      overflow: hidden !important;
    }

    /* サムネイル：タイル高さいっぱい・幅は縦横比で自動 */
    .history-thumb {
      height: 100%; width: auto; display: block; cursor: pointer;
      background: #f0f0f0; flex-shrink: 0;
      transition: opacity .1s;
    }
    .history-thumb:hover { opacity: .85; }

    /* サムネイル取得失敗時のプレースホルダー */
    .history-thumb-placeholder {
      width: 100%; aspect-ratio: 4/3;
      display: flex; align-items: center; justify-content: center;
      font-size: 28px; background: #f0f0f0; cursor: pointer;
      transition: background .1s;
    }
    .history-thumb-placeholder:hover { background: #e4e4e4; }

    /* 情報・ボタンをホバー時のみ表示するオーバーレイ */
    .history-overlay {
      position: absolute; bottom: 0; left: 0; right: 0;
      background: linear-gradient(transparent, rgba(0,0,0,0.72));
      padding: 20px 8px 6px;
      opacity: 0; transition: opacity .2s;
      pointer-events: none;
    }
    .history-item:hover .history-overlay { opacity: 1; pointer-events: auto; }

    .history-body {
      padding: 0; overflow: hidden;
      display: flex; flex-direction: column; gap: 2px;
    }
    .history-filename {
      font-size: 10px; font-weight: 600; color: #fff;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .history-path {
      font-size: 9px; color: rgba(255,255,255,0.7);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font-family: "Consolas", monospace;
    }
    .history-pageurl {
      font-size: 9px; color: rgba(180,210,255,0.85);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      cursor: pointer; text-decoration: none; display: block;
    }
    .history-pageurl:hover { color: #fff; text-decoration: underline; }
    .history-meta {
      font-size: 9px; color: rgba(255,255,255,0.6);
      display: flex; gap: 3px; flex-wrap: wrap; align-items: center;
    }
    .history-tag {
      background: rgba(74,144,226,0.8); color: #fff;
      border-radius: 3px; padding: 1px 4px; font-weight: 600; font-size: 9px;
      cursor: pointer; transition: background .1s;
    }
    .history-tag:hover { background: rgba(26,86,219,0.9); }
    .history-tag.filter-active { background: #1a56db; outline: 1px solid #fff; }
    .history-actions {
      display: flex; margin-top: 5px; gap: 4px; position: relative;
    }
    .history-btn {
      flex: 1; background: rgba(255,255,255,0.18); border: 1px solid rgba(255,255,255,0.3);
      border-radius: 4px; cursor: pointer; padding: 4px 2px; font-size: 11px; color: #fff;
      transition: background .1s;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .history-btn:hover { background: rgba(255,255,255,0.32); }
    .history-btn-addtag { flex: 0 0 auto; padding: 4px 6px; }

    /* 履歴タイルのインラインタグエディタ */
    .history-tag-editor {
      margin-top: 5px; background: rgba(0,0,0,0.45);
      border-radius: 5px; padding: 5px 6px;
      display: none; flex-direction: column; gap: 4px;
    }
    .history-tag-editor.visible { display: flex; }
    .history-tag-editor-chips {
      display: flex; flex-wrap: wrap; gap: 3px; align-items: center; min-height: 20px;
    }
    .history-tag-editor-chip {
      display: inline-flex; align-items: center; gap: 2px;
      background: rgba(74,144,226,0.85); color: #fff;
      border-radius: 3px; padding: 1px 5px; font-size: 10px; font-weight: 600;
    }
    .history-tag-editor-chip button {
      background: none; border: none; cursor: pointer; color: #fff;
      font-size: 11px; line-height: 1; padding: 0;
    }
    .history-tag-editor-chip button:hover { color: #faa; }
    .history-tag-editor-input-row {
      display: flex; gap: 4px; align-items: center; position: relative;
    }
    .history-tag-editor-input {
      flex: 1; border: 1px solid rgba(255,255,255,0.4); border-radius: 4px;
      background: rgba(255,255,255,0.15); color: #fff; font-size: 11px;
      padding: 2px 6px; outline: none; font-family: inherit;
    }
    .history-tag-editor-input::placeholder { color: rgba(255,255,255,0.5); }
    .history-tag-editor-input:focus { border-color: rgba(255,255,255,0.7); }
    .history-tag-editor-confirm {
      background: rgba(255,255,255,0.25); border: 1px solid rgba(255,255,255,0.4);
      border-radius: 4px; cursor: pointer; color: #fff; font-size: 10px;
      padding: 2px 7px; font-family: inherit; transition: background .1s; white-space: nowrap;
    }
    .history-tag-editor-confirm:hover { background: rgba(255,255,255,0.4); }
    .history-tag-suggestions {
      position: absolute; top: calc(100% + 2px); left: 0;
      background: #fff; border: 1px solid #d0d8f0;
      border-radius: 5px; box-shadow: 0 4px 12px rgba(0,0,0,.15);
      max-height: 100px; overflow-y: auto;
      display: none; z-index: 200; min-width: 140px;
    }
    .history-tag-suggestions.visible { display: block; }
    .history-tag-suggestions .suggestion-item {
      padding: 5px 9px; cursor: pointer; font-size: 11px; color: #1a1a1a;
    }
    .history-tag-suggestions .suggestion-item:hover { background: #f0f4ff; }

    /* 複数フォルダ選択ドロップダウン */
    .history-dropdown {
      position: absolute; bottom: 100%; left: 0; right: 0;
      background: #fff; border: 1px solid #d0d8f0;
      border-radius: 6px 6px 0 0; box-shadow: 0 -4px 12px rgba(0,0,0,.1);
      z-index: 100; overflow: hidden;
    }
    .history-dd-title {
      font-size: 9px; font-weight: 700; color: #888; padding: 4px 8px;
      background: #eef4ff; border-bottom: 1px solid #d0d8f0;
      text-transform: uppercase; letter-spacing: .04em;
    }
    .history-dd-item {
      display: flex; align-items: center; gap: 5px;
      padding: 5px 8px; font-size: 10px; cursor: pointer;
      border-bottom: 1px solid #f5f5f5; transition: background .1s;
    }
    .history-dd-item:last-child { border-bottom: none; }
    .history-dd-item:hover { background: #eef3ff; color: #1a56db; }
    .history-dd-name { font-weight: 600; flex-shrink: 0; }
    .history-dd-path {
      font-family: "Consolas", monospace; font-size: 9px; color: #aaa;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .history-empty {
      width: 100%; padding: 32px; text-align: center; font-size: 12px; color: #bbb;
    }

    /* エクスプローラーで開くボタン（候補アイテム内・right-header内） */
    .btn-open-explorer {
      background: none; border: 1px solid transparent;
      border-radius: 4px; cursor: pointer;
      padding: 2px 5px; font-size: 12px; color: #bbb;
      transition: color .1s, background .1s, border-color .1s; flex-shrink: 0;
    }
    .btn-open-explorer:hover { color: #4a90e2; background: #eef3ff; border-color: #b0c8f0; }
  </style>

  <div class="overlay" id="overlay">
    <div class="card" role="dialog" aria-modal="true">

      <!-- ヘッダー（固定） -->
      <div class="header">
        <div class="header-left">
          <h2>🖼 Image Saver</h2>
          <div class="header-path unset" id="selected-path-display">フォルダが選択されていません</div>
        </div>
        <div class="header-actions">
          <input type="text" class="header-filename-input" id="input-filename"
            placeholder="ファイル名" />
          <button class="btn btn-save" id="btn-save" disabled>保存</button>
          <label class="continuous-toggle" id="continuous-toggle"
            title="連続保存モード：漫画等の複数画像を同一セッションとして記録します。ONにするとタグが引き継がれ、保存履歴でまとめて表示できます。">
            <input type="checkbox" id="chk-continuous" />
            <span class="ct-label">連続保存</span>
          </label>
          <span class="continuous-badge" id="continuous-badge">🔴 連続保存中</span>
        </div>
      </div>

      <!-- ボディ：左右カラム -->
      <div class="body">

        <!-- 左カラム（プレビュー・ファイル名・タグ） -->
        <div class="col-left" id="col-left">
          <div class="col-left-scroll">

            <img class="preview" id="preview" src="" alt="プレビュー" />
            <div class="preview-resizer" id="preview-resizer"></div>

            <!-- 直近タグ（左カラム下部・スクロール可能） -->
            <div class="recent-tags-section" id="recent-tags-section" style="display:none">
              <span class="field-label">直近に使用したタグ</span>
              <div class="recent-tags-list" id="recent-tags-list"></div>
            </div>

            <!-- ブックマーク一覧（左カラム下部） -->
            <div class="bookmark-section" id="bookmark-section">
              <div class="bookmark-header">⭐ ブックマーク</div>
              <div class="bookmark-list" id="bookmark-list">
                <div class="bookmark-empty">ブックマークがありません</div>
              </div>
            </div>

          </div>
        </div>

        <!-- カラムリサイザー -->
        <div class="col-resizer" id="col-resizer"></div>

        <!-- 右カラム（保存先フォルダ） -->
        <div class="col-right" id="col-right">

          <!-- メインタブバー（保存先 / 保存履歴） -->
          <div class="main-tabbar">
            <button class="main-tab active" id="main-tab-dest">保存先</button>
            <button class="main-tab"        id="main-tab-history">保存履歴</button>
            <div class="history-filter-wrap" id="history-filter-wrap">
              <input type="text" id="history-filter-input"
                placeholder="🔍 タグで絞り込み" autocomplete="off" />
              <button class="history-filter-clear" id="history-filter-clear" title="クリア">✕</button>
              <input type="text" id="history-author-filter"
                placeholder="✏️ 作者で絞り込み" autocomplete="off" />
              <button class="history-filter-clear" id="history-author-filter-clear" title="クリア">✕</button>
              <select id="history-filter-mode" class="history-filter-mode-select" title="タグ・作者の絞り込みモード">
                <option value="and">AND</option>
                <option value="or">OR</option>
              </select>
            </div>
          </div>

          <!-- 保存先パネル -->
          <div class="main-tab-panel active" id="panel-dest">

            <!-- タブバー（タグ追加後に表示） + タグ入力（中央） -->
            <div class="dest-tabbar" id="dest-tabbar">
              <button class="dest-tab active" id="dest-tab-suggest">💡 候補から選ぶ</button>
              <button class="dest-tab"        id="dest-tab-explorer">📁 フォルダを選ぶ</button>
              <div class="dest-tabbar-center">
                <button class="btn-tag-filter" id="btn-tag-filter"
                  title="タグ名でフォルダを絞り込む" disabled>🔍 タグで絞り込み</button>
                <div class="dest-tabbar-tag-wrap">
                  <div class="dest-tabbar-tag-area" id="dest-tabbar-tag-area">
                    <input type="text" class="dest-tabbar-tag-input" id="tag-input"
                      placeholder="保存先に関連付けるタグを入力" autocomplete="off" />
                  </div>
                  <div class="suggestions" id="suggestions"></div>
                </div>
                <div class="dest-tabbar-subtag-wrap">
                  <div class="dest-tabbar-tag-area" id="dest-tabbar-subtag-area">
                    <input type="text" class="dest-tabbar-tag-input" id="subtag-input"
                      placeholder="履歴に付与するタグ" autocomplete="off"
                      title="保存先候補に使わないタグを入力（サブタグ）" />
                  </div>
                  <div class="suggestions" id="subtag-suggestions"></div>
                </div>
                <button class="new-folder-tag-btn" id="new-folder-tag-btn"
                  title="タグ名でフォルダを新規作成" disabled>🏷 タグ名でフォルダを新規作成</button>
              </div>
            </div>

            <!-- 保存先候補パネル（候補タブ選択時に全体表示） -->
            <div class="dest-panel" id="dest-panel">
              <div class="dest-candidates" id="dest-candidates">
                <div class="dest-empty">タグに関連付けられた保存先がありません</div>
              </div>
              <!-- 複数選択フッター -->
              <div class="dest-multi-footer" id="dest-multi-footer" style="display:none">
                <span class="dest-multi-count" id="dest-multi-count">0件選択中</span>
                <button class="btn-multi-save" id="btn-multi-save" disabled>選択した候補に保存</button>
              </div>
            </div>

            <!-- フォルダエクスプローラー（フォルダタブ選択時 or タグなし時に全体表示） -->
            <div id="explorer-wrapper" style="display:flex; flex-direction:column; flex:1; overflow:hidden;">
              <div class="right-header">
                <button class="btn-bookmark-add" id="btn-bookmark-add"
                  title="現在のフォルダをブックマークに追加">⭐</button>
                <button class="btn-add-candidate" id="btn-add-candidate"
                  title="現在のフォルダを保存先候補に追加" disabled>保存先候補に追加</button>
                
                <button class="btn-nav" id="btn-nav-back"  title="戻る"  disabled>◀</button>
                <button class="btn-nav" id="btn-nav-fwd"   title="進む"  disabled>▶</button>
                <button class="btn-open-explorer" id="btn-open-current"
                  title="現在のフォルダをエクスプローラーで開く">📂</button>
                <div class="view-switcher">
                  <button class="view-btn active" id="vbtn-list"   title="リスト表示">☰</button>
                  <button class="view-btn"        id="vbtn-detail" title="詳細表示">≡</button>
                  <button class="view-btn"        id="vbtn-tile"   title="タイル表示">⊞</button>
                </div>
                <select id="folder-sort-select" title="フォルダの並び順" style="
                  font-size:11px;padding:2px 4px;border:1px solid #dde;border-radius:4px;
                  background:#fff;color:#444;cursor:pointer;font-family:inherit;max-width:100px;">
                  <option value="name-asc">名前 ↑</option>
                  <option value="name-desc">名前 ↓</option>
                  <option value="created-asc">作成日 ↑</option>
                  <option value="created-desc">作成日 ↓</option>
                </select>
                <div style="display:flex;align-items:center;gap:3px;position:relative;">
                  <span style="font-size:10px;color:#888;white-space:nowrap">✏️ 作者:</span>
                  <input type="text" id="author-input" placeholder="作者名（任意）" autocomplete="off"
                    style="width:90px;border:1px solid #d0d0d0;border-radius:4px;padding:2px 7px;
                    font-size:11px;outline:none;font-family:inherit;" />
                  <button id="author-input-clear" style="background:none;border:none;cursor:pointer;
                    color:#aaa;font-size:13px;padding:0 2px;display:none;line-height:1;" title="クリア">✕</button>
                  <div id="author-suggestions" style="position:absolute;top:calc(100% + 2px);left:0;
                    background:#fff;border:1px solid #d0d8f0;border-radius:5px;
                    box-shadow:0 4px 12px rgba(0,0,0,.15);max-height:120px;overflow-y:auto;
                    display:none;z-index:200;min-width:120px;font-size:11px;"></div>
                </div>
                <div style="display:flex;align-items:center;gap:3px;margin:0 auto;">
                  <input type="text" id="folder-kw-input" placeholder="🔍 フォルダを絞り込み"
                    autocomplete="off" style="width:160px;border:1px solid #d0d0d0;
                    border-radius:4px;padding:2px 7px;font-size:11px;outline:none;font-family:inherit;" />
                  <button id="folder-kw-clear" title="クリア" style="
                    background:none;border:none;cursor:pointer;color:#aaa;font-size:13px;
                    padding:0 2px;display:none;line-height:1;">✕</button>
                  <input type="text" class="new-folder-input" id="new-folder-input"
                    placeholder="新しいフォルダ名" />
                  <button class="new-folder-btn" id="new-folder-btn">＋ 作成</button>
                </div>
              </div>
              <div class="explorer">
                <div class="explorer-toolbar">
                  <div class="breadcrumb" id="breadcrumb"></div>
                </div>
                <div class="tree-view" id="tree-view">
                  <div class="tree-message">読み込み中…</div>
                </div>
              </div>
            </div>

          </div>

          <!-- 保存履歴パネル -->\n          <div class=\"main-tab-panel\" id=\"panel-history\">\n            <div class=\"history-panel\">\n              <div class=\"history-infobar\" id=\"history-infobar\">\n                <span id=\"history-count\">0 件</span>\n                保存履歴情報: <span id=\"history-storage-size\">計算中…</span>\n                &nbsp;|&nbsp;保存サムネイル: <span id=\"history-idb-size\">計算中…</span>\n              </div>\n              <div id=\"history-pager-top\" class=\"history-pager\"></div>\n              <div class=\"history-list\" id=\"history-list\">\n                <div class=\"history-empty\">まだ保存履歴がありません</div>\n              </div>\n              <div id=\"history-pager-bottom\" class=\"history-pager\"></div>\n            </div>\n          </div>

        </div>
      </div>

  </div>
  </div>`;
}

// ----------------------------------------------------------------
// イベント設定
// ----------------------------------------------------------------
function setupModalEvents(
  shadow, host, imageUrl, pageUrl, defaultFilename,
  existingTags, lastSaveDir, tagDestinations,
  recentTags, savedViewMode, explorerRootPath, bookmarks, modalSize, startPriority,
  saveHistory, continuousSession, folderSort, recentSubTags, onCleanup,
  globalAuthors, recentAuthors, authorDestinations
) {
  // shadow/host は別ウィンドウモードでは document/null が渡される
  const previewEl = document.getElementById("preview");
  previewEl.style.display = "";
  previewEl.src = imageUrl;
  previewEl.addEventListener("error", async () => {
    // ① background XHR（Referer付き）で取得
    try {
      const res = await browser.runtime.sendMessage({
        type: "FETCH_IMAGE_AS_DATAURL",
        url: imageUrl,
      });
      if (res?.dataUrl) { previewEl.src = res.dataUrl; return; }
    } catch {}
    // ② XHRも失敗した場合（pixiv等）→ Python経由で取得
    try {
      const res = await browser.runtime.sendMessage({
        type: "FETCH_PREVIEW",
        url: imageUrl,
      });
      if (res?.dataUrl) previewEl.src = res.dataUrl;
    } catch {}
  }, { once: true });

  // ウィンドウのリサイズを監視して外枠サイズ（outerWidth/Height）を保存
  const card = document.querySelector(".card");
  let resizeTimer = null;
  const resizeObs = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const w = window.outerWidth;
      const h = window.outerHeight;
      if (w >= 600 && h >= 360) {
        browser.runtime.sendMessage({
          type: "SET_MODAL_SIZE",
          size: { width: w, height: h },
        });
      }
    }, 400);
  });
  resizeObs.observe(card);

  // ================================================================
  // フォルダエクスプローラー
  // ================================================================

  let currentPath = null;
  // selectedPath：候補モードで選んだパス（候補クリック時のみ設定）
  // フォルダ選択・タグ未選択時は currentPath を直接使う
  let selectedPath = null;
  let currentEntries = [];
  let currentResolvedPath = null;
  // ①表示形式：storage から復元
  let viewMode = savedViewMode || "list";

  // フォルダ並び順
  let currentFolderSort = folderSort || "name-asc";
  const folderSortSelect = document.getElementById("folder-sort-select");
  if (folderSortSelect) {
    folderSortSelect.value = currentFolderSort;
    folderSortSelect.addEventListener("change", () => {
      currentFolderSort = folderSortSelect.value;
      browser.storage.local.set({ explorerFolderSort: currentFolderSort });
      if (lastEntries && lastResolvedPath !== undefined) {
        renderEntries(lastEntries, lastResolvedPath);
      }
    });
  }

  // フォルダ絞り込みキーワード
  let folderKwFilter = "";
  let folderScrollPos = 0;
  const folderKwInput = document.getElementById("folder-kw-input");
  const folderKwClear = document.getElementById("folder-kw-clear");
  if (folderKwInput) {
    folderKwInput.addEventListener("input", () => {
      const prev = folderKwFilter;
      folderKwFilter = folderKwInput.value;
      folderKwClear.style.display = folderKwFilter ? "" : "none";
      // 絞り込みなし→ありになる直前のスクロール位置を記憶
      if (!prev && folderKwFilter) {
        const tv = document.getElementById("tree-view");
        folderScrollPos = tv?.scrollTop ?? 0;
      }
      if (lastEntries && lastResolvedPath !== undefined) {
        renderEntries(lastEntries, lastResolvedPath);
      }
    });
    folderKwClear.addEventListener("click", () => {
      folderKwInput.value = "";
      folderKwFilter = "";
      folderKwClear.style.display = "none";
      if (lastEntries && lastResolvedPath !== undefined) {
        renderEntries(lastEntries, lastResolvedPath);
      }
    });
  }

  const breadcrumbStack = [];

  // フォルダ移動履歴（戻る・進む用）各エントリ: { path, stack[] }
  const navHistory = [];
  let navHistoryIndex = -1;

  // 候補モード: "suggest"（候補リスト） or "explorer"（フォルダ選択）
  // getEffectiveSavePath から参照するため、ここで宣言する
  let destMode = "suggest";

  /**
   * 保存ボタンの有効・無効を更新する。
   * - 候補モード（suggest）：selectedPath があれば有効
   * - エクスプローラーモード or タグ未選択：currentPath があれば有効
   *   （currentPath=null はドライブ一覧画面 = フォルダ未選択）
   */
  function updateSaveButton() {
    const effectivePath = getEffectiveSavePath();
    document.getElementById("btn-save").disabled = !effectivePath;
  }

  /**
   * 実際に保存に使うパスを返す。
   * - 候補モードで候補を選んでいる → selectedPath
   * - それ以外 → currentPath（表示中フォルダ）
   */
  function getEffectiveSavePath() {
    if (destMode === "suggest" && selectedPath) return selectedPath;
    return currentPath;
  }

  updateSaveButton();

  function updatePathDisplay(path) {
    const el = document.getElementById("selected-path-display");
    const effective = path || getEffectiveSavePath();
    if (effective) {
      el.textContent = effective;
      el.classList.remove("unset");
    } else if (lastSaveDir) {
      el.textContent = `前回: ${lastSaveDir}`;
      el.classList.add("unset");
    } else {
      el.textContent = "フォルダが選択されていません";
      el.classList.add("unset");
    }
  }

  updatePathDisplay(selectedPath);

  // ---- 表示切り替えボタン（①前回の表示形式を反映） ----
  const viewButtons = {
    list:   document.getElementById("vbtn-list"),
    detail: document.getElementById("vbtn-detail"),
    tile:   document.getElementById("vbtn-tile"),
  };

  // 初期アクティブ状態を savedViewMode に合わせる
  Object.entries(viewButtons).forEach(([mode, btn]) => {
    btn.classList.toggle("active", mode === viewMode);
  });

  Object.entries(viewButtons).forEach(([mode, btn]) => {
    btn.addEventListener("click", () => {
      if (viewMode === mode) return;
      viewMode = mode;
      Object.values(viewButtons).forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      // ①変更を storage に保存
      browser.runtime.sendMessage({ type: "SET_EXPLORER_VIEW_MODE", mode });
      const view = document.getElementById("tree-view");
      view.className = `tree-view view-${mode}`;
      if (currentEntries.length > 0 || currentResolvedPath !== null) {
        renderEntries(currentEntries, currentResolvedPath);
      }
    });
  });

  // ================================================================
  // ④ブックマーク描画
  // ================================================================
  function renderBookmarks() {
    const list = document.getElementById("bookmark-list");
    list["innerHTML"] = "";

    if (!bookmarks || bookmarks.length === 0) {
      list["innerHTML"] = `<div class="bookmark-empty">ブックマークがありません</div>`;
      return;
    }

    for (const bm of bookmarks) {
      const row = document.createElement("div");
      row.className = "bookmark-row" + (selectedPath === bm.path ? " selected" : "");
      row["innerHTML"] = `
        <span class="bm-icon">⭐</span>
        <span class="bm-label">${escapeHtml(bm.label || bm.path.split("\\").pop())}</span>
        <span class="bm-path">${escapeHtml(bm.path)}</span>`;

      row.addEventListener("click", () => {
        // 候補モードのときはフォルダ選択モードに切り替える
        if (destMode === "suggest") switchDestMode("explorer");
        // ブックマークをクリックするとそのフォルダへ直接ナビゲート
        const parts = bm.path.split("\\").filter(Boolean);
        const stack = parts.reduce((acc, seg, i) => {
          const p = parts.slice(0, i + 1).join("\\");
          acc.push({ label: seg, path: p });
          return acc;
        }, []);
        navigateTo(bm.path, stack);
      });

      list.appendChild(row);
    }
  }

  renderBookmarks();

  // ================================================================
  // メインタブ（保存先 / 保存履歴）
  // ================================================================
  const mainTabDest    = document.getElementById("main-tab-dest");
  const mainTabHistory = document.getElementById("main-tab-history");
  const panelDest      = document.getElementById("panel-dest");
  const panelHistory   = document.getElementById("panel-history");

  function switchMainTab(tab) {
    if (tab === "dest") {
      mainTabDest.classList.add("active");
      mainTabHistory.classList.remove("active");
      panelDest.classList.add("active");
      panelHistory.classList.remove("active");
      historyFilterWrap.classList.remove("visible");
    } else {
      mainTabHistory.classList.add("active");
      mainTabDest.classList.remove("active");
      panelHistory.classList.add("active");
      panelDest.classList.remove("active");
      historyFilterWrap.classList.add("visible");
    }
  }

  mainTabDest.addEventListener("click",    () => switchMainTab("dest"));
  mainTabHistory.addEventListener("click", () => switchMainTab("history"));

  // ================================================================
  // 保存履歴描画
  // ================================================================
  let historyFilterTag    = ""; // 現在の絞り込みタグ
  let historyFilterAuthor = ""; // 現在の絞り込み作者
  let historyFilterMode   = "and"; // "and" | "or"
  let _historyRenderGen = 0; // renderHistory() の世代番号（非同期競合による二重描画防止）
  let _histPage     = 0;   // 現在ページ（0始まり）
  let _histPageSize = 100; // 1ページの表示件数
  // ストレージから件数設定を非同期で読み込む
  browser.storage.local.get("historyPageSize").then(({ historyPageSize }) => {
    _histPageSize = historyPageSize || 100;
  }).catch(() => {});

  // 絞り込み入力欄の制御
  const historyFilterWrap        = document.getElementById("history-filter-wrap");
  const historyFilterInput       = document.getElementById("history-filter-input");
  const historyFilterClear       = document.getElementById("history-filter-clear");
  const historyAuthorFilter      = document.getElementById("history-author-filter");
  const historyAuthorFilterClear = document.getElementById("history-author-filter-clear");
  const historyFilterModeSelect  = document.getElementById("history-filter-mode");

  function setHistoryFilter(tag) {
    historyFilterTag = tag;
    _histPage = 0;
    historyFilterInput.value = tag;
    historyFilterClear.classList.toggle("visible", tag !== "");
    renderHistory();
  }

  // タグチップクリック：既存フィルタートークンへの追加・除去（トグル）
  function toggleHistoryFilterTag(tag) {
    const tokens = historyFilterTag ? historyFilterTag.split(/\s+/).filter(Boolean) : [];
    const idx = tokens.indexOf(tag);
    if (idx !== -1) {
      tokens.splice(idx, 1);
    } else {
      tokens.push(tag);
    }
    setHistoryFilter(tokens.join(" "));
  }

  function setHistoryAuthorFilter(author) {
    historyFilterAuthor = author;
    _histPage = 0;
    historyAuthorFilter.value = author;
    historyAuthorFilterClear.classList.toggle("visible", author !== "");
    renderHistory();
  }

  historyFilterInput.addEventListener("input", () => {
    historyFilterTag = historyFilterInput.value;
    historyFilterClear.classList.toggle("visible", historyFilterTag !== "");
    renderHistory();
  });
  historyFilterClear.addEventListener("click", () => setHistoryFilter(""));

  historyAuthorFilter.addEventListener("input", () => {
    historyFilterAuthor = historyAuthorFilter.value;
    _histPage = 0;
    historyAuthorFilterClear.classList.toggle("visible", historyFilterAuthor !== "");
    renderHistory();
  });
  historyAuthorFilterClear.addEventListener("click", () => setHistoryAuthorFilter(""));

  if (historyFilterModeSelect) {
    historyFilterModeSelect.addEventListener("change", () => {
      historyFilterMode = historyFilterModeSelect.value;
      _histPage = 0;
      renderHistory();
    });
  }


  function renderHistory() {
    const gen = ++_historyRenderGen; // この呼び出しの世代番号を確保
    const list = document.getElementById("history-list");
    list["innerHTML"] = "";

    // infobar 更新
    const countEl   = document.getElementById("history-count");
    const storageSz = document.getElementById("history-storage-size");
    const idbSz     = document.getElementById("history-idb-size");
    browser.runtime.sendMessage({ type: "GET_STORAGE_SIZE" }).then(r => {
      if (storageSz && r) storageSz.textContent = r.storageSizeStr;
      if (idbSz && r)     idbSz.textContent     = r.idbSizeStr;
    }).catch(() => {});

    if (!saveHistory || saveHistory.length === 0) {
      if (countEl) countEl.textContent = "0 件";
      list["innerHTML"] = `<div class="history-empty">まだ保存履歴がありません</div>`;
      return;
    }

    // フィルタ適用（タグ・作者 絞り込み）
    const filterQ       = historyFilterTag.trim().toLowerCase();
    const filterTokens  = filterQ ? filterQ.split(/\s+/).filter(Boolean) : [];
    const authorQ       = historyFilterAuthor.trim().toLowerCase();
    let filtered        = saveHistory;
    const hasTagFilter  = filterTokens.length > 0;
    const hasAuthFilter = !!authorQ;
    if (hasTagFilter || hasAuthFilter) {
      filtered = filtered.filter(e => {
        const entryTags = (e.tags || []).map(t => t.toLowerCase());
        const tagMatch = !hasTagFilter || (
          historyFilterMode === "and"
            ? filterTokens.every(token => entryTags.some(t => t.includes(token)))
            : filterTokens.some(token => entryTags.some(t => t.includes(token)))
        );
        const authorMatch = !hasAuthFilter || (e.author || "").toLowerCase().includes(authorQ);
        // 両フィルター有効時のみモードを適用。片方のみの場合は active 側の結果をそのまま返す
        if (hasTagFilter && hasAuthFilter) {
          return historyFilterMode === "and" ? (tagMatch && authorMatch) : (tagMatch || authorMatch);
        }
        return tagMatch && authorMatch;
      });
    }
    const isFiltered = hasTagFilter || hasAuthFilter;

    const totalFiltered = filtered.length;
    // ページ範囲を超えないよう補正
    const totalPages = Math.max(1, Math.ceil(totalFiltered / _histPageSize));
    if (_histPage >= totalPages) _histPage = totalPages - 1;

    const pageSlice = filtered.slice(_histPage * _histPageSize, (_histPage + 1) * _histPageSize);

    if (countEl) {
      const suffix = isFiltered ? "（絞り込み中）" : "";
      if (totalFiltered <= _histPageSize) {
        countEl.textContent = `${totalFiltered} 件${suffix}`;
      } else {
        countEl.textContent = `${_histPage + 1}/${totalPages} ページ（全 ${totalFiltered} 件${suffix ? suffix.replace("（", "・") : ""}）`;
      }
    }

    if (filtered.length === 0) {
      list["innerHTML"] = `<div class="history-empty">絞り込み条件に一致する履歴がありません</div>`;
      renderHistoryPager(0);
      return;
    }

    renderHistoryPager(totalFiltered);

    // 表示モード判定（storage.local から非同期取得して再描画）
    browser.storage.local.get("historyDisplayMode").then(({ historyDisplayMode }) => {
      // 古い世代の呼び出しは描画しない（二重描画防止）
      if (gen !== _historyRenderGen) return;
      const mode = historyDisplayMode || "normal";
      if (mode === "group") {
        _renderHistoryGrouped(list, pageSlice);
      } else {
        _renderHistoryNormal(list, pageSlice);
      }
    }).catch(() => {
      if (gen !== _historyRenderGen) return;
      _renderHistoryNormal(list, pageSlice);
    });
  }

  function renderHistoryPager(total) {
    const totalPages = Math.max(1, Math.ceil(total / _histPageSize));
    const pagerHtml = total <= _histPageSize ? "" : `
      <button class="history-pager-btn" id="history-pager-prev" ${_histPage === 0 ? "disabled" : ""}>◀ 前へ</button>
      <span class="history-pager-info">${_histPage + 1} / ${totalPages} ページ</span>
      <button class="history-pager-btn" id="history-pager-next" ${_histPage >= totalPages - 1 ? "disabled" : ""}>次へ ▶</button>
      <select class="history-page-size-select" id="history-page-size-select" title="表示件数">
        ${[20,50,100,200].map(n => `<option value="${n}"${n === _histPageSize ? " selected" : ""}>${n}件</option>`).join("")}
      </select>`;

    ["history-pager-top", "history-pager-bottom"].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.innerHTML = pagerHtml;
        if (pagerHtml) {
          el.querySelector("#history-pager-prev")?.addEventListener("click", () => { _histPage--; renderHistory(); });
          el.querySelector("#history-pager-next")?.addEventListener("click", () => { _histPage++; renderHistory(); });
          el.querySelector("#history-page-size-select")?.addEventListener("change", (e) => {
            _histPageSize = parseInt(e.target.value);
            _histPage = 0;
            browser.storage.local.set({ historyPageSize: _histPageSize }).catch(() => {});
            renderHistory();
          });
        }
      }
    });
  }

  /** 通常表示（従来）*/
  function _renderHistoryNormal(list, filtered) {
    for (const entry of filtered) {
      const item = _buildHistoryItem(entry, [entry], filtered);
      list.appendChild(item);
    }
  }

  /** グループ表示：同一 sessionId をまとめて1アイテムに */
  function _renderHistoryGrouped(list, filtered) {
    const groups = [];
    const groupMap = new Map();
    for (const entry of filtered) {
      if (entry.sessionId) {
        if (groupMap.has(entry.sessionId)) {
          groups[groupMap.get(entry.sessionId)].items.push(entry);
        } else {
          groupMap.set(entry.sessionId, groups.length);
          groups.push({ sessionId: entry.sessionId, items: [entry] });
        }
      } else {
        groups.push({ sessionId: null, items: [entry] });
      }
    }

    for (const group of groups) {
      if (!group.sessionId || group.items.length === 1) {
        list.appendChild(_buildHistoryItem(group.items[0], [group.items[0]], filtered));
      } else {
        const first = group.items.at(-1); // 最初に保存した画像（unshiftで末尾が古い）

        // グループ全体ラッパー（通常フローに乗る flex-column コンテナ）
        const wrapper = document.createElement("div");
        wrapper.className = "history-group-wrapper";

        // 先頭タイル：_buildHistoryItem で通常タイルとして生成・幅を固定
        const orderedGroup = [...group.items].reverse(); // 古い順
        const item = _buildHistoryItem(first, orderedGroup, filtered);
        item.classList.add("history-item-group-card");
        item.style.cssText += ";border-color:#e67e22;box-sizing:border-box;";

        // 枚数バッジ
        const badge = document.createElement("div");
        badge.style.cssText = "position:absolute;top:4px;right:6px;z-index:2;font-size:10px;font-weight:700;" +
          "background:#e67e22;color:#fff;padding:1px 7px;border-radius:10px;pointer-events:none;";
        badge.textContent = `${group.items.length}枚`;
        item.appendChild(badge);

        // 展開ボタン（ラッパーの直接子として配置・オーバーレイ外）
        const expandBtn = document.createElement("button");
        expandBtn.className = "history-group-expand-btn";
        expandBtn.textContent = `▶ 展開（${group.items.length}枚）`;

        // 展開エリア（ラッパーの直接子として配置）
        const childrenArea = document.createElement("div");
        childrenArea.className = "history-group-children";

        wrapper.appendChild(item);
        wrapper.appendChild(expandBtn);
        wrapper.appendChild(childrenArea);

        let expanded = false;
        expandBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          expanded = !expanded;
          childrenArea.style.display = expanded ? "flex" : "none";
          expandBtn.textContent = expanded ? `▼ 折りたたむ` : `▶ 展開（${group.items.length}枚）`;
          expandBtn.style.borderRadius = expanded ? "0" : "0 0 8px 8px";
          if (expanded && childrenArea.childElementCount === 0) {
            for (const sub of orderedGroup) {
              childrenArea.appendChild(_buildHistoryItem(sub, orderedGroup, filtered, true));
            }
          }
        });

        list.appendChild(wrapper);
      }
    }
  }

  /** 保存履歴アイテムを構築して返す共通関数 */
  function _buildHistoryItem(entry, groupEntries, allEntries, isGroupChild) {
    // groupEntries: グループ内の全エントリ（古い順）、allEntries: 全履歴（表示順）
    // isGroupChild: 展開後の子タイルかどうか（◀▶の動作が変わる）
      const item = document.createElement("div");
      item.className = "history-item";

      // savePaths（配列）か savePath（旧形式）を正規化
      const paths = Array.isArray(entry.savePaths)
        ? entry.savePaths
        : (entry.savePath ? [entry.savePath] : []);
      const primaryPath = paths[0] ?? "";
      const isMulti = paths.length > 1;

      const savedDate = new Date(entry.savedAt).toLocaleString("ja-JP");
      const activeTokens = historyFilterTag
        ? new Set(historyFilterTag.split(/\s+/).filter(Boolean))
        : new Set();
      const tagHtml = (entry.tags || [])
        .map(t => `<span class="history-tag${activeTokens.has(t.toLowerCase()) ? ' filter-active' : ''}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join("");
      const authorHtml = entry.author
        ? `<span class="history-author${historyFilterAuthor && entry.author.toLowerCase().includes(historyFilterAuthor.toLowerCase()) ? ' filter-active' : ''}" data-author="${escapeHtml(entry.author)}">✏️ ${escapeHtml(entry.author)}</span>`
        : "";

      const pathLabel = isMulti
        ? `${paths.length} 件のフォルダに保存`
        : escapeHtml(primaryPath);
      const pathTitle = isMulti ? paths.join("\n") : primaryPath;

      // pageUrl 表示（ドメインのみ短縮表示・タイトルはフルURL）
      let pageUrlHtml = "";
      if (entry.pageUrl) {
        let displayUrl = entry.pageUrl;
        try { displayUrl = new URL(entry.pageUrl).hostname; } catch {}
        pageUrlHtml = `<a class="history-pageurl"
          title="${escapeHtml(entry.pageUrl)}"
          data-href="${escapeHtml(entry.pageUrl)}">🔗 ${escapeHtml(displayUrl)}</a>`;
      }

      item["innerHTML"] = `
        <div class="history-thumb-placeholder" title="${escapeHtml(pathTitle)}"
          style="cursor:pointer">🖼</div>
        <div class="history-overlay">
          <div class="history-body">
            <div class="history-filename">${escapeHtml(entry.filename)}</div>
            <div class="history-path" title="${escapeHtml(pathTitle)}">${pathLabel}</div>
            ${pageUrlHtml}
            <div class="history-meta">
              <span>${escapeHtml(savedDate)}</span>
              ${authorHtml}
              ${tagHtml}
            </div>
          </div>
          <div class="history-actions">
            <button class="history-btn history-btn-open" title="${escapeHtml(pathTitle)}">
              🗂 保存先フォルダを開く
            </button>
            <button class="history-btn history-btn-open-file" title="${escapeHtml(pathTitle)}">
              🖼 保存した画像を開く
            </button>
            <button class="history-btn history-btn-nav" title="${escapeHtml(pathTitle)}">
              🧭 移動
            </button>
            <button class="history-btn history-btn-addtag" title="タグを追加">🏷️ タグ追加</button>
          </div>
          <div class="history-tag-editor">
            <div class="history-tag-editor-chips"></div>
            <div class="history-tag-editor-input-row">
              <input type="text" class="history-tag-editor-input"
                placeholder="タグを入力..." autocomplete="off" />
              <button class="history-tag-editor-confirm">✔ 保存</button>
              <div class="history-tag-suggestions"></div>
            </div>
          </div>
        </div>`;

      const thumbEl = item.querySelector(".history-thumb-placeholder");

      /** サムネイルクリック時のプレビュー表示 */
      const safeGroup = groupEntries || [entry];
      const safeAll   = allEntries   || [entry];
      const groupIdx  = safeGroup.findIndex(e => e.id === entry.id);
      const globalIdx = safeAll.findIndex(e => e.id === entry.id);

      async function openPreview() {
        showModalLightbox(safeGroup, groupIdx, safeAll, globalIdx, isGroupChild);
      }

      // サムネイル：thumbId → IndexedDB から取得、なければ thumbnailBase64（旧形式）を使用
      if (entry.thumbId) {
        browser.runtime.sendMessage({ type: "GET_THUMB_DATA_URL", id: entry.thumbId })
          .then(({ dataUrl }) => {
            if (!dataUrl) return;
            const img = document.createElement("img");
            img.className = "history-thumb";
            img.src   = dataUrl;
            img.alt   = entry.filename;
            img.title = "クリックでプレビュー";
            img.style.cursor = "zoom-in";
            img.addEventListener("click", openPreview);
            item.insertBefore(img, thumbEl);
            thumbEl.style.display = "none";
          }).catch(() => {});
      } else if (entry.thumbnailBase64) {
        const img = document.createElement("img");
        img.className = "history-thumb";
        img.src   = entry.thumbnailBase64;
        img.alt   = entry.filename;
        img.title = "クリックでプレビュー";
        img.style.cursor = "zoom-in";
        img.addEventListener("click", openPreview);
        item.insertBefore(img, thumbEl);
        thumbEl.style.display = "none";
      } else {
        thumbEl.title = "クリックでプレビュー";
        thumbEl.style.cursor = "zoom-in";
        thumbEl.addEventListener("click", openPreview);
      }

      // pageUrl リンク
      const pageLink = item.querySelector(".history-pageurl");
      if (pageLink) {
        pageLink.addEventListener("click", (e) => {
          e.stopPropagation();
          window.open(pageLink.dataset.href, "_blank");
        });
      }

      item.querySelector(".history-btn-open").addEventListener("click", (e) => {
        e.stopPropagation();
        handleHistoryAction(paths, "open", item);
      });
      item.querySelector(".history-btn-open-file").addEventListener("click", async (e) => {
        e.stopPropagation();
        const p = paths[0];
        if (!p || !entry.filename) { showToast(shadow, "⚠️ 保存先情報が取得できません", true); return; }
        const filePath = p.replace(/[\\/]+$/, "") + "\\" + entry.filename;
        const res = await browser.runtime.sendMessage({ type: "FETCH_FILE_AS_DATAURL", path: filePath });
        if (res?.ok && res.dataUrl) {
          const win = window.open();
          if (win) {
            win.document.write(`<!DOCTYPE html><html><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;">
              <img src="${res.dataUrl}" style="max-width:100%;max-height:100vh;object-fit:contain;" /></body></html>`);
            win.document.close();
          }
        } else {
          showToast(shadow, `⚠️ ファイルを開けませんでした:\n${res?.error || filePath}`, true);
        }
      });
      item.querySelector(".history-btn-nav").addEventListener("click", (e) => {
        e.stopPropagation();
        handleHistoryAction(paths, "nav", item);
      });

      // ---- 🏷️ タグ追加ボタン ----
      const addTagBtn    = item.querySelector(".history-btn-addtag");
      const tagEditor    = item.querySelector(".history-tag-editor");
      const chipsArea    = item.querySelector(".history-tag-editor-chips");
      const tagEditorIn  = item.querySelector(".history-tag-editor-input");
      const confirmBtn   = item.querySelector(".history-tag-editor-confirm");
      const suggestPanel = item.querySelector(".history-tag-suggestions");

      let editorTags = [...(entry.tags || [])];

      function renderEditorChips() {
        chipsArea.innerHTML = "";
        for (const t of editorTags) {
          const chip = document.createElement("span");
          chip.className = "history-tag-editor-chip";
          chip.innerHTML = `${escapeHtml(t)}<button type="button" title="削除">×</button>`;
          chip.querySelector("button").addEventListener("click", (ev) => {
            ev.stopPropagation();
            editorTags = editorTags.filter(x => x !== t);
            renderEditorChips();
          });
          chipsArea.appendChild(chip);
        }
      }

      function showEditorSuggestions(q) {
        const matches = q
          ? existingTags.filter(t => tagMatches(t, q) && !editorTags.includes(t))
          : existingTags.filter(t => !editorTags.includes(t));
        if (!matches.length) { hideEditorSuggestions(); return; }
        suggestPanel.innerHTML = matches.slice(0, 8)
          .map(t => `<div class="suggestion-item" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</div>`)
          .join("");
        suggestPanel.classList.add("visible");
        suggestPanel.querySelectorAll(".suggestion-item").forEach(el => {
          el.addEventListener("mousedown", (ev) => {
            ev.preventDefault();
            if (!editorTags.includes(el.dataset.tag)) {
              editorTags.push(el.dataset.tag);
              renderEditorChips();
            }
            tagEditorIn.value = "";
            hideEditorSuggestions();
            tagEditorIn.focus();
          });
        });
      }

      function hideEditorSuggestions() {
        suggestPanel.classList.remove("visible");
        suggestPanel.innerHTML = "";
      }

      addTagBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const isVisible = tagEditor.classList.contains("visible");
        // 他の開いているエディタをすべて閉じる
        document.querySelectorAll(".history-tag-editor.visible").forEach(el => {
          if (el !== tagEditor) {
            el.classList.remove("visible");
            el.closest(".history-item")?.style && (el.closest(".history-item").style.overflow = "");
          }
        });
        if (isVisible) {
          tagEditor.classList.remove("visible");
          item.style.overflow = "";
        } else {
          editorTags = [...(entry.tags || [])];
          renderEditorChips();
          tagEditor.classList.add("visible");
          item.style.overflow = "visible";
          setTimeout(() => tagEditorIn.focus(), 30);
        }
      });

      tagEditorIn.addEventListener("input", () => {
        if (tagEditorIn.value) showEditorSuggestions(tagEditorIn.value);
        else hideEditorSuggestions();
      });

      tagEditorIn.addEventListener("blur", () => setTimeout(hideEditorSuggestions, 150));

      tagEditorIn.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          const val = tagEditorIn.value.trim();
          if (val && !editorTags.includes(val)) {
            editorTags.push(val);
            renderEditorChips();
          }
          tagEditorIn.value = "";
          hideEditorSuggestions();
        } else if (e.key === "Escape") {
          tagEditor.classList.remove("visible");
          item.style.overflow = "";
          hideEditorSuggestions();
        } else if (e.key === "Backspace" && !tagEditorIn.value && editorTags.length > 0) {
          editorTags.pop();
          renderEditorChips();
        }
      });

      async function saveEditorTags() {
        const pending = tagEditorIn.value.trim();
        if (pending && !editorTags.includes(pending)) editorTags.push(pending);
        const res = await browser.runtime.sendMessage({
          type: "UPDATE_HISTORY_ENTRY_TAGS",
          id:   entry.id,
          tags: editorTags,
        });
        if (res?.ok) {
          entry.tags = [...editorTags];
          const idx = saveHistory.findIndex(h => h.id === entry.id);
          if (idx !== -1) saveHistory[idx].tags = [...editorTags];
          // タイルのタグ表示を更新
          const metaEl = item.querySelector(".history-meta");
          if (metaEl) {
            const dateSpan = metaEl.querySelector("span");
            metaEl.innerHTML = "";
            if (dateSpan) metaEl.appendChild(dateSpan);
            for (const t of editorTags) {
              const span = document.createElement("span");
              span.className = "history-tag";
              span.dataset.tag = t;
              span.textContent = t;
              metaEl.appendChild(span);
            }
          }
          tagEditor.classList.remove("visible");
          item.style.overflow = "";
          tagEditorIn.value = "";
          showToast(shadow, "✅ タグを更新しました");
        } else {
          showToast(shadow, "⚠️ タグ更新に失敗しました", true);
        }
      }

      confirmBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        saveEditorTags();
      });

      return item;
  }

  // タグ・作者クリックでフィルタ適用（history-panel に委譲 → 再描画後も有効）
  document.getElementById("panel-history").addEventListener("click", (e) => {
    if (e.target.classList.contains("history-tag")) {
      const tag = e.target.dataset?.tag;
      if (!tag) return;
      e.stopPropagation();
      toggleHistoryFilterTag(tag);
    } else if (e.target.classList.contains("history-author")) {
      const author = e.target.dataset?.author;
      if (!author) return;
      e.stopPropagation();
      setHistoryAuthorFilter(historyFilterAuthor === author ? "" : author);
    }
  });

  /**
   * 保存履歴のアクション（open / nav）
   * 1件 → 直接実行、複数件 → インラインドロップダウンを表示
   */
  function handleHistoryAction(paths, action, item) {
    const execute = (p) => {
      if (action === "open") {
        browser.runtime.sendMessage({ type: "OPEN_EXPLORER", path: p });
      } else {
        const parts = normalizePath(p).split("\\").filter(Boolean);
        const stack = parts.reduce((acc, seg, i) => {
          acc.push({ label: seg, path: parts.slice(0, i + 1).join("\\") });
          return acc;
        }, []);
        switchMainTab("dest");
        navigateTo(p, stack);
      }
    };

    if (paths.length === 1) { execute(paths[0]); return; }

    // 既存のドロップダウンを閉じる
    document.querySelectorAll(".history-dropdown").forEach(d => d.remove());

    const dd = document.createElement("div");
    dd.className = "history-dropdown";
    const title = action === "open" ? "🗂 エクスプローラーで開く" : "🧭 このフォルダに移動";
    dd["innerHTML"] = `<div class="history-dd-title">${escapeHtml(title)}</div>`;

    for (const p of paths) {
      const row = document.createElement("div");
      row.className = "history-dd-item";
      row.title = p;
      row["innerHTML"] = `<span>📁</span><span class="history-dd-name">${escapeHtml(p.split("\\").pop())}</span><span class="history-dd-path">${escapeHtml(p)}</span>`;
      row.addEventListener("click", (e) => { e.stopPropagation(); dd.remove(); execute(p); });
      dd.appendChild(row);
    }

    item.querySelector(".history-actions").appendChild(dd);
    setTimeout(() => {
      const close = (e) => { if (!dd.contains(e.target)) { dd.remove(); document.removeEventListener("click", close, true); } };
      document.addEventListener("click", close, true);
    }, 0);
  }

  renderHistory();

  // ================================================================
  // エクスプローラーで現在フォルダを開くボタン
  // ================================================================
  document.getElementById("btn-open-current").addEventListener("click", async () => {
    if (!currentPath) return;
    const res = await browser.runtime.sendMessage({ type: "OPEN_EXPLORER", path: currentPath });
    if (!res || !res.ok) {
      showToast(shadow, `❌ フォルダを開けません: ${res?.error || "不明なエラー"}`, true);
    }
  });

  // ---- ⭐ ブックマーク追加ボタン ----
  const btnBookmarkAdd = document.getElementById("btn-bookmark-add");
  const btnNavBack     = document.getElementById("btn-nav-back");
  const btnNavFwd      = document.getElementById("btn-nav-fwd");

  /** 戻る・進むボタンの有効・無効を更新 */
  function updateNavButtons() {
    btnNavBack.disabled = navHistoryIndex <= 0;
    btnNavFwd.disabled  = navHistoryIndex >= navHistory.length - 1;
  }

  btnNavBack.addEventListener("click", () => {
    if (navHistoryIndex <= 0) return;
    navHistoryIndex--;
    const entry = navHistory[navHistoryIndex];
    navigateTo(entry.path, entry.stack, false); // false = 履歴に追加しない
  });

  btnNavFwd.addEventListener("click", () => {
    if (navHistoryIndex >= navHistory.length - 1) return;
    navHistoryIndex++;
    const entry = navHistory[navHistoryIndex];
    navigateTo(entry.path, entry.stack, false);
  });

  /** ボタンの状態（現在のフォルダが登録済みか）を更新 */
  function updateBookmarkBtn() {
    if (!currentPath) {
      // ドライブ一覧表示中はブックマーク対象なし
      btnBookmarkAdd.classList.remove("bookmarked");
      btnBookmarkAdd.title = "フォルダを開くとブックマークできます";
      btnBookmarkAdd.disabled = true;
      return;
    }
    btnBookmarkAdd.disabled = false;
    const already = bookmarks.some((b) => b.path === currentPath);
    btnBookmarkAdd.classList.toggle("bookmarked", already);
    btnBookmarkAdd.title = already
      ? `「${currentPath}」はブックマーク済みです`
      : `「${currentPath}」をブックマークに追加`;
  }

  btnBookmarkAdd.disabled = true; // 初期はドライブ一覧のため無効
  btnBookmarkAdd.addEventListener("click", async () => {
    if (!currentPath) return;
    const alreadyIdx = bookmarks.findIndex((b) => b.path === currentPath);
    if (alreadyIdx >= 0) {
      // ブックマーク解除
      bookmarks.splice(alreadyIdx, 1);
      await browser.runtime.sendMessage({ type: "SET_BOOKMARKS", data: bookmarks });
      updateBookmarkBtn();
      renderBookmarks();
      showToast(shadow, `🚫 ブックマークを解除しました`);
    } else {
      // ブックマーク追加
      bookmarks.push({ id: crypto.randomUUID(), path: currentPath, label: "" });
      await browser.runtime.sendMessage({ type: "SET_BOOKMARKS", data: bookmarks });
      updateBookmarkBtn();
      renderBookmarks();
      showToast(shadow, `⭐ ブックマークに追加しました`);
    }
  });

  // ---- ＋候補 ボタン（表示中フォルダを保存先候補に追加/解除） ----
  const btnAddCandidate = document.getElementById("btn-add-candidate");
  btnAddCandidate.disabled = true;

  /** 候補追加/解除ボタンの状態を更新 */
  async function updateAddCandidateBtn() {
    if (!currentPath || selectedTags.length === 0) {
      btnAddCandidate.disabled = true;
      btnAddCandidate.textContent = "保存先候補に追加";
      btnAddCandidate.title = selectedTags.length === 0
        ? "タグを選択すると候補に追加できます"
        : "フォルダを開くと候補に追加できます";
      return;
    }
    btnAddCandidate.disabled = false;
    // 全タグ登録済みか確認
    const res = await browser.runtime.sendMessage({ type: "GET_TAG_DESTINATIONS" });
    const tagDest = res?.tagDestinations || {};
    const allRegistered = selectedTags.every(tag =>
      (tagDest[tag] || []).some(d => d.path === currentPath)
    );
    if (allRegistered) {
      btnAddCandidate.textContent = "保存先候補から解除";
      btnAddCandidate.title = `「${currentPath}」を選択中タグの候補から解除`;
    } else {
      btnAddCandidate.textContent = "保存先候補に追加";
      btnAddCandidate.title = `「${currentPath}」を選択中タグの候補に追加`;
    }
  }

  btnAddCandidate.addEventListener("click", async () => {
    if (!currentPath || selectedTags.length === 0) return;

    const res = await browser.runtime.sendMessage({ type: "GET_TAG_DESTINATIONS" });
    const tagDest = res?.tagDestinations || {};

    const allRegistered = selectedTags.every(tag =>
      (tagDest[tag] || []).some(d => d.path === currentPath)
    );

    if (allRegistered) {
      // 解除処理
      for (const tag of selectedTags) {
        if (tagDest[tag]) {
          tagDest[tag] = tagDest[tag].filter(d => d.path !== currentPath);
        }
      }
      await browser.runtime.sendMessage({ type: "SET_TAG_DESTINATIONS", data: tagDest });
      for (const tag of selectedTags) {
        tagDestinations[tag] = tagDest[tag];
      }
      refreshCandidatePanel();
      await updateAddCandidateBtn();
      showToast(shadow, `✅ ${selectedTags.length} 件のタグから候補を解除しました`);
    } else {
      // 追加処理（未登録タグのみ）
      const eligible = selectedTags.filter(tag =>
        !(tagDest[tag] || []).some(d => d.path === currentPath)
      );
      let targetTags = eligible;
      if (eligible.length > 1) {
        targetTags = await showTagSelectDialog(eligible, currentPath);
        if (!targetTags || targetTags.length === 0) return;
      }
      let added = 0;
      for (const tag of targetTags) {
        if (!tagDest[tag]) tagDest[tag] = [];
        tagDest[tag].push({ id: crypto.randomUUID(), path: currentPath, label: "" });
        added++;
      }
      await browser.runtime.sendMessage({ type: "SET_TAG_DESTINATIONS", data: tagDest });
      for (const tag of targetTags) {
        tagDestinations[tag] = tagDest[tag];
      }
      refreshCandidatePanel();
      await updateAddCandidateBtn();
      showToast(shadow, `✅ ${added} 件のタグに候補として追加しました`);
    }
  });

  /**
   * タグ選択ダイアログ（複数選択可）を表示し、選択されたタグ配列を返す。
   * キャンセル時は null を返す。
   */
  function showTagSelectDialog(tags, path) {
    return new Promise((resolve) => {
      const root = (shadow instanceof ShadowRoot) ? shadow : document;
      const existing = root.querySelector(".tag-select-dialog-overlay");
      if (existing) existing.remove();

      const overlay = document.createElement("div");
      overlay.className = "tag-select-dialog-overlay";
      overlay.style.cssText = `
        position: fixed; inset: 0; background: rgba(0,0,0,.45);
        z-index: 2147483646; display: flex; align-items: center; justify-content: center;
      `;

      const dialog = document.createElement("div");
      dialog.style.cssText = `
        background: #fff; border-radius: 10px; padding: 20px 24px 16px;
        box-shadow: 0 8px 32px rgba(0,0,0,.28); min-width: 280px; max-width: 380px;
        font-family: "Segoe UI", sans-serif;
      `;

      const shortPath = path.length > 40 ? "..." + path.slice(-37) : path;
      dialog.innerHTML = `
        <div style="font-size:13px;font-weight:700;color:#2c3e50;margin-bottom:6px">候補に追加するタグを選択</div>
        <div style="font-size:11px;color:#888;margin-bottom:12px;word-break:break-all">${escapeHtml(shortPath)}</div>
        <div class="tag-select-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px"></div>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button class="tsd-cancel" style="padding:6px 16px;border-radius:6px;border:1px solid #ddd;background:#f0f0f0;color:#555;cursor:pointer;font-size:13px">キャンセル</button>
          <button class="tsd-ok" style="padding:6px 16px;border-radius:6px;border:none;background:#4a90e2;color:#fff;cursor:pointer;font-size:13px;font-weight:600">追加</button>
        </div>
      `;

      const list = dialog.querySelector(".tag-select-list");
      const checked = new Set(tags); // デフォルト全選択

      for (const tag of tags) {
        const label = document.createElement("label");
        label.style.cssText = `display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#333;
          padding:5px 8px;border-radius:5px;border:1px solid #b0d0f8;background:#eef5ff;transition:all .1s;`;
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.style.accentColor = "#4a90e2";
        cb.addEventListener("change", () => {
          if (cb.checked) { checked.add(tag); label.style.background = "#eef5ff"; label.style.borderColor = "#b0d0f8"; }
          else            { checked.delete(tag); label.style.background = "#fafafa"; label.style.borderColor = "#e0e0e0"; }
          okBtn.disabled = checked.size === 0;
        });
        label.appendChild(cb);
        label.appendChild(document.createTextNode(tag));
        list.appendChild(label);
      }

      const okBtn = dialog.querySelector(".tsd-ok");
      dialog.querySelector(".tsd-cancel").addEventListener("click", () => { overlay.remove(); resolve(null); });
      okBtn.addEventListener("click", () => { overlay.remove(); resolve([...checked]); });
      overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); resolve(null); } });

      overlay.appendChild(dialog);
      // ShadowRoot なら shadow に追加、それ以外（document含む）は document.body に追加
      if (shadow && shadow instanceof ShadowRoot) shadow.appendChild(overlay);
      else document.body.appendChild(overlay);
    });
  }

  // ---- 🔍 絞込ボタン（タグ名でフォルダ一覧をフィルタ） ----
  const btnTagFilter = document.getElementById("btn-tag-filter");
  let tagFilterActive = false;

  function updateTagFilterBtn() {
    if (selectedTags.length === 0 || !currentPath) {
      btnTagFilter.disabled = true;
      btnTagFilter.classList.remove("active");
      tagFilterActive = false;
      return;
    }
    btnTagFilter.disabled = false;
  }

  btnTagFilter.addEventListener("click", () => {
    tagFilterActive = !tagFilterActive;
    btnTagFilter.classList.toggle("active", tagFilterActive);
    if (tagFilterActive) {
      applyTagFilter();
    } else {
      clearTagFilter();
    }
  });

  function applyTagFilter() {
    if (!currentEntries || selectedTags.length === 0) return;
    const keywords = selectedTags.map(t => t.toLowerCase());
    const view = document.getElementById("tree-view");
    view.querySelectorAll(".tree-row").forEach(el => {
      const name = (el.dataset.name || "").toLowerCase();
      const match = keywords.some(k => name.includes(k));
      el.style.display = match ? "" : "none";
    });
    btnTagFilter.title = `絞込中: ${selectedTags.join(", ")}（再クリックで解除）`;
  }

  function clearTagFilter() {
    const view = document.getElementById("tree-view");
    view.querySelectorAll(".tree-row").forEach(el => { el.style.display = ""; });
    btnTagFilter.title = "タグ名でフォルダを絞り込む";
  }

  /** パンくずを描画 */
  function renderBreadcrumb() {
    const bar = document.getElementById("breadcrumb");
    bar["innerHTML"] = "";

    const root = document.createElement("span");
    root.className = "breadcrumb-item" + (breadcrumbStack.length === 0 ? " current" : "");
    root.textContent = "🖥 PC";
    if (breadcrumbStack.length > 0) {
      root.addEventListener("click", () => navigateTo(null, []));
    }
    bar.appendChild(root);

    breadcrumbStack.forEach((item, i) => {
      const sep = document.createElement("span");
      sep.className = "breadcrumb-sep";
      sep.textContent = " › ";
      bar.appendChild(sep);

      const crumb = document.createElement("span");
      const isCurrent = i === breadcrumbStack.length - 1;
      crumb.className = "breadcrumb-item" + (isCurrent ? " current" : "");
      crumb.textContent = item.label;
      if (!isCurrent) {
        crumb.addEventListener("click", () => {
          navigateTo(item.path, breadcrumbStack.slice(0, i + 1));
        });
      }
      bar.appendChild(crumb);
    });
  }

  /**
   * Windowsパスの正規化
   * - 末尾の \ を除去
   * - \\ の連続を \ 1個に統一
   */
  function normalizePath(p) {
    if (!p) return p;
    return p.replace(/\\{2,}/g, "\\").replace(/\\+$/, "");
  }

  /** ディレクトリを読み込んでビューを描画
   *  addToHistory=true（デフォルト）: 履歴に追加
   *  addToHistory=false: 戻る・進む操作時（履歴を変えない）
   */
  async function navigateTo(path, newStack, addToHistory = true) {
    const normalizedPath = normalizePath(path);
    currentPath = normalizedPath;
    breadcrumbStack.length = 0;
    newStack.forEach((s) => breadcrumbStack.push({
      ...s, path: normalizePath(s.path)
    }));

    // フォルダ絞り込みをクリア
    if (folderKwFilter) {
      folderKwFilter = "";
      if (folderKwInput) { folderKwInput.value = ""; }
      if (folderKwClear) { folderKwClear.style.display = "none"; }
    }

    // 履歴管理：addToHistory=true のときのみ記録
    if (addToHistory) {
      // 現在位置より先の履歴を切り捨て（新しい分岐）
      navHistory.splice(navHistoryIndex + 1);
      navHistory.push({ path: normalizedPath, stack: [...breadcrumbStack] });
      navHistoryIndex = navHistory.length - 1;
    }
    updateNavButtons();

    renderBreadcrumb();
    renderLoading();

    const res = await browser.runtime.sendMessage({ type: "LIST_DIR", path: normalizedPath });

    if (!res || !res.ok) {
      renderError(res ? res.error : "ネイティブアプリに接続できません");
      return;
    }

    currentEntries = res.entries;
    currentResolvedPath = normalizePath(res.path);
    renderEntries(currentEntries, currentResolvedPath);
    updatePathDisplay(null);
    updateSaveButton();
    updateBookmarkBtn();
    await updateAddCandidateBtn();
    updateTagFilterBtn();
    if (tagFilterActive) applyTagFilter();
    updateNewFolderTagBtn();
  }

  function renderLoading() {
    const view = document.getElementById("tree-view");
    view["innerHTML"] = `<div class="tree-message">読み込み中…</div>`;
  }

  function renderError(msg) {
    const view = document.getElementById("tree-view");
    view["innerHTML"] = `<div class="tree-message error">⚠ ${escapeHtml(msg)}</div>`;
  }

  // 最後のエントリ（並び順変更時の再描画用）
  let lastEntries = null;
  let lastResolvedPath = undefined;

  /** エントリ一覧を現在の viewMode で描画 */
  function renderEntries(entries, resolvedPath) {
    lastEntries = entries;
    lastResolvedPath = resolvedPath;

    const view = document.getElementById("tree-view");
    view.className = `tree-view view-${viewMode}`;
    view["innerHTML"] = "";

    let dirs = entries.filter((e) => e.isDir);

    // キーワード絞り込み
    if (folderKwFilter) {
      const kw = folderKwFilter.toLowerCase();
      dirs = dirs.filter(e => e.name.toLowerCase().includes(kw));
    }

    // フォルダ並び順を適用
    const [sortKey, sortDir] = currentFolderSort.split("-");
    if (sortKey === "name") {
      // Python側でStrCmpLogicalW（Windowsエクスプローラー互換）でソート済みのため
      // 「名前↑」はそのまま使用、「名前↓」のみ逆順にする
      if (sortDir === "desc") dirs = dirs.slice().reverse();
    } else {
      // 作成日ソートはJS側で処理
      dirs = dirs.slice().sort((a, b) => {
        const va = a.createdAt ?? 0;
        const vb = b.createdAt ?? 0;
        if (va < vb) return sortDir === "asc" ? -1 : 1;
        if (va > vb) return sortDir === "asc" ? 1 : -1;
        return 0;
      });
    }

    if (dirs.length === 0 && !resolvedPath) {
      view["innerHTML"] += `<div class="tree-message">フォルダが見つかりません</div>`;
      return;
    }

    dirs.forEach((entry) => {
      const fullPath = resolvedPath
        ? normalizePath(`${resolvedPath}\\${entry.name}`)
        : entry.name;

      const row = document.createElement("div");
      row.className = "tree-row" + (selectedPath === fullPath ? " selected" : "");
      row.dataset.name = entry.name;

      if (viewMode === "detail") {
        // 詳細表示：大アイコン＋名前＋フルパス
        row["innerHTML"] = `
          <span class="row-icon">📁</span>
          <div class="row-text">
            <span class="row-name">${escapeHtml(entry.name)}</span>
            <span class="row-path">${escapeHtml(fullPath)}</span>
          </div>
          <span class="row-arrow">▶</span>`;
      } else if (viewMode === "tile") {
        // タイル表示：アイコン大＋名前のみ
        row["innerHTML"] = `
          <span class="row-icon">📁</span>
          <span class="row-name">${escapeHtml(entry.name)}</span>`;
      } else {
        // リスト表示（デフォルト）
        row["innerHTML"] = `
          <span class="row-icon">📁</span>
          <span class="row-name">${escapeHtml(entry.name)}</span>
          <span class="row-arrow">▶</span>`;
      }

      row.addEventListener("click", () => {
        // フォルダ遷移時に絞り込みを解除
        if (tagFilterActive) {
          tagFilterActive = false;
          btnTagFilter.classList.remove("active");
          clearTagFilter();
        }
        navigateTo(fullPath, [
          ...breadcrumbStack,
          { label: entry.name, path: fullPath },
        ]);
      });

      view.appendChild(row);
    });

    if (dirs.length === 0 && resolvedPath) {
      const msg = document.createElement("div");
      msg.className = "tree-message";
      msg.textContent = "サブフォルダはありません";
      view.appendChild(msg);
    }

    // フォルダ絞り込み解除後のスクロール位置復元
    if (!folderKwFilter && folderScrollPos > 0) {
      requestAnimationFrame(() => {
        const tv = document.getElementById("tree-view");
        if (tv) tv.scrollTop = folderScrollPos;
      });
    }
  }

  // ③ 初期ロード：優先度設定に従って開始フォルダを決定
  // startPriority === "lastSave": 前回保存先 → 初期フォルダ → PCルート の順で優先
  // startPriority === "rootPath": 初期フォルダ → 前回保存先 → PCルート の順で優先
  const startPath = (() => {
    if (startPriority === "rootPath") {
      return explorerRootPath || lastSaveDir || null;
    }
    // デフォルト "lastSave"
    return lastSaveDir || explorerRootPath || null;
  })();

  if (startPath) {
    const parts = normalizePath(startPath).split("\\").filter(Boolean);
    const stack = parts.reduce((acc, seg, i) => {
      acc.push({ label: seg, path: parts.slice(0, i + 1).join("\\") });
      return acc;
    }, []);
    navigateTo(startPath, stack);
  } else {
    navigateTo(null, []);
  }

  // ================================================================
  // ② 直近タグ描画（左カラム下部）
  // ================================================================
  const recentSection = document.getElementById("recent-tags-section");
  const recentList    = document.getElementById("recent-tags-list");

  if (recentTags && recentTags.length > 0) {
    recentSection.style.display = "";
    // renderRecentTags() は selectedTags 宣言後に定義・呼び出す
  }

  // ---- 新規フォルダ作成 ----
  const newFolderInput = document.getElementById("new-folder-input");
  const newFolderBtn   = document.getElementById("new-folder-btn");

  async function createNewFolder() {
    const name = newFolderInput.value.trim();
    if (!name || !currentPath) {
      if (!currentPath) alert("フォルダを作成するには、まず親フォルダを開いてください");
      return;
    }
    newFolderInput.value = "";

    // ネイティブアプリにフォルダ作成を依頼
    // ※ EXECUTE_SAVE（画像保存用）ではなく専用の MKDIR メッセージを使う
    const newPath = `${currentPath}\\${name}`;
    const res = await browser.runtime.sendMessage({
      type: "MKDIR",
      path: newPath,
    });

    // 作成後に現在ディレクトリを再読み込み
    await navigateTo(currentPath, [...breadcrumbStack]);

    // 新しいフォルダを自動選択
    selectedPath = newPath;
    updatePathDisplay(newPath);
    updateSaveButton();
  }

  newFolderBtn.addEventListener("click", createNewFolder);
  newFolderInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); createNewFolder(); }
  });

  // ---- 🏷 タグ名でフォルダ作成 ----
  const newFolderTagBtn = document.getElementById("new-folder-tag-btn");

  /** タグ名で作成ボタンの有効/無効 */
  function updateNewFolderTagBtn() {
    newFolderTagBtn.disabled = selectedTags.length === 0 || !currentPath;
  }

  newFolderTagBtn.addEventListener("click", async () => {
    if (!currentPath || selectedTags.length === 0) return;

    // 使用するタグ名を決定（1件 → 即作成、複数 → 選択ダイアログ）
    if (selectedTags.length === 1) {
      await createFolderByTagNames([selectedTags[0]]);
    } else {
      showTagFolderDialog(selectedTags);
    }
  });

  /** 選択したタグ名でフォルダを作成または絞り込む */
  async function createFolderByTagNames(tagNames) {
    if (!currentPath) return;
    for (const tagName of tagNames) {
      const newPath = normalizePath(`${currentPath}\\${tagName}`);
      // 既に存在する場合は絞込に切り替え
      const check = await browser.runtime.sendMessage({ type: "LIST_DIR", path: newPath });
      if (check?.ok) {
        // 存在する → 絞込フィルタを適用してそのフォルダを強調
        tagFilterActive = true;
        btnTagFilter.classList.add("active");
        btnTagFilter.title = `絞込中: ${tagName}（再クリックで解除）`;
        const view = document.getElementById("tree-view");
        view.querySelectorAll(".tree-row").forEach(el => {
          const name = (el.dataset.name || "").toLowerCase();
          el.style.display = name.includes(tagName.toLowerCase()) ? "" : "none";
        });
        showToast(shadow, `「${tagName}」は既に存在します。絞込表示に切り替えました`);
      } else {
        // 存在しない → 作成
        await browser.runtime.sendMessage({ type: "MKDIR", path: newPath });
        showToast(shadow, `✅ フォルダ「${tagName}」を作成しました`);
      }
    }
    await navigateTo(currentPath, [...breadcrumbStack]);
  }

  /** 複数タグ選択ダイアログを表示 */
  function showTagFolderDialog(tags) {
    // 既存のダイアログを閉じる
    document.querySelectorAll(".tag-folder-dialog").forEach(d => d.remove());

    const dialog = document.createElement("div");
    dialog.className = "tag-folder-dialog";
    dialog["innerHTML"] = `
      <div class="tfd-title">🏷 作成するタグを選択</div>
      <div class="tfd-list">
        ${tags.map((t, i) => `
          <label class="tfd-item">
            <input type="checkbox" data-tag="${escapeHtml(t)}" checked />
            ${escapeHtml(t)}
          </label>`).join("")}
      </div>
      <div class="tfd-actions">
        <button class="tfd-btn confirm">作成</button>
        <button class="tfd-btn cancel">キャンセル</button>
      </div>`;

    // エクスプローラーの新規フォルダ行の上に表示
    // dest-tabbar-center の直下に表示
    const center = document.querySelector(".dest-tabbar-center");
    if (center) {
      center.parentNode.insertBefore(dialog, center.nextSibling);
    } else {
      document.getElementById("dest-tabbar").appendChild(dialog);
    }

    dialog.querySelector(".tfd-btn.cancel").addEventListener("click", () => dialog.remove());
    dialog.querySelector(".tfd-btn.confirm").addEventListener("click", async () => {
      const checked = [...dialog.querySelectorAll("input[type=checkbox]:checked")]
        .map(cb => cb.dataset.tag);
      dialog.remove();
      if (checked.length > 0) await createFolderByTagNames(checked);
    });
  }

  // ================================================================
  // タグ入力
  // ================================================================
  const selectedTags  = [];
  const selectedSubTags = [];
  let recentSubTagsList = recentSubTags || [];
  const tagInput      = document.getElementById("tag-input");
  const tagArea       = document.getElementById("dest-tabbar-tag-area");
  const suggestionsEl = document.getElementById("suggestions");
  const subTagInput   = document.getElementById("subtag-input");
  const subTagArea    = document.getElementById("dest-tabbar-subtag-area");
  const subSuggestEl  = document.getElementById("subtag-suggestions");

  // ② 直近タグ描画（selectedTags 宣言後に定義することで参照エラーを回避）
  function renderRecentTags() {
    recentList["innerHTML"] = "";
    for (const tag of recentTags) {
      const item = document.createElement("div");
      const isActive = selectedTags.includes(tag);
      item.className = "recent-tag-item" + (isActive ? " active" : "");
      item["innerHTML"] = `<span class="recent-tag-icon">${isActive ? "✅" : "🏷"}</span>${escapeHtml(tag)}`;
      item.title = isActive ? "追加済み（クリックで削除）" : "クリックで追加";

      item.addEventListener("click", () => {
        if (selectedTags.includes(tag)) {
          // 追加済みなら削除
          const idx = selectedTags.indexOf(tag);
          selectedTags.splice(idx, 1);
          // チップも削除
          tagArea.querySelectorAll(".tag-chip").forEach((chip) => {
            if (chip.textContent.replace("×", "").trim() === tag) chip.remove();
          });
          refreshCandidatePanel();
          renderRecentTags();
          // タグが0件になったら候補で選んでいた保存先をリセット
          if (selectedTags.length === 0 && destMode === "suggest") {
            selectedPath = null;
            updatePathDisplay(null);
            updateSaveButton();
          }
          updateAddCandidateBtn();
          updateTagFilterBtn();
          updateNewFolderTagBtn();
        } else {
          addTag(tag);
          renderRecentTags();
        }
      });

      recentList.appendChild(item);
    }
  }

  // 直近タグがあれば左カラムに表示
  if (recentTags && recentTags.length > 0) {
    recentSection.style.display = "";
    renderRecentTags();
  }

  // ================================================================
  // 保存先候補パネル
  // ================================================================
  const destPanel      = document.getElementById("dest-panel");
  const destCandidates = document.getElementById("dest-candidates");
  const destTabbar     = document.getElementById("dest-tabbar");
  const destTabSuggest  = document.getElementById("dest-tab-suggest");
  const destTabExplorer = document.getElementById("dest-tab-explorer");

  // 初期状態：タブバーを常時表示、タグが0件なのでタブボタンは非表示
  destTabbar.classList.add("visible");
  destTabSuggest.style.display  = "none";
  destTabExplorer.style.display = "none";
  const explorerSection = document.getElementById("explorer-wrapper");
  const destMultiFooter = document.getElementById("dest-multi-footer");
  const destMultiCount  = document.getElementById("dest-multi-count");
  const btnMultiSave    = document.getElementById("btn-multi-save");

  // 複数選択された候補パス（Set）
  const selectedPaths = new Set();

  /**
   * 現在のタグ配列に関連する保存先候補をすべて収集して返す。
   * 同じパスが複数タグに紐付いている場合は統合し、関連タグを付記する。
   */
  function collectCandidates(tags) {
    // path → { id, path, label, relatedTags[] } のマップで重複除去
    const map = new Map();
    for (const tag of tags) {
      const dests = tagDestinations[tag] || [];
      for (const d of dests) {
        if (!map.has(d.path)) {
          map.set(d.path, { ...d, relatedTags: [tag] });
        } else {
          map.get(d.path).relatedTags.push(tag);
        }
      }
    }
    return Array.from(map.values());
  }

  /** 候補パネルを更新する（タグ追加・削除のたびに呼ぶ） */
  function refreshCandidatePanel() {
    const candidates = collectCandidates(selectedTags);

    if (selectedTags.length === 0) {
      // タグ0個：タブバーは表示したまま（タグ入力欄を含むため）、タブボタンだけ隠す
      destTabbar.classList.add("visible");
      destTabSuggest.style.display = "none";
      destTabExplorer.style.display = "none";
      destPanel.classList.remove("visible");
      explorerSection.style.display = "flex";
      // 複数選択もリセット
      selectedPaths.clear();
      destMultiFooter.style.display = "none";
      return;
    }

    // タグ1個以上：タブボタンを表示してモードを確定
    destTabbar.classList.add("visible");
    destTabSuggest.style.display = "";
    destTabExplorer.style.display = "";
    switchDestMode(destMode);

    // 候補リストを描画
    renderCandidateList(candidates);

    // 候補が0件の場合は自動的に explorer モードへ
    if (candidates.length === 0 && destMode === "suggest") {
      switchDestMode("explorer");
    }

    // ---- 候補が1件のみの場合は自動チェック ----
    if (candidates.length === 1 && destMode === "suggest") {
      const onlyPath = candidates[0].path;
      if (!selectedPaths.has(onlyPath)) {
        selectedPaths.add(onlyPath);
        updateMultiFooter();
        // チェックボックスのUI反映
        const item = destCandidates.querySelector(".dest-candidate-item");
        if (item) {
          item.classList.add("selected");
          const chk = item.querySelector(".dest-cand-check");
          if (chk) chk.checked = true;
        }
      }
    }
  }

  /** 複数選択フッターの表示を更新 */
  function updateMultiFooter() {
    const count = selectedPaths.size;
    if (count === 0) {
      destMultiFooter.style.display = "none";
    } else {
      destMultiFooter.style.display = "flex";
      destMultiCount.textContent = `${count} 件選択中`;
      btnMultiSave.disabled = false;
    }
  }

  /** 候補リストのDOM描画（複数選択対応） */
  function renderCandidateList(candidates) {
    destCandidates["innerHTML"] = "";

    if (candidates.length === 0) {
      destCandidates["innerHTML"] =
        `<div class="dest-empty">このタグに関連する保存先がまだありません</div>`;
      updateMultiFooter();
      return;
    }

    for (const cand of candidates) {
      const isSelected = selectedPaths.has(cand.path);
      const item = document.createElement("div");
      item.className = "dest-candidate-item" + (isSelected ? " selected" : "");

      const labelText  = cand.label || cand.path.split("\\").pop();
      const isAutoLabel = !cand.label;

      item["innerHTML"] = `
        <div class="dest-cand-check">${isSelected ? "✓" : ""}</div>
        <span class="dest-cand-icon">📁</span>
        <div class="dest-cand-text">
          <div class="dest-cand-label ${isAutoLabel ? "no-label" : ""}">${escapeHtml(labelText)}</div>
          <div class="dest-cand-path">${escapeHtml(cand.path)}</div>
          <div class="dest-cand-tags">
            ${cand.relatedTags.map(t => `<span class="dest-cand-tag">${escapeHtml(t)}</span>`).join("")}
          </div>
        </div>
        <button class="btn-open-explorer" title="パスを編集">✏️</button>
        <button class="btn-open-explorer" title="エクスプローラーで開く">📂</button>`;

      // ✏️ 編集ボタン
      item.querySelectorAll(".btn-open-explorer")[0].addEventListener("click", (e) => {
        e.stopPropagation();
        // インライン編集フォームを表示
        item.classList.add("editing");
        const textDiv = item.querySelector(".dest-cand-text");
        const origHTML = textDiv.innerHTML;

        textDiv["innerHTML"] = `
          <div class="dest-cand-edit-form">
            <input class="dest-cand-edit-input" value="${escapeHtml(cand.path)}"
              placeholder="新しいパスを入力..." />
            <div class="dest-cand-edit-actions">
              <button class="dest-cand-edit-btn save">保存</button>
              <button class="dest-cand-edit-btn cancel">キャンセル</button>
            </div>
          </div>`;

        const input = textDiv.querySelector(".dest-cand-edit-input");
        input.focus();
        input.select();

        // キャンセル
        textDiv.querySelector(".dest-cand-edit-btn.cancel").addEventListener("click", (ev) => {
          ev.stopPropagation();
          renderCandidateList(collectCandidates(selectedTags));
        });

        // 保存
        const saveEdit = async (ev) => {
          if (ev) ev.stopPropagation();
          const newPath = normalizePath(input.value.trim());
          if (!newPath || newPath === cand.path) {
            renderCandidateList(collectCandidates(selectedTags));
            return;
          }
          // tagDestinations の全タグでこのパスを更新
          const res = await browser.runtime.sendMessage({ type: "GET_TAG_DESTINATIONS" });
          const td  = res?.tagDestinations || {};
          let updated = false;
          for (const tag of Object.keys(td)) {
            const idx = td[tag].findIndex(d => d.path === cand.path);
            if (idx >= 0) {
              td[tag][idx] = { ...td[tag][idx], path: newPath };
              updated = true;
            }
          }
          if (updated) {
            await browser.runtime.sendMessage({ type: "SET_TAG_DESTINATIONS", data: td });
            // ローカル更新
            for (const tag of Object.keys(td)) {
              tagDestinations[tag] = td[tag];
            }
            // selectedPaths も更新
            if (selectedPaths.has(cand.path)) {
              selectedPaths.delete(cand.path);
              selectedPaths.add(newPath);
            }
            showToast(shadow, `✅ パスを更新しました`);
          }
          renderCandidateList(collectCandidates(selectedTags));
        };

        textDiv.querySelector(".dest-cand-edit-btn.save").addEventListener("click", saveEdit);
        input.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); saveEdit(); }
          if (ev.key === "Escape") { ev.preventDefault(); renderCandidateList(collectCandidates(selectedTags)); }
        });
      });

      // 📂 エクスプローラーで開くボタン
      item.querySelectorAll(".btn-open-explorer")[1].addEventListener("click", async (e) => {
        e.stopPropagation();
        await browser.runtime.sendMessage({ type: "OPEN_EXPLORER", path: cand.path });
      });

      item.addEventListener("click", (e) => {
        // 編集中はクリックでの選択を無効
        if (item.classList.contains("editing")) return;

        if (selectedPaths.has(cand.path)) {
          selectedPaths.delete(cand.path);
        } else {
          selectedPaths.add(cand.path);
        }

        selectedPath = selectedPaths.size > 0 ? [...selectedPaths][0] : null;
        updatePathDisplay(selectedPath);
        updateSaveButton();
        updateMultiFooter();
        renderCandidateList(collectCandidates(selectedTags));

        const p = cand.path;
        const parts = normalizePath(p).split("\\").filter(Boolean);
        const stack = parts.reduce((acc, seg, i) => {
          acc.push({ label: seg, path: parts.slice(0, i + 1).join("\\") });
          return acc;
        }, []);
        navigateTo(p, stack);
      });

      destCandidates.appendChild(item);
    }

    updateMultiFooter();
  }

  /** 候補/エクスプローラーのモード切り替え（右カラム全体を排他使用） */
  function switchDestMode(mode) {
    destMode = mode;
    if (mode === "suggest") {
      destTabSuggest.classList.add("active");
      destTabExplorer.classList.remove("active");
      destPanel.classList.add("visible");
      explorerSection.style.display = "none";
    } else {
      destTabExplorer.classList.add("active");
      destTabSuggest.classList.remove("active");
      destPanel.classList.remove("visible");
      explorerSection.style.display = "flex";
    }
    // モード切替後にパス表示と保存ボタンを更新
    updatePathDisplay(null);
    updateSaveButton();
  }

  destTabSuggest.addEventListener("click",  () => switchDestMode("suggest"));
  destTabExplorer.addEventListener("click", () => switchDestMode("explorer"));

  // 初期状態：エクスプローラー表示（flex）・候補パネル非表示
  explorerSection.style.display = "flex";

  function addTag(value) {
    const tag = value.trim();
    if (!tag || selectedTags.includes(tag)) return;
    selectedTags.push(tag);
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip["innerHTML"] = `${escapeHtml(tag)}<button type="button" title="削除">×</button>`;
    tagArea.insertBefore(chip, tagInput);
    chip.querySelector("button").addEventListener("click", () => {
      chip.remove();
      selectedTags.splice(selectedTags.indexOf(tag), 1);
      refreshCandidatePanel();
      if (recentTags && recentTags.length > 0) renderRecentTags();
      if (selectedTags.length === 0 && destMode === "suggest") {
        selectedPath = null;
        updatePathDisplay(null);
        updateSaveButton();
      }
      updateAddCandidateBtn();
      updateTagFilterBtn();
      updateNewFolderTagBtn();
    });
    tagInput.value = "";
    hideSuggestions();
    refreshCandidatePanel();
    if (recentTags && recentTags.length > 0) renderRecentTags();
    updateAddCandidateBtn();
    updateTagFilterBtn();
    updateNewFolderTagBtn();
  }

  function addSubTag(value) {
    const tag = value.trim();
    if (!tag || selectedSubTags.includes(tag)) return;
    selectedSubTags.push(tag);
    const chip = document.createElement("span");
    chip.className = "tag-chip";
    chip.style.cssText = "background:#ede9f9;border-color:#c3b1e1;color:#5a3fa0;";
    chip["innerHTML"] = `${escapeHtml(tag)}<button type="button" title="削除">×</button>`;
    subTagArea.insertBefore(chip, subTagInput);
    chip.querySelector("button").addEventListener("click", () => {
      chip.remove();
      selectedSubTags.splice(selectedSubTags.indexOf(tag), 1);
    });
    subTagInput.value = "";
    hideSubSuggestions();
    // サブタグ直近リストを更新
    browser.runtime.sendMessage({ type: "UPDATE_RECENT_SUBTAGS", tags: [tag] }).catch(() => {});
    recentSubTagsList = [tag, ...recentSubTagsList.filter(t => t !== tag)].slice(0, 20);
  }

  function showSubSuggestions(q) {
    const matches = q
      ? (recentSubTagsList).filter(t => tagMatches(t, q) && !selectedSubTags.includes(t))
      : (recentSubTagsList).filter(t => !selectedSubTags.includes(t));
    if (!matches.length) { hideSubSuggestions(); return; }
    subSuggestEl["innerHTML"] = matches.slice(0, 8)
      .map((t, i) => `<div class="suggestion-item" data-index="${i}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</div>`)
      .join("");
    subSuggestEl.classList.add("visible");
    subSuggestEl.querySelectorAll(".suggestion-item").forEach(el => {
      el.addEventListener("mousedown", e => {
        e.preventDefault();
        addSubTag(el.dataset.tag);
        subTagInput.focus();
      });
    });
  }

  function hideSubSuggestions() {
    subSuggestEl.classList.remove("visible");
    subSuggestEl["innerHTML"] = "";
  }

  // サブタグ入力イベント
  subTagInput.title = "Enter でサブタグを設定";
  subTagInput.addEventListener("input", () => {
    if (subTagInput.value) showSubSuggestions(subTagInput.value);
    else hideSubSuggestions();
  });
  subTagInput.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      if (subTagInput.value.trim()) {
        e.preventDefault();
        addSubTag(subTagInput.value);
      }
    }
    if (e.key === "Escape") { hideSubSuggestions(); subTagInput.blur(); }
  });
  subTagInput.addEventListener("focus", () => {
    if (!subTagInput.value && recentTags.length > 0) {
      showSubSuggestions("");
    }
  });
  subTagInput.addEventListener("blur", () => { setTimeout(hideSubSuggestions, 150); });
  subTagArea.addEventListener("click", () => subTagInput.focus());

  /** ひらがな⇔カタカナ相互変換して両方でマッチする */
  function toHiragana(str) {
    return str.replace(/[\u30A1-\u30F6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
  }
  function toKatakana(str) {
    return str.replace(/[\u3041-\u3096]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60));
  }
  /** 全角英数記号→半角 */
  function toHalfWidth(str) {
    return str.replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
              .replace(/\u3000/g, " ");
  }
  /** 半角英数記号→全角 */
  function toFullWidth(str) {
    return str.replace(/[\u0021-\u007E]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0))
              .replace(/ /g, "\u3000");
  }
  function tagMatches(tag, q) {
    const tL  = tag.toLowerCase();
    const qL  = q.toLowerCase();
    // 全角・半角の両方に正規化してマッチ
    const tH  = toHalfWidth(toHiragana(tL));
    const qH  = toHalfWidth(toHiragana(qL));
    const tK  = toHalfWidth(toKatakana(tL));
    const qK  = toHalfWidth(toKatakana(qL));
    const tFH = toFullWidth(toHiragana(tL));
    const qFH = toFullWidth(toHiragana(qL));
    const tFK = toFullWidth(toKatakana(tL));
    const qFK = toFullWidth(toKatakana(qL));
    const tHalf = toHalfWidth(tL);
    const qHalf = toHalfWidth(qL);
    if (q.length >= 2) {
      return tHalf.includes(qHalf) || tH.includes(qH) || tK.includes(qK) ||
             tFH.includes(qFH)     || tFK.includes(qFK);
    } else {
      return tHalf.startsWith(qHalf) || tH.startsWith(qH) || tK.startsWith(qK);
    }
  }

  function showSuggestions(q) {
    const matches = existingTags.filter(
      (t) => tagMatches(t, q) && !selectedTags.includes(t)
    );
    if (!matches.length) { hideSuggestions(); return; }
    suggestionsEl["innerHTML"] = matches.slice(0, 8)
      .map((t, i) => `<div class="suggestion-item" data-index="${i}" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</div>`)
      .join("");
    suggestionsEl.classList.add("visible");
    suggestionsEl.querySelectorAll(".suggestion-item").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        addTag(el.dataset.tag);
        tagInput.focus();
      });
    });
  }

  function hideSuggestions() {
    suggestionsEl.classList.remove("visible");
    suggestionsEl["innerHTML"] = "";
  }

  /**
   * currentPath に関連付けられたタグをサジェスト表示する。
   * タグ入力フォーカス時かつ入力が空の場合に呼ばれる。
   */
  function showFolderTagSuggestions() {
    if (!currentPath) return;
    // tagDestinations を逆引き：currentPath を持つタグを列挙
    const relatedTags = Object.entries(tagDestinations)
      .filter(([, dests]) => dests.some((d) => d.path === currentPath))
      .map(([tag]) => tag)
      .filter((t) => !selectedTags.includes(t));
    if (!relatedTags.length) return;
    suggestionsEl["innerHTML"] = relatedTags.slice(0, 8)
      .map((t, i) => `<div class="suggestion-item" data-index="${i}" data-tag="${escapeHtml(t)}">🔗 ${escapeHtml(t)}</div>`)
      .join("");
    suggestionsEl.classList.add("visible");
    suggestionsEl.querySelectorAll(".suggestion-item").forEach((el) => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        addTag(el.dataset.tag);
        tagInput.focus();
      });
    });
  }

  function moveSuggestionActive(dir) {
    const items = suggestionsEl.querySelectorAll(".suggestion-item");
    if (!items.length) return;
    const cur = suggestionsEl.querySelector(".suggestion-item.active");
    let idx = -1;
    items.forEach((el, i) => { if (el === cur) idx = i; });
    items.forEach((el) => el.classList.remove("active"));
    items[(idx + dir + items.length) % items.length].classList.add("active");
  }

  tagInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const active = suggestionsEl.querySelector(".suggestion-item.active");
      if (active) {
        addTag(active.dataset.tag);
      } else if (tagInput.value.trim()) {
        addTag(tagInput.value);
      } else if (selectedTags.length > 0) {
        // 入力が空でEnter → タグで絞り込みを実行
        if (!btnTagFilter.disabled) btnTagFilter.click();
      }
    } else if (e.key === "Backspace" && !tagInput.value) {
      tagArea.querySelectorAll(".tag-chip").forEach((c, i, a) => { if (i === a.length - 1) c.remove(); });
      selectedTags.pop();
    } else if (e.key === "ArrowDown") { e.preventDefault(); moveSuggestionActive(1); }
      else if (e.key === "ArrowUp")   { e.preventDefault(); moveSuggestionActive(-1); }
      else if (e.key === "Escape")    { closeModal(); }
  });
  tagInput.title = "Enter でタグを設定";
  tagInput.addEventListener("input", () => {
    if (tagInput.value) {
      showSuggestions(tagInput.value);
    } else {
      hideSuggestions();
    }
  });

  // フォーカス時：入力途中でなければ currentPath に関連付けられたタグをサジェスト表示
  tagInput.addEventListener("focus", () => {
    if (tagInput.value.trim()) return; // 入力途中はスキップ
    showFolderTagSuggestions();
  });
  tagInput.addEventListener("blur",   () => setTimeout(hideSuggestions, 150));
  tagArea.addEventListener("click",   (e) => { if (e.target === tagArea) tagInput.focus(); });

  // ================================================================
  // 閉じる
  // ================================================================
  function closeModal() {
    if (onCleanup) onCleanup();
    window.close();
  }

  /** 保存後最小化用：ウィンドウを閉じずにUIをリセット（closeModalと同じリセット内容） */
  function resetModalUI() {
    // タグをリセット
    selectedTags.length = 0;
    tagArea.querySelectorAll(".tag-chip").forEach(c => c.remove());
    tagInput.value = "";
    hideSuggestions();
    // サブタグをリセット
    selectedSubTags.length = 0;
    subTagArea.querySelectorAll(".tag-chip").forEach(c => c.remove());
    subTagInput.value = "";
    hideSubSuggestions();
    // ファイル名をリセット
    document.getElementById("input-filename").value = "";
    // プレビューをリセット
    const previewEl = document.getElementById("preview");
    if (previewEl) { previewEl.src = ""; previewEl.style.display = "none"; }
    // 保存先をリセット
    selectedPath = null;
    selectedPaths.clear();
    updatePathDisplay(null);
    updateSaveButton();
    refreshCandidatePanel();
    // 直近タグのチェック状態をリセット
    if (recentTags && recentTags.length > 0) renderRecentTags();
  }

  /**
   * 連続保存モード用：ウィンドウを閉じずにUIをリセットして次の保存に備える。
   * background.jsに通知してmodalWindowIdを保持したままにする。
   */
  async function stayOpenForContinuous() {
    // 保存ウィンドウを最小化してバックグラウンドに退避
    try {
      const modalWin = await browser.windows.getCurrent();
      await browser.windows.update(modalWin.id, { state: "minimized" });
    } catch {}

    // ファイル名をリセット
    document.getElementById("input-filename").value = "";

    // サブタグをリセット
    selectedSubTags.length = 0;
    subTagArea.querySelectorAll(".tag-chip").forEach(c => c.remove());
    subTagInput.value = "";
    hideSubSuggestions();

    // プレビューをリセット
    const previewEl = document.getElementById("preview");
    previewEl.src = "";

    // サジェスト・絞り込みをリセット
    hideSuggestions();

    // 保存ボタンを再び無効化（次の画像が来るまで押せない状態に）
    const btnSave = document.getElementById("btn-save");
    btnSave.disabled = true;
    btnSave.textContent = "保存";
    btnMultiSave.disabled = true;
    btnMultiSave.textContent = "選択した候補に保存";
  }

  document.getElementById("overlay").addEventListener("click", (e) => {
    if (e.target === document.getElementById("overlay")) closeModal();
  });

  // ================================================================
  // 保存
  // ================================================================

  /**
   * ページのコンテキストでサムネイルを取得して Base64 を返す。
   * 1. DOM上の <img> から同ホストの画像を探してCanvas描画を試みる
   *    （注: crossOrigin属性なしの外部ドメイン画像はCanvas汚染でエラーになるため
   *          SecurityErrorをキャッチしてフォールバックへ）
   * 2. fetch（credentials:include）で取得を試みる
   * いずれも失敗した場合は null を返し background.js の XHR にフォールバックする
   */
  async function fetchThumbnailInPage(url) {
    try {
      const MAX = 600;

      // ① DOM上の同ホスト <img> を crossOrigin="anonymous" で再ロードしてCanvas描画
      // （crossOriginなしで読み込まれた画像はCanvas汚染でblob取得不可のため再取得）
      let targetImg = null;
      try {
        const urlHostname = new URL(url).hostname;
        const allImgs = [...document.querySelectorAll("img")]
          .filter(el => {
            try { return new URL(el.currentSrc || el.src).hostname === urlHostname; } catch { return false; }
          })
          .filter(el => el.complete && el.naturalWidth > 0);
        targetImg = allImgs.find(el => el.src === url || el.currentSrc === url)
          || allImgs.sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0]
          || null;
      } catch {}

      if (targetImg) {
        // crossOrigin="anonymous" で同URLを再ロード → Canvas汚染を回避
        const reloadedImg = await new Promise((resolve) => {
          const img = new Image();
          img.crossOrigin = "anonymous";
          img.onload  = () => resolve(img);
          img.onerror = () => resolve(null);
          img.src = targetImg.currentSrc || targetImg.src;
          // タイムアウト（2秒）
          setTimeout(() => resolve(null), 2000);
        });

        if (reloadedImg) {
          try {
            const scale = Math.min(MAX / reloadedImg.naturalWidth, MAX / reloadedImg.naturalHeight, 1);
            const w = Math.round(reloadedImg.naturalWidth  * scale);
            const h = Math.round(reloadedImg.naturalHeight * scale);
            const canvas = new OffscreenCanvas(w, h);
            canvas.getContext("2d").drawImage(reloadedImg, 0, 0, w, h);
            const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
            const ab = await jpegBlob.arrayBuffer();
            const bytes = new Uint8Array(ab);
            let binary = "";
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            return { dataUrl: "data:image/jpeg;base64," + btoa(binary), width: w, height: h };
          } catch (canvasErr) {
            console.warn("[ImageSaver] Canvas error after reload:", canvasErr.message);
          }
        } else {
        }
      }

      // ② fetch（credentials:include）で取得
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) return null;
      const blob   = await response.blob();
      const bitmap = await createImageBitmap(blob);
      const scale  = Math.min(MAX / bitmap.width, MAX / bitmap.height, 1);
      const w = Math.round(bitmap.width  * scale);
      const h = Math.round(bitmap.height * scale);
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
      const ab    = await jpegBlob.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let binary  = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return { dataUrl: "data:image/jpeg;base64," + btoa(binary), width: w, height: h };
    } catch (e) {
      console.warn("[ImageSaver] fetchThumbnailInPage error:", e.message);
      return null;
    }
  }

  // ================================================================
  // 連続保存モード
  // ================================================================
  const chkContinuous   = document.getElementById("chk-continuous");
  const continuousBadge = document.getElementById("continuous-badge");

  // セッション状態（ローカル管理）
  let csSession = continuousSession
    ? { ...continuousSession }
    : null; // null = OFF

  // 初期状態を反映
  function applyContinuousState() {
    const active = !!csSession;
    chkContinuous.checked = active;
    continuousBadge.classList.toggle("active", active);
    if (!active) return;

    // タグを引き継ぎ
    if (csSession.tags?.length) {
      for (const t of csSession.tags) {
        if (!selectedTags.includes(t)) addTag(t);
      }
    }
    // サブタグを引き継ぎ
    if (csSession.subTags?.length) {
      for (const t of csSession.subTags) {
        if (!selectedSubTags.includes(t)) addSubTag(t);
      }
    }

    // 候補モードの保存先を引き継ぎ（refreshCandidatePanel後に適用するため少し遅延）
    if (csSession.savePaths?.length || csSession.selectedPath) {
      setTimeout(() => {
        if (csSession.savePaths?.length) {
          for (const p of csSession.savePaths) selectedPaths.add(p);
          selectedPath = [...selectedPaths][0] || null;
          updatePathDisplay(selectedPath);
          updateSaveButton();
          refreshCandidatePanel();
        } else if (csSession.selectedPath) {
          selectedPath = csSession.selectedPath;
          updatePathDisplay(selectedPath);
          updateSaveButton();
        }
      }, 300);
    }
  }
  applyContinuousState();

  chkContinuous.addEventListener("change", async () => {
    if (chkContinuous.checked) {
      // ON にする → 新しいセッション開始
      csSession = {
        id:        crypto.randomUUID(),
        startedAt: new Date().toISOString(),
        tags:      [...selectedTags],
        subTags:   [...selectedSubTags],
        count:     0,
      };
      await browser.runtime.sendMessage({ type: "SET_CONTINUOUS_SESSION", session: csSession });
      continuousBadge.classList.add("active");
    } else {
      // OFF にする → 確認ダイアログ
      chkContinuous.checked = true; // いったん戻す
      const confirmed = await showContinuousEndDialog();
      if (!confirmed) return;
      chkContinuous.checked = false;
      csSession = null;
      await browser.runtime.sendMessage({ type: "SET_CONTINUOUS_SESSION", session: null });
      continuousBadge.classList.remove("active");
    }
  });

  /** 連続保存終了確認ダイアログ */
  function showContinuousEndDialog() {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = `
        position:fixed;inset:0;background:rgba(0,0,0,.5);
        z-index:2147483646;display:flex;align-items:center;justify-content:center;
      `;
      overlay.innerHTML = `
        <div style="background:#fff;border-radius:10px;padding:22px 26px 18px;
          box-shadow:0 8px 32px rgba(0,0,0,.28);max-width:340px;font-family:'Segoe UI',sans-serif;">
          <div style="font-size:14px;font-weight:700;color:#2c3e50;margin-bottom:10px">
            🔴 連続保存モードを終了しますか？
          </div>
          <div style="font-size:13px;color:#666;line-height:1.6;margin-bottom:16px">
            OFFにするとセッションIDが途切れ、次回保存から新しいグループになります。
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button id="cs-cancel" style="padding:6px 16px;border-radius:6px;border:1px solid #ddd;
              background:#f0f0f0;color:#555;cursor:pointer;font-size:13px">キャンセル</button>
            <button id="cs-ok" style="padding:6px 16px;border-radius:6px;border:none;
              background:#e67e22;color:#fff;cursor:pointer;font-size:13px;font-weight:600">終了する</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector("#cs-ok").addEventListener("click", () => { overlay.remove(); resolve(true); });
      overlay.querySelector("#cs-cancel").addEventListener("click", () => { overlay.remove(); resolve(false); });
      overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    });
  }

  /** 連続保存モード中の同名ファイル重複確認ダイアログ */
  function showDuplicateFileDialog(filename, savedAt) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.style.cssText = `
        position:fixed;inset:0;background:rgba(0,0,0,.5);
        z-index:2147483646;display:flex;align-items:center;justify-content:center;
      `;
      overlay.innerHTML = `
        <div style="background:#fff;border-radius:10px;padding:22px 26px 18px;
          box-shadow:0 8px 32px rgba(0,0,0,.28);max-width:360px;font-family:'Segoe UI',sans-serif;">
          <div style="font-size:14px;font-weight:700;color:#2c3e50;margin-bottom:10px">
            ⚠️ 同名のファイルが既に保存されています
          </div>
          <div style="font-size:13px;color:#666;line-height:1.6;margin-bottom:16px">
            <b style="color:#2c3e50">${escapeHtml(filename)}</b> は<br>
            このセッション内で ${escapeHtml(savedAt)} に保存済みです。<br>
            同じページを重複して保存していませんか？
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px">
            <button id="dup-cancel" style="padding:6px 16px;border-radius:6px;border:1px solid #ddd;
              background:#f0f0f0;color:#555;cursor:pointer;font-size:13px">キャンセル</button>
            <button id="dup-ok" style="padding:6px 16px;border-radius:6px;border:none;
              background:#4a90e2;color:#fff;cursor:pointer;font-size:13px;font-weight:600">保存する</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector("#dup-ok").addEventListener("click", () => { overlay.remove(); resolve(true); });
      overlay.querySelector("#dup-cancel").addEventListener("click", () => { overlay.remove(); resolve(false); });
      overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } });
    });
  }

  /** 保存成功後にセッション情報を更新（タグ・保存先を引き継ぎ用に保存） */
  async function updateContinuousSession(usedTags, usedSubTags, usedSavePaths, usedSelectedPath) {
    if (!csSession) return;
    csSession.count        = (csSession.count || 0) + 1;
    csSession.tags         = usedTags;
    csSession.subTags      = usedSubTags      || [];
    csSession.savePaths    = usedSavePaths    || [];
    csSession.selectedPath = usedSelectedPath || null;
    await browser.runtime.sendMessage({ type: "SET_CONTINUOUS_SESSION", session: csSession });
  }

  // ---- 一括保存ボタン（候補複数選択時） ----
  btnMultiSave.addEventListener("click", async () => {
    if (selectedPaths.size === 0) return;
    const filename = document.getElementById("input-filename").value.trim() || defaultFilename;
    if (tagInput.value.trim()) addTag(tagInput.value);

    // ---- 連続保存モード：同名ファイルの重複確認 ----
    if (csSession) {
      const dupEntry = saveHistory.find(e =>
        e.sessionId === csSession.id && e.filename === filename
      );
      if (dupEntry) {
        const dupDate = new Date(dupEntry.savedAt).toLocaleString("ja-JP");
        const proceed = await showDuplicateFileDialog(filename, dupDate);
        if (!proceed) return;
      }
    }

    btnMultiSave.disabled = true;
    btnMultiSave.textContent = "保存中…";

    // ページコンテキストでサムネイル取得（pixiv 等のクッキー認証に対応）
    const thumb = await fetchThumbnailInPage(imageUrl);

    const result = await browser.runtime.sendMessage({
      type: "EXECUTE_SAVE_MULTI",
      payload: {
        imageUrl, filename,
        savePaths: [...selectedPaths], tags: [...selectedTags],
        subTags:   [...selectedSubTags],
        author:  document.getElementById("author-input")?.value.trim() || "",
        pageUrl: pageUrl || null,
        // サブタグはtagsにマージして送信（管理は同一）
        thumbDataUrl: thumb?.dataUrl   || null,
        thumbWidth:   thumb?.width     || null,
        thumbHeight:  thumb?.height    || null,
        skipTagRecord: destMode === "suggest",
        sessionId:    csSession?.id    || null,
        sessionIndex: csSession ? (csSession.count + 1) : null,
      },
    });

    if (result && result.success && result.failCount === 0) {
      await updateContinuousSession([...selectedTags], [...selectedSubTags], [...selectedPaths], null);
      if (csSession) {
        await stayOpenForContinuous();
      } else {
        const { minimizeAfterSave } = await browser.storage.local.get("minimizeAfterSave");
        if (minimizeAfterSave) {
          btnMultiSave.disabled = false;
          resetModalUI();
          const wins = await browser.windows.getCurrent();
          await browser.windows.update(wins.id, { state: "minimized" });
        } else {
          showToast(shadow, `✅ ${result.successCount} 件に保存しました`);
          setTimeout(closeModal, 1400);
        }
      }
    } else if (result && result.success) {
      const fails = result.results.filter(r => !r.ok)
        .map(r => `・${r.savePath.split("\\").pop()}：${r.error}`).join("\n");
      showToast(shadow, `⚠️ ${result.successCount} 件成功・${result.failCount} 件失敗\n${fails}`, true);
      btnMultiSave.disabled = false;
      btnMultiSave.textContent = "選択した候補に保存";
    } else {
      showToast(shadow, `❌ 保存に失敗しました: ${result?.error || "不明なエラー"}`, true);
      btnMultiSave.disabled = false;
      btnMultiSave.textContent = "選択した候補に保存";
    }
  });
  document.getElementById("btn-save").addEventListener("click", async () => {
    const savePath = getEffectiveSavePath();
    if (!savePath) return;

    // ---- タグ絞り込み中の警告 ----
    if (tagFilterActive) {
      showToast(null,
        "⚠️ タグで絞り込み中です。\n表示されているフォルダ内のみが対象となっています。\n意図したフォルダを選択しているか確認してください。",
        true
      );
      return;
    }

    const filename = document.getElementById("input-filename").value.trim() || defaultFilename;
    if (tagInput.value.trim()) addTag(tagInput.value);

    // ---- 連続保存モード：同名ファイルの重複確認 ----
    if (csSession) {
      const dupEntry = saveHistory.find(e =>
        e.sessionId === csSession.id && e.filename === filename
      );
      if (dupEntry) {
        const dupDate = new Date(dupEntry.savedAt).toLocaleString("ja-JP");
        const proceed = await showDuplicateFileDialog(filename, dupDate);
        if (!proceed) return;
      }
    }

    const btn = document.getElementById("btn-save");
    btn.disabled = true;
    btn.textContent = "確認中…";

    // ---- 保存先フォルダの存在チェック ----
    const checkRes = await browser.runtime.sendMessage({ type: "LIST_DIR", path: savePath });
    if (!checkRes || !checkRes.ok) {
      // フォルダが存在しない or アクセス不可
      showToast(shadow,
        `⚠️ 保存先フォルダが見つかりません:\n${savePath}`,
        true
      );
      btn.disabled = false;
      btn.textContent = "保存";
      return;
    }

    btn.textContent = "保存中…";

    // ページコンテキストでサムネイル取得（pixiv 等のクッキー認証に対応）
    const thumb = await fetchThumbnailInPage(imageUrl);

    const result = await browser.runtime.sendMessage({
      type: "EXECUTE_SAVE",
      payload: {
        imageUrl, filename, savePath,
        tags:    [...selectedTags],
        subTags: [...selectedSubTags],
        author:  document.getElementById("author-input")?.value.trim() || "",
        pageUrl: pageUrl || null,
        thumbDataUrl: thumb?.dataUrl   || null,
        thumbWidth:   thumb?.width     || null,
        thumbHeight:  thumb?.height    || null,
        skipTagRecord: destMode === "suggest",
        sessionId:    csSession?.id    || null,
        sessionIndex: csSession ? (csSession.count + 1) : null,
      },
    });

    if (result && result.success) {
      await updateContinuousSession([...selectedTags], [...selectedSubTags], [...selectedPaths], selectedPath);
      if (csSession) {
        await stayOpenForContinuous();
      } else {
        const { minimizeAfterSave } = await browser.storage.local.get("minimizeAfterSave");
        if (minimizeAfterSave) {
          btn.disabled = false;
          btn.textContent = "保存";
          resetModalUI();
          const wins = await browser.windows.getCurrent();
          await browser.windows.update(wins.id, { state: "minimized" });
        } else {
          showToast(shadow, "✅ 保存しました");
          setTimeout(closeModal, 1200);
        }
      }
    } else {
      showToast(shadow, `❌ 保存に失敗: ${result?.error || "不明なエラー"}`, true);
      btn.disabled = false;
      btn.textContent = "保存";
    }
  });

  // ヘッダーのファイル名入力欄に初期値をセット（テンプレートリテラルのvalue属性は動作しないため）
  const filenameInput = document.getElementById("input-filename");
  filenameInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const btnSave = document.getElementById("btn-save");
    if (!btnSave.disabled) btnSave.click();
  });
  // ================================================================
  // 作者入力欄
  // ================================================================
  const authorInput       = document.getElementById("author-input");
  const authorInputClear  = document.getElementById("author-input-clear");
  const authorSuggestEl   = document.getElementById("author-suggestions");
  const allAuthors        = [...new Set([...(recentAuthors || []), ...(globalAuthors || [])])];

  function showAuthorSuggestions(q) {
    const matches = q
      ? allAuthors.filter(a => a.toLowerCase().includes(q.toLowerCase()))
      : allAuthors;
    if (!matches.length) { hideAuthorSuggestions(); return; }
    authorSuggestEl.innerHTML = matches.slice(0, 8).map(a =>
      `<div style="padding:5px 9px;cursor:pointer;color:#1a1a1a;" data-author="${escapeHtml(a)}">${escapeHtml(a)}</div>`
    ).join("");
    authorSuggestEl.style.display = "block";
    authorSuggestEl.querySelectorAll("[data-author]").forEach(el => {
      el.addEventListener("mouseenter", () => el.style.background = "#f0f4ff");
      el.addEventListener("mouseleave", () => el.style.background = "");
      el.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        authorInput.value = el.dataset.author;
        authorInputClear.style.display = "";
        hideAuthorSuggestions();
      });
    });
  }

  function hideAuthorSuggestions() {
    authorSuggestEl.style.display = "none";
    authorSuggestEl.innerHTML = "";
  }

  if (authorInput) {
    authorInput.addEventListener("input", () => {
      authorInputClear.style.display = authorInput.value ? "" : "none";
      showAuthorSuggestions(authorInput.value);
    });
    authorInput.addEventListener("focus", () => showAuthorSuggestions(authorInput.value));
    authorInput.addEventListener("blur", () => setTimeout(hideAuthorSuggestions, 150));
    authorInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { authorInput.value = ""; authorInputClear.style.display = "none"; hideAuthorSuggestions(); }
    });
    authorInputClear.addEventListener("click", () => {
      authorInput.value = ""; authorInputClear.style.display = "none"; hideAuthorSuggestions();
    });
  }

  // ================================================================
  const colLeft    = document.getElementById("col-left");
  const colResizer = document.getElementById("col-resizer");
  const body       = document.querySelector(".body");

  // 保存済みの幅を復元
  if (modalSize?.colLeftWidth) {
    colLeft.style.width = modalSize.colLeftWidth + "px";
  }

  let resizerDragging = false;
  let resizerStartX   = 0;
  let resizerStartW   = 0;

  colResizer.addEventListener("mousedown", (e) => {
    resizerDragging = true;
    resizerStartX   = e.clientX;
    resizerStartW   = colLeft.getBoundingClientRect().width;
    colResizer.classList.add("dragging");
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!resizerDragging) return;
    const bodyW  = body.getBoundingClientRect().width;
    const newW   = Math.min(
      Math.max(120, resizerStartW + (e.clientX - resizerStartX)),
      bodyW * 0.5
    );
    colLeft.style.width = newW + "px";
  });

  document.addEventListener("mouseup", async () => {
    if (!resizerDragging) return;
    resizerDragging = false;
    colResizer.classList.remove("dragging");
    // 幅を storage に保存（modalSize に統合）
    const w = colLeft.getBoundingClientRect().width;
    const cur = await browser.storage.local.get("modalSize");
    const ms  = cur.modalSize || {};
    ms.colLeftWidth = Math.round(w);
    await browser.storage.local.set({ modalSize: ms });
  });

  // ================================================================
  // プレビューリサイザー（縦方向）
  // ================================================================
  const previewResizer = document.getElementById("preview-resizer");
  const PREVIEW_MIN_H  = 40;
  const PREVIEW_MAX_H  = 400;

  if (modalSize?.previewHeight) {
    previewEl.style.height = modalSize.previewHeight + "px";
  }

  let previewDragging = false;
  let previewStartY   = 0;
  let previewStartH   = 0;

  previewResizer.addEventListener("mousedown", (e) => {
    previewDragging = true;
    previewStartY   = e.clientY;
    previewStartH   = previewEl.getBoundingClientRect().height;
    previewResizer.classList.add("dragging");
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!previewDragging) return;
    const newH = Math.min(
      Math.max(PREVIEW_MIN_H, previewStartH + (e.clientY - previewStartY)),
      PREVIEW_MAX_H
    );
    previewEl.style.height = newH + "px";
  });

  document.addEventListener("mouseup", async () => {
    if (!previewDragging) return;
    previewDragging = false;
    previewResizer.classList.remove("dragging");
    const h   = Math.round(previewEl.getBoundingClientRect().height);
    const cur = await browser.storage.local.get("modalSize");
    const ms  = cur.modalSize || {};
    ms.previewHeight = h;
    await browser.storage.local.set({ modalSize: ms });
  });

  // ================================================================
  filenameInput.value = defaultFilename;
  setTimeout(() => filenameInput.focus(), 50);

}

// ----------------------------------------------------------------
// トースト
// ----------------------------------------------------------------
// ----------------------------------------------------------------
// トースト通知（キュー方式・縦積み）
// ----------------------------------------------------------------
const _toastQueue = [];
let _toastActive = false;

// ----------------------------------------------------------------
// 保存履歴インラインライトボックス（設定画面の showGroupLightbox と同仕様）
// ----------------------------------------------------------------
async function showModalLightbox(groupEntries, startGroupIdx, allEntries, startGlobalIdx, isGroupChild) {
  // isGroupChild=true: 展開後の子タイル → ◀▶=グループ内、▲▼=全体
  // isGroupChild=false/undefined: 通常タイル → ◀▶=全体ナビ、▲▼非表示
  document.querySelector(".modal-lightbox-overlay")?.remove();

  const btnStyle = "position:fixed;background:rgba(255,255,255,.2);border:none;color:#fff;" +
    "font-size:32px;width:50px;height:50px;border-radius:50%;cursor:pointer;" +
    "display:flex;align-items:center;justify-content:center;transition:background .15s;z-index:10001;";

  const ov = document.createElement("div");
  ov.className = "modal-lightbox-overlay";
  ov.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:10000;" +
    "display:flex;align-items:center;justify-content:center;";
  ov.innerHTML = `
    <button class="mlb-close" style="position:fixed;top:14px;right:18px;${btnStyle}font-size:20px;width:34px;height:34px;">✕</button>
    <button class="mlb-left"  title="${isGroupChild ? "前の画像(グループ内)" : "前の履歴（全体）"}" style="${btnStyle}left:20px;top:50%;">&#8249;</button>
    <button class="mlb-right" title="${isGroupChild ? "次の画像(グループ内)" : "次の履歴（全体）"}" style="${btnStyle}right:20px;top:50%;">&#8250;</button>
    <button class="mlb-up"   title="前の履歴（全体）" style="${btnStyle}font-size:24px;top:20px;left:50%;">&#8963;</button>
    <button class="mlb-down" title="次の履歴（全体）" style="${btnStyle}font-size:24px;bottom:60px;left:50%;">&#8964;</button>
    <img class="mlb-img" style="max-width:90vw;max-height:85vh;object-fit:contain;border-radius:4px;box-shadow:0 8px 32px rgba(0,0,0,.5);cursor:default;" />
    <div class="mlb-info" style="position:fixed;bottom:16px;left:50%;transform:translateX(-50%);
      background:rgba(0,0,0,.6);color:#fff;font-size:11px;padding:4px 14px;border-radius:16px;
      display:flex;gap:12px;align-items:center;white-space:nowrap;z-index:10001;">
      <span class="mlb-group-label" style="color:rgba(255,255,255,.6);font-size:10px;">${isGroupChild ? "グループ内" : ""}</span>
      <span class="mlb-counter"></span>
      <span class="mlb-global-label" style="color:rgba(255,255,255,.6);font-size:10px;"></span>
      <span class="mlb-filename"></span>
    </div>
  `;
  document.body.appendChild(ov);

  const img        = ov.querySelector(".mlb-img");
  const counter    = ov.querySelector(".mlb-counter");
  const filename   = ov.querySelector(".mlb-filename");
  const globalLbl  = ov.querySelector(".mlb-global-label");
  const leftBtn    = ov.querySelector(".mlb-left");
  const rightBtn   = ov.querySelector(".mlb-right");
  const upBtn      = ov.querySelector(".mlb-up");
  const downBtn    = ov.querySelector(".mlb-down");

  const total      = groupEntries.length;
  const totalAll   = allEntries.length;
  let curGroup     = startGroupIdx;
  let curGlobal    = startGlobalIdx;

  // グループが1枚の場合は左右ナビを非表示
  // グループ内に複数枚ある場合のみ左右ボタンを表示（isGroupChildでない場合は全体ナビとして常時表示）
  if (total <= 1 && isGroupChild) { leftBtn.style.display = "none"; rightBtn.style.display = "none"; }

  function reposNavBtns() {
    const r = img.getBoundingClientRect();
    if (!r.width) return;
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    const bw = 50;
    // 左右
    let ll = cx / 2 - bw / 2;
    if (ll + bw > r.left - 8) ll = Math.max(8, r.left - bw - 8);
    leftBtn.style.left = `${Math.max(8,ll)}px`; leftBtn.style.right = "auto";
    leftBtn.style.top  = `${cy - bw/2}px`; leftBtn.style.transform = "none";
    let rl = cx + cx / 2 - bw / 2;
    if (rl < r.right + 8) rl = r.right + 8;
    rightBtn.style.left = `${Math.min(window.innerWidth-bw-8,rl)}px`; rightBtn.style.right = "auto";
    rightBtn.style.top  = `${cy - bw/2}px`; rightBtn.style.transform = "none";
    // 上下
    let ut = cy / 2 - bw / 2;
    if (ut + bw > r.top - 8) ut = Math.max(8, r.top - bw - 8);
    upBtn.style.top = `${Math.max(8,ut)}px`; upBtn.style.bottom = "auto";
    upBtn.style.left = `${cx - bw/2}px`; upBtn.style.transform = "none";
    let dt = cy + cy / 2 - bw / 2;
    if (dt < r.bottom + 8) dt = r.bottom + 8;
    downBtn.style.top = `${Math.min(window.innerHeight-bw-8,dt)}px`; downBtn.style.bottom = "auto";
    downBtn.style.left = `${cx - bw/2}px`; downBtn.style.transform = "none";
  }

  async function loadEntry(entry) {
    img.src = "";
    const p = (Array.isArray(entry.savePaths) ? entry.savePaths[0] : entry.savePath) || "";
    if (!p || !entry.filename) return;
    const filePath = p.replace(/[\\/]+$/, "") + "\\" + entry.filename;
    const res = await browser.runtime.sendMessage({ type: "FETCH_FILE_AS_DATAURL", path: filePath });
    if (res?.ok && res.dataUrl) {
      img.src = res.dataUrl;
      img.alt = entry.filename;
      if (img.complete && img.naturalWidth) reposNavBtns();
      else img.onload = () => { reposNavBtns(); img.onload = null; };
    }
  }

  function updateGroup(idx) {
    curGroup = idx;
    const entry = groupEntries[idx];
    counter.textContent = `${idx + 1} / ${total}`;
    filename.textContent = entry?.filename || "";
    leftBtn.style.opacity  = idx > 0 ? "1" : "0.3";
    rightBtn.style.opacity = idx < total - 1 ? "1" : "0.3";
    updateGlobalLabel();
    loadEntry(entry);
  }

  function updateGlobalLabel() {
    if (curGlobal < 0) { globalLbl.textContent = ""; return; }
    globalLbl.textContent = `全体 ${totalAll - curGlobal} / ${totalAll}`;
    upBtn.style.opacity   = curGlobal > 0 ? "1" : "0.3";
    downBtn.style.opacity = curGlobal < totalAll - 1 ? "1" : "0.3";
  }

  function goGlobalPrev() {
    if (curGlobal <= 0) return;
    curGlobal--;
    const e = allEntries[curGlobal];
    counter.textContent = "1 / 1"; filename.textContent = e?.filename || "";
    // グループ子タイルから全体ナビで移動した場合のみ左右（グループ内）を隠す
    if (isGroupChild) { leftBtn.style.display = "none"; rightBtn.style.display = "none"; }
    updateGlobalLabel();
    loadEntry(e);
  }
  function goGlobalNext() {
    if (curGlobal >= totalAll - 1) return;
    curGlobal++;
    const e = allEntries[curGlobal];
    counter.textContent = "1 / 1"; filename.textContent = e?.filename || "";
    if (isGroupChild) { leftBtn.style.display = "none"; rightBtn.style.display = "none"; }
    updateGlobalLabel();
    loadEntry(e);
  }

  // isGroupChildでない場合：左右=全体ナビ、上下=非表示
  // isGroupChildの場合：左右=グループ内ナビ、上下=全体ナビ
  if (!isGroupChild) {
    upBtn.style.display   = "none";
    downBtn.style.display = "none";
    leftBtn.addEventListener("click",  (e) => { e.stopPropagation(); goGlobalPrev(); });
    rightBtn.addEventListener("click", (e) => { e.stopPropagation(); goGlobalNext(); });
  } else {
    leftBtn.addEventListener("click",  (e) => { e.stopPropagation(); if (curGroup > 0) updateGroup(curGroup - 1); });
    rightBtn.addEventListener("click", (e) => { e.stopPropagation(); if (curGroup < total - 1) updateGroup(curGroup + 1); });
    upBtn.addEventListener("click",    (e) => { e.stopPropagation(); goGlobalPrev(); });
    downBtn.addEventListener("click",  (e) => { e.stopPropagation(); goGlobalNext(); });
  }

  const onResize = () => reposNavBtns();
  window.addEventListener("resize", onResize);

  function close() {
    ov.remove();
    window.removeEventListener("resize", onResize);
    document.removeEventListener("keydown", onKey);
  }
  ov.querySelector(".mlb-close").addEventListener("click", close);
  ov.addEventListener("click", (e) => { if (e.target === ov) close(); });

  const onKey = (e) => {
    if (e.key === "Escape") close();
    else if (!isGroupChild) {
      if (e.key === "ArrowLeft")  goGlobalPrev();
      if (e.key === "ArrowRight") goGlobalNext();
    } else {
      if (e.key === "ArrowLeft"  && curGroup > 0) updateGroup(curGroup - 1);
      if (e.key === "ArrowRight" && curGroup < total - 1) updateGroup(curGroup + 1);
      if (e.key === "ArrowUp")   goGlobalPrev();
      if (e.key === "ArrowDown") goGlobalNext();
    }
  };
  document.addEventListener("keydown", onKey);

  // 初期表示
  updateGroup(startGroupIdx);
}

function showToast(shadow, message, isError = false) {
  _toastQueue.push({ message, isError });
  if (!_toastActive) _processToastQueue();
}

function _processToastQueue() {
  if (_toastQueue.length === 0) { _toastActive = false; return; }
  _toastActive = true;
  const { message, isError } = _toastQueue.shift();

  const toast = document.createElement("div");
  toast.style.cssText = `
    position: fixed; top: 50%; left: 50%; transform: translateX(-50%) translateY(-50%);
    background: ${isError ? "#e74c3c" : "#27ae60"}; color: #fff;
    padding: 14px 28px; border-radius: 10px; font-size: 14px; font-weight: 600;
    z-index: 2147483647; box-shadow: 0 6px 28px rgba(0,0,0,.35);
    font-family: "Segoe UI", sans-serif;
    white-space: pre-wrap; text-align: center; max-width: 480px;
    animation: toast-in .2s ease;
  `;
  toast.textContent = message;

  // アニメーション用スタイル（初回のみ追加）
  if (!document.getElementById("toast-style")) {
    const s = document.createElement("style");
    s.id = "toast-style";
    s.textContent = `@keyframes toast-in { from { opacity:0; transform:translateX(-50%) translateY(calc(-50% + 12px)); } to { opacity:1; transform:translateX(-50%) translateY(-50%); } }`;
    document.head.appendChild(s);
  }

  document.body.appendChild(toast);
  const duration = isError ? 4000 : 2500;
  setTimeout(() => {
    toast.remove();
    // 次のトーストを少し間をあけて表示
    setTimeout(_processToastQueue, 150);
  }, duration);
}

// ----------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------
function guessFilename(url) {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1] || "image";
    return /\.\w{2,5}$/.test(last) ? last : `${last}.jpg`;
  } catch { return "image.jpg"; }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
