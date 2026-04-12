/**
 * settings.js
 * タグ別保存先の管理画面ロジック
 *
 * 機能:
 *   - タグごとの保存先リストを表示（折りたたみ）
 *   - ラベルのインライン編集
 *   - 保存先の削除
 *   - ドラッグ＆ドロップによる並び替え（タグ内）
 *   - タグごとの一括削除
 *
 * セキュリティノート:
 *   このファイルで innerHTML に動的な値を代入している箇所はすべて、
 *   escHtml() によって HTML 特殊文字をエスケープ済みの文字列のみを使用しています。
 *   静的解析ツールは動的な値の安全性を検証できないため警告が表示されますが、
 *   XSS のリスクはありません。
 */

// ----------------------------------------------------------------
// ヘルパー
// ----------------------------------------------------------------
/** 旧フォーマット(author:string)と新フォーマット(authors:string[])の両方に対応 */
function getEntryAuthors(entry) {
  if (Array.isArray(entry.authors)) return entry.authors.filter(Boolean);
  if (entry.author) return [entry.author];
  return [];
}

// ----------------------------------------------------------------
// 状態
// ----------------------------------------------------------------
// { "タグ名": [ { id, path, label }, ... ], ... }
let tagDestinations = {};
// [ { id, path, label }, ... ]
let bookmarks = [];
// 保存先関連付けなしを含む全タグ一覧
let globalTags = [];

// 作者
let globalAuthors      = [];
let authorDestinations = {};
// 保存履歴の作者フィルター
let _histAuthorFilter  = "";
// 保存履歴の取り込み元フィルター ("" | "external_import" | "normal")
let _histSourceFilter  = "";

// 開いているタグ行のセット（折りたたみ状態の管理）
const openTags = new Set();

// ---- 外部取り込み状態 ----
let _extScanResult    = null;   // SCAN_EXTERNAL_IMAGES のレスポンス
let _extFolderTagMap  = {};     // { relFolder: { mainTags: string[], subTags: string[], authTags: string[] } }
let _extManualTags    = [];     // 手動追加メインタグ
let _extManualSubTags = [];     // 手動追加サブタグ
let _extManualAuthors = [];     // 手動追加権利者
let _extTempExcludes  = [];     // 実行時のみ除外ワード
let _extImporting        = false;  // インポート中フラグ（beforeunload用）
let _extImportCancelled  = false;  // 中断フラグ
let _lastImportIds       = null;   // 直前インポートのエントリID配列（取り消し用）
let _extDragData         = null;   // チップD&D中の移動元情報 { folder, type, idx, tag }

// ----------------------------------------------------------------
// 初期化
// ----------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  // ---- タブスクロールインジケーター ----
  const _tabBar      = document.querySelector(".tab-bar");
  const _indLeft     = document.querySelector(".tab-scroll-left");
  const _indRight    = document.querySelector(".tab-scroll-right");
  function _updateTabIndicators() {
    if (!_tabBar || !_indLeft || !_indRight) return;
    const hasLeft  = _tabBar.scrollLeft > 1;
    const hasRight = _tabBar.scrollLeft < _tabBar.scrollWidth - _tabBar.clientWidth - 1;
    _indLeft.classList.toggle("visible",  hasLeft);
    _indRight.classList.toggle("visible", hasRight);
  }
  if (_tabBar) _tabBar.addEventListener("scroll", _updateTabIndicators);
  // 初期状態チェック（レイアウト確定後）
  requestAnimationFrame(_updateTabIndicators);

  // ---- タブ切り替え ----
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
      // 選択タブがタブバーからはみ出している場合にスクロールして全体を表示
      btn.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      // 保存履歴タブに切り替えたら描画
      if (btn.dataset.tab === "history") renderHistoryTab();
      if (btn.dataset.tab === "authors") renderAuthorsTab();
    });
  });

  await loadData();
  renderAll();
  setupBackup();
  setupRootPath();
  setupInstantSave();
  setupMinimizeAfterSave();
  setupFilenameSettings();
  setupDiffExport();
  setupExternalImportTab();
  setupBookmarks();
  setupLogs();
  setupHistoryTab();
  setupHistoryDisplayMode();
  setupAuthorsTab();
  setupDisplayCounts();

  // 削除処理有効化チェックボックス（開いた直後は必ずOFF）
  const chkDeleteMode = document.getElementById("chk-delete-mode");
  chkDeleteMode.checked = false; // 起動時は常にOFF
  chkDeleteMode.addEventListener("change", () => {
    document.body.classList.toggle("delete-mode", chkDeleteMode.checked);
  });

  // バージョン表示
  try {
    const manifest = browser.runtime.getManifest();
    const verEl = document.getElementById("app-version");
    if (verEl) verEl.textContent = `v${manifest.version}`;
  } catch {}

  // ---- タグ並び順セレクター ----
  const tagSortSelect = document.getElementById("tag-sort-select");
  if (tagSortSelect) {
    // 保存済みの並び順を復元
    const { tagSortOrder } = await browser.storage.local.get("tagSortOrder");
    if (tagSortOrder) tagSortSelect.value = tagSortOrder;
    tagSortSelect.addEventListener("change", async () => {
      await browser.storage.local.set({ tagSortOrder: tagSortSelect.value });
      renderAll();
    });
  }

  // ---- 一時的なアドオン判定（正規インストール時は注意書きを非表示） ----
  let isTemporary = false;
  try {
    const selfInfo = await browser.management.getSelf();
    const note = document.getElementById("tmp-addon-note");
    // about:debugging 経由の一時インストールは "temporary" または "development" を返す
    if (selfInfo.installType === "temporary" || selfInfo.installType === "development") {
      isTemporary = true;
      if (note) note.style.display = "";
    }
  } catch {
    isTemporary = true;
    const note = document.getElementById("tmp-addon-note");
    if (note) note.style.display = "";
  }

});

async function loadData() {
  const [destRes, bmRes, tagsRes, authorsRes, authorDestsRes] = await Promise.all([
    browser.runtime.sendMessage({ type: "GET_TAG_DESTINATIONS" }),
    browser.runtime.sendMessage({ type: "GET_BOOKMARKS" }),
    browser.runtime.sendMessage({ type: "GET_ALL_TAGS" }),
    browser.runtime.sendMessage({ type: "GET_GLOBAL_AUTHORS" }),
    browser.runtime.sendMessage({ type: "GET_AUTHOR_DESTINATIONS" }),
  ]);
  tagDestinations    = destRes.tagDestinations               || {};
  bookmarks          = bmRes.bookmarks                       || [];
  globalTags         = tagsRes.tags                          || [];
  globalAuthors      = authorsRes.authors                    || [];
  authorDestinations = authorDestsRes.authorDestinations     || {};
}

async function saveData() {
  await browser.runtime.sendMessage({
    type: "SET_TAG_DESTINATIONS",
    data: tagDestinations,
  });
  showStatus("保存しました ✔");
}

// ----------------------------------------------------------------
// 全体描画
// ----------------------------------------------------------------
function renderAll() {
  const list = document.getElementById("tag-list");
  list["innerHTML"] = "";

  // tagDestinations のキーと globalTags をマージ（サブタグ含む全タグを表示）
  let tags = [...new Set([...Object.keys(tagDestinations), ...globalTags])];

  if (tags.length === 0) {
    list["innerHTML"] = `
      <div class="empty-state">
        <span class="emoji">🏷️</span>
        まだ保存先が記録されていません。<br>
        タグを付けて画像を保存すると<br>ここに自動的に表示されます。
      </div>`;
    return;
  }

  // 並び順を適用
  const sortSelect = document.getElementById("tag-sort-select");
  const sortOrder  = sortSelect ? sortSelect.value : "registered";
  switch (sortOrder) {
    case "name":
      tags = [...tags].sort((a, b) => a.localeCompare(b, "ja"));
      break;
    case "name-desc":
      tags = [...tags].sort((a, b) => b.localeCompare(a, "ja"));
      break;
    case "count-desc":
      tags = [...tags].sort((a, b) => (tagDestinations[b]?.length || 0) - (tagDestinations[a]?.length || 0));
      break;
    case "count-asc":
      tags = [...tags].sort((a, b) => (tagDestinations[a]?.length || 0) - (tagDestinations[b]?.length || 0));
      break;
    case "registered-desc":
      tags = [...tags].reverse();
      break;
    // "registered" はそのまま（Object.keys の挿入順）
  }

  // ---- 新しいタグを追加ボタン ----
  const addTagBtn = document.createElement("button");
  addTagBtn.className = "tag-add-btn";
  addTagBtn.textContent = "＋ 新しいタグを追加";
  addTagBtn.addEventListener("click", () => {
    if (list.querySelector(".tag-add-form")) return; // 既に表示中
    const form = document.createElement("div");
    form.className = "tag-add-form";
    form.innerHTML = `
      <input type="text" class="tag-add-name" placeholder="タグ名" />
      <input type="text" class="tag-add-path" placeholder="保存先フォルダパス" />
      <div class="tag-add-actions">
        <button class="tag-add-confirm">追加</button>
        <button class="tag-add-cancel">キャンセル</button>
      </div>`;
    list.insertBefore(form, list.firstChild);
    const nameInput = form.querySelector(".tag-add-name");
    const pathInput = form.querySelector(".tag-add-path");
    nameInput.focus();
    const doAdd = () => {
      const tagName = nameInput.value.trim();
      const path    = pathInput.value.trim();
      if (!tagName) { showStatus("⚠️ タグ名を入力してください"); return; }
      if (!path)    { showStatus("⚠️ 保存先パスを入力してください"); return; }
      if (!tagDestinations[tagName]) tagDestinations[tagName] = [];
      const normalized = path.replace(/\\+$/, "");
      if (tagDestinations[tagName].some(d => d.path.replace(/\\+$/, "") === normalized)) {
        showStatus("⚠️ この保存先は既に登録されています");
        form.remove();
        return;
      }
      tagDestinations[tagName].push({ id: crypto.randomUUID(), path, label: "" });
      // globalTags にも追加
      browser.storage.local.get("globalTags").then(stored => {
        const gt = stored.globalTags || [];
        if (!gt.includes(tagName)) {
          gt.push(tagName);
          browser.storage.local.set({ globalTags: gt });
        }
      });
      openTags.add(tagName);
      saveData();
      renderAll();
    };
    form.querySelector(".tag-add-confirm").addEventListener("click", doAdd);
    form.querySelector(".tag-add-cancel").addEventListener("click", () => form.remove());
    pathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doAdd(); }
      if (e.key === "Escape") form.remove();
    });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); pathInput.focus(); }
      if (e.key === "Escape") form.remove();
    });
  });
  list.appendChild(addTagBtn);

  for (const tag of tags) {
    list.appendChild(buildTagRow(tag));
  }
}


// タグ行の構築
// ----------------------------------------------------------------
function buildTagRow(tag) {
  const dests = tagDestinations[tag] || [];
  const isOpen = openTags.has(tag);

  const row = document.createElement("div");
  row.className = "tag-row";
  row.dataset.tag = tag;

  // ---- ヘッダー ----
  const header = document.createElement("div");
  header.className = "tag-row-header";
  header["innerHTML"] = `
    <span class="tag-row-toggle ${isOpen ? "open" : ""}">▶</span>
    <span class="tag-row-name"># ${escHtml(tag)}</span>
    <span class="tag-row-count">${dests.length} 件</span>
    <button class="tag-row-edit" title="タグ名を変更">✏ 名前を変更</button>
    <button class="tag-row-del delete-guarded" title="このタグを削除">🗑</button>`;

  // タグ名変更ボタン
  header.querySelector(".tag-row-edit").addEventListener("click", async (e) => {
    e.stopPropagation();
    const newName = prompt(`タグ名を変更\n現在: ${tag}`, tag);
    if (!newName || newName.trim() === tag) return;
    const trimmed = newName.trim();
    if (!trimmed) return;

    // tagDestinationsのキーを変更（変更先が既存タグの場合は保存先候補をマージ）
    if (tagDestinations[tag]) {
      if (tagDestinations[trimmed]) {
        // 既存の変更先タグの保存先候補とマージ（パス重複除去）
        const existingPaths = new Set(tagDestinations[trimmed].map(d => d.path));
        const toAdd = tagDestinations[tag].filter(d => !existingPaths.has(d.path));
        tagDestinations[trimmed] = [...tagDestinations[trimmed], ...toAdd];
      } else {
        tagDestinations[trimmed] = tagDestinations[tag];
      }
      delete tagDestinations[tag];
    }

    // globalTagsのタグ名を変更
    try {
      const stored = await browser.storage.local.get("globalTags");
      const tags = stored.globalTags || [];
      const idx = tags.indexOf(tag);
      if (idx !== -1) tags[idx] = trimmed;
      else if (!tags.includes(trimmed)) tags.push(trimmed);
      await browser.storage.local.set({ globalTags: tags });
    } catch {}

    // saveHistoryのtags内のタグ名を変更
    try {
      const stored = await browser.storage.local.get("saveHistory");
      const history = stored.saveHistory || [];
      let changed = 0;
      history.forEach(entry => {
        if (Array.isArray(entry.tags) && entry.tags.includes(tag)) {
          entry.tags = entry.tags.map(t => t === tag ? trimmed : t);
          changed++;
        }
      });
      if (changed > 0) await browser.storage.local.set({ saveHistory: history });
    } catch {}

    openTags.delete(tag);
    openTags.add(trimmed);
    saveData();
    renderAll();
    showStatus(`タグ名を「${tag}」→「${trimmed}」に変更しました ✔`);
  });

  header.querySelector(".tag-row-del").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`タグ「${tag}」を削除しますか？\n関連付けられた保存先情報もすべて削除されます。`)) return;
    delete tagDestinations[tag];
    openTags.delete(tag);
    // globalTags からも削除
    try {
      const stored = await browser.storage.local.get("globalTags");
      const updated = (stored.globalTags || []).filter(t => t !== tag);
      await browser.storage.local.set({ globalTags: updated });
    } catch {}
    saveData();
    renderAll();
  });

  header.addEventListener("click", () => {
    if (openTags.has(tag)) {
      openTags.delete(tag);
    } else {
      openTags.add(tag);
    }
    renderAll();
  });

  // ---- 保存先リスト ----
  const destList = document.createElement("div");
  destList.className = "dest-list" + (isOpen ? " open" : "");

  for (let i = 0; i < dests.length; i++) {
    destList.appendChild(buildDestItem(tag, dests[i], i));
  }

  // ---- 保存先を追加ボタン ----
  const addBtn = document.createElement("button");
  addBtn.className = "dest-add-btn";
  addBtn.textContent = "＋ 保存先を追加";
  addBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (destList.querySelector(".dest-add-form")) return; // 既に表示中
    const form = document.createElement("div");
    form.className = "dest-add-form";
    form.innerHTML = `
      <input type="text" class="dest-add-input" placeholder="フォルダパスを入力" />
      <button class="dest-add-confirm">追加</button>
      <button class="dest-add-cancel">キャンセル</button>`;
    destList.appendChild(form);
    const input = form.querySelector(".dest-add-input");
    input.focus();
    const doAdd = () => {
      const path = input.value.trim();
      if (!path) { form.remove(); return; }
      if (!tagDestinations[tag]) tagDestinations[tag] = [];
      const normalized = path.replace(/\\+$/, "");
      if (tagDestinations[tag].some(d => d.path.replace(/\\+$/, "") === normalized)) {
        showStatus("⚠️ この保存先は既に登録されています");
        form.remove();
        return;
      }
      tagDestinations[tag].push({ id: crypto.randomUUID(), path, label: "" });
      saveData();
      openTags.add(tag);
      renderAll();
    };
    form.querySelector(".dest-add-confirm").addEventListener("click", doAdd);
    form.querySelector(".dest-add-cancel").addEventListener("click", () => form.remove());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doAdd(); }
      if (e.key === "Escape") form.remove();
    });
  });
  destList.appendChild(addBtn);

  row.appendChild(header);
  row.appendChild(destList);
  return row;
}

// ----------------------------------------------------------------
// 保存先アイテムの構築
// ----------------------------------------------------------------
function buildDestItem(tag, dest, index) {
  const item = document.createElement("div");
  item.className = "dest-item";
  item.dataset.id = dest.id;
  item.draggable = true;

  const labelDisplay = dest.label || dest.path.split("\\").pop();

  item["innerHTML"] = `
    <span class="dest-item-drag" title="ドラッグで並び替え">⠿</span>
    <span class="dest-item-icon">📁</span>
    <div class="dest-item-body">
      <div class="dest-item-label-wrap">
        <span class="dest-item-label" title="${escHtml(dest.label || "")}">${escHtml(labelDisplay)}</span>
      </div>
      <div class="dest-item-path" title="${escHtml(dest.path)}">${escHtml(dest.path)}</div>
    </div>
    <div class="dest-item-actions">
      <button class="dest-item-btn open-exp" title="エクスプローラーで開く">📂</button>
      <button class="dest-item-btn edit" title="ラベルを編集">✏️</button>
      <button class="dest-item-btn del delete-guarded"  title="削除">🗑</button>
    </div>`;

  // ---- ラベル編集 ----
  item.querySelector(".edit").addEventListener("click", (e) => {
    e.stopPropagation();
    startLabelEdit(item, tag, dest);
  });

  // ---- エクスプローラーで開く ----
  item.querySelector(".open-exp").addEventListener("click", (e) => {
    e.stopPropagation();
    browser.runtime.sendMessage({ type: "OPEN_EXPLORER", path: dest.path });
  });

  // ---- 削除 ----
  item.querySelector(".del").addEventListener("click", (e) => {
    e.stopPropagation();
    tagDestinations[tag] = tagDestinations[tag].filter((d) => d.id !== dest.id);
    // 保存先が0件になってもタグ自体は残す（空配列で保持）
    saveData();
    renderAll();
  });

  // ---- ドラッグ＆ドロップ（タグ内の並び替え） ----
  item.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", JSON.stringify({ tag, id: dest.id }));
    item.classList.add("dragging");
  });
  item.addEventListener("dragend", () => item.classList.remove("dragging"));

  item.addEventListener("dragover", (e) => {
    e.preventDefault();
    item.classList.add("drag-over");
  });
  item.addEventListener("dragleave", () => item.classList.remove("drag-over"));

  item.addEventListener("drop", (e) => {
    e.preventDefault();
    item.classList.remove("drag-over");

    let payload;
    try { payload = JSON.parse(e.dataTransfer.getData("text/plain")); }
    catch { return; }

    // 同タグ内のみ並び替えを許可
    if (payload.tag !== tag) return;

    const dests = tagDestinations[tag];
    const fromIdx = dests.findIndex((d) => d.id === payload.id);
    const toIdx   = dests.findIndex((d) => d.id === dest.id);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

    // 並び替え
    const [moved] = dests.splice(fromIdx, 1);
    dests.splice(toIdx, 0, moved);

    saveData();
    renderAll();
  });

  return item;
}

// ----------------------------------------------------------------
// ラベルのインライン編集
// ----------------------------------------------------------------
function startLabelEdit(item, tag, dest) {
  const labelWrap = item.querySelector(".dest-item-label-wrap");
  const currentLabel = dest.label || "";

  // ラベル表示をインプットに差し替え
  labelWrap["innerHTML"] = `
    <input class="dest-item-label-input" type="text"
      value="${escHtml(currentLabel)}"
      placeholder="ラベルを入力（省略可）" />`;

  const input = labelWrap.querySelector("input");
  input.focus();
  input.select();

  function commit() {
    const newLabel = input.value.trim();
    // データを更新
    const d = (tagDestinations[tag] || []).find((x) => x.id === dest.id);
    if (d) d.label = newLabel;
    saveData();
    renderAll();
  }

  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter")  { e.preventDefault(); commit(); }
    if (e.key === "Escape") { renderAll(); } // 変更を破棄
  });
}

// ----------------------------------------------------------------
// バックアップ・復元
// ----------------------------------------------------------------

