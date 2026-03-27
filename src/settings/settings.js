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
 */

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

// 開いているタグ行のセット（折りたたみ状態の管理）
const openTags = new Set();

// ----------------------------------------------------------------
// 初期化
// ----------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  // ---- タブ切り替え ----
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
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
  setupBookmarks();
  setupLogs();
  setupHistoryTab();
  setupHistoryDisplayMode();
  setupAuthorsTab();

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
 */
async function exportData() {
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
    "historyPageSize",
  ]);

  // IndexedDB のサムネイルも取得
  let idbThumbs = [];
  try {
    const res = await browser.runtime.sendMessage({ type: "EXPORT_IDB_THUMBS" });
    if (res?.ok) idbThumbs = res.thumbs;
  } catch {}

  const payload = {
    _meta: {
      exportedAt: new Date().toISOString(),
      version:    "1.5.65",
      app:        "image-saver-tags",
    },
    ...stored,
    _idbThumbs: idbThumbs,  // IDB サムネイル（差分インポート用）
  };

  const json = JSON.stringify(payload, null, 2);

  const ts   = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  const name = `image-saver-backup-${ts}.json`;

  // エクスポート先 + 即保存オプションの確認
  const { exportPath, exportAutoSave } = await browser.storage.local.get(["exportPath", "exportAutoSave"]);
  if (exportPath && exportAutoSave) {
    // Native Messaging 経由でファイルに直接書き出す
    const savePath = exportPath.replace(/[\\/]+$/, "") + "\\" + name;
    const res = await browser.runtime.sendMessage({
      type: "WRITE_FILE",
      path: savePath,
      content: json,
    });
    if (res?.ok) {
      showCenterToast(`✅ エクスポートしました
${savePath}
（サムネイル ${idbThumbs.length} 件含む）`);
    } else {
      const msg = res?.errorCode === "DIR_NOT_FOUND"
        ? `⚠️ フォルダが存在しません: ${exportPath}\n設定画面でエクスポート先を確認してください`
        : `⚠️ 直接保存に失敗しました。ダウンロードに切り替えます: ${res?.error || ""}`;
      showStatus(msg, true);
      _downloadJson(json, name, idbThumbs.length);
    }
    return;
  }

  _downloadJson(json, name, idbThumbs.length);
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

  // ---- historyPageSize ----
  if (parsed.historyPageSize !== undefined) {
    try {
      await browser.storage.local.set({ historyPageSize: parsed.historyPageSize });
      log(`📄 historyPageSize: ${parsed.historyPageSize}`);
    } catch (err) { logError(`historyPageSize の保存に失敗: ${err.message}`); return; }
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
let _histFilterTag = "";
let _histFilterMode = "or"; // "or" | "and"
let _histScrollPos = 0; // 絞り込みなし時のスクロール位置
let _histPage     = 0;   // 現在ページ（0始まり）
let _histPageSize = 100; // 1ページの表示件数
let _histSelected  = new Set();

/** 保存履歴表示モードの設定 */
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
    // 絞り込み中のみ活性化
    selectAllBtn.disabled = !_histFilterTag;
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
      browser.storage.local.set({ historyPageSize: _histPageSize }).catch(() => {});
      renderHistoryGrid();
    });
  }

  // 全選択（絞り込み中の全件）
  selectAllBtn.addEventListener("click", () => {
    const filterQ = _histFilterTag;
    if (!filterQ) return;
    const filterTokens = filterQ.split(/\s+/).filter(Boolean);
    const filtered = _historyData.filter(e => {
      const entryTags = [...(e.tags || []), ...(e.subTags || [])].map(t => t.toLowerCase());
      if (_histFilterMode === "and") {
        return filterTokens.every(token => entryTags.some(t => t.includes(token)));
      } else {
        return filterTokens.some(token => entryTags.some(t => t.includes(token)));
      }
    });
    filtered.forEach(e => _histSelected.add(e.id));
    document.getElementById("hist-deselect-all").disabled = _histSelected.size === 0;
    document.getElementById("hist-delete-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-add-tag-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-group-selected").disabled = _histSelected.size < 2;
    document.getElementById("hist-ungroup-selected").disabled = _histSelected.size === 0;
    renderHistoryGrid();
  });

  // 選択削除
  document.getElementById("hist-deselect-all").addEventListener("click", () => {
    _histSelected.clear();
    document.getElementById("hist-deselect-all").disabled = true;
    document.getElementById("hist-add-tag-selected").disabled = true;
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
}

async function renderHistoryTab() {
  const stored = await browser.storage.local.get(["saveHistory", "historyPageSize"]);
  _historyData  = stored.saveHistory    || [];
  _histPageSize = stored.historyPageSize || 100;
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

  const filtered = (hasTagFilter || hasAuthorFilter)
    ? _historyData.filter(e => {
        const entryTags = [...(e.tags || []), ...(e.subTags || [])].map(t => t.toLowerCase());
        const tagMatch = !hasTagFilter || (
          _histFilterMode === "and"
            ? filterTokens.every(token => entryTags.some(t => t.includes(token)))
            : filterTokens.some(token => entryTags.some(t => t.includes(token)))
        );
        const authorMatch = !hasAuthorFilter || (e.author || "").toLowerCase().includes(authorQ);
        // 両フィルター有効時のみモードを適用。片方のみの場合は active 側の結果をそのまま返す
        if (hasTagFilter && hasAuthorFilter) {
          return _histFilterMode === "and" ? (tagMatch && authorMatch) : (tagMatch || authorMatch);
        }
        return tagMatch && authorMatch;
      })
    : _historyData;

  const isFiltering = hasTagFilter || hasAuthorFilter;
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
  document.getElementById("hist-group-selected").disabled = _histSelected.size < 2;
  document.getElementById("hist-ungroup-selected").disabled = _histSelected.size === 0;
}

function renderHistoryPager(total) {
  const totalPages = Math.max(1, Math.ceil(total / _histPageSize));
  const pagerHtml = total <= _histPageSize ? "" : `
    <button class="hist-pager-btn" id="hist-pager-prev" ${_histPage === 0 ? "disabled" : ""}>◀ 前へ</button>
    <span class="hist-pager-info">${_histPage + 1} / ${totalPages} ページ</span>
    <button class="hist-pager-btn" id="hist-pager-next" ${_histPage >= totalPages - 1 ? "disabled" : ""}>次へ ▶</button>`;

  ["hist-pager-top", "hist-pager-bottom"].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = pagerHtml;
    if (pagerHtml) {
      el.querySelector("#hist-pager-prev")?.addEventListener("click", () => { _histPage--; renderHistoryGrid(); });
      el.querySelector("#hist-pager-next")?.addEventListener("click", () => { _histPage++; renderHistoryGrid(); });
    }
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
                const gIdx = _historyData.findIndex(h => h.id === first.id);
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
              const gIdx = _historyData.findIndex(h => h.id === item.id);
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
    tokens.push(tag);      // 含まれていなければ追加
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
  const authorHtml = entry.author
    ? `<span class="hist-card-author" data-author="${escHtml(entry.author)}">✏️ ${escHtml(entry.author)}</span>`
    : "";

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
                // 全体ナビ付きでシングル表示
                const gIdx = _historyData.findIndex(h => h.id === entry.id);
                showGroupLightbox([r.dataUrl], 0, [entry], { startEntryIndex: gIdx });
              }
            });
            placeholder.replaceWith(img);
          }
        }
      }).catch(() => {});
  }

  card.innerHTML = `
    <input type="checkbox" class="hist-select-box" ${_histSelected.has(entry.id) ? "checked" : ""} />
    ${thumbHtml}
    <div class="hist-card-overlay">
      <div class="hist-card-body">
        <div class="hist-card-filename" title="${escHtml(entry.filename)}">${escHtml(entry.filename)}</div>
        <div class="hist-card-path" title="${escHtml(primary)}">${escHtml(primary || "（パスなし）")}</div>
        ${authorHtml ? `<div class="hist-card-author-row">${authorHtml}</div>` : ""}
        <div class="hist-card-tags">${tagHtml}</div>
        <div class="hist-card-date">${escHtml(date)}</div>
      </div>
      <div class="hist-card-actions">
        <button class="hist-card-btn open-folder" title="${escHtml(primary)}">🗂 保存先フォルダを開く</button>
        <button class="hist-card-btn open-file" title="${escHtml(primary ? primary + '\\\\' + entry.filename : '')}">🖼 保存した画像を開く</button>
        <button class="hist-card-btn addtag" title="タグを追加">🏷️ タグ追加</button>
        <button class="hist-card-btn del delete-guarded" title="削除">🗑 削除</button>
      </div>
      <div class="hist-tag-editor" style="display:none">
        <div class="hist-tag-editor-chips"></div>
        <div class="hist-tag-editor-input-row">
          <input type="text" class="hist-tag-editor-input" placeholder="タグを入力..." autocomplete="off" />
          <button class="hist-tag-editor-confirm">✔ 保存</button>
          <div class="hist-tag-editor-suggestions"></div>
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

  // タグ追加ボタン・インラインエディタ
  const addTagBtn = card.querySelector(".hist-card-btn.addtag");
  const tagEditor = card.querySelector(".hist-tag-editor");
  const editorChips = card.querySelector(".hist-tag-editor-chips");
  const editorInput = card.querySelector(".hist-tag-editor-input");
  const editorConfirm = card.querySelector(".hist-tag-editor-confirm");
  const editorSuggestions = card.querySelector(".hist-tag-editor-suggestions");

  let pendingTags = new Set(entry.tags || []);

  function renderEditorChips() {
    editorChips.innerHTML = "";
    pendingTags.forEach(t => {
      const chip = document.createElement("span");
      chip.className = "hist-tag-editor-chip";
      chip.textContent = t;
      const del = document.createElement("button");
      del.textContent = "×";
      del.addEventListener("click", (e) => { e.stopPropagation(); pendingTags.delete(t); renderEditorChips(); });
      chip.appendChild(del);
      editorChips.appendChild(chip);
    });
  }

  function showSuggestions(query) {
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
        pendingTags.add(t);
        editorInput.value = "";
        editorSuggestions.style.display = "none";
        renderEditorChips();
      });
      editorSuggestions.appendChild(item);
    });
    editorSuggestions.style.display = "";
  }

  addTagBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = tagEditor.style.display !== "none";
    tagEditor.style.display = isOpen ? "none" : "";
    if (!isOpen) {
      pendingTags = new Set(entry.tags || []);
      renderEditorChips();
      editorInput.value = "";
      editorSuggestions.style.display = "none";
      editorInput.focus();
    }
  });

  editorInput.addEventListener("input", () => { showSuggestions(editorInput.value.trim()); });
  editorInput.addEventListener("blur", () => { setTimeout(() => { editorSuggestions.style.display = "none"; }, 150); });
  editorInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = editorInput.value.trim();
      if (val) { pendingTags.add(val); editorInput.value = ""; editorSuggestions.style.display = "none"; renderEditorChips(); }
    } else if (e.key === "Escape") {
      tagEditor.style.display = "none";
    }
  });

  editorConfirm.addEventListener("click", async (e) => {
    e.stopPropagation();
    const val = editorInput.value.trim();
    if (val) pendingTags.add(val);
    const newTags = [...pendingTags];
    const stored = await browser.storage.local.get(["saveHistory", "globalTags"]);
    const history = stored.saveHistory || [];
    const target = history.find(h => h.id === entry.id);
    if (target) {
      target.tags = newTags;
      // globalTagsにも新タグを追加
      const gSet = new Set([...(stored.globalTags || []), ...newTags]);
      await browser.storage.local.set({ saveHistory: history, globalTags: [...gSet] });
      _historyData = history;
      globalTags = [...gSet];
      tagEditor.style.display = "none";
      renderHistoryGrid();
      showStatus("タグを保存しました ✔");
    }
  });

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
        win.document.write(`<!DOCTYPE html><html><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;">
          <img src="${res.dataUrl}" style="max-width:100%;max-height:100vh;object-fit:contain;" /></body></html>`);
        win.document.close();
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

    // 全体ナビ用：現在表示中の _historyData インデックス
    let globalIdx = globalCtx?.startEntryIndex ?? -1;
    const totalGlobal = _historyData.length;

    function updateGlobalLabel() {
      if (globalIdx < 0) { labelAll.textContent = ""; return; }
      labelAll.textContent = `全体 ${totalGlobal - globalIdx} / ${totalGlobal}`;
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
      const entry = _historyData[gIdx];
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
  // タブクリック時に renderAuthorsTab が呼ばれるのでここでは初期化のみ
}

async function renderAuthorsTab() {
  const list = document.getElementById("author-list");
  if (!list) return;

  // 最新データを取得
  const [authorsRes, destsRes] = await Promise.all([
    browser.runtime.sendMessage({ type: "GET_GLOBAL_AUTHORS" }),
    browser.runtime.sendMessage({ type: "GET_AUTHOR_DESTINATIONS" }),
  ]);
  globalAuthors      = authorsRes.authors                || [];
  authorDestinations = destsRes.authorDestinations       || {};

  list.innerHTML = "";

  if (globalAuthors.length === 0) {
    list.innerHTML = `<div style="color:#888;font-size:13px;padding:8px">作者がまだ登録されていません。保存ダイアログで作者名を入力すると自動的に登録されます。</div>`;
    return;
  }

  globalAuthors.forEach(author => {
    const row = _buildAuthorRow(author);
    list.appendChild(row);
  });
}

function _buildAuthorRow(author) {
  const dests = authorDestinations[author] || [];
  const hasLink = dests.length > 0;

  const row = document.createElement("div");
  row.className = "author-row";

  const header = document.createElement("div");
  header.className = "author-header";

  const nameEl = document.createElement("span");
  nameEl.className = "author-name";
  nameEl.textContent = author;

  const toggleBtn = document.createElement("button");
  toggleBtn.className = "author-dest-toggle";
  toggleBtn.textContent = hasLink ? `📁 保存先 ${dests.length} 件` : "📁 保存先を追加";
  toggleBtn.title = "保存先の関連付けを管理";

  const delBtn = document.createElement("button");
  delBtn.className = "hist-card-btn del delete-guarded";
  delBtn.style.cssText = "font-size:11px;padding:2px 7px;margin-left:auto;";
  delBtn.textContent = "削除";

  header.appendChild(nameEl);
  header.appendChild(toggleBtn);
  header.appendChild(delBtn);

  const destList = document.createElement("div");
  destList.className = "author-dest-list";
  destList.style.display = "none";

  function renderDestList() {
    destList.innerHTML = "";
    const currentDests = authorDestinations[author] || [];

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
        const i = parseInt(btn.dataset.idx);
        authorDestinations[author] = (authorDestinations[author] || []).filter((_, j) => j !== i);
        await browser.runtime.sendMessage({ type: "SET_AUTHOR_DESTINATIONS", data: authorDestinations });
        renderDestList();
        toggleBtn.textContent = `📁 保存先 ${(authorDestinations[author] || []).length} 件`;
      });
    });

    const addBtn = addRow.querySelector(".author-dest-add-btn");
    const sel    = addRow.querySelector(".author-dest-select");
    addBtn.addEventListener("click", async () => {
      const opt = sel.options[sel.selectedIndex];
      if (!opt?.value) return;
      const newDest = { id: opt.value, path: opt.dataset.path, label: opt.dataset.label };
      if (!authorDestinations[author]) authorDestinations[author] = [];
      if (!authorDestinations[author].some(d => d.id === newDest.id)) {
        authorDestinations[author].push(newDest);
        await browser.runtime.sendMessage({ type: "SET_AUTHOR_DESTINATIONS", data: authorDestinations });
        renderDestList();
        toggleBtn.textContent = `📁 保存先 ${authorDestinations[author].length} 件`;
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
    if (!confirm(`「${author}」を作者一覧から削除しますか？`)) return;
    globalAuthors = globalAuthors.filter(a => a !== author);
    delete authorDestinations[author];
    await Promise.all([
      browser.runtime.sendMessage({ type: "SET_AUTHOR_DESTINATIONS", data: authorDestinations }),
      browser.storage.local.set({ globalAuthors }),
    ]);
    row.remove();
    showStatus("作者を削除しました");
  });

  row.appendChild(header);
  row.appendChild(destList);
  return row;
}