async function setupBackup() {
  // エクスポート先設定の初期ロード
  const { exportPath, exportAutoSave } = await browser.storage.local.get(["exportPath", "exportAutoSave"]);
  const pathInput  = document.getElementById("export-path-input");
  const autoCheck  = document.getElementById("export-auto-save");
  const exportSaveBtn = document.getElementById("export-path-save");
  if (pathInput) pathInput.value = exportPath || "";
  if (autoCheck) autoCheck.checked = !!exportAutoSave;

  // 未変更なら「設定」ボタンを非活性
  function updateExportSaveBtn() {
    exportSaveBtn.disabled = pathInput.value.trim() === (exportPath || "");
  }
  updateExportSaveBtn();
  pathInput.addEventListener("input", updateExportSaveBtn);

  const exportOpenBtn = document.getElementById("export-path-open");
  function updateExportOpenBtn() {
    exportOpenBtn.disabled = !pathInput.value.trim();
  }
  updateExportOpenBtn();
  exportOpenBtn.addEventListener("click", () => {
    const p = pathInput.value.trim();
    if (p) browser.runtime.sendMessage({ type: "OPEN_EXPLORER", path: p });
  });

  document.getElementById("export-path-save").addEventListener("click", async () => {
    const val = pathInput.value.trim();
    await browser.storage.local.set({ exportPath: val });
    exportSaveBtn.disabled = true;
    updateExportOpenBtn();
    showStatus("エクスポート先を設定しました");
  });
  document.getElementById("export-path-clear").addEventListener("click", async () => {
    pathInput.value = "";
    await browser.storage.local.set({ exportPath: "" });
    showStatus("エクスポート先をクリアしました");
  });
  autoCheck.addEventListener("change", async () => {
    await browser.storage.local.set({ exportAutoSave: autoCheck.checked });
  });

  document.getElementById("btn-export").addEventListener("click", exportData);
  document.getElementById("input-import").addEventListener("change", importData);

}

/**
 * storage.local の全データを JSON ファイルとしてダウンロードする。
 * exportPath が設定されていて exportAutoSave が ON の場合は Native 経由で保存。
 * diffExportEnabled が ON の場合は前回エクスポート以降の差分エントリのみを対象にする。
 */
async function exportData() {
  // ---- 進捗表示ヘルパー ----
  const resultEl = document.getElementById("export-result");
  const logLines = [];
  function log(msg) {
    logLines.push(msg);
    resultEl.className = "import-result success";
    resultEl.style.display = "block";
    resultEl["innerHTML"] = logLines.map(l => escHtml(l)).join("<br>");
  }
  function logError(msg) {
    logLines.push("❌ " + msg);
    resultEl.className = "import-result error";
    resultEl.style.display = "block";
    resultEl["innerHTML"] = logLines.map(l => escHtml(l)).join("<br>");
  }

  log("⏳ エクスポート準備中...");

  // storage.local のバックアップ対象キー
  const stored = await browser.storage.local.get([
    "tagDestinations",
    "globalTags",
    "lastSaveDir",
    "tagRecords",
    "folderBookmarks",
    "explorerRootPath",
    "explorerViewMode",
    "explorerStartPriority",
    "explorerFolderSort",
    "recentTags",
    "modalSize",
    "saveHistory",
    "exportPath",
    "exportAutoSave",
    "historyDisplayMode",
    "groupReadDirection",
    "instantSaveEnabled",
    "minimizeAfterSave",
    "tagSortOrder",
    "globalAuthors",
    "authorDestinations",
    "filenameIncludeTag",
    "filenameIncludeSubtag",
    "filenameIncludeAuthor",
    "settingsHistoryPageSize",
    "recentTagDisplayCount",
    "bookmarkDisplayCount",
    "diffExportEnabled",
    "lastExportedAt",
  ]);
  log("📦 設定データ取得完了");

  // IndexedDB のサムネイルも取得
  let idbThumbs = [];
  try {
    const res = await browser.runtime.sendMessage({ type: "EXPORT_IDB_THUMBS" });
    if (res?.ok) idbThumbs = res.thumbs;
  } catch {}
  log(`🖼 サムネイル取得完了（${idbThumbs.length} 件）`);

  // ---- 差分エクスポート処理 ----
  const isDiff = !!stored.diffExportEnabled && !!stored.lastExportedAt;
  let exportHistory = stored.saveHistory || [];
  let exportThumbs  = idbThumbs;

  if (isDiff) {
    const lastAt = new Date(stored.lastExportedAt);
    const fullCount = exportHistory.length;
    exportHistory = exportHistory.filter(entry => entry.savedAt && new Date(entry.savedAt) > lastAt);
    // 差分エントリで参照されるサムネイルのみに絞る
    const thumbIdSet = new Set(exportHistory.map(e => e.thumbId).filter(Boolean));
    exportThumbs = idbThumbs.filter(t => thumbIdSet.has(t.id));
    log(`🔍 差分: ${exportHistory.length} 件 / 全 ${fullCount} 件（前回エクスポート: ${stored.lastExportedAt.slice(0, 19).replace("T", " ")}）`);
    if (exportHistory.length === 0) {
      log("ℹ️ 差分なし（前回エクスポート以降の新規エントリはありません）");
      return;
    }
  }

  // ---- ペイロード生成 ----
  // 差分モード時は saveHistory・_idbThumbs を差分のみに置き換える
  const exportedAt = new Date().toISOString();
  const payload = {
    _meta: {
      exportedAt,
      version:  "1.11.0",
      app:      "image-saver-tags",
      isDiff:   isDiff,
      diffBase: isDiff ? stored.lastExportedAt : null,
    },
    ...stored,
    saveHistory: exportHistory,
    _idbThumbs:  exportThumbs,  // IDB サムネイル（差分インポート用）
  };

  const json    = JSON.stringify(payload, null, 2);
  const sizeKB  = (json.length / 1024).toFixed(1);
  log(`📝 JSON 生成完了（${sizeKB} KB）`);

  const prefix = isDiff ? "image-saver-diff" : "image-saver-backup";
  const ts     = exportedAt.slice(0, 19).replace(/[T:]/g, "-");
  const name   = `${prefix}-${ts}.json`;

  // ---- エクスポート先 + 即保存オプションの確認 ----
  const { exportPath, exportAutoSave } = await browser.storage.local.get(["exportPath", "exportAutoSave"]);
  if (exportPath && exportAutoSave) {
    // Native Messaging 経由でファイルに直接書き出す
    const savePath = exportPath.replace(/[\\/]+$/, "") + "\\" + name;
    log("💾 ファイル書き込み中...");
    const res = await browser.runtime.sendMessage({
      type: "WRITE_FILE",
      path: savePath,
      content: json,
    });
    if (res?.ok) {
      // 差分エクスポート完了時のみ lastExportedAt を更新（全エクスポートでは更新しない）
      if (isDiff) await browser.storage.local.set({ lastExportedAt: exportedAt });
      log(`✅ エクスポート完了: ${savePath}（サムネイル ${exportThumbs.length} 件含む）`);
      showCenterToast(`✅ エクスポートしました\n${savePath}\n（サムネイル ${exportThumbs.length} 件含む）`);
    } else {
      const msg = res?.errorCode === "DIR_NOT_FOUND"
        ? `⚠️ フォルダが存在しません: ${exportPath}\n設定画面でエクスポート先を確認してください`
        : `⚠️ 直接保存に失敗しました。ダウンロードに切り替えます: ${res?.error || ""}`;
      logError(msg);
      showStatus(msg, true);
      _downloadJson(json, name, exportThumbs.length);
      if (isDiff) await browser.storage.local.set({ lastExportedAt: exportedAt });
    }
    return;
  }

  _downloadJson(json, name, exportThumbs.length);
  // 差分エクスポート完了時のみ lastExportedAt を更新（全エクスポートでは更新しない）
  if (isDiff) await browser.storage.local.set({ lastExportedAt: exportedAt });
  log(`✅ ダウンロード開始（サムネイル ${exportThumbs.length} 件含む）`);
}

function _downloadJson(json, name, thumbCount) {
  const blob = new Blob([json], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href     = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  showCenterToast(`✅ エクスポートしました
${name}
（サムネイル ${thumbCount} 件含む）`);
}

/**
 * JSONファイルを読み込み、既存データとマージして storage.local に保存する。
 * 上書きではなく追記マージなので、既存データは失われない。
 */
async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;

  // 同じファイルを再選択できるようにリセット
  e.target.value = "";

  const resultEl = document.getElementById("import-result");
  resultEl.className = "import-result";
  resultEl.textContent = "";

  // ---- デバッグログ表示ヘルパー ----
  const logLines = [];
  function log(msg) {
    logLines.push(msg);
    // リアルタイムで表示更新
    resultEl.className = "import-result success";
    resultEl.style.display = "block";
    resultEl["innerHTML"] = logLines.map(l => escHtml(l)).join("<br>");
  }
  function logError(msg) {
    logLines.push("❌ " + msg);
    resultEl.className = "import-result error";
    resultEl.style.display = "block";
    resultEl["innerHTML"] = logLines.map(l => escHtml(l)).join("<br>");
  }

  log(`📂 ファイル読み込み中: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`);

  let parsed;
  try {
    const text = await file.text();
    parsed = JSON.parse(text);
    log(`✅ JSON 解析成功`);
  } catch (err) {
    logError(`JSON 解析失敗: ${err.message}`);
    return;
  }

  // アプリ識別チェック
  if (parsed._meta) {
    log(`📋 バックアップ情報: v${parsed._meta.version} / ${parsed._meta.exportedAt}`);
    if (parsed._meta.app && parsed._meta.app !== "image-saver-tags") {
      logError(`別アプリのバックアップです: ${parsed._meta.app}`);
      return;
    }
  } else {
    log(`⚠️ _meta フィールドなし（旧形式の可能性）`);
  }

  // 現在のデータを取得
  let current;
  try {
    current = await browser.storage.local.get([
      "tagDestinations", "globalTags", "lastSaveDir", "tagRecords",
      "folderBookmarks", "explorerRootPath", "explorerViewMode",
      "explorerStartPriority", "recentTags", "modalSize", "saveHistory",
      "globalAuthors", "authorDestinations",
    ]);
    log(`✅ 現在の storage.local 取得成功`);
  } catch (err) {
    logError(`storage.local の取得に失敗: ${err.message}`);
    return;
  }

  let addedDests = 0;
  let addedTags  = 0;

  // ---- tagDestinations ----
  if (parsed.tagDestinations && typeof parsed.tagDestinations === "object") {
    const tagCount = Object.keys(parsed.tagDestinations).length;
    log(`🏷 tagDestinations: ${tagCount} タグを処理中…`);
    try {
      const merged = current.tagDestinations || {};
      for (const [tag, dests] of Object.entries(parsed.tagDestinations)) {
        if (!Array.isArray(dests)) continue;
        if (!merged[tag]) merged[tag] = [];
        for (const d of dests) {
          if (!d.path) continue;
          const exists = merged[tag].some((x) => x.path === d.path);
          if (!exists) {
            merged[tag].push({ ...d, id: crypto.randomUUID() });
            addedDests++;
          }
        }
      }
      await browser.storage.local.set({ tagDestinations: merged });
      tagDestinations = merged;
      log(`  → ${addedDests} 件の保存先を追加`);
    } catch (err) {
      logError(`tagDestinations の保存に失敗: ${err.message}`);
      return;
    }
  } else {
    log(`⚠️ tagDestinations なし（スキップ）`);
  }

  // ---- authorDestinations ----
  if (parsed.authorDestinations && typeof parsed.authorDestinations === "object") {
    const authorDestCount = Object.keys(parsed.authorDestinations).length;
    log(`👤 authorDestinations: ${authorDestCount} 権利者を処理中…`);
    try {
      const merged = current.authorDestinations || {};
      let addedAuthorDests = 0;
      for (const [author, dests] of Object.entries(parsed.authorDestinations)) {
        if (!Array.isArray(dests)) continue;
        if (!merged[author]) merged[author] = [];
        for (const d of dests) {
          if (!d.path) continue;
          const exists = merged[author].some((x) => x.path === d.path);
          if (!exists) {
            merged[author].push({ ...d, id: crypto.randomUUID() });
            addedAuthorDests++;
          }
        }
      }
      await browser.storage.local.set({ authorDestinations: merged });
      log(`  → ${addedAuthorDests} 件の権利者保存先を追加`);
    } catch (err) {
      logError(`authorDestinations の保存に失敗: ${err.message}`);
      return;
    }
  } else {
    log(`⚠️ authorDestinations なし（スキップ）`);
  }

  // ---- globalTags ----
  if (Array.isArray(parsed.globalTags)) {
    try {
      const existing = new Set(current.globalTags || []);
      for (const t of parsed.globalTags) {
        if (!existing.has(t)) { existing.add(t); addedTags++; }
      }
      await browser.storage.local.set({ globalTags: Array.from(existing) });
      log(`🏷 globalTags: ${addedTags} 件追加（合計 ${existing.size} 件）`);
    } catch (err) {
      logError(`globalTags の保存に失敗: ${err.message}`);
      return;
    }
  }

  // ---- globalAuthors ----
  if (Array.isArray(parsed.globalAuthors)) {
    try {
      const existing = new Set(current.globalAuthors || []);
      let addedAuthors = 0;
      for (const a of parsed.globalAuthors) {
        if (!existing.has(a)) { existing.add(a); addedAuthors++; }
      }
      await browser.storage.local.set({ globalAuthors: Array.from(existing) });
      log(`👤 globalAuthors: ${addedAuthors} 件追加（合計 ${existing.size} 件）`);
    } catch (err) {
      logError(`globalAuthors の保存に失敗: ${err.message}`);
      return;
    }
  }

  // ---- lastSaveDir ----
  if (parsed.lastSaveDir) {
    try {
      await browser.storage.local.set({ lastSaveDir: parsed.lastSaveDir });
      log(`📁 lastSaveDir: ${parsed.lastSaveDir}`);
    } catch (err) { logError(`lastSaveDir の保存に失敗: ${err.message}`); return; }
  }

  // ---- explorerRootPath ----
  if (parsed.explorerRootPath) {
    try {
      await browser.storage.local.set({ explorerRootPath: parsed.explorerRootPath });
      log(`📁 explorerRootPath: ${parsed.explorerRootPath}`);
    } catch (err) { logError(`explorerRootPath の保存に失敗: ${err.message}`); return; }
  }

  // ---- explorerViewMode ----
  if (parsed.explorerViewMode) {
    try {
      await browser.storage.local.set({ explorerViewMode: parsed.explorerViewMode });
      log(`🖼 explorerViewMode: ${parsed.explorerViewMode}`);
    } catch (err) { logError(`explorerViewMode の保存に失敗: ${err.message}`); return; }
  }

  // ---- explorerStartPriority ----
  if (parsed.explorerStartPriority) {
    try {
      await browser.storage.local.set({ explorerStartPriority: parsed.explorerStartPriority });
      log(`🔢 explorerStartPriority: ${parsed.explorerStartPriority}`);
    } catch (err) { logError(`explorerStartPriority の保存に失敗: ${err.message}`); return; }
  }

  // ---- explorerFolderSort ----
  if (parsed.explorerFolderSort) {
    try {
      await browser.storage.local.set({ explorerFolderSort: parsed.explorerFolderSort });
      log(`🔤 explorerFolderSort: ${parsed.explorerFolderSort}`);
    } catch (err) { logError(`explorerFolderSort の保存に失敗: ${err.message}`); return; }
  }

  // ---- tagSortOrder ----
  if (parsed.tagSortOrder) {
    try {
      await browser.storage.local.set({ tagSortOrder: parsed.tagSortOrder });
      log(`🔤 tagSortOrder: ${parsed.tagSortOrder}`);
    } catch (err) { logError(`tagSortOrder の保存に失敗: ${err.message}`); return; }
  }

  // ---- exportPath / exportAutoSave ----
  if (parsed.exportPath !== undefined) {
    try {
      await browser.storage.local.set({ exportPath: parsed.exportPath });
      log(`📤 exportPath: ${parsed.exportPath || "（未設定）"}`);
    } catch (err) { logError(`exportPath の保存に失敗: ${err.message}`); return; }
  }
  if (parsed.exportAutoSave !== undefined) {
    try {
      await browser.storage.local.set({ exportAutoSave: parsed.exportAutoSave });
      log(`📤 exportAutoSave: ${parsed.exportAutoSave}`);
    } catch (err) { logError(`exportAutoSave の保存に失敗: ${err.message}`); return; }
  }

  // ---- settingsHistoryPageSize (旧キー historyPageSize にも対応) ----
  const importedPageSize = parsed.settingsHistoryPageSize ?? parsed.historyPageSize;
  if (importedPageSize !== undefined) {
    try {
      await browser.storage.local.set({ settingsHistoryPageSize: importedPageSize });
      log(`📄 settingsHistoryPageSize: ${importedPageSize}`);
    } catch (err) { logError(`settingsHistoryPageSize の保存に失敗: ${err.message}`); return; }
  }

  // ---- recentTagDisplayCount / bookmarkDisplayCount ----
  for (const key of ["recentTagDisplayCount", "bookmarkDisplayCount"]) {
    if (parsed[key] !== undefined) {
      try {
        await browser.storage.local.set({ [key]: parsed[key] });
        log(`📄 ${key}: ${parsed[key]}`);
      } catch (err) { logError(`${key} の保存に失敗: ${err.message}`); return; }
    }
  }

  // ---- historyDisplayMode / groupReadDirection ----
  if (parsed.historyDisplayMode) {
    try {
      await browser.storage.local.set({ historyDisplayMode: parsed.historyDisplayMode });
      log(`🖼 historyDisplayMode: ${parsed.historyDisplayMode}`);
    } catch (err) { logError(`historyDisplayMode の保存に失敗: ${err.message}`); return; }
  }
  if (parsed.groupReadDirection) {
    try {
      await browser.storage.local.set({ groupReadDirection: parsed.groupReadDirection });
      log(`↔️ groupReadDirection: ${parsed.groupReadDirection}`);
    } catch (err) { logError(`groupReadDirection の保存に失敗: ${err.message}`); return; }
  }

  // ---- instantSaveEnabled ----
  if (parsed.instantSaveEnabled !== undefined) {
    try {
      await browser.storage.local.set({ instantSaveEnabled: parsed.instantSaveEnabled });
      log(`⚡ instantSaveEnabled: ${parsed.instantSaveEnabled}`);
    } catch (err) { logError(`instantSaveEnabled の保存に失敗: ${err.message}`); return; }
  }
  // ---- minimizeAfterSave ----
  if (parsed.minimizeAfterSave !== undefined) {
    try {
      await browser.storage.local.set({ minimizeAfterSave: parsed.minimizeAfterSave });
      log(`🗕 minimizeAfterSave: ${parsed.minimizeAfterSave}`);
    } catch (err) { logError(`minimizeAfterSave の保存に失敗: ${err.message}`); return; }
  }

  // ---- filenameIncludeTag ----
  if (parsed.filenameIncludeTag !== undefined) {
    try {
      await browser.storage.local.set({ filenameIncludeTag: parsed.filenameIncludeTag });
      log(`📝 filenameIncludeTag: ${parsed.filenameIncludeTag}`);
    } catch (err) { logError(`filenameIncludeTag の保存に失敗: ${err.message}`); return; }
  }
  // ---- filenameIncludeSubtag ----
  if (parsed.filenameIncludeSubtag !== undefined) {
    try {
      await browser.storage.local.set({ filenameIncludeSubtag: parsed.filenameIncludeSubtag });
      log(`📝 filenameIncludeSubtag: ${parsed.filenameIncludeSubtag}`);
    } catch (err) { logError(`filenameIncludeSubtag の保存に失敗: ${err.message}`); return; }
  }
  // ---- filenameIncludeAuthor ----
  if (parsed.filenameIncludeAuthor !== undefined) {
    try {
      await browser.storage.local.set({ filenameIncludeAuthor: parsed.filenameIncludeAuthor });
      log(`📝 filenameIncludeAuthor: ${parsed.filenameIncludeAuthor}`);
    } catch (err) { logError(`filenameIncludeAuthor の保存に失敗: ${err.message}`); return; }
  }

  // ---- diffExportEnabled ----
  if (parsed.diffExportEnabled !== undefined) {
    try {
      await browser.storage.local.set({ diffExportEnabled: parsed.diffExportEnabled });
      log(`🔀 diffExportEnabled: ${parsed.diffExportEnabled}`);
    } catch (err) { logError(`diffExportEnabled の保存に失敗: ${err.message}`); return; }
  }
  // ---- lastExportedAt ----
  if (parsed.lastExportedAt !== undefined) {
    try {
      await browser.storage.local.set({ lastExportedAt: parsed.lastExportedAt });
      log(`🕐 lastExportedAt: ${parsed.lastExportedAt}`);
    } catch (err) { logError(`lastExportedAt の保存に失敗: ${err.message}`); return; }
  }

  // ---- recentTags ----
  if (Array.isArray(parsed.recentTags)) {
    try {
      const existingRecent = current.recentTags || [];
      const mergedRecent = [
        ...parsed.recentTags,
        ...existingRecent.filter((t) => !parsed.recentTags.includes(t)),
      ].slice(0, 20);
      await browser.storage.local.set({ recentTags: mergedRecent });
      log(`🕘 recentTags: ${mergedRecent.length} 件`);
    } catch (err) { logError(`recentTags の保存に失敗: ${err.message}`); return; }
  }

  // ---- modalSize ----
  if (parsed.modalSize) {
    try {
      await browser.storage.local.set({ modalSize: parsed.modalSize });
      log(`📐 modalSize: ${parsed.modalSize.width}×${parsed.modalSize.height}`);
    } catch (err) { logError(`modalSize の保存に失敗: ${err.message}`); return; }
  }

  // ---- saveHistory のマージ（id重複除去・最大10件） ----
  if (Array.isArray(parsed.saveHistory)) {
    try {
      const existing = current.saveHistory || [];
      const existingIds = new Set(existing.map((h) => h.id));
      const newItems = parsed.saveHistory.filter((h) => h.id && !existingIds.has(h.id));
      // 旧バックアップに subTags フィールドが残存する場合は tags に統合
      newItems.forEach(h => {
        if (h.subTags?.length) {
          h.tags = [...new Set([...(h.tags || []), ...h.subTags])];
          delete h.subTags;
        }
      });
      const merged = [...newItems, ...existing]; // 上限なし
      await browser.storage.local.set({ saveHistory: merged });
      log(`🗂 saveHistory: ${newItems.length} 件追加（合計 ${merged.length} 件）`);
    } catch (err) { logError(`saveHistory の保存に失敗: ${err.message}`); return; }
  }

  // ---- tagRecords ----
  if (parsed.tagRecords && typeof parsed.tagRecords === "object") {
    try {
      const mergedRec = { ...(current.tagRecords || {}), ...parsed.tagRecords };
      await browser.storage.local.set({ tagRecords: mergedRec });
      log(`📝 tagRecords: ${Object.keys(parsed.tagRecords).length} 件追加`);
    } catch (err) { logError(`tagRecords の保存に失敗: ${err.message}`); return; }
  }

  // ---- folderBookmarks ----
  if (Array.isArray(parsed.folderBookmarks)) {
    try {
      const existing = current.folderBookmarks || [];
      const existingPaths = new Set(existing.map((b) => b.path));
      const newBms = parsed.folderBookmarks
        .filter((b) => b.path && !existingPaths.has(b.path))
        .map((b) => ({ ...b, id: crypto.randomUUID() }));
      const mergedBms = [...existing, ...newBms];
      await browser.storage.local.set({ folderBookmarks: mergedBms });
      bookmarks = mergedBms;
      log(`⭐ folderBookmarks: ${newBms.length} 件追加（合計 ${mergedBms.length} 件）`);
    } catch (err) { logError(`folderBookmarks の保存に失敗: ${err.message}`); return; }
  }

  // ---- _idbThumbs：IndexedDB サムネイルの差分追加 ----
  if (Array.isArray(parsed._idbThumbs) && parsed._idbThumbs.length > 0) {
    try {
      const res = await browser.runtime.sendMessage({
        type: "IMPORT_IDB_THUMBS",
        thumbs: parsed._idbThumbs,
      });
      if (res?.ok) {
        log(`🖼 IndexedDB サムネイル: ${res.added} 件追加（全 ${parsed._idbThumbs.length} 件中）`);
      } else {
        log(`⚠️ IndexedDB サムネイル復元失敗: ${res?.error || "不明"}`);
      }
    } catch (err) { log(`⚠️ IndexedDB サムネイル復元エラー: ${err.message}`); }
  }

  // 画面を更新
  renderAll();

  const exportedAt = parsed._meta?.exportedAt
    ? new Date(parsed._meta.exportedAt).toLocaleString("ja-JP")
    : "不明";

  log(`✅ インポート完了（バックアップ日時: ${exportedAt}）`);
  log(`   保存先 ${addedDests} 件・タグ ${addedTags} 件を追加しました`);

  // 全般タブの表示をリフレッシュ
  await loadData();
  renderAll();
  setupRootPath();
  setupInstantSave();
  setupFilenameSettings();
  setupDiffExport();
  // エクスポートパス
  const { exportPath, exportAutoSave } = await browser.storage.local.get(["exportPath", "exportAutoSave"]);
  const pathInput = document.getElementById("export-path-input");
  const autoCheck = document.getElementById("export-auto-save");
  if (pathInput) pathInput.value = exportPath || "";
  if (autoCheck) autoCheck.checked = !!exportAutoSave;
  showStatus("インポートが完了しました ✔");
}

// ----------------------------------------------------------------
// ステータスバー
// ----------------------------------------------------------------
let statusTimer = null;

function showStatus(msg, isError = false) {
  const bar = document.getElementById("status-bar");
  bar.textContent = msg;
  bar.style.color = isError ? "#e74c3c" : "#27ae60";
  bar.classList.remove("hidden");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { bar.classList.add("hidden"); bar.style.color = ""; }, isError ? 4000 : 2000);
}

/** 画面中央に大きめのトーストを表示する（エクスポート完了通知用） */
function showCenterToast(msg, isError = false) {
  const existing = document.querySelector(".center-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = "center-toast";
  toast.style.cssText = `
    position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
    background:${isError ? "#e74c3c" : "#2c3e50"};
    color:#fff; padding:18px 32px; border-radius:12px;
    font-size:14px; font-weight:600; line-height:1.6;
    box-shadow:0 8px 32px rgba(0,0,0,.3);
    z-index:99999; text-align:center; max-width:80vw;
    animation:centerToastIn .2s ease;
  `;
  toast.textContent = msg;
  document.body.appendChild(toast);

  // アニメーション用CSS（初回のみ追加）
  if (!document.getElementById("center-toast-style")) {
    const style = document.createElement("style");
    style.id = "center-toast-style";
    style.textContent = `
      @keyframes centerToastIn {
        from { opacity:0; transform:translate(-50%,-55%); }
        to   { opacity:1; transform:translate(-50%,-50%); }
      }
    `;
    document.head.appendChild(style);
  }

  setTimeout(() => {
    toast.style.transition = "opacity .3s";
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 320);
  }, 2800);
}

// ----------------------------------------------------------------
// 即保存ボタン設定
// ----------------------------------------------------------------
async function setupInstantSave() {
  const chk = document.getElementById("chk-instant-save");
  if (!chk) return;
  const { instantSaveEnabled } = await browser.storage.local.get("instantSaveEnabled");
  chk.checked = instantSaveEnabled !== false; // デフォルトON
  chk.addEventListener("change", async () => {
    await browser.storage.local.set({ instantSaveEnabled: chk.checked });
  });
}

async function setupMinimizeAfterSave() {
  const chk = document.getElementById("chk-minimize-after-save");
  if (!chk) return;
  const { minimizeAfterSave } = await browser.storage.local.get("minimizeAfterSave");
  chk.checked = !!minimizeAfterSave; // デフォルトOFF
  chk.addEventListener("change", async () => {
    await browser.storage.local.set({ minimizeAfterSave: chk.checked });
  });
}

// ----------------------------------------------------------------
// 差分エクスポート設定
// ----------------------------------------------------------------
async function setupDiffExport() {
  const chk = document.getElementById("chk-diff-export");
  if (!chk) return;
  const { diffExportEnabled } = await browser.storage.local.get("diffExportEnabled");
  chk.checked = !!diffExportEnabled; // デフォルトOFF
  chk.addEventListener("change", async () => {
    await browser.storage.local.set({ diffExportEnabled: chk.checked });
  });
}

// ----------------------------------------------------------------
// ファイル名設定
// ----------------------------------------------------------------
async function setupFilenameSettings() {
  const chkTag    = document.getElementById("chk-filename-include-tag");
  const chkSubtag = document.getElementById("chk-filename-include-subtag");
  const chkAuthor = document.getElementById("chk-filename-include-author");
  if (!chkTag || !chkSubtag || !chkAuthor) return;

  const { filenameIncludeTag, filenameIncludeSubtag, filenameIncludeAuthor } =
    await browser.storage.local.get(["filenameIncludeTag", "filenameIncludeSubtag", "filenameIncludeAuthor"]);
  chkTag.checked    = !!filenameIncludeTag;    // デフォルトOFF
  chkSubtag.checked = !!filenameIncludeSubtag; // デフォルトOFF
  chkAuthor.checked = !!filenameIncludeAuthor; // デフォルトOFF

  chkTag.addEventListener("change",    async () => { await browser.storage.local.set({ filenameIncludeTag:    chkTag.checked    }); });
  chkSubtag.addEventListener("change", async () => { await browser.storage.local.set({ filenameIncludeSubtag: chkSubtag.checked }); });
  chkAuthor.addEventListener("change", async () => { await browser.storage.local.set({ filenameIncludeAuthor: chkAuthor.checked }); });
}

// ----------------------------------------------------------------
// ③ 初期フォルダ設定
// ----------------------------------------------------------------
async function setupRootPath() {
  const stored = await browser.storage.local.get(["explorerRootPath", "explorerStartPriority"]);
  const input = document.getElementById("root-path-input");
  const rootSaveBtn = document.getElementById("root-path-save");
  input.value = stored.explorerRootPath || "";

  // 未変更なら「設定」ボタンを非活性
  function updateRootSaveBtn() {
    rootSaveBtn.disabled = input.value.trim() === (stored.explorerRootPath || "");
  }
  updateRootSaveBtn();
  input.addEventListener("input", updateRootSaveBtn);

  // 優先度ラジオの初期状態
  const priority = stored.explorerStartPriority || "lastSave";
  const radio = document.querySelector(`input[name="start-priority"][value="${priority}"]`);
  if (radio) radio.checked = true;

  // 優先度変更
  document.querySelectorAll("input[name='start-priority']").forEach((r) => {
    r.addEventListener("change", async () => {
      await browser.runtime.sendMessage({
        type: "SET_EXPLORER_START_PRIORITY",
        priority: r.value,
      });
      showStatus(`開始フォルダの優先順位を変更しました: ${r.value === "lastSave" ? "前回の保存先を優先" : "初期フォルダを優先"}`);
    });
  });

  const rootOpenBtn = document.getElementById("root-path-open");
  function updateRootOpenBtn() {
    rootOpenBtn.disabled = !input.value.trim();
  }
  updateRootOpenBtn();
  rootOpenBtn.addEventListener("click", () => {
    const p = input.value.trim();
    if (p) browser.runtime.sendMessage({ type: "OPEN_EXPLORER", path: p });
  });

  document.getElementById("root-path-save").addEventListener("click", async () => {
    const val = input.value.trim();
    await browser.storage.local.set({ explorerRootPath: val || null });
    rootSaveBtn.disabled = true;
    updateRootOpenBtn();
    showStatus(val ? `初期フォルダを設定しました: ${val}` : "初期フォルダをクリアしました");
  });

  document.getElementById("root-path-clear").addEventListener("click", async () => {
    input.value = "";
    await browser.storage.local.set({ explorerRootPath: null });
    showStatus("初期フォルダをクリアしました");
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("root-path-save").click();
  });
}

// ----------------------------------------------------------------
// ⑤ ブックマーク管理
// ----------------------------------------------------------------
async function setupBookmarks() {
  renderBookmarks();

  // ---- 追加 ----
  const addPathInput = document.getElementById("bm-add-path");
  document.getElementById("bm-add-btn").addEventListener("click", () => addBookmark());
  addPathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addBookmark();
  });
}

function addBookmark() {
  const path = document.getElementById("bm-add-path").value.trim();
  if (!path) return;

  // 重複チェック
  if (bookmarks.some((b) => b.path === path)) {
    showStatus("そのパスはすでにブックマーク済みです");
    return;
  }

  bookmarks.push({
    id:    crypto.randomUUID(),
    path,
    label: "", // ラベルは後からインライン編集
  });

  document.getElementById("bm-add-path").value = "";
  saveBookmarks();
  renderBookmarks();
}

function renderBookmarks() {
  const list = document.getElementById("bm-list");
  list["innerHTML"] = "";

  if (bookmarks.length === 0) {
    list["innerHTML"] = `
      <div class="empty-state" style="padding:16px">
        <span class="emoji" style="font-size:20px">⭐</span>
        まだブックマークがありません。<br>よく使うフォルダを追加してください。
      </div>`;
    return;
  }

  for (let i = 0; i < bookmarks.length; i++) {
    list.appendChild(buildBookmarkItem(bookmarks[i], i));
  }
}

function buildBookmarkItem(bm, index) {
  const item = document.createElement("div");
  item.className = "bm-item";
  item.dataset.id = bm.id;
  item.draggable = true;

  const labelDisplay = bm.label || bm.path.split("\\").pop();

  item["innerHTML"] = `
    <span class="bm-item-drag" title="ドラッグで並び替え">⠿</span>
    <span class="bm-item-icon">⭐</span>
    <div class="bm-item-body">
      <div class="bm-item-label-wrap">
        <span class="bm-item-label"
          title="${escHtml(bm.label || "")}">${escHtml(labelDisplay)}</span>
      </div>
      <div class="bm-item-path" title="${escHtml(bm.path)}">${escHtml(bm.path)}</div>
    </div>
    <div class="bm-item-actions">
      <button class="bm-item-btn edit" title="ラベルを編集">✏️</button>
      <button class="bm-item-btn del delete-guarded"  title="削除">🗑</button>
    </div>`;

  // ---- ラベル編集 ----
  item.querySelector(".edit").addEventListener("click", (e) => {
    e.stopPropagation();
    startBmLabelEdit(item, bm);
  });

  // ---- 削除 ----
  item.querySelector(".del").addEventListener("click", (e) => {
    e.stopPropagation();
    bookmarks = bookmarks.filter((b) => b.id !== bm.id);
    saveBookmarks();
    renderBookmarks();
  });

  // ---- ドラッグ＆ドロップ ----
  item.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/plain", bm.id);
    item.classList.add("dragging");
  });
  item.addEventListener("dragend", () => item.classList.remove("dragging"));
  item.addEventListener("dragover", (e) => {
    e.preventDefault();
    item.classList.add("drag-over");
  });
  item.addEventListener("dragleave", () => item.classList.remove("drag-over"));
  item.addEventListener("drop", (e) => {
    e.preventDefault();
    item.classList.remove("drag-over");
    const fromId = e.dataTransfer.getData("text/plain");
    const fromIdx = bookmarks.findIndex((b) => b.id === fromId);
    const toIdx   = bookmarks.findIndex((b) => b.id === bm.id);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const [moved] = bookmarks.splice(fromIdx, 1);
    bookmarks.splice(toIdx, 0, moved);
    saveBookmarks();
    renderBookmarks();
  });

  return item;
}

function startBmLabelEdit(item, bm) {
  const wrap = item.querySelector(".bm-item-label-wrap");
  wrap["innerHTML"] = `
    <input class="bm-item-label-input" type="text"
      value="${escHtml(bm.label || "")}"
      placeholder="ラベルを入力（省略可）" />`;
  const input = wrap.querySelector("input");
  input.focus(); input.select();

  function commit() {
    const b = bookmarks.find((x) => x.id === bm.id);
    if (b) b.label = input.value.trim();
    saveBookmarks();
    renderBookmarks();
  }
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter")  { e.preventDefault(); commit(); }
    if (e.key === "Escape") { renderBookmarks(); }
  });
}

async function saveBookmarks() {
  await browser.runtime.sendMessage({ type: "SET_BOOKMARKS", data: bookmarks });
  showStatus("ブックマークを保存しました ✔");
}

// ----------------------------------------------------------------
// 動作ログ
// ----------------------------------------------------------------
async function setupLogs() {
  await renderLogs();

  document.getElementById("btn-log-refresh").addEventListener("click", renderLogs);

  document.getElementById("btn-log-clear").addEventListener("click", async () => {
    if (!confirm("動作ログをすべて削除しますか？")) return;
    await browser.runtime.sendMessage({ type: "CLEAR_LOGS" });
    await renderLogs();
    showStatus("ログをクリアしました");
  });
}

async function renderLogs() {
  const list = document.getElementById("log-list");
  list["innerHTML"] = "";

  const { logs } = await browser.runtime.sendMessage({ type: "GET_LOGS" });

  if (!logs || logs.length === 0) {
    list["innerHTML"] = `<div class="log-empty">ログがありません</div>`;
    return;
  }

  for (const entry of logs) {
    const div = document.createElement("div");
    div.className = "log-entry";

    // 時刻を短縮表示（日本時間）
    const t = new Date(entry.time).toLocaleTimeString("ja-JP", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const date = new Date(entry.time).toLocaleDateString("ja-JP", {
      month: "2-digit", day: "2-digit",
    });

    div["innerHTML"] = `
      <span class="log-time">${escHtml(date)} ${escHtml(t)}</span>
      <span class="log-level ${escHtml(entry.level)}">${escHtml(entry.level)}</span>
      <span class="log-msg">${escHtml(entry.message)}${
        entry.detail ? `<br><span class="log-detail">${escHtml(String(entry.detail))}</span>` : ""
      }</span>`;

    list.appendChild(div);
  }
}

// ----------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------
function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ----------------------------------------------------------------
// 保存履歴タブ
// ----------------------------------------------------------------
let _historyData = [];
let _currentFilteredHistory = null; // 絞り込み中はフィルター後配列、なしは null
let _histFilterTag = "";
let _histFilterMode = "or"; // "or" | "and"
let _histScrollPos = 0; // 絞り込みなし時のスクロール位置
let _histPage     = 0;   // 現在ページ（0始まり）
let _histPageSize = 100; // 1ページの表示件数
let _histSelected  = new Set();

/** 保存履歴表示モードの設定 */
async function setupDisplayCounts() {
  const { recentTagDisplayCount, bookmarkDisplayCount } = await browser.storage.local.get(["recentTagDisplayCount", "bookmarkDisplayCount"]);
  const rcSel = document.getElementById("recent-tag-count-select");
  const bmSel = document.getElementById("bookmark-count-select");
  if (rcSel) {
    rcSel.value = String(recentTagDisplayCount || 20);
    rcSel.addEventListener("change", () => {
      browser.storage.local.set({ recentTagDisplayCount: Number(rcSel.value) });
    });
  }
  if (bmSel) {
    bmSel.value = String(bookmarkDisplayCount || 20);
    bmSel.addEventListener("change", () => {
      browser.storage.local.set({ bookmarkDisplayCount: Number(bmSel.value) });
    });
  }
}

async function setupHistoryDisplayMode() {
  const { historyDisplayMode } = await browser.storage.local.get("historyDisplayMode");
  const mode = historyDisplayMode || "normal";
  const radio = document.querySelector(`input[name="history-display-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;

  document.querySelectorAll('input[name="history-display-mode"]').forEach(r => {
    r.addEventListener("change", async () => {
      await browser.storage.local.set({ historyDisplayMode: r.value });
      renderHistoryGrid();
    });
  });

  // 読み進める方向（デフォルト: rtl）
  const { groupReadDirection } = await browser.storage.local.get("groupReadDirection");
  const dir = groupReadDirection || "rtl";
  const dirRadio = document.querySelector(`input[name="group-read-direction"][value="${dir}"]`);
  if (dirRadio) dirRadio.checked = true;

  document.querySelectorAll('input[name="group-read-direction"]').forEach(r => {
    r.addEventListener("change", async () => {
      await browser.storage.local.set({ groupReadDirection: r.value });
    });
  });
}

function setupHistoryTab() {
  // 絞り込み入力
  const filterInput = document.getElementById("hist-filter");
  const filterClear = document.getElementById("hist-filter-clear");
  const selectAllBtn = document.getElementById("hist-select-all");

  function updateSelectAllBtn() {
    // 何らかの絞り込みが有効な場合のみ活性化
    selectAllBtn.disabled = !_histFilterTag && !_histAuthorFilter && !_histSourceFilter;
  }
  _updateSelectAllBtn = updateSelectAllBtn; // グローバル参照を更新

  const filterModeSelect = document.getElementById("hist-filter-mode");
  if (filterModeSelect) {
    filterModeSelect.addEventListener("change", () => {
      _histFilterMode = filterModeSelect.value;
      _histPage = 0;
      if (_histFilterTag) renderHistoryGrid();
    });
  }

  filterInput.addEventListener("input", () => {
    const prev = _histFilterTag;
    _histFilterTag = filterInput.value.trim().toLowerCase();
    _histPage = 0;
    filterClear.style.display = _histFilterTag ? "" : "none";
    updateSelectAllBtn();
    if (!prev && _histFilterTag) {
      const grid = document.getElementById("hist-grid");
      _histScrollPos = grid?.scrollTop ?? 0;
    }
    renderHistoryGrid();
  });
  filterClear.addEventListener("click", () => {
    _histFilterTag = "";
    _histPage = 0;
    filterInput.value = "";
    filterClear.style.display = "none";
    updateSelectAllBtn();
    renderHistoryGrid();
  });

  // 件数セレクト
  const pageSizeSelect = document.getElementById("hist-page-size-select");
  if (pageSizeSelect) {
    pageSizeSelect.addEventListener("change", () => {
      _histPageSize = parseInt(pageSizeSelect.value);
      _histPage = 0;
      browser.storage.local.set({ settingsHistoryPageSize: _histPageSize }).catch(() => {});
      renderHistoryGrid();
    });
  }

  // 全選択（絞り込み中の全件）
  selectAllBtn.addEventListener("click", () => {
    if (!_histFilterTag && !_histAuthorFilter && !_histSourceFilter) return;
    const filterTokens = _histFilterTag ? _histFilterTag.split(/\s+/).filter(Boolean) : [];
    const authorQ      = _histAuthorFilter.trim().toLowerCase();
    const filtered = _historyData.filter(e => {
      const entryTags = (e.tags || []).map(t => t.toLowerCase());
      const tagMatch = !filterTokens.length || (_histFilterMode === "and"
        ? filterTokens.every(token => entryTags.some(t => t.includes(token)))
        : filterTokens.some(token => entryTags.some(t => t.includes(token))));
      const eAuthors = getEntryAuthors(e).map(a => a.toLowerCase());
      const authorMatch = !authorQ || eAuthors.some(a => a.includes(authorQ));
      const sourceMatch = !_histSourceFilter || (
        _histSourceFilter === "external_import" ? e.source === "external_import"
        : e.source !== "external_import"
      );
      return tagMatch && authorMatch && sourceMatch;
    });
    filtered.forEach(e => _histSelected.add(e.id));
    document.getElementById("hist-deselect-all").disabled = _histSelected.size === 0;
    document.getElementById("hist-delete-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-add-tag-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-group-selected").disabled = _histSelected.size < 2;
    document.getElementById("hist-ungroup-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-sync-global-tags").disabled = _histSelected.size === 0;
    renderHistoryGrid();
  });

  // 選択削除
  document.getElementById("hist-deselect-all").addEventListener("click", () => {
    _histSelected.clear();
    document.getElementById("hist-deselect-all").disabled = true;
    document.getElementById("hist-add-tag-selected").disabled = true;
    document.getElementById("hist-sync-global-tags").disabled = true;
    document.getElementById("hist-group-selected").disabled = true;
    document.getElementById("hist-ungroup-selected").disabled = true;
    document.getElementById("hist-delete-selected").disabled = true;
    renderHistoryGrid();
  });

  document.getElementById("hist-delete-selected").addEventListener("click", async () => {
    if (!_histSelected.size) return;
    if (!confirm(`選択した ${_histSelected.size} 件を削除しますか？`)) return;
    const stored = await browser.storage.local.get("saveHistory");
    const history = (stored.saveHistory || []).filter(e => !_histSelected.has(e.id));
    await browser.storage.local.set({ saveHistory: history });
    _histSelected.clear();
    await renderHistoryTab();
  });

  // 全件削除
  // 連続保存グループ化
  document.getElementById("hist-ungroup-selected").addEventListener("click", async () => {
    if (_histSelected.size < 1) return;
    const ids = [..._histSelected];
    const stored = await browser.storage.local.get("saveHistory");
    const history = stored.saveHistory || [];
    // 選択エントリのみを個別解除（他のメンバーはグループのまま残る）
    const targets = history.filter(e => ids.includes(e.id) && e.sessionId);
    if (targets.length === 0) { showStatus("グループに属する履歴が選択されていません", true); return; }

    targets.forEach(entry => {
      entry.sessionId    = null;
      entry.sessionIndex = null;
    });

    await browser.storage.local.set({ saveHistory: history });
    _historyData = history;
    _histSelected.clear();
    renderHistoryGrid();
    showStatus(`${targets.length} 件をグループから解除しました`);
  });


  document.getElementById("hist-group-selected").addEventListener("click", async () => {
    if (_histSelected.size < 2) return;
    const ids = [..._histSelected];
    if (!confirm(`選択した ${ids.length} 件を連続保存グループにまとめますか？\n新しいセッションIDが付与されます。`)) return;

    const stored = await browser.storage.local.get("saveHistory");
    const history = stored.saveHistory || [];
    const newSessionId = crypto.randomUUID();

    const targets = history
      .filter(e => ids.includes(e.id))
      .sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt));

    targets.forEach((entry, i) => {
      entry.sessionId    = newSessionId;
      entry.sessionIndex = i + 1;
    });

    await browser.storage.local.set({ saveHistory: history });
    _historyData = history;
    _histSelected.clear();
    renderHistoryGrid();
    showStatus(`${targets.length} 件をグループ化しました`);
  });

  // 一括タグ追加
  document.getElementById("hist-add-tag-selected").addEventListener("click", () => {
    if (!_histSelected.size) return;
    const ids = [..._histSelected];
    // 選択エントリの共通タグをデフォルト表示（最初のエントリのタグを参考に）
    const firstEntry = _historyData.find(e => _histSelected.has(e.id));
    showAddTagDialog(ids, firstEntry?.tags || []);
  });

  /**
   * タグ追加ダイアログ
   * @param {string[]} targetIds 対象エントリのID配列
   * @param {string[]} existingTags 既存タグ（サジェスト用）
   */
  function showAddTagDialog(targetIds, existingTags) {
    const existing = document.querySelector(".add-tag-dialog-overlay");
    if (existing) existing.remove();

    const isBulk = targetIds.length > 1;
    const overlay = document.createElement("div");
    overlay.className = "add-tag-dialog-overlay period-dialog-overlay";
    overlay.innerHTML = `
      <div class="period-dialog" style="max-width:380px">
        <h3>🏷 タグを追加${isBulk ? `（${targetIds.length}件）` : ""}</h3>
        ${isBulk ? `<div style="font-size:12px;color:#888;margin-bottom:10px">選択した全履歴に同じタグを追加します</div>` : ""}
        <div style="margin-bottom:14px">
          <div style="font-size:12px;color:#555;margin-bottom:6px">追加するタグ（カンマ・スペース・Enterで区切り）</div>
          <div style="border:1px solid #ccc;border-radius:6px;padding:6px 8px;min-height:36px;
            display:flex;flex-wrap:wrap;gap:4px;align-items:center;cursor:text" id="atd-chip-area">
            <input id="atd-input" type="text" autocomplete="off"
              style="border:none;outline:none;font-size:13px;min-width:80px;flex:1;font-family:inherit"
              placeholder="タグを入力…" />
          </div>
          <div id="atd-suggestions" style="border:1px solid #e0e0e0;border-radius:6px;background:#fff;
            max-height:100px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.1);display:none;margin-top:2px"></div>
        </div>
        <div class="pd-footer">
          <button class="pd-cancel">キャンセル</button>
          <button class="atd-ok pd-ok" style="background:#4a90e2" disabled>追加する</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const chipArea   = overlay.querySelector("#atd-chip-area");
    const input      = overlay.querySelector("#atd-input");
    const suggestBox = overlay.querySelector("#atd-suggestions");
    const okBtn      = overlay.querySelector(".atd-ok");
    const pendingTags = new Set();

    // globalTagsを取得してサジェストに使用
    browser.storage.local.get("globalTags").then(({ globalTags }) => {
      const allTags = globalTags || [];

      function updateSuggest(q) {
        const matches = allTags.filter(t =>
          t.toLowerCase().includes(q.toLowerCase()) && !pendingTags.has(t)
        );
        if (!matches.length || !q) { suggestBox.style.display = "none"; return; }
        suggestBox.innerHTML = matches.slice(0, 8)
          .map(t => `<div class="atd-sug" style="padding:6px 10px;cursor:pointer;font-size:13px"
            data-tag="${escHtml(t)}">${escHtml(t)}</div>`).join("");
        suggestBox.style.display = "";
        suggestBox.querySelectorAll(".atd-sug").forEach(el => {
          el.addEventListener("mousedown", (e) => { e.preventDefault(); addChip(el.dataset.tag); });
          el.addEventListener("mouseover", () => el.style.background = "#f0f4ff");
          el.addEventListener("mouseout",  () => el.style.background = "");
        });
      }

      function addChip(tag) {
        tag = tag.trim();
        if (!tag || pendingTags.has(tag)) return;
        pendingTags.add(tag);
        const chip = document.createElement("span");
        chip.style.cssText = "background:#ddeaff;border:1px solid #4a90e2;border-radius:12px;padding:2px 8px;font-size:12px;display:flex;align-items:center;gap:4px;";
        chip.innerHTML = `${escHtml(tag)}<button style="background:none;border:none;cursor:pointer;color:#4a90e2;font-size:13px;padding:0;line-height:1">×</button>`;
        chip.querySelector("button").addEventListener("click", () => { chip.remove(); pendingTags.delete(tag); okBtn.disabled = pendingTags.size === 0; });
        chipArea.insertBefore(chip, input);
        input.value = "";
        suggestBox.style.display = "none";
        okBtn.disabled = false;
      }

      input.addEventListener("input", () => updateSuggest(input.value));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === "," || e.key === " ") {
          e.preventDefault();
          if (input.value.trim()) addChip(input.value);
        } else if (e.key === "Backspace" && !input.value) {
          const chips = chipArea.querySelectorAll("span");
          if (chips.length) chips[chips.length - 1].querySelector("button").click();
        }
      });
      input.addEventListener("blur", () => setTimeout(() => { suggestBox.style.display = "none"; }, 150));
      chipArea.addEventListener("click", () => input.focus());
    });

    okBtn.addEventListener("click", async () => {
      if (!pendingTags.size) return;
      overlay.remove();

      const stored = await browser.storage.local.get("saveHistory");
      const history = stored.saveHistory || [];
      let changed = false;
      for (const entry of history) {
        if (!targetIds.includes(entry.id)) continue;
        const current = new Set(entry.tags || []);
        for (const t of pendingTags) {
          if (!current.has(t)) { current.add(t); changed = true; }
        }
        entry.tags = [...current];
      }
      if (changed) {
        await browser.storage.local.set({ saveHistory: history });
        // globalTagsにも追加
        const { globalTags } = await browser.storage.local.get("globalTags");
        const gSet = new Set(globalTags || []);
        for (const t of pendingTags) gSet.add(t);
        await browser.storage.local.set({ globalTags: [...gSet] });
        _historyData = history;
        renderHistoryGrid();
        showStatus(`タグを ${pendingTags.size} 件追加しました`);
      }
    });

    overlay.querySelector(".pd-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
    setTimeout(() => input.focus(), 50);
  }

  document.getElementById("hist-delete-period").addEventListener("click", () => {
    showPeriodDeleteDialog();
  });

  document.getElementById("hist-gen-thumbs").addEventListener("click", async () => {
    const selectedEntries = _historyData.filter(e => _histSelected.has(e.id));
    if (selectedEntries.length === 0) {
      showStatus("⚠️ 先に対象の履歴を選択してください", true);
      return;
    }

    const noThumbCount  = selectedEntries.filter(e => !e.thumbId).length;
    const hasThumbCount = selectedEntries.filter(e =>  e.thumbId).length;

    // 確認ダイアログで実行モードを選択
    const mode = await showThumbGenConfirmDialog(selectedEntries.length, noThumbCount, hasThumbCount);
    if (!mode) return; // キャンセル

    const overwrite = mode === "overwrite";
    // overwrite=true なら全選択対象、false ならサムネイルなしのみ
    const targetEntries = overwrite
      ? selectedEntries
      : selectedEntries.filter(e => !e.thumbId);

    if (targetEntries.length === 0) {
      showStatus("生成対象がありません");
      return;
    }

    const btn = document.getElementById("hist-gen-thumbs");
    btn.disabled = true;
    btn.textContent = "🖼 生成中…";

    const res = await browser.runtime.sendMessage({
      type: "GENERATE_MISSING_THUMBS",
      targetIds: targetEntries.map(e => e.id),
      overwrite,
    });

    btn.disabled = false;
    btn.textContent = "🖼 サムネイル生成";

    showThumbGenResultDialog(res, targetEntries.length);

    if (res?.ok && res.generated > 0) {
      const stored = await browser.storage.local.get("saveHistory");
      _historyData = stored.saveHistory || [];
      renderHistoryGrid();
    }
  });

  /** サムネイル生成 確認ダイアログ。"normal" / "overwrite" / null(キャンセル) を返す */
  function showThumbGenConfirmDialog(total, noThumb, hasThumb) {
    return new Promise((resolve) => {
      const existing = document.querySelector(".thumb-confirm-overlay");
      if (existing) existing.remove();

      const overlay = document.createElement("div");
      overlay.className = "thumb-confirm-overlay period-dialog-overlay";
      overlay.innerHTML = `
        <div class="period-dialog" style="max-width:380px">
          <h3>🖼 サムネイル生成</h3>
          <div style="font-size:13px;color:#444;line-height:1.8;margin-bottom:14px">
            選択中：<b>${total} 件</b>
            （サムネイルなし <b>${noThumb} 件</b> / あり <b>${hasThumb} 件</b>）
          </div>
          <div class="pd-footer" style="gap:6px;flex-wrap:wrap;justify-content:flex-end">
            <button class="pd-cancel">キャンセル</button>
            <button class="btn-normal pd-ok" style="background:#4a90e2"
              ${noThumb === 0 ? "disabled" : ""}>サムネイルなしのみ生成（${noThumb}件）</button>
            <button class="btn-overwrite pd-ok" style="background:#e67e22">すべて上書き生成（${total}件）</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      overlay.querySelector(".btn-normal").addEventListener("click", () => { overlay.remove(); resolve("normal"); });
      overlay.querySelector(".btn-overwrite").addEventListener("click", () => { overlay.remove(); resolve("overwrite"); });
      overlay.querySelector(".pd-cancel").addEventListener("click", () => { overlay.remove(); resolve(null); });
      overlay.addEventListener("click", e => { if (e.target === overlay) { overlay.remove(); resolve(null); } });
    });
  }

  /** サムネイル生成結果ダイアログ */
  function showThumbGenResultDialog(res, total) {
    const existing = document.querySelector(".thumb-result-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "thumb-result-overlay period-dialog-overlay";
    overlay.innerHTML = `
      <div class="period-dialog" style="max-width:360px">
        <h3>🖼 サムネイル生成結果</h3>
        <div style="font-size:13px;color:#444;line-height:1.9;margin-bottom:14px">
          <div>対象件数：<b>${total} 件</b></div>
          <div style="color:#27ae60">✅ 成功：<b>${res?.generated ?? 0} 件</b></div>
          ${(res?.failed  ?? 0) > 0 ? `<div style="color:#e74c3c">❌ 失敗：<b>${res.failed} 件</b>（ファイルが見つからない等）</div>` : ""}
          ${(res?.skipped ?? 0) > 0 ? `<div style="color:#888">⏭ スキップ：<b>${res.skipped} 件</b>（パス情報なし）</div>` : ""}
        </div>
        <div class="pd-footer">
          <button class="pd-ok" style="background:#4a90e2">閉じる</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector(".pd-ok").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
  }

  /** 期間指定削除ダイアログを表示 */
  function showPeriodDeleteDialog() {
    const existing = document.querySelector(".period-dialog-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "period-dialog-overlay";

    // デフォルト：今日の日付
    const todayStr = new Date().toISOString().slice(0, 10);

    overlay.innerHTML = `
      <div class="period-dialog">
        <h3>🗑 期間指定で履歴を削除</h3>
        <div class="pd-row">
          <label>開始日</label>
          <input type="date" id="pd-from" value="" />
        </div>
        <div class="pd-row">
          <label>終了日</label>
          <input type="date" id="pd-to" value="${todayStr}" />
        </div>
        <div class="pd-preview" id="pd-preview">　</div>
        <div class="pd-footer">
          <button class="pd-cancel">キャンセル</button>
          <button class="pd-ok" disabled>削除</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const fromInput = overlay.querySelector("#pd-from");
    const toInput   = overlay.querySelector("#pd-to");
    const preview   = overlay.querySelector("#pd-preview");
    const okBtn     = overlay.querySelector(".pd-ok");

    function updatePreview() {
      const from = fromInput.value ? new Date(fromInput.value + "T00:00:00") : null;
      const to   = toInput.value   ? new Date(toInput.value   + "T23:59:59") : null;
      const targets = _historyData.filter(e => {
        const d = new Date(e.savedAt);
        if (from && d < from) return false;
        if (to   && d > to)   return false;
        return true;
      });
      if (!from && !to) {
        preview.textContent = "期間を指定してください";
        okBtn.disabled = true;
      } else if (targets.length === 0) {
        preview.textContent = "該当する履歴がありません";
        okBtn.disabled = true;
      } else {
        preview.textContent = `${targets.length} 件が削除対象です`;
        okBtn.disabled = false;
      }
    }

    fromInput.addEventListener("change", updatePreview);
    toInput.addEventListener("change", updatePreview);

    overlay.querySelector(".pd-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    okBtn.addEventListener("click", async () => {
      const from = fromInput.value ? new Date(fromInput.value + "T00:00:00") : null;
      const to   = toInput.value   ? new Date(toInput.value   + "T23:59:59") : null;
      const targets = _historyData.filter(e => {
        const d = new Date(e.savedAt);
        if (from && d < from) return false;
        if (to   && d > to)   return false;
        return true;
      });
      if (targets.length === 0) return;
      if (!confirm(`${targets.length} 件の履歴を削除しますか？\n（サムネイルも削除されます）`)) return;

      for (const e of targets) {
        if (e.thumbId) {
          await browser.runtime.sendMessage({ type: "DELETE_THUMB", thumbId: e.thumbId });
        }
      }
      const targetIds = new Set(targets.map(e => e.id));
      _historyData = _historyData.filter(e => !targetIds.has(e.id));
      _histSelected.clear();
      await browser.storage.local.set({ saveHistory: _historyData });
      overlay.remove();
      renderHistoryGrid();
      showStatus(`${targets.length} 件の履歴を削除しました`);
    });
  }

  // 作者フィルター
  const authorFilterInput = document.getElementById("hist-author-filter");
  const authorFilterClear = document.getElementById("hist-author-filter-clear");
  if (authorFilterInput) {
    authorFilterInput.addEventListener("input", () => {
      _histAuthorFilter = authorFilterInput.value.trim().toLowerCase();
      _histPage = 0;
      if (authorFilterClear) authorFilterClear.style.display = _histAuthorFilter ? "" : "none";
      renderHistoryGrid();
    });
  }
  if (authorFilterClear) {
    authorFilterClear.addEventListener("click", () => {
      _histAuthorFilter = "";
      _histPage = 0;
      if (authorFilterInput) { authorFilterInput.value = ""; }
      authorFilterClear.style.display = "none";
      renderHistoryGrid();
    });
  }

  // 取り込み元フィルター
  const sourceFilterSelect = document.getElementById("hist-source-filter");
  if (sourceFilterSelect) {
    sourceFilterSelect.addEventListener("change", () => {
      _histSourceFilter = sourceFilterSelect.value;
      _histPage = 0;
      updateSelectAllBtn();
      renderHistoryGrid();
    });
  }

  // タグ・保存先反映ボタン
  // - タグ・サブタグを globalTags に追加
  // - メインタグの保存先を tagDestinations に追記（サブタグは除外）
  document.getElementById("hist-sync-global-tags").addEventListener("click", async () => {
    if (!_histSelected.size) return;
    const selectedEntries = _historyData.filter(e => _histSelected.has(e.id));

    // globalTags 更新（メイン + サブ）
    const allTagsFlat = selectedEntries.flatMap(e => e.tags || []);
    const currentGlobalSet = new Set(globalTags);
    const newGlobalTagsList = [...new Set(allTagsFlat)].filter(t => !currentGlobalSet.has(t));
    const newGlobalTags = [...globalTags, ...newGlobalTagsList];

    // tagDestinations 更新（メインタグのみ・サブタグは除外）
    let destAddCount = 0;
    for (const entry of selectedEntries) {
      const path = Array.isArray(entry.savePaths) ? (entry.savePaths[0] || "") : (entry.savePath || "");
      if (!path) continue;
      for (const tag of (entry.tags || [])) {
        if (!tagDestinations[tag]) tagDestinations[tag] = [];
        if (!tagDestinations[tag].some(d => d.path === path)) {
          tagDestinations[tag].push({ id: crypto.randomUUID(), path, label: "" });
          destAddCount++;
        }
      }
    }

    if (newGlobalTagsList.length === 0 && destAddCount === 0) {
      showStatus("すべて反映済みです（新規追加なし）");
      return;
    }

    await browser.storage.local.set({ globalTags: newGlobalTags, tagDestinations });
    globalTags = newGlobalTags;

    const parts = [];
    if (newGlobalTagsList.length > 0) parts.push(`新規タグ: ${newGlobalTagsList.length} 件`);
    if (destAddCount > 0) parts.push(`保存先: ${destAddCount} 件`);
    showStatus(`✅ 反映しました（${parts.join("、")}）`);
    renderAll();
  });
}

async function renderHistoryTab() {
  const stored = await browser.storage.local.get(["saveHistory", "settingsHistoryPageSize"]);
  _historyData  = stored.saveHistory              || [];
  _histPageSize = stored.settingsHistoryPageSize  || 100;
  // セレクトの値も同期
  const sel = document.getElementById("hist-page-size-select");
  if (sel) sel.value = String(_histPageSize);
  _histSelected.clear();

  // 容量表示
  browser.runtime.sendMessage({ type: "GET_STORAGE_SIZE" }).then(r => {
    if (r) {
      document.getElementById("hist-storage").textContent = `保存履歴情報: ${r.storageSizeStr}`;
      document.getElementById("hist-idb").textContent     = `保存サムネイル: ${r.idbSizeStr}`;
    }
  }).catch(() => {});

  renderHistoryGrid();
}

function renderHistoryGrid() {
  const grid = document.getElementById("hist-grid");
  grid.innerHTML = "";

  const filterQ = _histFilterTag;
  const filterTokens = filterQ ? filterQ.split(/\s+/).filter(Boolean) : [];
  const authorQ = _histAuthorFilter.trim().toLowerCase();
  const hasTagFilter    = filterTokens.length > 0;
  const hasAuthorFilter = !!authorQ;
  const hasSourceFilter = !!_histSourceFilter;

  const filtered = (hasTagFilter || hasAuthorFilter || hasSourceFilter)
    ? _historyData.filter(e => {
        const entryTags = (e.tags || []).map(t => t.toLowerCase());
        const tagMatch = !hasTagFilter || (
          _histFilterMode === "and"
            ? filterTokens.every(token => entryTags.some(t => t === token))
            : filterTokens.some(token => entryTags.some(t => t === token))
        );
        const eAuthors = getEntryAuthors(e).map(a => a.toLowerCase());
        const authorMatch = !hasAuthorFilter || eAuthors.some(a => a.includes(authorQ));
        const sourceMatch = !hasSourceFilter || (
          _histSourceFilter === "external_import" ? e.source === "external_import"
          : e.source !== "external_import"
        );
        // タグ・権利者の両フィルター有効時のみモードを適用。ソースフィルタは常に AND
        let tagAuthorMatch;
        if (hasTagFilter && hasAuthorFilter) {
          tagAuthorMatch = _histFilterMode === "and" ? (tagMatch && authorMatch) : (tagMatch || authorMatch);
        } else {
          tagAuthorMatch = tagMatch && authorMatch;
        }
        return tagAuthorMatch && sourceMatch;
      })
    : _historyData;

  // 絞り込み結果をライトボックスのグローバルナビ用に保持
  _currentFilteredHistory = (hasTagFilter || hasAuthorFilter || hasSourceFilter) ? filtered : null;

  const isFiltering = hasTagFilter || hasAuthorFilter || hasSourceFilter;
  const totalFiltered = filtered.length;

  // ページ範囲補正
  const totalPages = Math.max(1, Math.ceil(totalFiltered / _histPageSize));
  if (_histPage >= totalPages) _histPage = totalPages - 1;
  const pageSlice = filtered.slice(_histPage * _histPageSize, (_histPage + 1) * _histPageSize);

  const countEl = document.getElementById("hist-count");
  if (countEl) {
    const suffix = isFiltering ? "（絞り込み中）" : "";
    if (totalFiltered <= _histPageSize) {
      countEl.textContent = `${totalFiltered} 件${suffix}`;
    } else {
      countEl.textContent = `${_histPage + 1}/${totalPages} ページ（全 ${totalFiltered} 件${suffix ? "・絞り込み中" : ""}）`;
    }
  }

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="hist-empty">${
      isFiltering ? "絞り込み条件に一致する履歴がありません" : "保存履歴がありません"
    }</div>`;
    renderHistoryPager(0);
    return;
  }

  renderHistoryPager(totalFiltered);

  // 表示モード判定
  const modeRadio = document.querySelector('input[name="history-display-mode"]:checked');
  const displayMode = modeRadio ? modeRadio.value : "normal";

  if (displayMode === "group") {
    renderHistoryGridGrouped(grid, pageSlice);
    document.getElementById("hist-delete-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-deselect-all").disabled = _histSelected.size === 0;
    document.getElementById("hist-add-tag-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-sync-global-tags").disabled = _histSelected.size === 0;
    document.getElementById("hist-group-selected").disabled = _histSelected.size < 2;
    document.getElementById("hist-ungroup-selected").disabled = _histSelected.size === 0;
    return;
  }

  for (const entry of pageSlice) {
    const card = document.createElement("div");
    card.className = "hist-card" + (_histSelected.has(entry.id) ? " selected" : "");
    _buildHistCardInner(card, entry);
    grid.appendChild(card);
  }

  document.getElementById("hist-delete-selected").disabled = _histSelected.size === 0;
  document.getElementById("hist-deselect-all").disabled = _histSelected.size === 0;
  document.getElementById("hist-add-tag-selected").disabled = _histSelected.size === 0;
  document.getElementById("hist-sync-global-tags").disabled = _histSelected.size === 0;
  document.getElementById("hist-group-selected").disabled = _histSelected.size < 2;
  document.getElementById("hist-ungroup-selected").disabled = _histSelected.size === 0;
}

function renderHistoryPager(total) {
  const totalPages = Math.max(1, Math.ceil(total / _histPageSize));

  function buildPager() {
    const frag = document.createDocumentFragment();
    if (total <= _histPageSize) return frag;

    const makeBtn = (p) => {
      const btn = document.createElement("button");
      btn.className = "hist-pager-btn" + (p === _histPage ? " current" : "");
      btn.textContent = String(p + 1);
      btn.disabled = (p === _histPage);
      btn.addEventListener("click", () => { _histPage = p; renderHistoryGrid(); });
      return btn;
    };
    const makeDots = () => {
      const s = document.createElement("span");
      s.className = "hist-pager-dots";
      s.textContent = "…";
      return s;
    };

    if (totalPages <= 5) {
      for (let p = 0; p < totalPages; p++) frag.appendChild(makeBtn(p));
    } else {
      frag.appendChild(makeBtn(0));
      const rStart = Math.max(1, _histPage - 2);
      const rEnd   = Math.min(totalPages - 2, _histPage + 2);
      if (rStart > 1) frag.appendChild(makeDots());
      for (let p = rStart; p <= rEnd; p++) frag.appendChild(makeBtn(p));
      if (rEnd < totalPages - 2) frag.appendChild(makeDots());
      frag.appendChild(makeBtn(totalPages - 1));
    }
    return frag;
  }

  ["hist-pager-top", "hist-pager-bottom"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = "";
    el.appendChild(buildPager());
  });
}

/** グループ表示モード：同一 sessionId をまとめて1タイルに表示 */
function renderHistoryGridGrouped(grid, entries) {
  // sessionId でグループ化。nullは個別扱い（グループIDとして entry.id を使う）
  const groups = [];
  const groupMap = new Map(); // sessionId → group index

  for (const entry of entries) {
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
      // 通常カード（セッションなし or 1件のみ）
      const entry = group.items[0];
      const card = document.createElement("div");
      card.className = "hist-card" + (_histSelected.has(entry.id) ? " selected" : "");
      _buildHistCardInner(card, entry);
      grid.appendChild(card);
    } else {
      // グループカード
      const first = group.items.at(-1); // 最初に保存した画像（unshiftで末尾が古い）
      const paths = Array.isArray(first.savePaths) ? first.savePaths : (first.savePath ? [first.savePath] : []);
      const primary = paths[0] ?? "";
      const date  = new Date(first.savedAt).toLocaleString("ja-JP");
      const tagHtml = (first.tags || [])
        .map(t => `<span class="hist-card-tag" data-tag="${escHtml(t)}">${escHtml(t)}</span>`).join("");

      // ラッパー（overflow: visible で展開エリアを外に出す）
      const wrapper = document.createElement("div");
      wrapper.style.cssText = "display:flex;flex-direction:column;gap:0;flex-shrink:0;width:220px;align-self:flex-start;";

      // 先頭カード（通常カードと同サイズ）
      const card = document.createElement("div");
      card.className = "hist-card hist-card-group";
      card.style.cssText = "border-color:#e67e22;position:relative;width:220px;height:360px;";

      // 枚数バッジ
      const badge = document.createElement("div");
      badge.style.cssText = "position:absolute;top:4px;right:6px;z-index:2;font-size:10px;font-weight:700;" +
        "background:#e67e22;color:#fff;padding:1px 6px;border-radius:10px;pointer-events:none;";
      badge.textContent = `${group.items.length}枚`;

      // プレースホルダー
      const placeholder = document.createElement("div");
      placeholder.className = "hist-card-thumb-placeholder";

      // オーバーレイ（情報エリア）
      const overlay = document.createElement("div");
      overlay.className = "hist-card-overlay";
      overlay.innerHTML = `
        <div class="hist-card-body">
          <div class="hist-card-filename" title="${escHtml(first.filename)}">${escHtml(first.filename)} 他</div>
          <div class="hist-card-path" title="${escHtml(primary)}">${escHtml(primary || "（パスなし）")}</div>
          <div class="hist-card-tags">${tagHtml}</div>
          <div class="hist-card-date">${escHtml(date)}</div>
        </div>`;

      card.appendChild(badge);
      card.appendChild(placeholder);
      card.appendChild(overlay);

      // 展開ボタン（カードの下に分離）
      const expandBtn = document.createElement("button");
      expandBtn.className = "hist-card-btn";
      expandBtn.style.cssText = "width:100%;border-radius:0 0 8px 8px;border:1px solid #e67e22;border-top:2px solid #e67e22;" +
        "padding:4px;font-size:10px;cursor:pointer;background:#fff8f0;color:#c0622a;font-family:inherit;text-align:center;";
      expandBtn.textContent = `▶ 展開（${group.items.length}枚）`;

      // 展開エリア（スクロール可能な横並び）
      const expandArea = document.createElement("div");
      expandArea.style.cssText = "display:none;flex-direction:row;flex-wrap:wrap;gap:6px;" +
        "padding:8px;border:1px solid #e67e22;border-top:none;background:#fff8f0;" +
        "border-radius:0 0 8px 8px;max-height:600px;overflow-y:auto;";

      wrapper.appendChild(card);
      wrapper.appendChild(expandBtn);
      wrapper.appendChild(expandArea);

      // 1枚目サムネイル
      const orderedItemsForLb = [...group.items].reverse();
      const allDataUrls = new Array(orderedItemsForLb.length).fill(null);
      if (first.thumbId) {
        browser.runtime.sendMessage({ type: "GET_THUMB_DATA_URL", thumbId: first.thumbId })
          .then(r => {
            if (r?.dataUrl) {
              allDataUrls[0] = r.dataUrl;
              const img = document.createElement("img");
              img.className = "hist-card-thumb";
              img.src = r.dataUrl;
              img.style.cursor = "zoom-in";
              img.addEventListener("click", () => {
                const _navData = _currentFilteredHistory ?? _historyData;
                const gIdx = _navData.findIndex(h => h.id === first.id);
                showGroupLightbox(allDataUrls, 0, orderedItemsForLb, { startEntryIndex: gIdx });
              });
              placeholder.replaceWith(img);
            }
          }).catch(() => {});
      }

      // タグクリック絞り込み
      overlay.querySelectorAll(".hist-card-tag").forEach(el => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          _applyTagFilter(el.dataset.tag.toLowerCase());
        });
      });

      // 展開ボタンイベント
      let expanded = false;
      expandBtn.addEventListener("click", () => {
        expanded = !expanded;
        expandArea.style.display = expanded ? "flex" : "none";
        expandBtn.textContent = expanded ? `▼ 折りたたむ` : `▶ 展開（${group.items.length}枚）`;
        expandBtn.style.borderRadius = expanded ? "0" : "0 0 8px 8px";
        if (expanded && expandArea.childElementCount === 0) {
          orderedItemsForLb.forEach((item, idx) => {
            const sub = document.createElement("div");
            sub.className = "hist-card";
            sub.style.cssText = "width:220px;height:360px;flex-shrink:0;";
            _buildHistCardInner(sub, item, (dataUrl) => {
              allDataUrls[idx] = dataUrl;
              const _navData = _currentFilteredHistory ?? _historyData;
              const gIdx = _navData.findIndex(h => h.id === item.id);
              showGroupLightbox(allDataUrls, idx, orderedItemsForLb, { startEntryIndex: gIdx });
            });
            expandArea.appendChild(sub);
          });
        }
      });

      grid.appendChild(wrapper);
    }
  }
}

/**
 * hist-card の内部HTML・イベントを構築する共通関数
 * renderHistoryGrid と renderHistoryGridGrouped の両方から使用
 */
// setupHistoryTab内で代入される（スコープ外から参照するため）
let _updateSelectAllBtn = () => {};

/** タグチップクリックで絞り込みを切り替える共通処理 */
function _applyTagFilter(tag) {
  const prev = _histFilterTag;
  // 既存トークンにタグを追加/削除（スペース区切りで複数対応）
  const tokens = prev ? prev.split(/\s+/).filter(Boolean) : [];
  const idx = tokens.indexOf(tag);
  if (idx !== -1) {
    tokens.splice(idx, 1); // 既に含まれていれば除去
  } else {
    tokens.push(tag.toLowerCase());      // 含まれていなければ追加
  }
  _histFilterTag = tokens.join(" ");
  document.getElementById("hist-filter").value = _histFilterTag;
  document.getElementById("hist-filter-clear").style.display = _histFilterTag ? "" : "none";
  _updateSelectAllBtn();
  if (!prev && _histFilterTag) {
    // 絞り込み開始：スクロール位置を記憶
    const grid = document.getElementById("hist-grid");
    _histScrollPos = grid?.scrollTop ?? 0;
  }
  renderHistoryGrid();
}

function _applyAuthorFilter(author) {
  _histAuthorFilter = author;
  _histPage = 0;
  const input = document.getElementById("hist-author-filter");
  const clear = document.getElementById("hist-author-filter-clear");
  if (input) input.value = author;
  if (clear) clear.style.display = author ? "" : "none";
  renderHistoryGrid();
}

function _buildHistCardInner(card, entry, onThumbClick) {
  const paths   = Array.isArray(entry.savePaths) ? entry.savePaths : (entry.savePath ? [entry.savePath] : []);
  const primary = paths[0] ?? "";
  const date    = new Date(entry.savedAt).toLocaleString("ja-JP");
  const tagHtml = (entry.tags || [])
    .map(t => `<span class="hist-card-tag" data-tag="${escHtml(t)}">${escHtml(t)}<button class="hist-tag-del-btn delete-guarded" data-tag="${escHtml(t)}" title="${escHtml(t)}を削除" tabindex="-1">×</button></span>`).join("");
  const entryAuthors = getEntryAuthors(entry);
  const authorHtml = entryAuthors.map(a =>
    `<span class="hist-card-author" data-author="${escHtml(a)}">✏️ ${escHtml(a)}</span>`
  ).join("");

  let thumbHtml = `<div class="hist-card-thumb-placeholder">🖼</div>`;
  if (entry.thumbId) {
    browser.runtime.sendMessage({ type: "GET_THUMB_DATA_URL", thumbId: entry.thumbId })
      .then(r => {
        if (r?.dataUrl) {
          const placeholder = card.querySelector(".hist-card-thumb-placeholder");
          if (placeholder) {
            const img = document.createElement("img");
            img.className = "hist-card-thumb";
            img.src = r.dataUrl;
            img.title = "クリックで拡大";
            img.style.cursor = "zoom-in";
            img.addEventListener("click", (e) => {
              e.stopPropagation();
              if (onThumbClick) {
                onThumbClick(r.dataUrl, img);
              } else {
                // 全体ナビ付きでシングル表示（絞り込み中は絞り込み結果内でナビ）
                const _navData = _currentFilteredHistory ?? _historyData;
                const gIdx = _navData.findIndex(h => h.id === entry.id);
                showGroupLightbox([r.dataUrl], 0, [entry], { startEntryIndex: gIdx });
              }
            });
            placeholder.replaceWith(img);
          }
        }
      }).catch(() => {});
  }

  const pageUrlHtml = entry.pageUrl
    ? `<div class="hist-card-pageurl" title="${escHtml(entry.pageUrl)}">${escHtml(entry.pageUrl)}</div>`
    : "";

  card.innerHTML = `
    <input type="checkbox" class="hist-select-box" ${_histSelected.has(entry.id) ? "checked" : ""} />
    ${thumbHtml}
    <div class="hist-card-overlay">
      <div class="hist-card-body">
        <div class="hist-card-filename" title="${escHtml(entry.filename)}">${entry.source === "external_import" ? '<span class="hist-source-badge" title="外部取り込み">📥</span>' : ""}${escHtml(entry.filename)}</div>
        <div class="hist-card-path" title="${escHtml(primary)}">${escHtml(primary || "（パスなし）")}</div>
        ${authorHtml ? `<div class="hist-card-author-row">${authorHtml}</div>` : ""}
        <div class="hist-card-tags">${tagHtml}</div>
        <div class="hist-card-date">${escHtml(date)}</div>
        ${pageUrlHtml}
      </div>
      <div class="hist-card-actions">
        <button class="hist-card-btn open-folder" title="${escHtml(primary)}">🗂 保存先</button>
        <button class="hist-card-btn open-file" title="${escHtml(primary ? primary + '\\\\' + entry.filename : '')}">🖼 保存した画像</button>
        <div class="hist-card-actions-row">
          <button class="hist-card-btn del delete-guarded" title="削除">🗑 削除</button>
          <button class="hist-card-btn info-edit" title="情報を編集">✏️ 情報を編集</button>
        </div>
      </div>
      <div class="hist-info-editor">
        <div class="hist-info-editor-inner">
          <div class="hist-info-editor-title">✏️ 情報を編集</div>
          <div class="hist-info-editor-preview">
            <img class="hist-info-thumb" src="" alt="" style="display:none;" />
          </div>
          <div class="hist-info-field-group">
            <div class="hist-info-field-label">🏷️ タグ</div>
            <div class="hist-tag-editor-chips"></div>
            <div class="hist-tag-editor-input-row">
              <input type="text" class="hist-tag-editor-input" placeholder="タグを入力..." autocomplete="off" />
              <div class="hist-tag-editor-suggestions"></div>
            </div>
          </div>
          <div class="hist-info-field-group">
            <div class="hist-info-field-label">✏️ 権利者</div>
            <div class="hist-author-chips"></div>
            <div class="hist-author-input-row">
              <input type="text" class="hist-author-input" placeholder="追加(Enter)..." autocomplete="off" />
              <div class="hist-author-suggestions"></div>
            </div>
          </div>
          <div class="hist-info-field-group">
            <div class="hist-info-field-label">📁 保存先情報</div>
            <input type="text" class="hist-path-input" placeholder="保存先パス" />
          </div>
          <div class="hist-info-editor-actions">
            <button class="hist-info-editor-save">💾 保存</button>
            <button class="hist-info-editor-cancel">✕ 閉じる</button>
            <button class="hist-info-editor-undo" disabled>↩ アンドゥ</button>
          </div>
        </div>
      </div>
    </div>`;

  card.querySelector(".hist-select-box").addEventListener("change", (e) => {
    if (e.target.checked) _histSelected.add(entry.id);
    else                  _histSelected.delete(entry.id);
    card.classList.toggle("selected", e.target.checked);
    document.getElementById("hist-delete-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-deselect-all").disabled = _histSelected.size === 0;
    document.getElementById("hist-add-tag-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-sync-global-tags").disabled = _histSelected.size === 0;
    document.getElementById("hist-group-selected").disabled = _histSelected.size < 2;
    document.getElementById("hist-ungroup-selected").disabled = _histSelected.size === 0;
  });

  card.querySelectorAll(".hist-card-tag").forEach(el => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      _applyTagFilter(el.dataset.tag.toLowerCase());
    });
  });

  // 作者チップクリックで絞り込み
  const authorChip = card.querySelector(".hist-card-author");
  if (authorChip) {
    authorChip.addEventListener("click", (e) => {
      e.stopPropagation();
      _applyAuthorFilter(authorChip.dataset.author.toLowerCase());
    });
  }

  // ── 情報を編集 パネル ──────────────────────────────────────────
  const infoEditBtn     = card.querySelector(".hist-card-btn.info-edit");
  const infoEditor      = card.querySelector(".hist-info-editor");
  const infoThumb       = card.querySelector(".hist-info-thumb");
  const editorChips     = card.querySelector(".hist-tag-editor-chips");
  const editorInput     = card.querySelector(".hist-tag-editor-input");
  const editorSuggestions = card.querySelector(".hist-tag-editor-suggestions");
  const authorChipsEl   = card.querySelector(".hist-author-chips");
  const authorInput     = card.querySelector(".hist-author-input");
  const authorSugEl     = card.querySelector(".hist-author-suggestions");
  const pathInput       = card.querySelector(".hist-path-input");
  const undoBtn         = card.querySelector(".hist-info-editor-undo");
  const infoSaveBtn     = card.querySelector(".hist-info-editor-save");
  const infoCancelBtn   = card.querySelector(".hist-info-editor-cancel");

  let pendingTags    = new Set(entry.tags    || []);
  let pendingAuthors = [...getEntryAuthors(entry)];
  let _undoStack     = [];  // { type, tag/author/oldPath/newPath }
  let _prevPath      = "";

  // ---- タグチップ描画（メインタグ + サブタグを同一エリアに混在表示）----
  function renderEditorChips() {
    editorChips.innerHTML = "";
    // メインタグ（新規入力で追加されるのもこちら）
    pendingTags.forEach(t => {
      const chip = document.createElement("span");
      chip.className = "hist-tag-editor-chip";
      chip.dataset.type = "main";
      chip.textContent = t;
      const del = document.createElement("button");
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        _undoStack.push({ type: "deleteTag", tag: t });
        pendingTags.delete(t);
        renderEditorChips();
        saveEntryNow();
        updateUndoBtn();
      });
      chip.appendChild(del);
      editorChips.appendChild(chip);
    });
  }

  function showTagSuggestions(query) {
    editorSuggestions.innerHTML = "";
    if (!query) { editorSuggestions.style.display = "none"; return; }
    const q = query.toLowerCase();
    const matches = globalTags.filter(t => t.toLowerCase().includes(q) && !pendingTags.has(t)).slice(0, 8);
    if (!matches.length) { editorSuggestions.style.display = "none"; return; }
    matches.forEach(t => {
      const item = document.createElement("div");
      item.className = "suggestion-item";
      item.textContent = t;
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        _undoStack.push({ type: "addTag", tag: t });
        pendingTags.add(t);
        editorInput.value = "";
        editorSuggestions.style.display = "none";
        renderEditorChips();
        saveEntryNow();
        updateUndoBtn();
      });
      editorSuggestions.appendChild(item);
    });
    editorSuggestions.style.display = "";
  }

  // ---- 作者チップ描画 ----
  function renderAuthorEditorChips() {
    authorChipsEl.innerHTML = "";
    pendingAuthors.forEach(a => {
      const chip = document.createElement("span");
      chip.className = "hist-author-chip";
      chip.textContent = a;
      const del = document.createElement("button");
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        _undoStack.push({ type: "deleteAuthor", author: a });
        pendingAuthors = pendingAuthors.filter(x => x !== a);
        renderAuthorEditorChips();
        saveEntryNow();
        updateUndoBtn();
      });
      chip.appendChild(del);
      authorChipsEl.appendChild(chip);
    });
  }

  function showAuthorEditorSuggestions(q) {
    authorSugEl.innerHTML = "";
    const matches = (q
      ? globalAuthors.filter(a => a.toLowerCase().includes(q.toLowerCase()))
      : globalAuthors
    ).filter(a => !pendingAuthors.includes(a)).slice(0, 8);
    if (!matches.length) { authorSugEl.style.display = "none"; return; }
    matches.forEach(a => {
      const item = document.createElement("div");
      item.className = "suggestion-item";
      item.textContent = a;
      item.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        if (!pendingAuthors.includes(a)) {
          _undoStack.push({ type: "addAuthor", author: a });
          pendingAuthors.push(a);
          renderAuthorEditorChips();
          saveEntryNow();
          updateUndoBtn();
        }
        authorInput.value = "";
        authorSugEl.style.display = "none";
      });
      authorSugEl.appendChild(item);
    });
    authorSugEl.style.display = "";
  }

  // ---- リアルタイム保存 ----
  async function saveEntryNow() {
    const stored = await browser.storage.local.get(["saveHistory", "globalTags", "globalAuthors"]);
    const history = stored.saveHistory || [];
    const target  = history.find(h => h.id === entry.id);
    if (!target) return;
    target.tags    = [...pendingTags];
    target.authors = [...pendingAuthors];
    delete target.author;
    const newPath = pathInput.value.trim();
    if (newPath) target.savePaths = [newPath];
    const gTagSet    = new Set([...(stored.globalTags    || []), ...pendingTags]);
    const gAuthorSet = new Set([...(stored.globalAuthors || []), ...pendingAuthors]);
    await browser.storage.local.set({
      saveHistory:   history,
      globalTags:    [...gTagSet],
      globalAuthors: [...gAuthorSet],
    });
    _historyData  = history;
    globalTags    = [...gTagSet];
    globalAuthors = [...gAuthorSet];
    showStatus("自動保存しました ✔");
  }

  function updateUndoBtn() {
    if (undoBtn) undoBtn.disabled = _undoStack.length === 0;
  }

  // ---- パネル開閉 ----
  infoEditBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = infoEditor.classList.contains("open");
    if (isOpen) { infoEditor.classList.remove("open"); renderHistoryGrid(); return; }
    // 現在値でリセット
    pendingTags    = new Set(entry.tags    || []);
    pendingAuthors = [...getEntryAuthors(entry)];
    pathInput.value = primary || "";
    _prevPath      = pathInput.value;
    _undoStack     = [];
    renderEditorChips();
    renderAuthorEditorChips();
    updateUndoBtn();
    editorInput.value = "";
    editorSuggestions.style.display = "none";
    authorInput.value = "";
    authorSugEl.style.display = "none";
    // サムネイル取得→インライン表示
    const imgEl = card.querySelector(".hist-card-thumb, img.hist-card-thumb");
    if (imgEl?.src) {
      infoThumb.src = imgEl.src;
      infoThumb.style.display = "";
    } else if (entry.thumbId) {
      browser.runtime.sendMessage({ type: "GET_THUMB_DATA_URL", thumbId: entry.thumbId })
        .then(r => { if (r?.dataUrl) { infoThumb.src = r.dataUrl; infoThumb.style.display = ""; } })
        .catch(() => {});
    }
    infoEditor.classList.add("open");
    editorInput.focus();
  });

  // 明示的な保存ボタン（リアルタイム保存と併用）
  infoSaveBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    await saveEntryNow();
    showStatus("保存しました ✔");
    // ボタンに視覚フィードバック
    infoSaveBtn.textContent = "✔ 保存済み";
    infoSaveBtn.disabled = true;
    setTimeout(() => { infoSaveBtn.textContent = "💾 保存"; infoSaveBtn.disabled = false; }, 1200);
  });

  infoCancelBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    infoEditor.classList.remove("open");
    renderHistoryGrid();
  });

  // オーバーレイ背景クリックで閉じる
  infoEditor.addEventListener("click", (e) => {
    if (e.target === infoEditor) {
      infoEditor.classList.remove("open");
      renderHistoryGrid();
    }
  });

  // ---- タグ入力配線 ----
  editorInput.addEventListener("input", () => showTagSuggestions(editorInput.value.trim()));
  editorInput.addEventListener("blur", () => { setTimeout(() => { editorSuggestions.style.display = "none"; }, 150); });
  editorInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = editorInput.value.trim();
      if (val) {
        _undoStack.push({ type: "addTag", tag: val });
        pendingTags.add(val);
        editorInput.value = "";
        editorSuggestions.style.display = "none";
        renderEditorChips();
        saveEntryNow();
        updateUndoBtn();
      }
    } else if (e.key === "Escape") {
      infoEditor.classList.remove("open");
    }
  });

  // ---- 作者入力配線 ----
  authorInput.addEventListener("input", () => showAuthorEditorSuggestions(authorInput.value.trim()));
  authorInput.addEventListener("blur", () => { setTimeout(() => { authorSugEl.style.display = "none"; }, 150); });
  authorInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = authorInput.value.trim();
      if (val && !pendingAuthors.includes(val)) {
        _undoStack.push({ type: "addAuthor", author: val });
        pendingAuthors.push(val);
        renderAuthorEditorChips();
        saveEntryNow();
        updateUndoBtn();
      }
      authorInput.value = "";
      authorSugEl.style.display = "none";
    }
  });

  // ---- パス入力 blur で自動保存 ----
  pathInput.addEventListener("blur", async () => {
    const newPath = pathInput.value.trim();
    if (newPath !== _prevPath) {
      _undoStack.push({ type: "changePath", oldPath: _prevPath, newPath });
      _prevPath = newPath;
      await saveEntryNow();
      updateUndoBtn();
    }
  });

  // ---- アンドゥ ----
  if (undoBtn) {
    undoBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!_undoStack.length) return;
      const op = _undoStack.pop();
      if      (op.type === "addTag")         pendingTags.delete(op.tag);
      else if (op.type === "deleteTag")      pendingTags.add(op.tag);
      else if (op.type === "addAuthor")      pendingAuthors = pendingAuthors.filter(a => a !== op.author);
      else if (op.type === "deleteAuthor")   pendingAuthors.push(op.author);
      else if (op.type === "changePath")     { pathInput.value = op.oldPath; _prevPath = op.oldPath; }
      renderEditorChips();
      renderAuthorEditorChips();
      await saveEntryNow();
      updateUndoBtn();
    });
  }

  // タグ削除ボタン（削除モード時のみ表示）
  card.querySelectorAll(".hist-tag-del-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const tag = btn.dataset.tag;
      if (!confirm(`「${tag}」をこの履歴から削除しますか？`)) return;
      const stored = await browser.storage.local.get("saveHistory");
      const history = stored.saveHistory || [];
      const target = history.find(h => h.id === entry.id);
      if (target) {
        target.tags = (target.tags || []).filter(t => t !== tag);
        await browser.storage.local.set({ saveHistory: history });
        _historyData = history;
        renderHistoryGrid();
      }
    });
  });

  card.querySelector(".hist-card-btn.open-folder").addEventListener("click", (e) => {
    e.stopPropagation();
    if (primary) browser.runtime.sendMessage({ type: "OPEN_EXPLORER", path: primary });
  });

  card.querySelector(".hist-card-btn.open-file").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!primary || !entry.filename) { showStatus("⚠️ 保存先情報が取得できません", true); return; }
    const filePath = primary.replace(/[\\/]+$/, "") + "\\" + entry.filename;
    const res = await browser.runtime.sendMessage({ type: "FETCH_FILE_AS_DATAURL", path: filePath });
    if (res?.ok && res.dataUrl) {
      const win = window.open();
      if (win) {
        win.document.body.style.cssText = "margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;";
        const img = win.document.createElement("img");
        img.src = res.dataUrl;
        img.style.cssText = "max-width:100%;max-height:100vh;object-fit:contain;";
        win.document.body.appendChild(img);
      }
    } else {
      showStatus(`⚠️ ファイルを開けませんでした: ${res?.error || filePath}`, true);
    }
  });

  card.querySelector(".hist-card-btn.del").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`「${entry.filename}」を履歴から削除しますか？`)) return;
    if (entry.thumbId) {
      await browser.runtime.sendMessage({ type: "DELETE_THUMB", thumbId: entry.thumbId });
    }
    _historyData = _historyData.filter(h => h.id !== entry.id);
    await browser.storage.local.set({ saveHistory: _historyData });
    _histSelected.delete(entry.id);
    renderHistoryGrid();
    showStatus("削除しました");
  });
}

/** ⑤ ライトボックス表示 */
function showLightbox(dataUrl, filename) {
  const existing = document.querySelector(".lightbox-overlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  overlay.innerHTML = `
    <button class="lb-close" title="閉じる">✕</button>
    <img src="${dataUrl}" alt="${escHtml(filename)}" />
    <div class="lb-info">${escHtml(filename)}</div>
  `;

  // オーバーレイ背景クリックで閉じる
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.querySelector(".lb-close").addEventListener("click", () => overlay.remove());

  // Escape キーで閉じる
  const onKey = (e) => { if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); } };
  document.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);
}

/** グループ内ナビゲーション付きライトボックス */
function showGroupLightbox(dataUrls, startIndex, items, globalCtx) {
  // globalCtx: { startEntryIndex } — _historyDataの何番目かを指定（省略可）
  const existing = document.querySelector(".lightbox-overlay");
  if (existing) existing.remove();

  let currentIdx = startIndex;
  const total = dataUrls.length;

  // 読み進める方向設定を取得（デフォルト: rtl = 右→左 = ◀で次ページ）
  browser.storage.local.get("groupReadDirection").then(({ groupReadDirection }) => {
    const rtl = (groupReadDirection || "rtl") === "rtl";

    const overlay = document.createElement("div");
    overlay.className = "lightbox-overlay";
    overlay.innerHTML = `
      <button class="lb-close" title="閉じる">✕</button>
      <button class="lb-nav lb-left" title="${rtl ? "次の画像(グループ内)" : "前の画像(グループ内)"}" style="
        position:fixed;
        background:rgba(255,255,255,.2);border:none;color:#fff;font-size:36px;
        width:52px;height:52px;border-radius:50%;cursor:pointer;display:flex;
        align-items:center;justify-content:center;transition:background .15s;
        left:20px;top:50%;">&#8249;</button>
      <button class="lb-nav lb-right" title="${rtl ? "前の画像(グループ内)" : "次の画像(グループ内)"}" style="
        position:fixed;
        background:rgba(255,255,255,.2);border:none;color:#fff;font-size:36px;
        width:52px;height:52px;border-radius:50%;cursor:pointer;display:flex;
        align-items:center;justify-content:center;transition:background .15s;
        right:20px;top:50%;">&#8250;</button>
      <button class="lb-nav lb-up" title="前の履歴（全体）" style="
        position:fixed;left:50%;
        background:rgba(255,255,255,.2);border:none;color:#fff;font-size:28px;
        width:52px;height:52px;border-radius:50%;cursor:pointer;display:flex;
        align-items:center;justify-content:center;transition:background .15s;
        top:20px;">&#8963;</button>
      <button class="lb-nav lb-down" title="次の履歴（全体）" style="
        position:fixed;left:50%;
        background:rgba(255,255,255,.2);border:none;color:#fff;font-size:28px;
        width:52px;height:52px;border-radius:50%;cursor:pointer;display:flex;
        align-items:center;justify-content:center;transition:background .15s;
        bottom:60px;">&#8964;</button>
      <img class="lb-img" src="" alt="" />
      <div class="lb-info" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;justify-content:center;">
        <span class="lb-label-group" style="font-size:10px;color:rgba(255,255,255,.6);white-space:nowrap;">グループ内</span>
        <span class="lb-counter"></span>
        <span class="lb-label-all" style="font-size:10px;color:rgba(255,255,255,.6);white-space:nowrap;"></span>
        <span class="lb-filename"></span>
      </div>
    `;

    const img = overlay.querySelector(".lb-img");
    const counter = overlay.querySelector(".lb-counter");
    const filenameEl = overlay.querySelector(".lb-filename");
    const labelAll   = overlay.querySelector(".lb-label-all");
    const leftBtn  = overlay.querySelector(".lb-left");
    const rightBtn = overlay.querySelector(".lb-right");

    // グループが1枚のみの場合は左右ナビを非表示
    if (total <= 1) {
      leftBtn.style.display  = "none";
      rightBtn.style.display = "none";
    }
    const upBtn    = overlay.querySelector(".lb-up");
    const downBtn  = overlay.querySelector(".lb-down");

    // 全体ナビ用：現在表示中のインデックス（絞り込み中は絞り込み結果内）
    const _globalData = _currentFilteredHistory ?? _historyData;
    let globalIdx = globalCtx?.startEntryIndex ?? -1;
    const totalGlobal = _globalData.length;

    function updateGlobalLabel() {
      if (globalIdx < 0) { labelAll.textContent = ""; return; }
      const label = _currentFilteredHistory ? "絞り込み結果" : "全体";
      labelAll.textContent = `${label} ${totalGlobal - globalIdx} / ${totalGlobal}`;
      upBtn.style.opacity   = globalIdx > 0 ? "1" : "0.3";
      downBtn.style.opacity = globalIdx < totalGlobal - 1 ? "1" : "0.3";
    }

    function goGlobalPrev() {
      // 全体の新しい方（インデックス小＝新しい）
      if (globalIdx <= 0) return;
      globalIdx--;
      openGlobalEntry(globalIdx);
    }
    function goGlobalNext() {
      // 全体の古い方（インデックス大＝古い）
      if (globalIdx >= totalGlobal - 1) return;
      globalIdx++;
      openGlobalEntry(globalIdx);
    }

    function openGlobalEntry(gIdx) {
      const entry = _globalData[gIdx];
      if (!entry) return;
      if (entry.thumbId) {
        browser.runtime.sendMessage({ type: "GET_THUMB_DATA_URL", thumbId: entry.thumbId })
          .then(r => {
            const url = r?.dataUrl || "";
            img.src = url;
            img.alt = entry.filename || "";
            counter.textContent = "1 / 1";
            filenameEl.textContent = entry.filename || "";
            updateGlobalLabel();
            setFixedNavPositions();
          }).catch(() => {});
      } else {
        img.src = ""; img.alt = entry.filename || "";
        counter.textContent = "1 / 1";
        filenameEl.textContent = entry.filename || "";
        updateGlobalLabel();
      }
    }

    upBtn.addEventListener("click", (e) => { e.stopPropagation(); goGlobalPrev(); });
    downBtn.addEventListener("click", (e) => { e.stopPropagation(); goGlobalNext(); });

    // 上下ボタンの位置：画面上下端と画像の中間
    // rtl: ◀(left)=次(idx+1)、▶(right)=前(idx-1)
    // ltr: ◀(left)=前(idx-1)、▶(right)=次(idx+1)
    function goPrev() { if (currentIdx < total - 1) updateView(currentIdx + 1); }
    function goNext() { if (currentIdx > 0) updateView(currentIdx - 1); }

    /** ナビゲーションボタンを固定位置に設定（画面中央基準・画像に依存しない） */
    function setFixedNavPositions() {
      const cx  = window.innerWidth  / 2;
      const cy  = window.innerHeight / 2;
      const btn = 52;

      // ◀：画面の左1/4、縦中央
      leftBtn.style.cssText  += `;left:${Math.round(cx / 2 - btn / 2)}px;top:${Math.round(cy - btn / 2)}px;right:auto;`;
      // ▶：画面の右1/4、縦中央
      rightBtn.style.cssText += `;left:${Math.round(cx + cx / 2 - btn / 2)}px;top:${Math.round(cy - btn / 2)}px;right:auto;`;
      // ▲：画面の上1/4、横中央
      upBtn.style.cssText    += `;top:${Math.round(cy / 2 - btn / 2)}px;left:${Math.round(cx - btn / 2)}px;bottom:auto;`;
      // ▼：画面の下1/4、横中央
      downBtn.style.cssText  += `;top:${Math.round(cy + cy / 2 - btn / 2)}px;left:${Math.round(cx - btn / 2)}px;bottom:auto;`;
    }

    function updateView(idx) {
      currentIdx = idx;
      const entry = items[idx];
      const url = dataUrls[idx];
      if (url) {
        img.src = url;
      } else if (entry?.thumbId) {
        img.src = "";
        browser.runtime.sendMessage({ type: "GET_THUMB_DATA_URL", thumbId: entry.thumbId })
          .then(r => { if (r?.dataUrl) { img.src = r.dataUrl; dataUrls[idx] = r.dataUrl; } })
          .catch(() => {});
      }
      img.alt = entry?.filename || "";
      // 表示番号はユーザー向け：rtlなら「新しい順 (total-idx)」、ltrなら「古い順 (idx+1)」
      const displayNum = rtl ? (total - idx) : (idx + 1);
      counter.textContent = `${displayNum} / ${total}`;
      filenameEl.textContent = entry?.filename || "";
      leftBtn.style.opacity  = rtl ? (idx < total - 1 ? "1" : "0.3") : (idx > 0 ? "1" : "0.3");
      rightBtn.style.opacity = rtl ? (idx > 0 ? "1" : "0.3")         : (idx < total - 1 ? "1" : "0.3");
      updateGlobalLabel();
      setFixedNavPositions();
    }

    if (rtl) {
      leftBtn.addEventListener("click", goPrev);
      rightBtn.addEventListener("click", goNext);
    } else {
      leftBtn.addEventListener("click", goNext);
      rightBtn.addEventListener("click", goPrev);
    }

    const onResize = () => setFixedNavPositions();
    window.addEventListener("resize", onResize);

    overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); window.removeEventListener("resize", onResize); } });
    overlay.querySelector(".lb-close").addEventListener("click", () => { overlay.remove(); window.removeEventListener("resize", onResize); });

    const onKey = (e) => {
      if (["Escape","ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(e.key)) e.preventDefault();
      if (e.key === "Escape") { overlay.remove(); document.removeEventListener("keydown", onKey); window.removeEventListener("resize", onResize); }
      else if (e.key === "ArrowLeft")  { rtl ? goPrev() : goNext(); }
      else if (e.key === "ArrowRight") { rtl ? goNext() : goPrev(); }
      else if (e.key === "ArrowUp")    { goGlobalPrev(); }
      else if (e.key === "ArrowDown")  { goGlobalNext(); }
    };
    document.addEventListener("keydown", onKey);

    document.body.appendChild(overlay);
    setFixedNavPositions();
    updateView(currentIdx);
  });
}

// ----------------------------------------------------------------
// 作者タブ
// ----------------------------------------------------------------
function setupAuthorsTab() {
  const sortSel = document.getElementById("author-sort-select");
  if (sortSel) {
    sortSel.addEventListener("change", () => _renderAuthorList());
  }
}

async function renderAuthorsTab() {
  const list = document.getElementById("author-list");
  if (!list) return;

  // 最新データを取得
  const [authorsRes, destsRes] = await Promise.all([
    browser.runtime.sendMessage({ type: "GET_GLOBAL_AUTHORS" }),
    browser.runtime.sendMessage({ type: "GET_AUTHOR_DESTINATIONS" }),
  ]);
  globalAuthors      = authorsRes.authors          || [];
  authorDestinations = destsRes.authorDestinations || {};

  _renderAuthorList();
}

function _renderAuthorList() {
  const list       = document.getElementById("author-list");
  const countLabel = document.getElementById("author-count-label");
  const sortSel    = document.getElementById("author-sort-select");
  if (!list) return;

  list.innerHTML = "";

  if (countLabel) countLabel.textContent = `${globalAuthors.length} 件`;

  if (globalAuthors.length === 0) {
    list.innerHTML = `<div style="color:#888;font-size:13px;padding:8px">権利者がまだ登録されていません。保存ダイアログで権利者名を入力すると自動的に登録されます。</div>`;
    return;
  }

  const sortVal = sortSel?.value || "registered";
  const sorted  = [...globalAuthors].sort((a, b) => {
    switch (sortVal) {
      case "registered":      return globalAuthors.indexOf(a) - globalAuthors.indexOf(b);
      case "registered-desc": return globalAuthors.indexOf(b) - globalAuthors.indexOf(a);
      case "name":            return a.localeCompare(b, "ja");
      case "name-desc":       return b.localeCompare(a, "ja");
      case "count-desc":      return (authorDestinations[b]?.length || 0) - (authorDestinations[a]?.length || 0);
      case "count-asc":       return (authorDestinations[a]?.length || 0) - (authorDestinations[b]?.length || 0);
      default:                return 0;
    }
  });

  sorted.forEach(author => {
    const row = _buildAuthorRow(author);
    list.appendChild(row);
  });
}

function _buildAuthorRow(author) {
  const dests = authorDestinations[author] || [];
  const hasLink = dests.length > 0;

  const row = document.createElement("div");
  row.className = "author-row";
  row.dataset.author = author;

  const header = document.createElement("div");
  header.className = "author-header";

  const nameEl = document.createElement("span");
  nameEl.className = "author-name";
  nameEl.textContent = author;

  // インラインリネームUI
  const renameInput = document.createElement("input");
  renameInput.type = "text";
  renameInput.value = author;
  renameInput.style.cssText = "display:none;font-size:13px;border:1px solid #a0b0e0;border-radius:4px;" +
    "padding:1px 6px;font-family:inherit;width:160px;";
  const renameConfirm = document.createElement("button");
  renameConfirm.textContent = "✔";
  renameConfirm.title = "変更を確定";
  renameConfirm.style.cssText = "display:none;font-size:12px;padding:2px 6px;border:1px solid #a0d0a0;" +
    "border-radius:4px;background:#e8f8e8;cursor:pointer;";
  const renameCancel = document.createElement("button");
  renameCancel.textContent = "✕";
  renameCancel.title = "キャンセル";
  renameCancel.style.cssText = "display:none;font-size:12px;padding:2px 6px;border:1px solid #d0d0d0;" +
    "border-radius:4px;background:#f5f5f5;cursor:pointer;";
  const editBtn = document.createElement("button");
  editBtn.textContent = "✏";
  editBtn.title = "名前を変更";
  editBtn.style.cssText = "font-size:12px;padding:2px 6px;border:1px solid #d0d8f0;border-radius:4px;" +
    "background:#f0f4ff;cursor:pointer;";

  function startRename() {
    nameEl.style.display = "none";
    editBtn.style.display = "none";
    renameInput.style.display = "";
    renameConfirm.style.display = "";
    renameCancel.style.display = "";
    renameInput.value = author;
    renameInput.focus();
    renameInput.select();
  }
  function cancelRename() {
    nameEl.style.display = "";
    editBtn.style.display = "";
    renameInput.style.display = "none";
    renameConfirm.style.display = "none";
    renameCancel.style.display = "none";
  }
  editBtn.addEventListener("click", (e) => { e.stopPropagation(); startRename(); });
  renameCancel.addEventListener("click", (e) => { e.stopPropagation(); cancelRename(); });
  renameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") renameConfirm.click();
    else if (e.key === "Escape") cancelRename();
  });
  renameConfirm.addEventListener("click", async (e) => {
    e.stopPropagation();
    const newName = renameInput.value.trim();
    if (!newName || newName === author) { cancelRename(); return; }
    if (globalAuthors.includes(newName)) { alert(`「${newName}」は既に存在します`); return; }
    // globalAuthors の更新
    const idx = globalAuthors.indexOf(author);
    if (idx !== -1) globalAuthors[idx] = newName;
    // authorDestinations のキー変更
    if (authorDestinations[author]) {
      authorDestinations[newName] = authorDestinations[author];
      delete authorDestinations[author];
    }
    await Promise.all([
      browser.storage.local.set({ globalAuthors }),
      browser.runtime.sendMessage({ type: "SET_AUTHOR_DESTINATIONS", data: authorDestinations }),
    ]);
    nameEl.textContent = newName;
    // author 変数を更新（クロージャの参照を更新するため row.dataset を使用）
    row.dataset.author = newName;
    cancelRename();
    showStatus("権利者名を変更しました");
  });

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "author-dest-toggle";
  toggleBtn.textContent = hasLink ? `📁 保存先 ${dests.length} 件` : "📁 保存先を追加";
  toggleBtn.title = "保存先の関連付けを管理";

  const delBtn = document.createElement("button");
  delBtn.className = "hist-card-btn del delete-guarded";
  delBtn.style.cssText = "font-size:11px;padding:2px 7px;margin-left:auto;width:auto;flex-shrink:0;";
  delBtn.textContent = "削除";

  header.appendChild(nameEl);
  header.appendChild(renameInput);
  header.appendChild(renameConfirm);
  header.appendChild(renameCancel);
  header.appendChild(editBtn);
  header.appendChild(toggleBtn);
  header.appendChild(delBtn);

  const destList = document.createElement("div");
  destList.className = "author-dest-list";
  destList.style.display = "none";

  function renderDestList() {
    const curAuthor = row.dataset.author || author; // リネーム後も最新名を参照
    destList.innerHTML = "";
    const currentDests = authorDestinations[curAuthor] || [];

    if (currentDests.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText = "color:#aaa;font-size:11px;padding:4px 0";
      empty.textContent = "保存先が未登録です";
      destList.appendChild(empty);
    } else {
      currentDests.forEach((dest, idx) => {
        const item = document.createElement("div");
        item.className = "author-dest-item";
        item.innerHTML = `
          <span class="author-dest-label" title="${escHtml(dest.path)}">${escHtml(dest.label || dest.path)}</span>
          <span class="author-dest-path">${escHtml(dest.path)}</span>
          <button class="author-dest-del delete-guarded" data-idx="${idx}" title="削除">×</button>`;
        destList.appendChild(item);
      });
    }

    // 追加行
    const addRow = document.createElement("div");
    addRow.className = "author-add-dest-row";
    addRow.innerHTML = `
      <select class="author-dest-select">
        <option value="">-- 保存先を選択 --</option>
        ${Object.entries(tagDestinations).flatMap(([, arr]) => arr).map(d =>
          `<option value="${escHtml(d.id)}" data-path="${escHtml(d.path)}" data-label="${escHtml(d.label || d.path)}">${escHtml(d.label || d.path)}</option>`
        ).join("")}
      </select>
      <button class="author-dest-add-btn">追加</button>`;
    destList.appendChild(addRow);

    // イベント
    destList.querySelectorAll(".author-dest-del").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const n = row.dataset.author || author;
        const i = parseInt(btn.dataset.idx);
        authorDestinations[n] = (authorDestinations[n] || []).filter((_, j) => j !== i);
        await browser.runtime.sendMessage({ type: "SET_AUTHOR_DESTINATIONS", data: authorDestinations });
        renderDestList();
        toggleBtn.textContent = `📁 保存先 ${(authorDestinations[n] || []).length} 件`;
      });
    });

    const addBtn = addRow.querySelector(".author-dest-add-btn");
    const sel    = addRow.querySelector(".author-dest-select");
    addBtn.addEventListener("click", async () => {
      const n = row.dataset.author || author;
      const opt = sel.options[sel.selectedIndex];
      if (!opt?.value) return;
      const newDest = { id: opt.value, path: opt.dataset.path, label: opt.dataset.label };
      if (!authorDestinations[n]) authorDestinations[n] = [];
      if (!authorDestinations[n].some(d => d.id === newDest.id)) {
        authorDestinations[author].push(newDest);
        await browser.runtime.sendMessage({ type: "SET_AUTHOR_DESTINATIONS", data: authorDestinations });
        renderDestList();
        const n2 = row.dataset.author || author;
        toggleBtn.textContent = `📁 保存先 ${(authorDestinations[n2] || []).length} 件`;
      }
    });
  }

  toggleBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = destList.style.display !== "none";
    destList.style.display = isOpen ? "none" : "";
    if (!isOpen) renderDestList();
  });

  delBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const currentName = row.dataset.author || author;
    if (!confirm(`「${currentName}」を権利者一覧から削除しますか？`)) return;
    globalAuthors = globalAuthors.filter(a => a !== currentName);
    delete authorDestinations[currentName];
    await Promise.all([
      browser.runtime.sendMessage({ type: "SET_AUTHOR_DESTINATIONS", data: authorDestinations }),
      browser.storage.local.set({ globalAuthors }),
    ]);
    row.remove();
    showStatus("権利者を削除しました");
  });

  row.appendChild(header);
  row.appendChild(destList);
  return row;
}

// ================================================================
// 外部取り込みタブ
// ================================================================

const EXT_IMPORT_DEFAULT_EXCLUDES = [
  "C:", "D:", "E:", "F:", "G:", "H:",
  "Users", "Desktop", "Downloads", "Pictures", "Documents", "OneDrive",
  "ダウンロード", "ピクチャ", "デスクトップ", "ドキュメント", "画像",
];

/** チップ要素を生成する */
function _extMakeChip(label, onRemove) {
  const chip = document.createElement("span");
  chip.style.cssText =
    "display:inline-flex;align-items:center;gap:3px;background:#e8f0fe;" +
    "border:1px solid #b0c8f0;border-radius:10px;padding:1px 7px;" +
    "font-size:11px;color:#1a4db0;";
  chip.textContent = label;
  const del = document.createElement("button");
  del.textContent = "✕";
  del.title = "削除";
  del.style.cssText =
    "background:none;border:none;cursor:pointer;color:#aaa;font-size:10px;" +
    "padding:0 0 0 3px;line-height:1;";
  del.addEventListener("click", () => { chip.remove(); onRemove(); });
  chip.appendChild(del);
  return chip;
}

/** 除外ワードチップを再描画 */
function _extRenderExcludeChips(excludes, container, onUpdate) {
  container.innerHTML = "";
  // インデックスのスナップショットを使ってクロージャを正しく生成
  [...excludes].forEach((w, i) => {
    const chip = _extMakeChip(w, () => {
      excludes.splice(excludes.indexOf(w), 1);
      _extRenderExcludeChips(excludes, container, onUpdate);
      onUpdate();
    });
    container.appendChild(chip);
  });
}

/** 汎用チップ配列を再描画 */
function _extRenderChips(arr, container, onUpdate) {
  container.innerHTML = "";
  [...arr].forEach(item => {
    const chip = _extMakeChip(item, () => {
      const idx = arr.indexOf(item);
      if (idx !== -1) arr.splice(idx, 1);
      _extRenderChips(arr, container, onUpdate);
      onUpdate();
    });
    container.appendChild(chip);
  });
}

/** 外部取り込みタブの初期化 */
async function setupExternalImportTab() {
  const stored = await browser.storage.local.get(["extImportExcludes", "extImportCutoffDate", "saveHistory"]);
  let savedExcludes = stored.extImportExcludes || [...EXT_IMPORT_DEFAULT_EXCLUDES];

  // BorgesTag 最古保存日ヒント（外部取り込みエントリを除外して算出）
  const hintEl = document.getElementById("ext-cutoff-hint");
  if (hintEl && stored.saveHistory?.length) {
    const normalEntries = stored.saveHistory.filter(e => e.source !== "external_import");
    if (normalEntries.length) {
      const oldest = normalEntries.reduce((a, b) =>
        new Date(a.savedAt) < new Date(b.savedAt) ? a : b
      );
      hintEl.textContent = `（BorgesTag 最古保存日: ${oldest.savedAt.slice(0, 10)}）`;
    }
  }

  // 基準日時を復元
  if (stored.extImportCutoffDate) {
    const cdEl = document.getElementById("ext-cutoff-date");
    if (cdEl) cdEl.value = stored.extImportCutoffDate;
  }

  // 保存済み除外ワードチップ
  const excludeChipsEl = document.getElementById("ext-exclude-chips");
  const saveExcludes   = async () => {
    await browser.storage.local.set({ extImportExcludes: savedExcludes });
  };
  _extRenderExcludeChips(savedExcludes, excludeChipsEl, saveExcludes);

  const excludeInput = document.getElementById("ext-exclude-input");
  const addExclude   = async () => {
    const w = excludeInput.value.trim();
    if (!w || savedExcludes.some(e => e.normalize("NFKC").toLowerCase() === w.normalize("NFKC").toLowerCase())) {
      excludeInput.value = "";
      return;
    }
    savedExcludes.push(w);
    excludeInput.value = "";
    _extRenderExcludeChips(savedExcludes, excludeChipsEl, saveExcludes);
    await saveExcludes();
  };
  document.getElementById("ext-exclude-add").addEventListener("click", addExclude);
  excludeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addExclude(); } });

  document.getElementById("ext-exclude-reset").addEventListener("click", async () => {
    savedExcludes.length = 0;
    EXT_IMPORT_DEFAULT_EXCLUDES.forEach(w => savedExcludes.push(w));
    _extRenderExcludeChips(savedExcludes, excludeChipsEl, saveExcludes);
    await saveExcludes();
  });

  // 実行時のみ除外ワード
  const tempChipsEl = document.getElementById("ext-temp-exclude-chips");
  const tempInput   = document.getElementById("ext-temp-exclude-input");
  const renderTempChips = () => {
    _extRenderExcludeChips(_extTempExcludes, tempChipsEl, renderTempChips);
  };
  const addTemp = () => {
    const w = tempInput.value.trim();
    if (!w) return;
    _extTempExcludes.push(w);
    tempInput.value = "";
    renderTempChips();
  };
  document.getElementById("ext-temp-exclude-add").addEventListener("click", addTemp);
  tempInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addTemp(); } });
  document.getElementById("ext-temp-exclude-clear").addEventListener("click", () => {
    _extTempExcludes.length = 0;
    renderTempChips();
  });

  // スキャン実行
  document.getElementById("btn-ext-scan").addEventListener("click", () => scanExternal(savedExcludes));

  // インポート実行
  document.getElementById("btn-ext-import").addEventListener("click", executeExternalImport);

  // サムネイル生成チェック → 警告表示切り替え
  document.getElementById("ext-gen-thumb").addEventListener("change", (e) => {
    const warn = document.getElementById("ext-thumb-warning");
    if (warn) warn.style.display = e.target.checked ? "" : "none";
  });

  // 権利者入力 + サジェスト
  const authorInput = document.getElementById("ext-author-input");
  const authorSugg  = document.getElementById("ext-author-suggestions");
  const authorChips = document.getElementById("ext-author-chips");

  const renderAuthorChips = () => {
    _extRenderChips(_extManualAuthors, authorChips, renderAuthorChips);
  };
  const addAuthor = (val) => {
    const v = val !== undefined ? val : authorInput.value.trim();
    if (!v || _extManualAuthors.includes(v)) { authorInput.value = ""; if (authorSugg) authorSugg.style.display = "none"; return; }
    _extManualAuthors.push(v);
    authorInput.value = "";
    if (authorSugg) authorSugg.style.display = "none";
    renderAuthorChips();
  };
  document.getElementById("ext-author-add").addEventListener("click", () => addAuthor());
  authorInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addAuthor(); } });
  authorInput.addEventListener("input", () => {
    if (!authorSugg) return;
    const q = authorInput.value.trim().toLowerCase();
    if (!q) { authorSugg.style.display = "none"; return; }
    const matches = globalAuthors.filter(a => a.toLowerCase().includes(q));
    if (!matches.length) { authorSugg.style.display = "none"; return; }
    authorSugg.innerHTML = "";
    matches.slice(0, 8).forEach(a => {
      const item = document.createElement("div");
      item.textContent = a;
      item.style.cssText = "padding:5px 10px;cursor:pointer;";
      item.addEventListener("mousedown", (e) => { e.preventDefault(); addAuthor(a); });
      item.addEventListener("mouseover", () => { item.style.background = "#f0f5ff"; });
      item.addEventListener("mouseout",  () => { item.style.background = ""; });
      authorSugg.appendChild(item);
    });
    authorSugg.style.display = "";
  });
  authorInput.addEventListener("blur", () => {
    setTimeout(() => { if (authorSugg) authorSugg.style.display = "none"; }, 150);
  });

  // 手動メインタグ
  const manualTagInput = document.getElementById("ext-manual-tag-input");
  const manualTagChips = document.getElementById("ext-manual-tag-chips");
  const renderManualTagChips = () => {
    _extRenderChips(_extManualTags, manualTagChips, renderManualTagChips);
  };
  const addManualTag = () => {
    const v = manualTagInput.value.trim();
    if (!v || _extManualTags.includes(v)) { manualTagInput.value = ""; return; }
    _extManualTags.push(v);
    manualTagInput.value = "";
    renderManualTagChips();
  };
  document.getElementById("ext-manual-tag-add").addEventListener("click", addManualTag);
  manualTagInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addManualTag(); } });

  // 手動サブタグ
  const manualSubTagInput = document.getElementById("ext-manual-subtag-input");
  const manualSubTagChips = document.getElementById("ext-manual-subtag-chips");
  const renderManualSubTagChips = () => {
    _extRenderChips(_extManualSubTags, manualSubTagChips, renderManualSubTagChips);
  };
  const addManualSubTag = () => {
    const v = manualSubTagInput.value.trim();
    if (!v || _extManualSubTags.includes(v)) { manualSubTagInput.value = ""; return; }
    _extManualSubTags.push(v);
    manualSubTagInput.value = "";
    renderManualSubTagChips();
  };
  document.getElementById("ext-manual-subtag-add").addEventListener("click", addManualSubTag);
  manualSubTagInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addManualSubTag(); } });

  // 離脱警告
  window.addEventListener("beforeunload", (e) => {
    if (_extImporting) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

/** スキャン実行 */
async function scanExternal(savedExcludes) {
  const path     = document.getElementById("ext-scan-path").value.trim();
  const resultEl = document.getElementById("ext-scan-result");
  resultEl.innerHTML = "";
  resultEl.className = "import-result";
  resultEl.style.display = "block";

  if (!path) {
    resultEl.innerHTML = "❌ パスを入力してください";
    resultEl.className = "import-result error";
    return;
  }

  const log = (msg) => { resultEl.innerHTML += escHtml(msg) + "\n"; };
  log("⏳ スキャン中...");

  const allExcludes  = [...savedExcludes, ..._extTempExcludes];
  const excludesNorm = allExcludes.map(s => s.normalize("NFKC").toLowerCase());
  const cutoffVal    = document.getElementById("ext-cutoff-date").value;
  const cutoffIso    = cutoffVal ? new Date(cutoffVal).toISOString() : "";

  if (cutoffVal) {
    await browser.storage.local.set({ extImportCutoffDate: cutoffVal });
  }

  let res;
  try {
    res = await browser.runtime.sendMessage({
      type:       "SCAN_EXTERNAL_IMAGES",
      path,
      cutoffDate: cutoffIso,
      excludes:   excludesNorm,
    });
  } catch (e) {
    resultEl.innerHTML = "";
    log(`❌ ${e.message}`);
    resultEl.className = "import-result error";
    return;
  }

  if (!res?.ok) {
    resultEl.innerHTML = "";
    log(`❌ ${res?.error || "不明なエラー"}`);
    resultEl.className = "import-result error";
    return;
  }

  // 重複チェック（savePaths 配列・savePath 単数の両形式に対応）
  const { saveHistory } = await browser.storage.local.get("saveHistory");
  const existingKeys = new Set(
    (saveHistory || []).map(e => {
      const p = Array.isArray(e.savePaths) ? (e.savePaths[0] || "") : (e.savePath || "");
      return `${p}\0${e.filename || e.fileName || ""}`;
    })
  );
  const deduped = res.entries.filter(e => !existingKeys.has(`${e.savePath}\0${e.fileName}`));
  const skipped = res.entries.length - deduped.length;

  _extScanResult = { ...res, entries: deduped };

  resultEl.innerHTML = "";
  log(`✅ スキャン完了: ${res.scanned} 件スキャン`);
  log(`📋 対象: ${deduped.length} 件（重複スキップ: ${skipped} 件）`);
  if (!res.allFolders?.length) log("ℹ️ 対象フォルダが見つかりませんでした");
  resultEl.className = "import-result success";

  const scanPath = document.getElementById("ext-scan-path").value.trim();
  await renderFolderTable(res.allFolders || [], res.folderTokens || {}, scanPath);
  document.getElementById("ext-tag-section").style.display    = "";
  document.getElementById("ext-import-section").style.display = "";
  const countEl = document.getElementById("ext-entry-count");
  if (countEl) countEl.textContent = deduped.length;
  const warnEl  = document.getElementById("ext-thumb-warning");
  if (warnEl) warnEl.style.display = document.getElementById("ext-gen-thumb").checked ? "" : "none";
}

/** フォルダ別タグ設定テーブル描画
 *  folders:      Python の allFolders（"." = ルート直下、"sub" や "sub\\child" = サブフォルダ）
 *  folderTokens: Python の folderTokens（{ relFolder: [token, ...] }）
 *  scanPath:     スキャン対象パス（ルートフォルダ名の表示に使用）
 */
async function renderFolderTable(folders, folderTokens, scanPath) {
  const tbody = document.getElementById("ext-folder-tbody");
  tbody.innerHTML = "";
  _extFolderTagMap = {};

  if (!folders.length) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="2" style="padding:8px;color:#aaa;font-size:12px;border:1px solid #e0e0e0;">
      フォルダが見つかりませんでした</td>`;
    tbody.appendChild(tr);
    return;
  }

  // スキャンルートの最後のフォルダ名を取得（表示用）
  const rootName = scanPath.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean).pop() || scanPath;

  // チップの背景色・ボーダー色をタイプ別に定義
  const chipStyle = {
    main: "background:#e8f5e9;border:1px solid #a5d6a7;",
    sub:  "background:#e3f2fd;border:1px solid #90caf9;",
    auth: "background:#fff3e0;border:1px solid #ffcc80;",
  };

  for (const folder of folders) {
    // 初期メインタグ: Python から受け取った絶対パストークン（除外ワード適用済み）
    const initialMainTags = folderTokens[folder] || [];
    _extFolderTagMap[folder] = { mainTags: [...initialMainTags], subTags: [], authTags: [] };

    const displayName = folder === "."
      ? `${escHtml(rootName)} <span style="font-size:10px;color:#888;">（ルート）</span>`
      : escHtml(folder);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="padding:4px 8px;border:1px solid #e0e0e0;white-space:nowrap;font-size:11px;
        font-weight:600;color:#2c3e50;vertical-align:top;">${displayName}</td>
      <td style="padding:4px 8px;border:1px solid #e0e0e0;">
        <div class="ext-frow" style="display:flex;align-items:flex-start;gap:6px;padding:3px 0;">
          <span style="font-size:10px;color:#888;white-space:nowrap;padding-top:4px;min-width:44px;">メイン:</span>
          <div class="ext-ftag-main-chips" style="display:flex;flex-wrap:wrap;gap:3px;flex:1;min-height:22px;"></div>
          <input type="text" class="ext-ftag-main-input" placeholder="Enter で追加"
            style="font-size:11px;padding:2px 5px;border:1px solid #d0d0d0;border-radius:3px;width:110px;font-family:inherit;" />
        </div>
        <div class="ext-frow" style="display:flex;align-items:flex-start;gap:6px;padding:3px 0;border-top:1px dashed #f0f0f0;">
          <span style="font-size:10px;color:#888;white-space:nowrap;padding-top:4px;min-width:44px;">サブ:</span>
          <div class="ext-ftag-sub-chips" style="display:flex;flex-wrap:wrap;gap:3px;flex:1;min-height:22px;"></div>
          <input type="text" class="ext-ftag-sub-input" placeholder="Enter で追加"
            style="font-size:11px;padding:2px 5px;border:1px solid #d0d0d0;border-radius:3px;width:110px;font-family:inherit;" />
        </div>
        <div class="ext-frow" style="display:flex;align-items:flex-start;gap:6px;padding:3px 0;border-top:1px dashed #f0f0f0;">
          <span style="font-size:10px;color:#888;white-space:nowrap;padding-top:4px;min-width:44px;">権利者:</span>
          <div class="ext-ftag-auth-chips" style="display:flex;flex-wrap:wrap;gap:3px;flex:1;min-height:22px;"></div>
          <input type="text" class="ext-ftag-auth-input" placeholder="Enter で追加"
            style="font-size:11px;padding:2px 5px;border:1px solid #d0d0d0;border-radius:3px;width:110px;font-family:inherit;" />
        </div>
      </td>
    `;
    tbody.appendChild(tr);

    const chipsEls = {
      main: tr.querySelector(".ext-ftag-main-chips"),
      sub:  tr.querySelector(".ext-ftag-sub-chips"),
      auth: tr.querySelector(".ext-ftag-auth-chips"),
    };
    const inputs = {
      main: tr.querySelector(".ext-ftag-main-input"),
      sub:  tr.querySelector(".ext-ftag-sub-input"),
      auth: tr.querySelector(".ext-ftag-auth-input"),
    };

    const renderChips = (type) => {
      const arr = _extFolderTagMap[folder][type + "Tags"];
      const el  = chipsEls[type];
      el.innerHTML = "";
      arr.forEach((tag, i) => {
        const chip = document.createElement("span");
        chip.draggable = true;
        chip.style.cssText = `${chipStyle[type]}border-radius:10px;padding:1px 8px;font-size:11px;display:inline-flex;align-items:center;gap:3px;cursor:grab;`;
        chip.innerHTML = `${escHtml(tag)}<span data-idx="${i}" style="cursor:pointer;color:#999;font-size:10px;line-height:1;padding-left:2px;">✕</span>`;
        chip.querySelector("span").addEventListener("click", (ev) => {
          _extFolderTagMap[folder][type + "Tags"].splice(Number(ev.target.dataset.idx), 1);
          renderChips(type);
        });
        // ドラッグ開始: 移動元情報を記録・同行チップの pointer-events を無効化
        chip.addEventListener("dragstart", (e) => {
          _extDragData = { folder, type, idx: i, tag };
          e.dataTransfer.effectAllowed = "move";
          chip.style.opacity = "0.4";
          // ドラッグ中は全チップの pointer-events を無効化（ドロップゾーンの邪魔をしないよう）
          tr.querySelectorAll("span[draggable='true']").forEach(c => {
            c.style.pointerEvents = "none";
          });
        });
        chip.addEventListener("dragend", () => {
          chip.style.opacity = "";
          _extDragData = null;
          // pointer-events を元に戻す
          tr.querySelectorAll("span[draggable='true']").forEach(c => {
            c.style.pointerEvents = "";
          });
        });
        el.appendChild(chip);
      });
    };

    // ドロップゾーン設定（同フォルダ内の別種別チップコンテナへの移動）
    ["main", "sub", "auth"].forEach(targetType => {
      const dropEl = chipsEls[targetType];
      dropEl.addEventListener("dragover", (e) => {
        if (!_extDragData || _extDragData.folder !== folder) return;
        if (_extDragData.type === targetType) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        dropEl.style.outline = "2px dashed #4a90e2";
        dropEl.style.borderRadius = "3px";
      });
      dropEl.addEventListener("dragleave", () => {
        dropEl.style.outline = "";
      });
      dropEl.addEventListener("drop", (e) => {
        e.preventDefault();
        dropEl.style.outline = "";
        if (!_extDragData || _extDragData.folder !== folder) return;
        const { type: srcType, idx: srcIdx, tag } = _extDragData;
        if (srcType === targetType) return;
        // ソースから削除、ターゲットに追加（重複なし）
        _extFolderTagMap[folder][srcType + "Tags"].splice(srcIdx, 1);
        const targetArr = _extFolderTagMap[folder][targetType + "Tags"];
        if (!targetArr.includes(tag)) targetArr.push(tag);
        renderChips(srcType);
        renderChips(targetType);
        _extDragData = null;
      });
    });

    const addTag = (input, type) => {
      const v = input.value.trim();
      if (!v) return;
      const arr = _extFolderTagMap[folder][type + "Tags"];
      if (!arr.includes(v)) { arr.push(v); renderChips(type); }
      input.value = "";
    };

    ["main", "sub", "auth"].forEach(type => {
      inputs[type].addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); addTag(inputs[type], type); }
      });
    });

    // 初期チップ描画（メインタグのみ初期値あり）
    renderChips("main");
  }
}

/** インポート実行 */
async function executeExternalImport() {
  if (!_extScanResult?.entries?.length) {
    showStatus("⚠️ スキャン結果がありません", true);
    return;
  }
  _extImporting        = true;
  _extImportCancelled  = false;
  _lastImportIds       = null;

  const resultEl  = document.getElementById("ext-import-result");
  const actionsEl = document.getElementById("ext-import-actions");
  resultEl.innerHTML = "";
  resultEl.className = "import-result";
  resultEl.style.display = "block";
  actionsEl.innerHTML = "";
  actionsEl.style.display = "none";
  const log = (msg) => { resultEl.innerHTML += escHtml(msg) + "\n"; };

  const genThumb = document.getElementById("ext-gen-thumb").checked;
  const entries  = _extScanResult.entries;
  log(`⏳ インポート準備中... (${entries.length} 件)`);

  // エントリごとに tags/subTags/authors をフォルダ別設定から決定
  const pendingEntries = entries.map(e => {
    const fm = _extFolderTagMap[e.relFolder] || { mainTags: [], subTags: [], authTags: [] };
    return {
      id:       crypto.randomUUID(),
      savedAt:  e.savedAt,
      imageUrl: "",
      pageUrl:  "",
      savePaths: [e.savePath],
      filename: e.fileName,
      tags:     [...new Set([...fm.mainTags, ...fm.subTags, ..._extManualTags, ..._extManualSubTags])],
      authors:  [...fm.authTags,  ..._extManualAuthors],
      thumbId:  null,
      source:   "external_import",
    };
  });

  // サムネイル生成（1件ずつ処理 — Native Messaging 1MB 上限対策）
  if (genThumb) {
    // 中断ボタンを表示
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "backup-btn";
    cancelBtn.textContent = "🛑 中断";
    cancelBtn.style.cssText = "padding:3px 10px;font-size:12px;";
    cancelBtn.addEventListener("click", () => {
      _extImportCancelled = true;
      cancelBtn.disabled  = true;
      cancelBtn.textContent = "⛔ 中断中...";
    });
    actionsEl.appendChild(cancelBtn);
    actionsEl.style.display = "";

    log(`🖼 サムネイル生成中... (0 / ${entries.length} 件)`);
    for (let i = 0; i < entries.length; i++) {
      if (_extImportCancelled) break;
      const entry = entries[i];
      let thumbRes;
      try {
        thumbRes = await browser.runtime.sendMessage({
          type:  "GENERATE_THUMBS_BATCH",
          paths: [entry.filePath],
        });
      } catch (_) { /* 失敗スキップ */ }

      if (thumbRes?.ok) {
        const b64 = thumbRes.thumbs?.[entry.filePath];
        if (b64) {
          const pending   = pendingEntries[i];
          pending.thumbId = pending.id;
          await browser.runtime.sendMessage({
            type:   "IMPORT_IDB_THUMBS",
            thumbs: [{ id: pending.id, dataUrl: `data:image/jpeg;base64,${b64}` }],
          });
        }
      }

      resultEl.innerHTML = "";
      log(`🖼 サムネイル生成中... (${i + 1} / ${entries.length} 件)`);
    }

    // 中断ボタンを除去
    actionsEl.innerHTML  = "";
    actionsEl.style.display = "none";

    if (_extImportCancelled) {
      resultEl.innerHTML = "";
      log("⛔ 中断しました（インポートはキャンセルされました）");
      _extImporting = false;
      return;
    }

    resultEl.innerHTML = "";
    log(`🖼 サムネイル生成完了`);
  }

  // saveHistory にマージ（savedAt 降順でソートして時系列の正しい位置に挿入）
  const stored = await browser.storage.local.get(["saveHistory", "globalTags", "globalAuthors"]);
  const existing = stored.saveHistory || [];
  const merged   = [...pendingEntries, ...existing]
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

  // インポートしたタグ・サブタグ・権利者を globalTags / globalAuthors に追加
  const importedTags    = pendingEntries.flatMap(e => e.tags || []);
  const importedAuthors = pendingEntries.flatMap(e => e.authors || []);
  const gTagSet    = new Set([...(stored.globalTags    || []), ...importedTags]);
  const gAuthorSet = new Set([...(stored.globalAuthors || []), ...importedAuthors]);

  // tagDestinations 更新（メインタグのみ・サブタグは保存先に関連付けない）
  for (const pe of pendingEntries) {
    const path = Array.isArray(pe.savePaths) ? (pe.savePaths[0] || "") : (pe.savePath || "");
    if (!path) continue;
    for (const tag of (pe.tags || [])) {
      if (!tagDestinations[tag]) tagDestinations[tag] = [];
      if (!tagDestinations[tag].some(d => d.path === path)) {
        tagDestinations[tag].push({ id: crypto.randomUUID(), path, label: "" });
      }
    }
  }

  await browser.storage.local.set({
    saveHistory:   merged,
    globalTags:    [...gTagSet],
    globalAuthors: [...gAuthorSet],
    tagDestinations,
  });
  _historyData  = merged;
  globalTags    = [...gTagSet];
  globalAuthors = [...gAuthorSet];

  _extImporting  = false;
  _lastImportIds = pendingEntries.map(e => e.id);

  resultEl.className = "import-result success";
  resultEl.innerHTML = "";
  log(`✅ ${pendingEntries.length} 件をインポートしました`);
  showStatus(`✅ ${pendingEntries.length} 件のインポートが完了しました`);

  // 取り消しボタンを表示
  const undoBtn = document.createElement("button");
  undoBtn.className   = "backup-btn";
  undoBtn.textContent = "↩ 取り消し";
  undoBtn.style.cssText = "padding:3px 10px;font-size:12px;";
  undoBtn.addEventListener("click", async () => {
    if (!_lastImportIds?.length) return;
    undoBtn.disabled    = true;
    undoBtn.textContent = "⏳ 取り消し中...";

    // サムネイル削除（thumbId を持つエントリのみ）
    for (const id of _lastImportIds) {
      const e = _historyData.find(h => h.id === id);
      if (e?.thumbId) {
        try { await browser.runtime.sendMessage({ type: "DELETE_THUMB", id: e.thumbId }); } catch (_) {}
      }
    }

    // saveHistory から取り消し対象を除去
    const idSet = new Set(_lastImportIds);
    const { saveHistory: sh } = await browser.storage.local.get("saveHistory");
    const filtered = (sh || []).filter(e => !idSet.has(e.id));
    await browser.storage.local.set({ saveHistory: filtered });
    _historyData   = filtered;
    _lastImportIds = null;

    actionsEl.innerHTML  = "";
    actionsEl.style.display = "none";
    resultEl.className   = "import-result";
    resultEl.innerHTML   = escHtml("↩ インポートを取り消しました") + "\n";
    showStatus("↩ インポートを取り消しました");
    renderAll();
  });
  actionsEl.appendChild(undoBtn);
  actionsEl.style.display = "";
}
