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
// 保存履歴の GIF フィルター（v1.22.2）
// v1.32.2 GROUP-28 mvdl：GIF のみチェックボックスをプルダウン化、音声付きフィルタ追加
// "all" | "gif" | "audio"
let _histFormatFilter  = "all";
// v1.37.0 GROUP-36-fav-filter：お気に入りのみ表示トグル（独立フィルタ、他フィルタと AND 結合）
let _histFavFilter     = false;

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

// ---- v1.20.0: 1枚ずつ形式の状態 ----
let _extMode           = "batch";   // "batch" | "per_item"
let _extFolderList     = [];        // extImportFolderList
let _extSessions       = [];        // extImportSessions
let _extCompletedRoots = [];        // extImportCompletedRoots
let _extActiveSession  = null;      // 現在プレビュー中のセッション
let _extSubfolderCands = [];        // サブフォルダ選択候補
let _extFpStack        = [];        // フォルダピッカーの breadcrumb stack
let _extFpCurrent      = null;      // フォルダピッカーの現在パス
let _extFpSelectedPath = null;      // フォルダピッカーで選択中のパス

// ---- v1.22.0: 取り込み予定リスト共通化（一括取り込み・1枚ずつ取り込みのフィード）----
// 選択キー: single なら item.id、subfolders なら `${item.id}\0${sub.path}`
let _extFlSelectedKeys = new Set();
// ---- v1.27.0 GROUP-19 Phase A: タブ化状態 ----
// "single" or "root:<normalizedPath>" の形式で保持。起動時に storage.local.extImportFlActiveTab から復元
let _extFlActiveTab = "single";
// ---- v1.28.0 GROUP-19 Phase B/C: ソート状態・タブ順序・テーブル高さ ----
// { [tabId]: "insertion"|"path"|"status"|"count"|"progress"|"thumbsize" }
let _extFlSortModes = {};
// ルート別タブの表示順（normalized rootPath の配列）。単体タブは常に左端固定で管理外
let _extFlTabOrder = [];
// テーブル領域の高さ（px、ユーザーリサイズ後の値を永続化）
let _extFlTableHeight = null;
// サブフォルダピッカー用: ドラッグ操作の状態
let _extPickerDrag     = null;
//   { mode: "unify"|"invert", target: bool, lastIdx: number, processed: Set<number>, anchorIdx: number }
let _extPickerLastClickedIdx = -1;  // Shift+クリック範囲選択の起点

// ----------------------------------------------------------------
// 初期化
// ----------------------------------------------------------------
document.addEventListener("DOMContentLoaded", async () => {
  // v1.32.1 GROUP-29：settings 画面起動時に saveHistory の savedAt 降順ソートを保証。
  // 過去の import（v1.32.0 以前）で順序が乱れたデータを自動修復する one-time 修正。
  // 既に降順なら何もしない（冪等）、何度実行しても安全。
  try {
    const { saveHistory } = await browser.storage.local.get("saveHistory");
    if (Array.isArray(saveHistory) && saveHistory.length >= 2) {
      let outOfOrder = false;
      for (let i = 0; i < saveHistory.length - 1; i++) {
        const ta = saveHistory[i]?.savedAt     ? new Date(saveHistory[i].savedAt).getTime()     : 0;
        const tb = saveHistory[i + 1]?.savedAt ? new Date(saveHistory[i + 1].savedAt).getTime() : 0;
        if (ta < tb) { outOfOrder = true; break; }
      }
      if (outOfOrder) {
        saveHistory.sort((a, b) => {
          const ta = a?.savedAt ? new Date(a.savedAt).getTime() : 0;
          const tb = b?.savedAt ? new Date(b.savedAt).getTime() : 0;
          return tb - ta;
        });
        await browser.storage.local.set({ saveHistory });
        console.log(`[GROUP-29] saveHistory を savedAt 降順で再ソート（${saveHistory.length} 件）`);
      }
    }
  } catch (err) {
    console.warn("[GROUP-29] saveHistory 再ソート失敗", err);
  }

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
      // v1.25.0 GROUP-12-width: 外部取り込みタブ時のみ body に wide-tab クラスを付与し、
      // レスポンシブ max-width（720 / 960 / 1200 / 1480px）を有効化
      document.body.classList.toggle("wide-tab", btn.dataset.tab === "external-import");
      // 保存履歴タブに切り替えたら描画
      if (btn.dataset.tab === "history") renderHistoryTab();
      if (btn.dataset.tab === "authors") renderAuthorsTab();
    });
  });
  // v1.25.0 GROUP-12-width: 初期表示時に現在アクティブタブが external-import なら wide-tab を適用
  {
    const activeInitial = document.querySelector(".tab-btn.active");
    if (activeInitial) {
      document.body.classList.toggle("wide-tab", activeInitial.dataset.tab === "external-import");
    }
  }

  await loadData();
  renderAll();
  setupBackup();
  setupRootPath();
  setupInstantSave();
  setupMinimizeAfterSave();
  setupFilenameSettings();
  setupDiffExport();
  setupExportThumbsOption();
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
  // GROUP-26-mem (v1.29.2): const → let、json 作成後に null 化で V8 allocation 余地確保
  let stored = await browser.storage.local.get([
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
    "hoverButtonsTempHidden",
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
    "exportThumbsEnabled",
    "lastExportedAt",
  ]);
  log("📦 設定データ取得完了");

  // GROUP-26-mem-2 (v1.31.0 Phase A'): 全サムネ一括取得（EXPORT_IDB_THUMBS, 〜350MB）を廃止、
  // history chunk ごとに GET_IDB_THUMBS_BY_IDS で都度取得して実行中ピークを削減。
  // サムネ埋込 OFF のときは thumb 取得自体をスキップ（既存挙動と一致）。
  const exportThumbsEnabled = stored.exportThumbsEnabled !== false; // デフォルト ON（既存挙動維持）
  if (exportThumbsEnabled) {
    log("🖼 サムネイル埋込 ON（chunk 単位で IDB から都度取得、ピーク削減）");
  } else {
    log("🖼 サムネイル埋込は OFF（_idbThumbs=[] で JSON サイズを大幅削減、thumbId 参照は保持）");
  }

  // ---- 差分エクスポート処理 ----
  const isDiff = !!stored.diffExportEnabled && !!stored.lastExportedAt;
  let exportHistory = stored.saveHistory || [];

  if (isDiff) {
    const lastAt = new Date(stored.lastExportedAt);
    const fullCount = exportHistory.length;
    exportHistory = exportHistory.filter(entry => entry.savedAt && new Date(entry.savedAt) > lastAt);
    log(`🔍 差分: ${exportHistory.length} 件 / 全 ${fullCount} 件（前回エクスポート: ${stored.lastExportedAt.slice(0, 19).replace("T", " ")}）`);
    if (exportHistory.length === 0) {
      log("ℹ️ 差分なし（前回エクスポート以降の新規エントリはありません）");
      return;
    }
  }

  // ---- ファイル名生成（GROUP-26-split / v1.30.0: ローカル時刻化で UTC ずれ解消） ----
  const exportedAt = new Date().toISOString(); // JSON meta 用は UTC 維持
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const prefix = isDiff ? "borgestag-diff" : "borgestag-export";
  const zipName = `${prefix}-${ts}.zip`;

  // ---- AutoSave 判定（stored null 化前にスナップショット） ----
  const useAutoSave = !!(stored.exportPath && stored.exportAutoSave);
  const exportPathSnapshot = stored.exportPath || "";
  const diffBase = isDiff ? stored.lastExportedAt : null;

  // ---- 一時ディレクトリ作成（GROUP-26-split） ----
  // v1.30.10 GROUP-26-cleanup-2: AutoSave でも常に %TEMP% 配下に chunk を作成。
  // 従来は AutoSave ON で exportPath（OneDrive 等）配下に chunk を置いていたが、
  // OneDrive の同期ロックで _retry_rmtree（5 回 × 500ms）が間に合わず空フォルダが残留していた。
  // %TEMP% はローカル・同期対象外のため確実に削除でき、zip 最終出力はそのまま exportPath に書ける。
  const mkRes = await browser.runtime.sendMessage({
    type: "MKDIR_EXPORT_TMP",
    parentPath: null, // 常に %TEMP%\\borgestag_chunk_cache\\ 配下
  });
  if (!mkRes?.ok) {
    logError(`一時ディレクトリ作成失敗: ${mkRes?.error || "不明"}`);
    return;
  }
  const tempDir = mkRes.tempDir;
  log(`📁 一時ディレクトリ: ${tempDir}`);

  // ---- 分割書出（settings / history-NNN / thumbs-NNN / manifest） ----
  const CHUNK_SIZE = 500;
  const files = [];

  // settings.json（設定キー群のみ、saveHistory 除外）
  const settingsOnly = { ...stored };
  delete settingsOnly.saveHistory;
  const settingsName = "settings.json";
  const settingsRes = await browser.runtime.sendMessage({
    type: "WRITE_FILE",
    path: `${tempDir}\\${settingsName}`,
    content: JSON.stringify(settingsOnly, null, 2),
  });
  if (!settingsRes?.ok) {
    logError(`settings.json 書込失敗: ${settingsRes?.error || ""}`);
    return;
  }
  files.push({ category: "settings", path: settingsName });
  stored = null; // GROUP-26-mem: settings 書出後は不要

  // GROUP-26-mem-2 (v1.31.0 Phase A'): history と thumbs のループを統合し、
  // chunk ごとに per-iteration で書き出す。1 iteration の寿命は const スコープで完結、
  // 次反復前に旧 chunk は GC 対象になるため実行中ピークが大幅削減される。
  const historyTotal = exportHistory.length;
  let thumbsTotalWritten = 0;
  for (let i = 0, n = 1; i < historyTotal; i += CHUNK_SIZE, n++) {
    const batch = exportHistory.slice(i, i + CHUNK_SIZE);

    // history-NNN.json 書出
    const histName = `history-${String(n).padStart(3, "0")}.json`;
    const histRes = await browser.runtime.sendMessage({
      type: "WRITE_FILE",
      path: `${tempDir}\\${histName}`,
      content: JSON.stringify(batch, null, 2),
    });
    if (!histRes?.ok) {
      logError(`${histName} 書込失敗: ${histRes?.error || ""}`);
      return;
    }
    files.push({ category: "history", path: histName, entries: batch.length });
    log(`✏️ ${histName} 書込（${Math.min(i + CHUNK_SIZE, historyTotal)}/${historyTotal}）`);

    // thumbs-NNN.json 書出（サムネ ON かつ該当エントリに thumbId があれば）
    if (exportThumbsEnabled) {
      const thumbIds = batch.map(e => e.thumbId).filter(Boolean);
      if (thumbIds.length > 0) {
        const thumbsRes = await browser.runtime.sendMessage({
          type: "GET_IDB_THUMBS_BY_IDS",
          ids: thumbIds,
        });
        if (!thumbsRes?.ok) {
          logError(`thumbs-${String(n).padStart(3, "0")}.json 取得失敗: ${thumbsRes?.error || ""}`);
          return;
        }
        if (thumbsRes.thumbs.length > 0) {
          const thumbsName = `thumbs-${String(n).padStart(3, "0")}.json`;
          const writeRes = await browser.runtime.sendMessage({
            type: "WRITE_FILE",
            path: `${tempDir}\\${thumbsName}`,
            content: JSON.stringify(thumbsRes.thumbs, null, 2),
          });
          if (!writeRes?.ok) {
            logError(`${thumbsName} 書込失敗: ${writeRes?.error || ""}`);
            return;
          }
          files.push({ category: "thumbs", path: thumbsName, entries: thumbsRes.thumbs.length });
          thumbsTotalWritten += thumbsRes.thumbs.length;
          log(`✏️ ${thumbsName} 書込（${thumbsRes.thumbs.length} 件）`);
        }
      }
    }
  }
  exportHistory = null;
  const thumbsTotal = thumbsTotalWritten;

  // manifest.json 書出
  const manifestData = {
    formatVersion: 1,
    borgestagVersion: "1.30.0",
    app: "image-saver-tags",
    exportedAt,
    isDiff,
    diffBase,
    chunkSize: CHUNK_SIZE,
    thumbnailsIncluded: exportThumbsEnabled,
    files,
    totalEntries: { history: historyTotal, thumbs: thumbsTotal },
  };
  const manifestRes = await browser.runtime.sendMessage({
    type: "WRITE_FILE",
    path: `${tempDir}\\manifest.json`,
    content: JSON.stringify(manifestData, null, 2),
  });
  if (!manifestRes?.ok) {
    logError(`manifest.json 書込失敗: ${manifestRes?.error || ""}`);
    return;
  }

  // ---- zip 化（Native 側 ZIP_DEFLATED、deleteSrc=true で一時 dir 削除） ----
  log("🗜 zip 化中...");
  const zipPath = useAutoSave
    ? `${exportPathSnapshot.replace(/[\\/]+$/, "")}\\${zipName}`
    : `${tempDir}_tmp_${ts}.zip`; // OFF 経路：tempDir と同階層の一時 zip
  const zipRes = await browser.runtime.sendMessage({
    type: "ZIP_DIRECTORY",
    srcDir: tempDir,
    dstZipPath: zipPath,
    deleteSrc: true,
  });
  if (!zipRes?.ok) {
    logError(`zip 生成失敗: ${zipRes?.error || ""}`);
    return;
  }
  const actualZipPath = zipRes.zipPath;
  const zipSizeMB = (zipRes.zipSize / 1024 / 1024).toFixed(2);
  log(`🗜 zip 生成完了（${zipRes.fileCount} ファイル、${zipSizeMB} MB）`);

  // GROUP-26-cleanup (v1.30.1): Native 側で一時 dir 削除に失敗した場合の明示通知
  // OneDrive / アンチウイルスのファイル監視でロックされているケース（Native 側は 5 回 retry 済）
  if (zipRes.cleanupWarning) {
    logError(`⚠️ ${zipRes.cleanupWarning}`);
    if (zipRes.tempDirPath) {
      log(`📂 手動削除してください: ${zipRes.tempDirPath}`);
    }
  }

  if (useAutoSave) {
    if (isDiff) await browser.storage.local.set({ lastExportedAt: exportedAt });
    log(`✅ エクスポート完了: ${actualZipPath}`);
    showCenterToast(`✅ エクスポートしました\n${actualZipPath}\n（${zipSizeMB} MB）`);
    return;
  }

  // ---- AutoSave OFF: zip を chunk で読み込み → Blob DL → 一時 zip 削除 ----
  log("💾 ダウンロード準備中...");
  const chunkReadRes = await browser.runtime.sendMessage({
    type: "READ_FILE_CHUNKS_B64",
    path: actualZipPath,
  });
  if (!chunkReadRes?.ok) {
    logError(`zip 読込失敗: ${chunkReadRes?.error || ""}`);
    return;
  }
  const blob = _assembleBlobFromB64Chunks(chunkReadRes.chunksB64, "application/zip");
  browser.runtime.sendMessage({ type: "DELETE_CHUNK_FILE", path: actualZipPath }).catch(() => {});
  _downloadBlob(blob, zipName);

  if (isDiff) await browser.storage.local.set({ lastExportedAt: exportedAt });
  log(`✅ ダウンロード開始: ${zipName}（${zipSizeMB} MB）`);
}

// GROUP-26-split (v1.30.0): Base64 chunk 配列から Blob を組み立てる
function _assembleBlobFromB64Chunks(chunksB64, mime) {
  const arrays = [];
  for (const b64 of chunksB64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    arrays.push(arr);
  }
  return new Blob(arrays, { type: mime || "application/octet-stream" });
}

// GROUP-26-split (v1.30.0): Blob をブラウザダウンロード
function _downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// GROUP-26-unzip (v1.30.0): .zip ファイルを JSZip で展開し、旧 JSON 形式と同構造の payload を組立てる
// 既存 importData の後続ロジック（_meta チェック／storage マージ／IDB サムネ復元）をそのまま流用可能にする
async function _parseZipImport(file, log, logError) {
  if (typeof JSZip === "undefined") {
    logError("JSZip 未ロード（vendor/jszip.min.js 読み込み失敗）");
    return null;
  }
  log("🗜 zip 展開中...");
  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (err) {
    logError(`zip 読込失敗: ${err?.message || String(err)}`);
    return null;
  }

  const manifestFile = zip.file("manifest.json");
  if (!manifestFile) {
    logError("manifest.json が zip 内に見つかりません（非対応 zip 形式）");
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(await manifestFile.async("string"));
  } catch (err) {
    logError(`manifest.json 解析失敗: ${err?.message || String(err)}`);
    return null;
  }
  log(`📋 manifest: formatVersion=${manifest.formatVersion} / ${manifest.files?.length || 0} ファイル`);

  if (manifest.formatVersion !== 1) {
    logError(`未対応フォーマット: formatVersion=${manifest.formatVersion}`);
    return null;
  }

  // settings.json
  let settings = {};
  const settingsFile = zip.file("settings.json");
  if (settingsFile) {
    try {
      settings = JSON.parse(await settingsFile.async("string"));
      log(`✅ settings.json 読込`);
    } catch (err) {
      logError(`settings.json 解析失敗: ${err?.message || String(err)}`);
      return null;
    }
  }

  // history-NNN.json を順次連結（manifest.files の順序を維持）
  const allHistory = [];
  const historyFiles = (manifest.files || []).filter(f => f.category === "history");
  for (const f of historyFiles) {
    const hf = zip.file(f.path);
    if (!hf) { log(`⚠️ ${f.path} が zip 内に見つかりません（スキップ）`); continue; }
    try {
      const items = JSON.parse(await hf.async("string"));
      if (Array.isArray(items)) allHistory.push(...items);
      log(`✏️ ${f.path} 読込（${items.length} 件）`);
    } catch (err) {
      logError(`${f.path} 解析失敗: ${err?.message || String(err)}`);
      return null;
    }
  }

  // thumbs-NNN.json を順次連結
  const allThumbs = [];
  const thumbsFiles = (manifest.files || []).filter(f => f.category === "thumbs");
  for (const f of thumbsFiles) {
    const tf = zip.file(f.path);
    if (!tf) { log(`⚠️ ${f.path} が zip 内に見つかりません（スキップ）`); continue; }
    try {
      const items = JSON.parse(await tf.async("string"));
      if (Array.isArray(items)) allThumbs.push(...items);
      log(`✏️ ${f.path} 読込（${items.length} 件）`);
    } catch (err) {
      logError(`${f.path} 解析失敗: ${err?.message || String(err)}`);
      return null;
    }
  }

  // 旧 JSON 形式と同構造の擬似 payload を組立てる
  const pseudoPayload = {
    _meta: {
      exportedAt: manifest.exportedAt,
      version:    manifest.borgestagVersion || "1.30.0",
      app:        manifest.app || "image-saver-tags",
      isDiff:     !!manifest.isDiff,
      diffBase:   manifest.diffBase || null,
    },
    ...settings,
    saveHistory: allHistory,
    _idbThumbs:  allThumbs,
  };
  log(`✅ zip 展開完了（history ${allHistory.length} 件、thumbs ${allThumbs.length} 件）`);
  return pseudoPayload;
}

// GROUP-26-split (v1.30.0): 旧 v1.29.2 までの単一 JSON エクスポート経路は廃止、
// 本ファイルの exportData は zip 形式のみを出力する。_downloadJson は旧 JSON のインポート互換
// （importData 経由）とは無関係なので削除可能。残したままでも呼び出し側がなく dead code。
// 互換性のため当面は関数のみ残す（next minor で削除検討）。
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
    // GROUP-26-unzip (v1.30.0): .zip は分割形式として JSZip で展開、.json は従来の単一 JSON
    if (file.name.toLowerCase().endsWith(".zip")) {
      parsed = await _parseZipImport(file, log, logError);
      if (!parsed) return; // エラーは helper 内で log 済
    } else {
      const text = await file.text();
      parsed = JSON.parse(text);
      log(`✅ JSON 解析成功`);
    }
  } catch (err) {
    logError(`解析失敗: ${err.message}`);
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
  // ---- hoverButtonsTempHidden ----（GROUP-2-a / v1.29.0）
  if (parsed.hoverButtonsTempHidden !== undefined) {
    try {
      await browser.storage.local.set({ hoverButtonsTempHidden: !!parsed.hoverButtonsTempHidden });
      log(`🙈 hoverButtonsTempHidden: ${!!parsed.hoverButtonsTempHidden}`);
    } catch (err) { logError(`hoverButtonsTempHidden の保存に失敗: ${err.message}`); return; }
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
  // ---- exportThumbsEnabled ----（GROUP-26-III / v1.29.1）
  if (parsed.exportThumbsEnabled !== undefined) {
    try {
      await browser.storage.local.set({ exportThumbsEnabled: !!parsed.exportThumbsEnabled });
      log(`🖼 exportThumbsEnabled: ${!!parsed.exportThumbsEnabled}`);
    } catch (err) { logError(`exportThumbsEnabled の保存に失敗: ${err.message}`); return; }
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

  // ---- saveHistory のマージ（id重複除去・savedAt 降順ソート） ----
  // v1.32.1 GROUP-29：従来は `[...newItems, ...existing]` で imported を先頭に置いていた
  // ため、手元に新しい履歴があり古い履歴を import すると古い方が前に来ていた。
  // savedAt 降順でソートして常に「新しい順＝先頭」に統一する。
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
      const merged = [...newItems, ...existing];
      // v1.32.1：savedAt 降順で並べ替え（新しい順＝先頭、savedAt なしは末尾）
      merged.sort((a, b) => {
        const ta = a && a.savedAt ? new Date(a.savedAt).getTime() : 0;
        const tb = b && b.savedAt ? new Date(b.savedAt).getTime() : 0;
        return tb - ta;
      });
      await browser.storage.local.set({ saveHistory: merged });
      log(`🗂 saveHistory: ${newItems.length} 件追加（合計 ${merged.length} 件、savedAt 降順でソート）`);
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
  setupExportThumbsOption();
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
// GROUP-26-III (v1.29.1): サムネ埋込オプション設定
// チェックボックス初期化＋ onChange 永続化＋ OFF で削減されるサイズ推定表示
// ----------------------------------------------------------------
async function setupExportThumbsOption() {
  const chk = document.getElementById("chk-export-thumbs");
  const hint = document.getElementById("export-thumbs-size-hint");
  if (!chk) return;
  const { exportThumbsEnabled } = await browser.storage.local.get("exportThumbsEnabled");
  chk.checked = exportThumbsEnabled !== false; // デフォルト ON（既存挙動維持）
  chk.addEventListener("change", async () => {
    await browser.storage.local.set({ exportThumbsEnabled: chk.checked });
  });
  // サイズ推定（非同期、UI ブロックせず）
  // 3000 件規模の IDB 走査は数秒かかる可能性があるため setTimeout で遅延実行
  if (hint) {
    setTimeout(async () => {
      try {
        const res = await browser.runtime.sendMessage({ type: "EXPORT_IDB_THUMBS" });
        if (res?.ok && Array.isArray(res.thumbs) && res.thumbs.length > 0) {
          const bytes = JSON.stringify(res.thumbs).length;
          const mb = (bytes / 1024 / 1024).toFixed(1);
          hint.textContent = `（${res.thumbs.length} 件、OFF で約 ${mb} MB 削減）`;
        }
      } catch (_) { /* サイズ推定失敗は非致命、hint 空のまま */ }
    }, 500);
  }
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
// 絞り込みチップ（v1.21.1 でチップ化）
// - 正規化方針：タグ・権利者ともに chips は lower-case 済みで保持
// - `_histFilterTag` / `_histAuthorFilter` は既存呼び出しコード向けの shadow（join 表示用）
//   ※権利者名にスペースを含むケースがあり join で壊れるため、フィルタ判定は必ず chips 配列側を参照する
let _histFilterTagChips    = [];
let _histFilterAuthorChips = [];
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

/**
 * 文字列正規化（v1.21.3）
 * サジェストのマッチで使用：
 * - NFKC で半角カナ→全角カナ・全角英数→半角英数を統一
 * - カタカナ → ひらがな（U+30A1〜U+30F6 を -0x60 シフト）
 * - 小文字化
 * これにより「アサ」「あさ」「ｱｻ」「Asa」「ＡＳＡ」が同一視される。
 */
function _normalizeForMatch(s) {
  if (!s) return "";
  let t = String(s).normalize("NFKC").toLowerCase();
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    // カタカナ U+30A1..U+30F6 → ひらがな U+3041..U+3096
    if (c >= 0x30a1 && c <= 0x30f6) {
      out += String.fromCharCode(c - 0x60);
    } else {
      out += t[i];
    }
  }
  return out;
}

/**
 * 履歴絞り込みチップ入力コントローラ（v1.21.1）
 * タグ絞り込み / 権利者絞り込みで共通利用。
 *
 * 挙動：
 * - Enter / カンマでチップ確定（スペース確定は commitOnSpace=true のときのみ有効）
 * - 入力欄フォーカス時・入力時に候補サジェストを表示（1文字目から発火、上限8件）
 * - サジェスト項目のクリックで即チップ化し、続けて選べるよう再表示
 * - ✕ボタン / Backspace（入力空のとき）でチップ削除
 * - クリアボタンで全チップ一括削除
 */
function _setupHistChipInput({
  wrapId, inputId, suggestId, clearBtnId,
  chipClass,        // "" or "author"
  commitOnSpace,    // bool
  getSuggestions,   // async () => string[]
  getChips,         // () => string[]
  setChips,         // (string[]) => void
}) {
  const wrap    = document.getElementById(wrapId);
  const input   = document.getElementById(inputId);
  const suggest = document.getElementById(suggestId);
  const clear   = document.getElementById(clearBtnId);
  if (!wrap || !input || !suggest) return;

  function renderChips() {
    Array.from(wrap.querySelectorAll(".hist-chip")).forEach(c => c.remove());
    const chips = getChips();
    chips.forEach(chip => {
      const span = document.createElement("span");
      span.className = "hist-chip" + (chipClass ? " " + chipClass : "");
      span.textContent = chip;
      const btn = document.createElement("button");
      btn.textContent = "×";
      btn.title = "削除";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        setChips(getChips().filter(c => c !== chip));
        renderChips();
      });
      span.appendChild(btn);
      wrap.insertBefore(span, input);
    });
    if (clear) clear.style.display = chips.length ? "" : "none";
  }

  function commitInput() {
    const raw = input.value.trim();
    if (!raw) return false;
    const normalized = raw.toLowerCase();
    const chips = getChips();
    if (!chips.includes(normalized)) {
      setChips([...chips, normalized]);
      renderChips();
    }
    input.value = "";
    hideSuggest();
    return true;
  }

  async function showSuggest() {
    const qRaw = input.value.trim();
    // v1.21.2: 未入力時はサジェスト非表示（従来は全件古い順 8 件を固定表示していたが意味が薄い）
    if (!qRaw) { hideSuggest(); return; }
    // v1.21.3: かな/カナ・半角/全角を無視して比較
    const qNorm = _normalizeForMatch(qRaw);
    const src = (await getSuggestions()) || [];
    const chips = getChips();
    // v1.21.2: 前方一致（startsWith）に変更。部分一致だと候補が広くなりすぎるため
    // v1.21.3: 比較は _normalizeForMatch を介して行う
    const matches = src
      .filter(v => _normalizeForMatch(v).startsWith(qNorm))
      .filter(v => !chips.includes(v.toLowerCase()))
      .slice(0, 8);
    if (!matches.length) { hideSuggest(); return; }
    suggest.innerHTML = matches.map(v =>
      `<div class="hist-sug-item" data-val="${escHtml(v)}">${escHtml(v)}</div>`
    ).join("");
    suggest.classList.add("visible");
    suggest.querySelectorAll(".hist-sug-item").forEach(el => {
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        input.value = el.dataset.val;
        commitInput();
        input.focus();
        showSuggest();  // 続けて選択できるよう再表示
      });
    });
  }

  function hideSuggest() {
    suggest.classList.remove("visible");
    suggest.innerHTML = "";
  }

  input.addEventListener("input", () => showSuggest());
  input.addEventListener("focus", () => {
    wrap.classList.add("focused");
    showSuggest();
  });
  input.addEventListener("blur", () => {
    wrap.classList.remove("focused");
    setTimeout(hideSuggest, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") {
      if (input.value.trim()) {
        e.preventDefault();
        commitInput();
      }
    } else if (e.key === " " && commitOnSpace) {
      if (input.value.trim()) {
        e.preventDefault();
        commitInput();
      }
    } else if (e.key === "Backspace" && !input.value) {
      const chips = getChips();
      if (chips.length) {
        setChips(chips.slice(0, -1));
        renderChips();
      }
    } else if (e.key === "Escape") {
      hideSuggest();
      input.blur();
    }
  });

  if (clear) {
    clear.addEventListener("click", () => {
      setChips([]);
      renderChips();
      input.focus();
    });
  }

  wrap.addEventListener("click", (e) => {
    if (e.target.closest(".hist-chip") || e.target.closest(".hist-chip-suggest")) return;
    input.focus();
  });

  // 初期描画
  renderChips();
}

function setupHistoryTab() {
  // 絞り込み入力（v1.21.1 でチップ化）
  const filterInput = document.getElementById("hist-filter");
  const filterClear = document.getElementById("hist-filter-clear");
  const selectAllBtn = document.getElementById("hist-select-all");

  function updateSelectAllBtn() {
    // 何らかの絞り込みが有効な場合のみ活性化
    selectAllBtn.disabled =
      _histFilterTagChips.length === 0 &&
      _histFilterAuthorChips.length === 0 &&
      !_histSourceFilter &&
      _histFormatFilter === "all" &&
      !_histFavFilter; // v1.37.0 GROUP-36-fav-filter
  }
  _updateSelectAllBtn = updateSelectAllBtn; // グローバル参照を更新

  const filterModeSelect = document.getElementById("hist-filter-mode");
  if (filterModeSelect) {
    filterModeSelect.addEventListener("change", () => {
      _histFilterMode = filterModeSelect.value;
      _histPage = 0;
      if (_histFilterTagChips.length || _histFilterAuthorChips.length) renderHistoryGrid();
    });
  }

  // タグ絞り込みチップ
  _setupHistChipInput({
    wrapId: "hist-filter-wrap",
    inputId: "hist-filter",
    suggestId: "hist-filter-suggest",
    clearBtnId: "hist-filter-clear",
    chipClass: "",
    commitOnSpace: true, // スペース区切りで即チップ化（v1.19.1 以前の仕様を踏襲）
    getSuggestions: async () => {
      const { globalTags } = await browser.storage.local.get("globalTags");
      return globalTags || [];
    },
    getChips: () => _histFilterTagChips,
    setChips: (chips) => {
      const prevLen = _histFilterTagChips.length;
      _histFilterTagChips = chips;
      _histFilterTag = chips.join(" "); // shadow（表示互換のため保持、判定には使わない）
      _histPage = 0;
      updateSelectAllBtn();
      if (prevLen === 0 && chips.length > 0) {
        const grid = document.getElementById("hist-grid");
        _histScrollPos = grid?.scrollTop ?? 0;
      }
      renderHistoryGrid();
    },
  });

  // 権利者絞り込みチップ
  _setupHistChipInput({
    wrapId: "hist-author-filter-wrap",
    inputId: "hist-author-filter",
    suggestId: "hist-author-filter-suggest",
    clearBtnId: "hist-author-filter-clear",
    chipClass: "author",
    commitOnSpace: false, // 権利者名はスペースを含むことがあるため、スペース確定を無効化
    getSuggestions: async () => {
      const { globalAuthors } = await browser.storage.local.get("globalAuthors");
      return globalAuthors || [];
    },
    getChips: () => _histFilterAuthorChips,
    setChips: (chips) => {
      _histFilterAuthorChips = chips;
      _histAuthorFilter = chips.join(" "); // shadow（表示互換のため保持）
      _histPage = 0;
      updateSelectAllBtn();
      renderHistoryGrid();
    },
  });

  // 互換：既存の filterClear は setupHistChipInput 側でバインド済み
  void filterInput; void filterClear;

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
    // v1.33.2：updateSelectAllBtn の 4 種フィルタ判定と条件を揃える（形式フィルタ漏れを修正）
    if (
      _histFilterTagChips.length === 0 &&
      _histFilterAuthorChips.length === 0 &&
      !_histSourceFilter &&
      _histFormatFilter === "all" &&
      !_histFavFilter
    ) return;
    const filtered = _historyData.filter(e => _entryMatchesCurrentFilter(e));
    filtered.forEach(e => _histSelected.add(e.id));
    document.getElementById("hist-deselect-all").disabled = _histSelected.size === 0;
    document.getElementById("hist-delete-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-add-tag-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-add-author-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-replace-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-remove-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-group-selected").disabled = _histSelected.size < 2;
    document.getElementById("hist-ungroup-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-sync-global-tags").disabled = _histSelected.size === 0;
    _updateAudioToggleSelectedBtn();
    _updateFavBulkButtons();
    renderHistoryGrid();
  });

  // v1.37.0 GROUP-38：処理中モーダル（一括操作中の二重押下防止＋進行表示）
  // v1.38.0：お気に入り画像プレビュー＋完了状態対応（Q-ux-2 / Q-ux-B）
  // v1.38.1：完了時の auto-close を削除（Q-ux-B「画像を表示中なので閉じる操作はユーザーに任せる」要件）
  //
  // ライフサイクル：
  //   showBusyModal(msg, sub)  → 表示開始（spinner＋お気に入りプレビュー）
  //   completeBusyModal(doneMsg) → 「✅ 完了」へ遷移、閉じるボタン表示。**閉じるのはユーザー操作のみ**
  //   hideBusyModal()           → 完了状態なら no-op、それ以外は即時非表示（エラー経路向け）
  //
  // 標準パターン（処理ハンドラ）：
  //   showBusyModal("処理中…", `${n} 件`);
  //   try {
  //     // ... 重い処理
  //     completeBusyModal("完了");
  //   } finally { hideBusyModal(); }   // 完了済なら no-op、エラーなら即閉じ
  let _busyState = "hidden"; // hidden / busy / done
  let _busyPreviewToken = 0; // 古いプレビュー fetch を破棄するためのトークン

  // v1.38.0：お気に入りからランダム 1 件選び、なければ全保存履歴からランダム。サムネ取得＋プレビュー表示
  // v1.39.0 GROUP-40-caption：表示画像のソース（favorite or 全保存履歴）に応じてキャプションも切替
  async function _loadBusyPreview(token) {
    try {
      const list = (_historyData || []).filter(e => e?.thumbId);
      if (list.length === 0) return;
      const favs = list.filter(e => !!e.favorite);
      const isFavSource = favs.length > 0;
      const pool = isFavSource ? favs : list;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      const r = await browser.runtime.sendMessage({ type: "GET_THUMB_DATA_URL", thumbId: pick.thumbId });
      // この間に showBusyModal が再度呼ばれていれば、古いトークンは破棄
      if (token !== _busyPreviewToken) return;
      if (_busyState !== "busy" && _busyState !== "done") return;
      if (r?.dataUrl) {
        const img = document.getElementById("busy-modal-preview");
        const caption = document.getElementById("busy-modal-caption");
        if (img) {
          img.src = r.dataUrl;
          img.style.display = "block";
        }
        if (caption) {
          caption.textContent = isFavSource
            ? "処理待ちの間お気に入りからランダムに表示しています"
            : "処理待ちの間ランダムな画像を表示しています";
          caption.style.display = "block";
        }
      }
    } catch (_) { /* プレビュー失敗は致命的ではないので握りつぶす */ }
  }

  function showBusyModal(message, sub) {
    const overlay = document.getElementById("busy-modal-overlay");
    if (!overlay) return;
    // v1.38.1：完了状態が残っているなら強制クリア（連続発火時に古いモーダルが居座らないよう）
    _busyForceHide();
    _busyState = "busy";
    const token = ++_busyPreviewToken;
    // 各要素の状態リセット
    const msg = document.getElementById("busy-modal-message");
    const subEl = document.getElementById("busy-modal-sub");
    const spinner = document.getElementById("busy-modal-spinner");
    const icon = document.getElementById("busy-modal-icon");
    const closeBtn = document.getElementById("busy-modal-close");
    const preview = document.getElementById("busy-modal-preview");
    const caption = document.getElementById("busy-modal-caption");
    if (msg) msg.textContent = message || "処理中…";
    if (subEl) subEl.textContent = sub || "";
    // v1.39.0 GROUP-40-spinner-inline：スピナーは flex item として inline 表示
    if (spinner) spinner.style.display = "block";
    if (icon) icon.style.display = "none";
    if (closeBtn) closeBtn.style.display = "none";
    if (preview) { preview.style.display = "none"; preview.removeAttribute("src"); }
    if (caption) { caption.style.display = "none"; caption.textContent = ""; }
    overlay.dataset.shown = "1";
    overlay.style.display = "flex";
    // プレビュー画像取得は非同期で進行
    _loadBusyPreview(token);
  }

  // v1.38.1：完了時はプレビュー画像を眺める時間を確保するため auto-close せず、
  // ユーザーが閉じるボタンを押すまで残す（Q-ux-B 本来要件）
  // v1.39.0 GROUP-40：スピナーが居た位置で ✅ アイコンに置換、閉じるボタンは同じ行の右へ。
  // doneMessage には ✅ を含めない（インライン icon と二重になるため）
  function completeBusyModal(doneMessage) {
    if (_busyState === "hidden") return; // showBusyModal なしで呼ばれた場合は無視
    _busyState = "done";
    const msg = document.getElementById("busy-modal-message");
    const subEl = document.getElementById("busy-modal-sub");
    const spinner = document.getElementById("busy-modal-spinner");
    const icon = document.getElementById("busy-modal-icon");
    const closeBtn = document.getElementById("busy-modal-close");
    if (spinner) spinner.style.display = "none";
    if (icon) icon.style.display = "block";
    if (msg) msg.textContent = doneMessage || "完了";
    if (subEl) subEl.textContent = "";
    if (closeBtn) {
      closeBtn.style.display = "inline-block";
      closeBtn.onclick = () => { _busyForceHide(); };
    }
  }

  function _busyForceHide() {
    const overlay = document.getElementById("busy-modal-overlay");
    if (!overlay) return;
    _busyState = "hidden";
    overlay.dataset.shown = "0";
    overlay.style.display = "none";
  }

  function hideBusyModal() {
    // 完了状態なら閉じる責務を auto-close / 閉じるボタンに委譲（no-op）
    if (_busyState === "done") return;
    _busyForceHide();
  }

  // v1.35.0 GROUP-35-perf-B：選択クリア＋一括ボタン無効化を一箇所に集約。
  // グループ化／解除でも再利用、renderHistoryGrid を経由しない軽量経路を提供。
  function _clearSelectionAndDisableBulkButtons() {
    document.querySelectorAll(".hist-card.selected").forEach(card => {
      card.classList.remove("selected");
      const cb = card.querySelector(".hist-select-box");
      if (cb) cb.checked = false;
    });
    const ids = [
      "hist-deselect-all", "hist-add-tag-selected", "hist-add-author-selected",
      "hist-replace-selected", "hist-remove-selected", "hist-sync-global-tags",
      "hist-group-selected", "hist-ungroup-selected", "hist-delete-selected",
      "hist-fav-add-selected", "hist-fav-remove-selected",
    ];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    }
    _updateAudioToggleSelectedBtn();
  }

  // 選択削除
  document.getElementById("hist-deselect-all").addEventListener("click", () => {
    _histSelected.clear();
    _clearSelectionAndDisableBulkButtons();
    // 選択チェックボックスのみ整合させればよく、カード DOM 再生成は不要
  });

  // v1.33.0 GROUP-32-b：選択した履歴の音声を一括 ON/OFF
  document.getElementById("hist-audio-toggle-selected").addEventListener("click", async () => {
    await _toggleAudioSelected();
  });

  // v1.37.0 GROUP-36-fav-bulk：選択した履歴を一括でお気に入り追加
  document.getElementById("hist-fav-add-selected").addEventListener("click", async () => {
    if (!_histSelected.size) return;
    const ids = [..._histSelected];
    showBusyModal("お気に入り追加中…", `${ids.length} 件`);
    try {
      const changed = await _setBulkFavorite(ids, true);
      showStatus(`${changed} 件をお気に入りに追加しました`);
      completeBusyModal(`${changed} 件をお気に入りに追加しました`);
    } finally { hideBusyModal(); }
  });

  // v1.37.0 GROUP-36-fav-bulk：選択した履歴のお気に入りを一括解除
  document.getElementById("hist-fav-remove-selected").addEventListener("click", async () => {
    if (!_histSelected.size) return;
    const ids = [..._histSelected];
    showBusyModal("お気に入り解除中…", `${ids.length} 件`);
    try {
      const changed = await _setBulkFavorite(ids, false);
      showStatus(`${changed} 件のお気に入りを解除しました`);
      completeBusyModal(`${changed} 件のお気に入りを解除しました`);
    } finally { hideBusyModal(); }
  });

  document.getElementById("hist-delete-selected").addEventListener("click", async () => {
    if (!_histSelected.size) return;
    const n = _histSelected.size;
    if (!confirm(`選択した ${n} 件を削除しますか？`)) return;
    showBusyModal("削除中…", `${n} 件`);
    try {
      const stored = await browser.storage.local.get("saveHistory");
      const history = (stored.saveHistory || []).filter(e => !_histSelected.has(e.id));
      await browser.storage.local.set({ saveHistory: history });
      _histSelected.clear();
      await renderHistoryTab();
      completeBusyModal(`${n} 件削除しました`);
    } finally { hideBusyModal(); }
  });

  // 全件削除
  // 連続保存グループ化
  // v1.35.0 GROUP-35-perf-B：表示モード判定のヘルパー
  function _isHistoryGroupMode() {
    const r = document.querySelector('input[name="history-display-mode"]:checked');
    return r ? r.value === "group" : false;
  }

  document.getElementById("hist-ungroup-selected").addEventListener("click", async () => {
    if (_histSelected.size < 1) return;
    const ids = [..._histSelected];
    // v1.37.0 GROUP-38：処理中モーダル＋先行で選択を視覚クリア
    showBusyModal("グループ解除中…", `${ids.length} 件`);
    try {
      const stored = await browser.storage.local.get("saveHistory");
      const history = stored.saveHistory || [];
      // 選択エントリのみを個別解除（他のメンバーはグループのまま残る）
      const targets = history.filter(e => ids.includes(e.id) && e.sessionId);
      if (targets.length === 0) { showStatus("グループに属する履歴が選択されていません", true); return; }

      // v1.36.0 GROUP-35-perf-B-2：差分更新で参照する旧 sessionId を取得（更新前に確保）
      const prevSessionIds = targets.map(e => e.sessionId);
      const targetIds = targets.map(e => e.id);

      targets.forEach(entry => {
        entry.sessionId    = null;
        entry.sessionIndex = null;
      });

      await browser.storage.local.set({ saveHistory: history });
      _historyData = history;
      _histSelected.clear();
      // v1.35.0 GROUP-35-perf-B：通常表示モードはカード描画に影響しないので軽量更新
      // v1.36.0 GROUP-35-perf-B-2：グループ表示モードでも差分更新で再構築範囲を限定
      if (_isHistoryGroupMode()) {
        _partialRefreshGroupedDom(targetIds, prevSessionIds);
        _clearSelectionAndDisableBulkButtons();
      } else {
        _clearSelectionAndDisableBulkButtons();
      }
      showStatus(`${targets.length} 件をグループから解除しました`);
      completeBusyModal(`${targets.length} 件解除しました`);
    } finally {
      hideBusyModal();
    }
  });


  document.getElementById("hist-group-selected").addEventListener("click", async () => {
    if (_histSelected.size < 2) return;
    const ids = [..._histSelected];
    if (!confirm(`選択した ${ids.length} 件を連続保存グループにまとめますか？\n新しいセッションIDが付与されます。`)) return;

    // v1.37.0 GROUP-38：処理中モーダル
    showBusyModal("グループ化中…", `${ids.length} 件`);
    try {
      const stored = await browser.storage.local.get("saveHistory");
      const history = stored.saveHistory || [];
      const newSessionId = crypto.randomUUID();

      const targets = history
        .filter(e => ids.includes(e.id))
        .sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt));

      // v1.36.0 GROUP-35-perf-B-2：差分更新で参照する旧 sessionId を取得（更新前に確保）
      const prevSessionIds = targets.map(e => e.sessionId).filter(Boolean);
      const targetIds = targets.map(e => e.id);

      targets.forEach((entry, i) => {
        entry.sessionId    = newSessionId;
        entry.sessionIndex = i + 1;
      });

      await browser.storage.local.set({ saveHistory: history });
      _historyData = history;
      _histSelected.clear();
      // v1.35.0 GROUP-35-perf-B：通常表示モードはカード描画に影響しないので軽量更新
      // v1.36.0 GROUP-35-perf-B-2：グループ表示モードでも差分更新で再構築範囲を限定
      if (_isHistoryGroupMode()) {
        _partialRefreshGroupedDom(targetIds, prevSessionIds);
        _clearSelectionAndDisableBulkButtons();
      } else {
        _clearSelectionAndDisableBulkButtons();
      }
      showStatus(`${targets.length} 件をグループ化しました`);
      completeBusyModal(`${targets.length} 件グループ化しました`);
    } finally {
      hideBusyModal();
    }
  });

  // 一括タグ追加
  document.getElementById("hist-add-tag-selected").addEventListener("click", () => {
    if (!_histSelected.size) return;
    const ids = [..._histSelected];
    // 選択エントリの共通タグをデフォルト表示（最初のエントリのタグを参考に）
    const firstEntry = _historyData.find(e => _histSelected.has(e.id));
    showAddTagDialog(ids, firstEntry?.tags || []);
  });

  // 一括権利者追加
  document.getElementById("hist-add-author-selected").addEventListener("click", () => {
    if (!_histSelected.size) return;
    showAddAuthorDialog([..._histSelected]);
  });

  // v1.34.0 GROUP-3-b：一括置換
  document.getElementById("hist-replace-selected").addEventListener("click", () => {
    if (!_histSelected.size) return;
    showReplaceRemoveDialog([..._histSelected], "replace");
  });

  // v1.34.0 GROUP-3-b：一括除去
  document.getElementById("hist-remove-selected").addEventListener("click", () => {
    if (!_histSelected.size) return;
    showReplaceRemoveDialog([..._histSelected], "remove");
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
        // 1文字入力でもサジェストを表示する（以前は 2 文字以上で発火）
        if (!matches.length) { suggestBox.style.display = "none"; return; }
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

      // v1.37.0 GROUP-38：処理中モーダル
      showBusyModal("タグ追加中…", `${targetIds.length} 件`);
      try {
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
          for (const id of targetIds) _refreshHistCardByEntryId(id);
          _updateHistCount();
          showStatus(`タグを ${pendingTags.size} 件追加しました`);
        }
        completeBusyModal(`タグ ${pendingTags.size} 件追加しました`);
      } finally {
        hideBusyModal();
      }
    });

    overlay.querySelector(".pd-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
    setTimeout(() => input.focus(), 50);
  }

  /**
   * 権利者追加ダイアログ
   * @param {string[]} targetIds 対象エントリのID配列
   */
  function showAddAuthorDialog(targetIds) {
    const existing = document.querySelector(".add-author-dialog-overlay");
    if (existing) existing.remove();

    const isBulk = targetIds.length > 1;
    const overlay = document.createElement("div");
    overlay.className = "add-author-dialog-overlay period-dialog-overlay";
    overlay.innerHTML = `
      <div class="period-dialog" style="max-width:380px">
        <h3>✏️ 権利者を追加${isBulk ? `（${targetIds.length}件）` : ""}</h3>
        ${isBulk ? `<div style="font-size:12px;color:#888;margin-bottom:10px">選択した全履歴に同じ権利者を追加します</div>` : ""}
        <div style="margin-bottom:14px">
          <div style="font-size:12px;color:#555;margin-bottom:6px">追加する権利者名（カンマ・Enterで区切り）</div>
          <div style="border:1px solid #ccc;border-radius:6px;padding:6px 8px;min-height:36px;
            display:flex;flex-wrap:wrap;gap:4px;align-items:center;cursor:text" id="aad-chip-area">
            <input id="aad-input" type="text" autocomplete="off"
              style="border:none;outline:none;font-size:13px;min-width:80px;flex:1;font-family:inherit"
              placeholder="権利者名を入力…" />
          </div>
          <div id="aad-suggestions" style="border:1px solid #e0e0e0;border-radius:6px;background:#fff;
            max-height:100px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,.1);display:none;margin-top:2px"></div>
        </div>
        <div class="pd-footer">
          <button class="pd-cancel">キャンセル</button>
          <button class="aad-ok pd-ok" style="background:#4a90e2" disabled>追加する</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const chipArea   = overlay.querySelector("#aad-chip-area");
    const input      = overlay.querySelector("#aad-input");
    const suggestBox = overlay.querySelector("#aad-suggestions");
    const okBtn      = overlay.querySelector(".aad-ok");
    const pendingAuthors = new Set();

    // globalAuthorsを取得してサジェストに使用
    browser.storage.local.get("globalAuthors").then(({ globalAuthors }) => {
      const allAuthors = globalAuthors || [];

      function updateSuggest(q) {
        const matches = allAuthors.filter(a =>
          a.toLowerCase().includes(q.toLowerCase()) && !pendingAuthors.has(a)
        );
        // 1文字入力でもサジェストを表示する（以前は 2 文字以上で発火）
        if (!matches.length) { suggestBox.style.display = "none"; return; }
        suggestBox.innerHTML = matches.slice(0, 8)
          .map(a => `<div class="aad-sug" style="padding:6px 10px;cursor:pointer;font-size:13px"
            data-author="${escHtml(a)}">${escHtml(a)}</div>`).join("");
        suggestBox.style.display = "";
        suggestBox.querySelectorAll(".aad-sug").forEach(el => {
          el.addEventListener("mousedown", (e) => { e.preventDefault(); addChip(el.dataset.author); });
          el.addEventListener("mouseover", () => el.style.background = "#f0f4ff");
          el.addEventListener("mouseout",  () => el.style.background = "");
        });
      }

      function addChip(author) {
        author = author.trim();
        if (!author || pendingAuthors.has(author)) return;
        pendingAuthors.add(author);
        const chip = document.createElement("span");
        chip.style.cssText = "background:#e8f5e9;border:1px solid #4caf50;border-radius:12px;padding:2px 8px;font-size:12px;display:flex;align-items:center;gap:4px;";
        chip.innerHTML = `${escHtml(author)}<button style="background:none;border:none;cursor:pointer;color:#4caf50;font-size:13px;padding:0;line-height:1">×</button>`;
        chip.querySelector("button").addEventListener("click", () => { chip.remove(); pendingAuthors.delete(author); okBtn.disabled = pendingAuthors.size === 0; });
        chipArea.insertBefore(chip, input);
        input.value = "";
        suggestBox.style.display = "none";
        okBtn.disabled = false;
      }

      input.addEventListener("input", () => updateSuggest(input.value));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === ",") {
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
      if (!pendingAuthors.size) return;
      overlay.remove();

      // v1.37.0 GROUP-38：処理中モーダル
      showBusyModal("権利者追加中…", `${targetIds.length} 件`);
      try {
        const stored = await browser.storage.local.get("saveHistory");
        const history = stored.saveHistory || [];
        let changed = false;
        for (const entry of history) {
          if (!targetIds.includes(entry.id)) continue;
          const current = new Set(getEntryAuthors(entry));
          for (const a of pendingAuthors) {
            if (!current.has(a)) { current.add(a); changed = true; }
          }
          entry.authors = [...current];
          delete entry.author; // 旧形式フィールドを削除
        }
        if (changed) {
          await browser.storage.local.set({ saveHistory: history });
          // globalAuthorsにも追加
          const { globalAuthors } = await browser.storage.local.get("globalAuthors");
          const gSet = new Set(globalAuthors || []);
          for (const a of pendingAuthors) gSet.add(a);
          await browser.storage.local.set({ globalAuthors: [...gSet] });
          _historyData = history;
          for (const id of targetIds) _refreshHistCardByEntryId(id);
          _updateHistCount();
          showStatus(`権利者を ${pendingAuthors.size} 件追加しました`);
        }
        completeBusyModal(`権利者 ${pendingAuthors.size} 件追加しました`);
      } finally {
        hideBusyModal();
      }
    });

    overlay.querySelector(".pd-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
    setTimeout(() => input.focus(), 50);
  }

  /**
   * v1.34.0 GROUP-3-b：置換／除去共用モーダル
   * @param {string[]} targetIds 対象エントリのID配列
   * @param {"replace"|"remove"} mode
   */
  function showReplaceRemoveDialog(targetIds, mode) {
    const existing = document.querySelector(".replace-remove-dialog-overlay");
    if (existing) existing.remove();

    // 選択エントリの tags ∪ authors を収集（実在値のみ）
    const targetSet = new Set(targetIds);
    const entries = _historyData.filter(e => targetSet.has(e.id));
    const tagSet = new Set();
    const authorSet = new Set();
    for (const e of entries) {
      for (const t of e.tags || []) tagSet.add(t);
      for (const a of getEntryAuthors(e)) authorSet.add(a);
    }
    // "kind:value" 形式で一意化（同じ値がタグ・権利者双方に実在しても両方見せる）
    const options = [];
    for (const t of [...tagSet].sort((a, b) => a.localeCompare(b))) options.push({ kind: "tag", value: t });
    for (const a of [...authorSet].sort((a, b) => a.localeCompare(b))) options.push({ kind: "author", value: a });

    const isReplace = mode === "replace";
    const title = isReplace ? "🔁 置換" : "➖ 除去";
    const action = isReplace ? "置換する" : "除去する";
    const overlay = document.createElement("div");
    overlay.className = "replace-remove-dialog-overlay period-dialog-overlay";
    overlay.innerHTML = `
      <div class="period-dialog" style="max-width:440px">
        <h3>${title}${targetIds.length > 1 ? `（${targetIds.length} 件）` : ""}</h3>
        <div style="font-size:12px;color:#888;margin-bottom:10px">
          選択エントリに実在するタグ・権利者から対象値を選んでください（完全一致で${isReplace ? "置換" : "除去"}）。
        </div>
        <div style="margin-bottom:14px">
          <div style="font-size:12px;color:#555;margin-bottom:6px">対象値</div>
          <select id="rrd-source" style="width:100%;padding:6px 8px;font-size:13px;border:1px solid #ccc;border-radius:6px;font-family:inherit">
            <option value="">（選択してください）</option>
            ${options.map((o, i) => {
              const label = `${o.kind === "tag" ? "🏷" : "✏️"} ${escHtml(o.value)}`;
              // v1.34.1 hotfix：HTML 属性値の NUL は parser で U+FFFD に置換される仕様のため、
              // 従来の kind\0value 形式では分離不能だった。index 参照方式に変更（options 配列をクロージャ経由で参照）。
              return `<option value="${i}">${label}</option>`;
            }).join("")}
          </select>
          ${options.length === 0 ? `<div style="font-size:12px;color:#c0392b;margin-top:6px">選択エントリにタグ・権利者がありません。</div>` : ""}
        </div>
        ${isReplace ? `
        <div style="margin-bottom:14px">
          <div style="font-size:12px;color:#555;margin-bottom:6px">置換後の値</div>
          <input id="rrd-target" type="text" autocomplete="off" placeholder="置換後の値を入力…"
            style="width:100%;padding:6px 8px;font-size:13px;border:1px solid #ccc;border-radius:6px;outline:none;font-family:inherit" />
        </div>` : ""}
        <div class="pd-footer">
          <button class="pd-cancel">キャンセル</button>
          <button class="rrd-ok pd-ok" style="background:${isReplace ? "#4a90e2" : "#c0392b"}" disabled>${action}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const sourceSel = overlay.querySelector("#rrd-source");
    const targetInput = overlay.querySelector("#rrd-target");
    const okBtn = overlay.querySelector(".rrd-ok");

    function updateOkState() {
      const hasSource = !!sourceSel.value;
      if (!isReplace) { okBtn.disabled = !hasSource; return; }
      const newVal = (targetInput?.value || "").trim();
      okBtn.disabled = !(hasSource && newVal);
    }
    sourceSel.addEventListener("change", updateOkState);
    if (targetInput) targetInput.addEventListener("input", updateOkState);

    okBtn.addEventListener("click", async () => {
      const raw = sourceSel.value;
      if (!raw) return;
      const idx = parseInt(raw, 10);
      const selected = options[idx];
      if (!selected) return;
      const kind = selected.kind;
      const oldVal = selected.value;
      const newValRaw = isReplace ? (targetInput.value || "").trim() : "";
      if (isReplace && !newValRaw) return;

      // 除去時：全タグ／全権利者が空になるエントリがあるか事前チェック
      if (!isReplace) {
        const wouldEmpty = [];
        for (const e of entries) {
          if (kind === "tag") {
            const curTags = (e.tags || []).filter(t => t !== oldVal);
            if ((e.tags || []).includes(oldVal) && curTags.length === 0) wouldEmpty.push(e);
          } else {
            const curAuthors = getEntryAuthors(e).filter(a => a !== oldVal);
            if (getEntryAuthors(e).includes(oldVal) && curAuthors.length === 0) wouldEmpty.push(e);
          }
        }
        if (wouldEmpty.length > 0) {
          const label = kind === "tag" ? "タグ" : "権利者";
          const ok = confirm(`除去すると ${wouldEmpty.length} 件のエントリで${label}が空になります。続行しますか？`);
          if (!ok) return;
        }
      }

      overlay.remove();

      // v1.37.0 GROUP-38：処理中モーダル
      const verbLabel = isReplace ? "置換" : "除去";
      showBusyModal(`${verbLabel}中…`, `${targetIds.length} 件`);
      try {
        const stored = await browser.storage.local.get("saveHistory");
        const history = stored.saveHistory || [];
        let processed = 0;
        for (const entry of history) {
          if (!targetSet.has(entry.id)) continue;
          if (kind === "tag") {
            const tags = entry.tags || [];
            if (!tags.includes(oldVal)) continue;
            if (isReplace) {
              const set = new Set(tags.map(t => (t === oldVal ? newValRaw : t)));
              entry.tags = [...set];
            } else {
              entry.tags = tags.filter(t => t !== oldVal);
            }
            processed++;
          } else {
            const authors = getEntryAuthors(entry);
            if (!authors.includes(oldVal)) continue;
            if (isReplace) {
              const set = new Set(authors.map(a => (a === oldVal ? newValRaw : a)));
              entry.authors = [...set];
            } else {
              entry.authors = authors.filter(a => a !== oldVal);
            }
            delete entry.author;
            processed++;
          }
        }

        if (processed > 0) {
          await browser.storage.local.set({ saveHistory: history });
          // グローバルカタログにも反映（置換時のみ、新値を追加）
          if (isReplace) {
            const key = kind === "tag" ? "globalTags" : "globalAuthors";
            const { [key]: g } = await browser.storage.local.get(key);
            const gSet = new Set(g || []);
            gSet.add(newValRaw);
            await browser.storage.local.set({ [key]: [...gSet] });
          }
          _historyData = history;
          for (const id of targetIds) _refreshHistCardByEntryId(id);
          _updateHistCount();
        }
        const label = kind === "tag" ? "タグ" : "権利者";
        showStatus(`${processed} 件の${label}を${verbLabel}しました`);
        completeBusyModal(`${processed} 件の${label}を${verbLabel}しました`);
      } finally {
        hideBusyModal();
      }
    });

    overlay.querySelector(".pd-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });
    setTimeout(() => sourceSel.focus(), 50);
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

  // 作者フィルター（v1.21.1 でチップ化。バインドは _setupHistChipInput 側）

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

  // v1.32.2：形式フィルター（GIF のみ → プルダウン化、音声付き追加）
  document.getElementById("hist-format-filter")?.addEventListener("change", (e) => {
    _histFormatFilter = e.target.value || "all";
    _histPage = 0;
    updateSelectAllBtn();
    renderHistoryGrid();
  });

  // v1.37.0 GROUP-36-fav-filter：お気に入りのみ表示する独立トグル
  document.getElementById("hist-fav-filter-toggle")?.addEventListener("click", (e) => {
    _histFavFilter = !_histFavFilter;
    const btn = e.currentTarget;
    btn.setAttribute("aria-pressed", _histFavFilter ? "true" : "false");
    btn.textContent = _histFavFilter ? "❤️ お気に入りのみ" : "🤍 お気に入りのみ";
    btn.style.background = _histFavFilter ? "rgba(220,40,80,0.85)" : "#fff";
    btn.style.color      = _histFavFilter ? "#fff" : "#444";
    btn.style.borderColor = _histFavFilter ? "rgba(220,40,80,0.85)" : "#dde";
    _histPage = 0;
    updateSelectAllBtn();
    renderHistoryGrid();
  });

  // タグ・保存先反映ボタン
  // - タグ・サブタグを globalTags に追加
  // - メインタグの保存先を tagDestinations に追記（サブタグは除外）
  document.getElementById("hist-sync-global-tags").addEventListener("click", async () => {
    if (!_histSelected.size) return;
    showBusyModal("タグ・保存先 反映中…", `${_histSelected.size} 件`);
    try {
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
        completeBusyModal("反映済み（新規追加なし）");
        return;
      }

      await browser.storage.local.set({ globalTags: newGlobalTags, tagDestinations });
      globalTags = newGlobalTags;

      const parts = [];
      if (newGlobalTagsList.length > 0) parts.push(`新規タグ: ${newGlobalTagsList.length} 件`);
      if (destAddCount > 0) parts.push(`保存先: ${destAddCount} 件`);
      showStatus(`✅ 反映しました（${parts.join("、")}）`);
      renderAll();
      completeBusyModal(`反映完了（${parts.join("、")}）`);
    } finally {
      hideBusyModal();
    }
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
  // v1.40.0 GROUP-43 Phase 2：DOM 破棄前に GIF Worker セッションをクリーンアップ
  _destroyGifSessionsInTree(grid);
  grid.innerHTML = "";

  const hasTagFilter    = _histFilterTagChips.length > 0;
  const hasAuthorFilter = _histFilterAuthorChips.length > 0;
  const hasSourceFilter = !!_histSourceFilter;
  const hasFormatFilter = _histFormatFilter !== "all";
  const hasFavFilter    = _histFavFilter; // v1.37.0 GROUP-36-fav-filter

  const filtered = (hasTagFilter || hasAuthorFilter || hasSourceFilter || hasFormatFilter || hasFavFilter)
    ? _historyData.filter(e => _entryMatchesCurrentFilter(e))
    : _historyData;

  // 絞り込み結果をライトボックスのグローバルナビ用に保持
  _currentFilteredHistory = (hasTagFilter || hasAuthorFilter || hasSourceFilter || hasFormatFilter || hasFavFilter) ? filtered : null;

  const isFiltering = hasTagFilter || hasAuthorFilter || hasSourceFilter || hasFormatFilter || hasFavFilter;
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
    document.getElementById("hist-add-author-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-replace-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-remove-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-sync-global-tags").disabled = _histSelected.size === 0;
    document.getElementById("hist-group-selected").disabled = _histSelected.size < 2;
    document.getElementById("hist-ungroup-selected").disabled = _histSelected.size === 0;
    _updateAudioToggleSelectedBtn();
    _updateFavBulkButtons();
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
  document.getElementById("hist-replace-selected").disabled = _histSelected.size === 0;
  document.getElementById("hist-remove-selected").disabled = _histSelected.size === 0;
  document.getElementById("hist-sync-global-tags").disabled = _histSelected.size === 0;
  document.getElementById("hist-group-selected").disabled = _histSelected.size < 2;
  document.getElementById("hist-ungroup-selected").disabled = _histSelected.size === 0;
  _updateAudioToggleSelectedBtn();
  _updateFavBulkButtons();
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
// v1.36.0 GROUP-35-perf-B-2：page slice からグループを計算する純粋関数
function _computeHistoryGroups(entries) {
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
  return groups;
}

// v1.36.0 GROUP-35-perf-B-2：単独カードを生成（renderHistoryGrid 通常モード／グループ表示の単独カード共通）
function _buildSingleHistCard(entry) {
  const card = document.createElement("div");
  card.className = "hist-card" + (_histSelected.has(entry.id) ? " selected" : "");
  _buildHistCardInner(card, entry);
  return card;
}

function renderHistoryGridGrouped(grid, entries) {
  const groups = _computeHistoryGroups(entries);

  for (const group of groups) {
    if (!group.sessionId || group.items.length === 1) {
      // 通常カード（セッションなし or 1件のみ）
      grid.appendChild(_buildSingleHistCard(group.items[0]));
    } else {
      // グループカード
      grid.appendChild(_buildGroupWrapperElement(group));
    }
  }
}

// v1.36.0 GROUP-35-perf-B-2：グループ wrapper を独立 helper として抽出
// （差分更新 _partialRefreshGroupedDom から再利用するため）
function _buildGroupWrapperElement(group) {
  const first = group.items.at(-1); // 最初に保存した画像（unshiftで末尾が古い）
  const paths = Array.isArray(first.savePaths) ? first.savePaths : (first.savePath ? [first.savePath] : []);
  const primary = paths[0] ?? "";
  const date  = new Date(first.savedAt).toLocaleString("ja-JP");
  const tagHtml = (first.tags || [])
    .map(t => `<span class="hist-card-tag" data-tag="${escHtml(t)}">${escHtml(t)}</span>`).join("");

  // ラッパー（overflow: visible で展開エリアを外に出す）
  const wrapper = document.createElement("div");
  wrapper.className = "hist-group-wrapper";
  wrapper.dataset.sessionId = group.sessionId;
  wrapper.dataset.groupEntryIds = "|" + group.items.map(i => i.id).join("|") + "|";
  wrapper.style.cssText = "display:flex;flex-direction:column;gap:0;flex-shrink:0;width:220px;align-self:flex-start;";

  // 先頭カード（通常カードと同サイズ）
  const card = document.createElement("div");
  card.className = "hist-card hist-card-group";
  card.dataset.representativeId = first.id;
  card.style.cssText = "border-color:#e67e22;position:relative;width:220px;height:360px;";

  // 枚数バッジ
  const badge = document.createElement("div");
  badge.className = "hist-group-badge";
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

  // 展開エリア（スクロール可能な横並び、後続クリック時に内容を構築）
  const expandArea = document.createElement("div");
  expandArea.className = "hist-group-expand-area";
  expandArea.style.cssText = "display:none;flex-direction:row;flex-wrap:wrap;gap:6px;" +
    "padding:8px;border:1px solid #e67e22;border-top:none;background:#fff8f0;" +
    "border-radius:0 0 8px 8px;max-height:600px;overflow-y:auto;";

  // グループ選択チェックボックス
  const groupChk = document.createElement("input");
  groupChk.type = "checkbox";
  groupChk.className = "hist-select-box hist-group-select-box";
  // 全アイテムが選択済みならチェック状態にする
  const allSelected = group.items.every(it => _histSelected.has(it.id));
  groupChk.checked = allSelected;
  groupChk.title = "グループ内を一括選択";
  groupChk.addEventListener("change", (e) => {
    for (const it of group.items) {
      if (e.target.checked) _histSelected.add(it.id);
      else                  _histSelected.delete(it.id);
    }
    // 展開エリア内の個別チェックボックスも同期
    expandArea.querySelectorAll(".hist-select-box").forEach(cb => {
      cb.checked = e.target.checked;
      cb.closest(".hist-card")?.classList.toggle("selected", e.target.checked);
    });
    document.getElementById("hist-delete-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-deselect-all").disabled = _histSelected.size === 0;
    document.getElementById("hist-add-tag-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-add-author-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-replace-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-remove-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-sync-global-tags").disabled = _histSelected.size === 0;
    document.getElementById("hist-group-selected").disabled = _histSelected.size < 2;
    document.getElementById("hist-ungroup-selected").disabled = _histSelected.size === 0;
    _updateAudioToggleSelectedBtn();
    _updateFavBulkButtons();
  });

  card.appendChild(badge);
  card.appendChild(groupChk);
  card.appendChild(placeholder);
  card.appendChild(overlay);

  // 展開ボタン（カードの下に分離）
  const expandBtn = document.createElement("button");
  expandBtn.className = "hist-card-btn hist-group-expand-btn";
  expandBtn.style.cssText = "width:100%;border-radius:0 0 8px 8px;border:1px solid #e67e22;border-top:2px solid #e67e22;" +
    "padding:4px;font-size:10px;cursor:pointer;background:#fff8f0;color:#c0622a;font-family:inherit;text-align:center;";
  expandBtn.textContent = `▶ 展開（${group.items.length}枚）`;

  wrapper.appendChild(card);
  wrapper.appendChild(expandBtn);
  wrapper.appendChild(expandArea);

  // 1枚目サムネイル
  const orderedItemsForLb = [...group.items].reverse();
  const allDataUrls = new Array(orderedItemsForLb.length).fill(null);
  if (first.thumbId) {
    if (_isGifEntry(first)) {
      // v1.40.0 GROUP-43 Phase 2：GIF 代表サムネは <canvas> + Worker
      const canvas = document.createElement("canvas");
      canvas.className = "hist-card-thumb";
      canvas.style.cursor = "zoom-in";
      canvas.addEventListener("click", async () => {
        if (!allDataUrls[0]) {
          try {
            const r = await browser.runtime.sendMessage({ type: "GET_THUMB_DATA_URL", thumbId: first.thumbId });
            if (r?.dataUrl) allDataUrls[0] = r.dataUrl;
          } catch (_) { /* ignore */ }
        }
        const _navData = _currentFilteredHistory ?? _historyData;
        const gIdx = _navData.findIndex(h => h.id === first.id);
        showGroupLightbox(allDataUrls, 0, orderedItemsForLb, { startEntryIndex: gIdx });
      });
      placeholder.replaceWith(canvas);
      _initGifTile(canvas, first).then(sessId => {
        if (!sessId) {
          // fallback：dataUrl 経路へ
          _fallbackCanvasToImg(canvas, first, null);
        }
      }).catch(() => {});
    } else {
      // 非 GIF は既存 dataUrl 経路
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

  return wrapper;
}

// v1.36.0 GROUP-35-perf-B-2：グループ表示モード時のグループ化／解除を差分更新する。
// 影響を受けない既存 wrapper / 単独カードはそのまま再 attach し、影響範囲のみ DOM を作り直す。
// renderHistoryGrid 全件再描画と比べ、_buildHistCardInner / btoa / structured clone deserialize を
// 影響範囲内のエントリ数に絞り込める。
//
// 引数 prevSessionIds：操作前に targets が属していた sessionId 集合
//   group 化前：targets が前に持っていた sessionId（null は除外、変化判定用）
//   ungroup 前：targets が解除前に属していた sessionId
function _partialRefreshGroupedDom(targetIds, prevSessionIds) {
  const grid = document.getElementById("hist-grid");
  if (!grid) return;

  // page slice を再計算（renderHistoryGrid と同じロジック）
  const hasTagFilter    = _histFilterTagChips.length > 0;
  const hasAuthorFilter = _histFilterAuthorChips.length > 0;
  const hasSourceFilter = !!_histSourceFilter;
  const hasFormatFilter = _histFormatFilter !== "all";
  const hasFavFilter    = _histFavFilter;
  const isFiltering = hasTagFilter || hasAuthorFilter || hasSourceFilter || hasFormatFilter || hasFavFilter;
  const filtered = isFiltering
    ? _historyData.filter(e => _entryMatchesCurrentFilter(e))
    : _historyData;
  const totalFiltered = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / _histPageSize));
  if (_histPage >= totalPages) _histPage = totalPages - 1;
  const pageSlice = filtered.slice(_histPage * _histPageSize, (_histPage + 1) * _histPageSize);

  const targetSet = new Set(targetIds);
  const affectedOldSids = new Set((prevSessionIds || []).filter(Boolean));

  // 既存 DOM を session/entry でインデックス化（影響を受けない要素は再 attach する）
  const existingWrappers = new Map(); // sessionId → wrapper element
  const existingCards    = new Map(); // entry.id → card element
  for (const el of grid.children) {
    if (el.classList.contains("hist-group-wrapper")) {
      const sid = el.dataset.sessionId;
      if (sid) existingWrappers.set(sid, el);
    } else if (el.classList.contains("hist-card") && el.dataset.entryId) {
      existingCards.set(el.dataset.entryId, el);
    }
  }

  // 新グルーピング計算
  const newGroups = _computeHistoryGroups(pageSlice);

  // 新グループのうち、targets を含む or 旧 sessionId が含まれていたものは「影響あり」として再構築
  // それ以外は既存 DOM を再 attach（DOM 操作なし）
  const newSidsAffected = new Set();
  for (const g of newGroups) {
    if (g.items.some(e => targetSet.has(e.id))) {
      if (g.sessionId) newSidsAffected.add(g.sessionId);
    }
  }

  // 一旦すべての子を detach（順序を再構築するため）
  while (grid.firstChild) grid.removeChild(grid.firstChild);

  // 新グルーピング順に DOM を再追加
  for (const group of newGroups) {
    const isAffectedSid = group.sessionId && (
      affectedOldSids.has(group.sessionId) || newSidsAffected.has(group.sessionId)
    );
    const containsTarget = group.items.some(e => targetSet.has(e.id));
    const isAffected = isAffectedSid || containsTarget;

    if (!group.sessionId || group.items.length === 1) {
      // 単独カード
      const entry = group.items[0];
      const existing = existingCards.get(entry.id);
      const sid = entry.sessionId || "";
      // 既存の単独カードをそのまま使える条件：
      //   (1) DOM に存在する（過去ページ表示時に作られたもの）
      //   (2) target でない
      //   (3) 旧 sessionId（affectedOldSids）に該当しない（旧グループの残メンバー化ケースを除外）
      //   (4) 新 sessionId（newSidsAffected）にも該当しない
      const canReuse = existing
        && !targetSet.has(entry.id)
        && !affectedOldSids.has(sid)
        && !newSidsAffected.has(sid);
      if (canReuse) {
        // 念のため selected クラス整合
        existing.classList.toggle("selected", _histSelected.has(entry.id));
        const cb = existing.querySelector(".hist-select-box");
        if (cb) cb.checked = _histSelected.has(entry.id);
        grid.appendChild(existing);
      } else {
        // 影響を受ける entry：新規構築（targets が単独化したケースなど）
        grid.appendChild(_buildSingleHistCard(entry));
      }
    } else {
      // グループ wrapper
      const existing = existingWrappers.get(group.sessionId);
      if (existing && !isAffected) {
        // 影響を受けない既存グループ：そのまま再 attach
        grid.appendChild(existing);
      } else {
        // 影響を受ける（新規グループ・メンバー変更）：新規構築
        grid.appendChild(_buildGroupWrapperElement(group));
      }
    }
  }

  // v1.40.0 GROUP-43 Phase 2：再 attach されなかった旧 DOM 要素は
  // 棄てられるため、それらに含まれる GIF Worker セッションをクリーンアップ
  for (const el of existingWrappers.values()) {
    if (el && !el.parentNode) _destroyGifSessionsInTree(el);
  }
  for (const el of existingCards.values()) {
    if (el && !el.parentNode) _destroyGifSessionsInTree(el);
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
  const prevLen = _histFilterTagChips.length;
  const t = (tag || "").trim().toLowerCase();
  if (!t) return;
  const chips = [..._histFilterTagChips];
  const idx = chips.indexOf(t);
  if (idx !== -1) chips.splice(idx, 1);
  else chips.push(t);
  _histFilterTagChips = chips;
  _histFilterTag = chips.join(" "); // shadow
  _histPage = 0;
  // 表示同期（チップ UI 側を直接再描画させる）
  const wrap = document.getElementById("hist-filter-wrap");
  if (wrap) {
    Array.from(wrap.querySelectorAll(".hist-chip")).forEach(c => c.remove());
    const input = document.getElementById("hist-filter");
    chips.forEach(chip => {
      const span = document.createElement("span");
      span.className = "hist-chip";
      span.textContent = chip;
      const btn = document.createElement("button");
      btn.textContent = "×"; btn.title = "削除";
      btn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); _applyTagFilter(chip); });
      span.appendChild(btn);
      if (input) wrap.insertBefore(span, input);
    });
  }
  document.getElementById("hist-filter-clear").style.display = chips.length ? "" : "none";
  _updateSelectAllBtn();
  if (prevLen === 0 && chips.length > 0) {
    // 絞り込み開始：スクロール位置を記憶
    const grid = document.getElementById("hist-grid");
    _histScrollPos = grid?.scrollTop ?? 0;
  }
  renderHistoryGrid();
}

function _applyAuthorFilter(author) {
  const a = (author || "").trim().toLowerCase();
  const chips = a ? [a] : [];
  _histFilterAuthorChips = chips;
  _histAuthorFilter = chips.join(" "); // shadow
  _histPage = 0;
  const wrap = document.getElementById("hist-author-filter-wrap");
  const input = document.getElementById("hist-author-filter");
  const clear = document.getElementById("hist-author-filter-clear");
  if (wrap) {
    Array.from(wrap.querySelectorAll(".hist-chip")).forEach(c => c.remove());
    chips.forEach(chip => {
      const span = document.createElement("span");
      span.className = "hist-chip author";
      span.textContent = chip;
      const btn = document.createElement("button");
      btn.textContent = "×"; btn.title = "削除";
      btn.addEventListener("click", (e) => { e.stopPropagation(); e.preventDefault(); _applyAuthorFilter(""); });
      span.appendChild(btn);
      if (input) wrap.insertBefore(span, input);
    });
  }
  if (clear) clear.style.display = chips.length ? "" : "none";
  _updateSelectAllBtn();
  renderHistoryGrid();
}

/**
 * 現在の絞り込み条件にエントリが合致するか判定
 * タイル差分更新時に、編集結果が絞り込み条件から外れたか判定するために使用。
 * v1.21.1 以降、タグ・権利者ともチップ配列を参照する。
 * - タグ：チップごと完全一致（v1.19.1 仕様踏襲）、AND/OR は `_histFilterMode`
 * - 権利者：チップごと部分一致（従来の substring 挙動を踏襲）、AND/OR は `_histFilterMode`
 * - タグ・権利者の両方が有効なときの組合せも `_histFilterMode` に従う
 */
function _entryMatchesCurrentFilter(entry) {
  const hasTagFilter    = _histFilterTagChips.length > 0;
  const hasAuthorFilter = _histFilterAuthorChips.length > 0;
  const hasSourceFilter = !!_histSourceFilter;
  const hasFormatFilter = _histFormatFilter !== "all";
  const hasFavFilter    = _histFavFilter; // v1.37.0 GROUP-36-fav-filter
  if (!hasTagFilter && !hasAuthorFilter && !hasSourceFilter && !hasFormatFilter && !hasFavFilter) return true;

  // v1.37.0 GROUP-36-fav-filter：お気に入りフィルタ（AND 結合）
  if (hasFavFilter && !entry.favorite) return false;

  // v1.32.2 GROUP-28 mvdl：形式フィルター
  if (_histFormatFilter === "gif" && !/\.gif$/i.test(entry.filename || "")) return false;
  if (_histFormatFilter === "audio" && !entry.audioFilename) return false;

  const entryTags = (entry.tags || []).map(t => t.toLowerCase());
  const tagMatch = !hasTagFilter || (
    _histFilterMode === "and"
      ? _histFilterTagChips.every(chip => entryTags.some(t => t === chip))
      : _histFilterTagChips.some(chip => entryTags.some(t => t === chip))
  );
  const eAuthors = getEntryAuthors(entry).map(a => a.toLowerCase());
  const authorMatch = !hasAuthorFilter || (
    _histFilterMode === "and"
      ? _histFilterAuthorChips.every(chip => eAuthors.some(a => a.includes(chip)))
      : _histFilterAuthorChips.some(chip => eAuthors.some(a => a.includes(chip)))
  );
  const sourceMatch = !hasSourceFilter || (
    _histSourceFilter === "external_import" ? entry.source === "external_import"
    : entry.source !== "external_import"
  );
  let tagAuthorMatch;
  if (hasTagFilter && hasAuthorFilter) {
    tagAuthorMatch = _histFilterMode === "and" ? (tagMatch && authorMatch) : (tagMatch || authorMatch);
  } else {
    tagAuthorMatch = tagMatch && authorMatch;
  }
  return tagAuthorMatch && sourceMatch;
}

/**
 * 指定エントリに対応するタイルDOM要素群を返す
 * - 通常カード: 直接の hist-card
 * - グループカード: グループ内のアイテムなら、グループのラッパー親要素と、展開エリア内の個別カードも含める
 * 戻り値: { individualCards: NodeList相当の配列, groupWrappers: 該当する場合のグループwrapper配列 }
 */
function _findHistCardsByEntryId(entryId) {
  const grid = document.getElementById("hist-grid");
  if (!grid) return { individualCards: [], groupWrappers: [] };
  // grid 直下の通常カードのみ（グループwrapper内の子カードは除外）
  const individualCards = [...grid.querySelectorAll(`:scope > .hist-card[data-entry-id="${entryId}"]`)];
  const groupWrappers = [...grid.querySelectorAll(`.hist-group-wrapper[data-group-entry-ids*="|${entryId}|"]`)];
  return { individualCards, groupWrappers };
}

/**
 * エントリ1件分のタイルを差分更新する
 * - 絞り込み条件に合致しなければタイルを非表示（削除）
 * - 合致すれば _buildHistCardInner で再構築
 * - グループ表示中で該当エントリがグループ先頭なら、グループカードの代表表示も更新
 * - グループ件数が変動した場合はバッジも更新
 */
// v1.39.1 GROUP-42-b：単一エントリの保存履歴カードを部分更新（GIF 再デコード回避）
//
// ## 役割
// - 既存の hist-card 要素を保持したまま、変更があったフィールドだけ DOM 更新
// - thumb-wrap（GIF/サムネ <img>・音声アイコン・お気に入りハート）には触らない → GIF アニメ再デコード起こらない
// - 新フィールドや handler を追加した時は本関数も更新する（再登録漏れ対策）
//
// ## 更新対象フィールド
// 1. tags（.hist-card-tags 内）：innerHTML 更新＋ click handler 再登録
// 2. authors（.hist-card-author-row）：0↔1+ の追加削除も対応＋ click handler 再登録
// 3. primary path（.hist-card-path text + open-folder/open-file 各 btn の title）
//
// ## 再登録が必要な handler（要・部分更新後に必ず attach）
// - .hist-card-tag click → _applyTagFilter
// - .hist-tag-del-btn click → タグ削除ロジック
// - .hist-card-author click → _applyAuthorFilter
//
// ## 触らないため再登録不要な handler
// - .hist-select-box / .hist-card-thumb-wrap 配下（img / audio-icon / fav-btn）
// - .hist-card-pageurl / .hist-card-btn.* （open-folder / open-file / del / info-edit）
// - .hist-info-editor 内部要素（パネル全体）
//
// 詳細は 設計書類\11_部分更新_ハンドラ再登録ポリシー.md
function _updateHistCardFields(card, entry) {
  // (1) tags
  const tagsEl = card.querySelector(".hist-card-tags");
  if (tagsEl) {
    tagsEl.innerHTML = (entry.tags || [])
      .map(t => `<span class="hist-card-tag" data-tag="${escHtml(t)}">${escHtml(t)}<button class="hist-tag-del-btn delete-guarded" data-tag="${escHtml(t)}" title="${escHtml(t)}を削除" tabindex="-1">×</button></span>`)
      .join("");
    tagsEl.querySelectorAll(".hist-card-tag").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        _applyTagFilter(el.dataset.tag.toLowerCase());
      });
    });
    tagsEl.querySelectorAll(".hist-tag-del-btn").forEach(btn => {
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
          _refreshHistCardByEntryId(entry.id);
          _updateHistCount();
        }
      });
    });
  }

  // (2) authors（無→有・有→無の追加削除も対応）
  const entryAuthors = getEntryAuthors(entry);
  const authorHtml = entryAuthors
    .map(a => `<span class="hist-card-author" data-author="${escHtml(a)}">✏️ ${escHtml(a)}</span>`)
    .join("");
  let authorRow = card.querySelector(".hist-card-author-row");
  if (entryAuthors.length > 0) {
    if (!authorRow) {
      authorRow = document.createElement("div");
      authorRow.className = "hist-card-author-row";
      const tagsRow = card.querySelector(".hist-card-tags");
      if (tagsRow?.parentNode) tagsRow.parentNode.insertBefore(authorRow, tagsRow);
    }
    authorRow.innerHTML = authorHtml;
    authorRow.querySelectorAll(".hist-card-author").forEach(el => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        _applyAuthorFilter(el.dataset.author.toLowerCase());
      });
    });
  } else if (authorRow) {
    authorRow.remove();
  }

  // (3) primary path（表示テキスト＋ボタン title 同期）
  const paths = Array.isArray(entry.savePaths) ? entry.savePaths : (entry.savePath ? [entry.savePath] : []);
  const primary = paths[0] ?? "";
  const pathEl = card.querySelector(".hist-card-path");
  if (pathEl) {
    pathEl.title = primary;
    pathEl.textContent = primary || "（パスなし）";
  }
  const openFolderBtn = card.querySelector(".hist-card-btn.open-folder");
  if (openFolderBtn) openFolderBtn.title = primary;
  const openFileBtn = card.querySelector(".hist-card-btn.open-file");
  if (openFileBtn) openFileBtn.title = primary && entry.filename ? `${primary}\\${entry.filename}` : "";
}

function _refreshHistCardByEntryId(entryId) {
  const entry = _historyData.find(h => h.id === entryId);
  const { individualCards, groupWrappers } = _findHistCardsByEntryId(entryId);

  // エントリが削除されている、または絞り込み合致しない場合は非表示
  const shouldHide = !entry || !_entryMatchesCurrentFilter(entry);

  // 通常カード側
  for (const card of individualCards) {
    if (shouldHide) {
      // v1.40.0 GROUP-43 Phase 2：除去前に GIF Worker セッションを片付ける
      _destroyGifSessionsInTree(card);
      card.remove();
      continue;
    }
    // v1.39.1 GROUP-42-b：thumb-wrap を含む既存 DOM を保持し、変更フィールドのみ部分更新
    _updateHistCardFields(card, entry);
    card.className = "hist-card" + (_histSelected.has(entry.id) ? " selected" : "");
  }

  // グループカード側（グループ表示モード）
  for (const wrapper of groupWrappers) {
    _refreshGroupWrapper(wrapper, entryId, shouldHide ? null : entry);
  }
}

/**
 * グループwrapperの中の指定エントリを更新・削除する
 * - 展開エリア内の該当子カードを再構築 or 削除
 * - グループ先頭（代表表示）に影響する場合は代表カードも更新
 * - バッジの枚数も更新
 * - グループが空 or 1件になった場合は wrapper ごと削除（次回描画で通常カードに戻る）
 */
function _refreshGroupWrapper(wrapper, entryId, entryOrNull) {
  const sessionId = wrapper.dataset.sessionId;
  if (!sessionId) return;
  // 現在の _historyData からグループを再構築
  const items = _historyData.filter(h => h.sessionId === sessionId && _entryMatchesCurrentFilter(h));
  if (items.length <= 1) {
    // グループ解体（0件 or 1件になった）→ 順序維持のため全体再描画にフォールバック
    renderHistoryGrid();
    return;
  }

  // データ属性 data-group-entry-ids を更新
  wrapper.dataset.groupEntryIds = "|" + items.map(i => i.id).join("|") + "|";

  // 展開エリア内の該当子カードを更新・削除
  const expandArea = wrapper.querySelector(".hist-group-expand-area");
  if (expandArea) {
    const childCards = [...expandArea.querySelectorAll(`.hist-card[data-entry-id="${entryId}"]`)];
    for (const child of childCards) {
      if (!entryOrNull) {
        // v1.40.0 GROUP-43 Phase 2：除去前に GIF Worker セッションを片付け
        _destroyGifSessionsInTree(child);
        child.remove();
      } else {
        // v1.39.1 GROUP-42-b：thumb-wrap を含む既存 DOM を保持し、変更フィールドのみ部分更新
        _updateHistCardFields(child, entryOrNull);
        child.className = "hist-card" + (_histSelected.has(entryOrNull.id) ? " selected" : "");
      }
    }
  }

  // バッジ更新
  const badge = wrapper.querySelector(".hist-group-badge");
  if (badge) badge.textContent = `${items.length}枚`;
  // 展開ボタンのラベル更新
  const expandBtn = wrapper.querySelector(".hist-group-expand-btn");
  if (expandBtn) {
    const expanded = expandArea && expandArea.style.display !== "none";
    expandBtn.textContent = expanded ? `▼ 折りたたむ` : `▶ 展開（${items.length}枚）`;
  }
  // グループチェックボックス状態更新
  const groupChk = wrapper.querySelector(".hist-group-select-box");
  if (groupChk) {
    groupChk.checked = items.every(it => _histSelected.has(it.id));
  }

  // 代表カード（グループ先頭）の表示を更新
  // グループ先頭は items.at(-1)（古いものが代表）
  const representative = items.at(-1);
  const representativeCard = wrapper.querySelector(":scope > .hist-card.hist-card-group");
  if (representativeCard && representative) {
    // data-entry-id と data-representative-id を更新
    representativeCard.dataset.representativeId = representative.id;
    const overlay = representativeCard.querySelector(".hist-card-overlay");
    if (overlay) {
      const paths = Array.isArray(representative.savePaths) ? representative.savePaths : (representative.savePath ? [representative.savePath] : []);
      const primary = paths[0] ?? "";
      const date = new Date(representative.savedAt).toLocaleString("ja-JP");
      const tagHtml = (representative.tags || [])
        .map(t => `<span class="hist-card-tag" data-tag="${escHtml(t)}">${escHtml(t)}</span>`).join("");
      overlay.innerHTML = `
        <div class="hist-card-body">
          <div class="hist-card-filename" title="${escHtml(representative.filename)}">${escHtml(representative.filename)} 他</div>
          <div class="hist-card-path" title="${escHtml(primary)}">${escHtml(primary || "（パスなし）")}</div>
          <div class="hist-card-tags">${tagHtml}</div>
          <div class="hist-card-date">${escHtml(date)}</div>
        </div>`;
      // タグクリック配線
      overlay.querySelectorAll(".hist-card-tag").forEach(el => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          _applyTagFilter(el.dataset.tag.toLowerCase());
        });
      });
    }
  }
}

/**
 * エントリ1件をDOMから削除（個別タイル削除ボタン用）
 * - 通常カードなら要素ごと削除
 * - グループカード内なら展開エリア内の該当子カード削除 + バッジ更新
 */
function _removeHistCardByEntryId(entryId) {
  _refreshHistCardByEntryId(entryId);
}

/** 保存履歴タブのツールバーボタンの disabled 状態を現在の選択数に応じて更新 */
function _updateHistToolbarButtons() {
  const n = _histSelected.size;
  const set = (id, disabled) => { const el = document.getElementById(id); if (el) el.disabled = disabled; };
  set("hist-delete-selected", n === 0);
  set("hist-deselect-all", n === 0);
  set("hist-add-tag-selected", n === 0);
  set("hist-add-author-selected", n === 0);
  set("hist-sync-global-tags", n === 0);
  set("hist-group-selected", n < 2);
  set("hist-ungroup-selected", n === 0);
  // v1.37.0 GROUP-36-fav-bulk
  set("hist-fav-add-selected", n === 0);
  set("hist-fav-remove-selected", n === 0);
}

/** 件数表示を現在の絞り込み状態に応じて更新 */
function _updateHistCount() {
  const countEl = document.getElementById("hist-count");
  if (!countEl) return;
  const hasTagFilter    = _histFilterTagChips.length > 0;
  const hasAuthorFilter = _histFilterAuthorChips.length > 0;
  const hasSourceFilter = !!_histSourceFilter;
  const hasFormatFilter = _histFormatFilter !== "all";
  const hasFavFilter    = _histFavFilter;
  const isFiltering = hasTagFilter || hasAuthorFilter || hasSourceFilter || hasFormatFilter || hasFavFilter;
  const filtered = isFiltering
    ? _historyData.filter(_entryMatchesCurrentFilter)
    : _historyData;
  const totalFiltered = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalFiltered / _histPageSize));
  const suffix = isFiltering ? "（絞り込み中）" : "";
  if (totalFiltered <= _histPageSize) {
    countEl.textContent = `${totalFiltered} 件${suffix}`;
  } else {
    countEl.textContent = `${_histPage + 1}/${totalPages} ページ（全 ${totalFiltered} 件${suffix ? "・絞り込み中" : ""}）`;
  }
  _currentFilteredHistory = isFiltering ? filtered : null;
}

// ================================================================
// v1.31.4 GROUP-28 mvdl：保存履歴カードの音声再生制御
// v1.32.0 GROUP-28 mvdl Phase 2：複数エントリ同時再生＋Lightbox / viewer 対応
// ================================================================
// - entry.id をキーに <audio> / Blob URL をキャッシュ（複数回再生の高速化）
// - v1.32.0：**複数エントリを同時再生可能**（以前の単一制限を撤廃）
// - クリックで toggle（停止中 → 再生、再生中 → 停止）
// - アイコン状態は data-muted 属性で切替（CSS 側で背景色変更）
// - Lightbox / viewer からも同じ API を呼出可能に _toggleEntryAudio として公開
// ================================================================
const _histAudioCache = new Map();   // entry.id → {audio: HTMLAudioElement, blobUrl: string}
const _histAudioPlayingIds = new Set(); // 現在再生中の entry.id の集合（複数同時 OK）

function _updateAudioButtonsForEntry(entryId, playing) {
  // DOM 上の該当エントリの🔇/🔊ボタン（複数箇所：hist-card / Lightbox）を一括更新
  document.querySelectorAll(`.hist-card-audio-icon[data-audio-entry-id="${entryId}"]`).forEach(btn => {
    btn.dataset.muted = playing ? "0" : "1";
    btn.textContent = playing ? "🔊" : "🔇";
  });
}

async function _toggleHistAudio(entry, btn) {
  // 既にこのエントリが再生中なら停止
  const existing = _histAudioCache.get(entry.id);
  if (existing && existing.audio && !existing.audio.paused) {
    try { existing.audio.pause(); existing.audio.currentTime = 0; } catch (_) {}
    _histAudioPlayingIds.delete(entry.id);
    _updateAudioButtonsForEntry(entry.id, false);
    return;
  }

  // v1.32.0：他エントリは停止しない（複数同時再生）

  // 必要データ
  const paths = Array.isArray(entry.savePaths) ? entry.savePaths : (entry.savePath ? [entry.savePath] : []);
  const primary = paths[0];
  if (!primary || !entry.audioFilename) {
    console.warn(`[hist-audio] パス情報がありません`, { entry });
    return;
  }
  const audioPath = `${primary.replace(/[\\/]+$/, "")}\\${entry.audioFilename}`;

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = "⏳";

  try {
    let cached = _histAudioCache.get(entry.id);
    if (!cached) {
      // v1.31.9：FETCH_FILE_AS_DATAURL は内部で Python の READ_FILE_BASE64 を呼び出し
      // 非 GIF ファイルは PIL で画像として開こうとして UnidentifiedImageError になる。
      // 音声 (.webm / .mp3 等) は READ_FILE_CHUNKS_B64 を直接使って PIL を迂回する。
      const res = await browser.runtime.sendMessage({
        type: "READ_FILE_CHUNKS_B64",
        path: audioPath,
      });
      if (!res || !res.ok || !Array.isArray(res.chunksB64)) {
        console.warn(`[hist-audio] 音声読込失敗`, res?.error || "不明", { path: audioPath });
        btn.disabled = false;
        btn.textContent = originalText;
        return;
      }
      // chunk 配列 → Blob
      const arrays = [];
      for (const b64 of res.chunksB64) {
        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        arrays.push(arr);
      }
      const blob = new Blob(arrays, { type: entry.audioMimeType || "audio/webm" });
      const blobUrl = URL.createObjectURL(blob);
      const audio = new Audio(blobUrl);
      audio.loop = true; // GIF は自動ループなのでそれに合わせる
      audio.addEventListener("ended", () => {
        // loop=true なので基本 ended は発火しないが保険で
        if (_histAudioPlayingId === entry.id) _histAudioStopCurrent();
      });
      cached = { audio, blobUrl };
      _histAudioCache.set(entry.id, cached);
    }

    await cached.audio.play();
    _histAudioPlayingId = entry.id;
    // v1.32.0：再生終了時（audio 側が loop=true だが何らかで pause 状態に）も UI を戻す
    cached.audio.onpause = () => {
      if (cached.audio.ended || cached.audio.currentTime === 0) {
        _histAudioPlayingIds.delete(entry.id);
        _updateAudioButtonsForEntry(entry.id, false);
      }
    };
    _histAudioPlayingIds.add(entry.id);
    _updateAudioButtonsForEntry(entry.id, true);
    btn.dataset.muted = "0";
    btn.textContent = "🔊";
  } catch (err) {
    console.warn(`[hist-audio] 音声再生エラー`, err);
    btn.textContent = originalText;
  } finally {
    btn.disabled = false;
  }
}

// v1.33.0 GROUP-32-b：選択した保存履歴の音声を一括でトグル（全停止 or 全再生）
// - 選択エントリのうち少なくとも 1 件が再生中なら全停止
// - 全て停止中なら音声ありエントリ全てを再生
function _hasPlayingAudioInSelection() {
  for (const id of _histSelected) {
    if (_histAudioPlayingIds.has(id)) return true;
  }
  return false;
}

function _selectedEntriesWithAudio() {
  return _historyData.filter(e => _histSelected.has(e.id) && e.audioFilename);
}

function _updateAudioToggleSelectedBtn() {
  const btn = document.getElementById("hist-audio-toggle-selected");
  if (!btn) return;
  const hasAudio = _selectedEntriesWithAudio().length > 0;
  btn.disabled = !hasAudio;
  if (hasAudio) {
    btn.textContent = _hasPlayingAudioInSelection() ? "🔇 音声 OFF" : "🔊 音声 ON";
  } else {
    btn.textContent = "🔊 音声 ON/OFF";
  }
}

// v1.37.0 GROUP-36-fav-bulk：選択中のお気に入り追加/解除ボタンの活性状態を更新
// - 追加：選択件数 > 0 で活性
// - 解除：選択件数 > 0 で活性（個別判定はせず、単純に選択時のみ押下可能）
function _updateFavBulkButtons() {
  const n = _histSelected.size;
  const addBtn    = document.getElementById("hist-fav-add-selected");
  const removeBtn = document.getElementById("hist-fav-remove-selected");
  if (addBtn)    addBtn.disabled    = n === 0;
  if (removeBtn) removeBtn.disabled = n === 0;
}

async function _toggleAudioSelected() {
  const targets = _selectedEntriesWithAudio();
  if (targets.length === 0) return;
  const shouldStop = _hasPlayingAudioInSelection();
  if (shouldStop) {
    // 再生中のものを一括停止
    for (const entry of targets) {
      const cached = _histAudioCache.get(entry.id);
      if (cached && cached.audio && !cached.audio.paused) {
        try { cached.audio.pause(); cached.audio.currentTime = 0; } catch (_) {}
        _histAudioPlayingIds.delete(entry.id);
        _updateAudioButtonsForEntry(entry.id, false);
      }
    }
  } else {
    // 停止中のものを一括再生（_toggleHistAudio は再生中なら停止する挙動なので、停止中のみ直接呼ぶ）
    for (const entry of targets) {
      if (_histAudioPlayingIds.has(entry.id)) continue;
      // ダミー btn を用意して _toggleHistAudio を再利用
      const iconBtn = document.querySelector(`.hist-card-audio-icon[data-audio-entry-id="${entry.id}"]`);
      if (iconBtn) {
        // eslint-disable-next-line no-await-in-loop
        await _toggleHistAudio(entry, iconBtn);
      } else {
        // DOM にボタンがない（別ページ等）場合はダミー element で呼出
        const dummy = document.createElement("button");
        // eslint-disable-next-line no-await-in-loop
        await _toggleHistAudio(entry, dummy);
      }
    }
  }
  _updateAudioToggleSelectedBtn();
}

// v1.37.0 GROUP-36-fav → v1.38.0：単一エントリのお気に入りトグル（オプティミスティック更新）
// - クリック直後に DOM／メモリを即時反映（体感即時）
// - storage.local.set は裏で実行、失敗時は DOM／メモリを元に戻してエラー表示
// - 別タブ／modal 側の表示は次回開いたタイミングで反映される
async function _toggleEntryFavorite(entryId) {
  // 現在値の確定（メモリ優先、なければ storage 同期前の保険として false）
  const memEntry = (_historyData || []).find(e => e.id === entryId);
  const prev = !!memEntry?.favorite;
  const next = !prev;

  // ① 即時 UI 反映：メモリ＋ DOM＋（必要なら）当該タイルのみ除去
  if (memEntry) memEntry.favorite = next;
  _updateFavButtonsForEntry(entryId, next);
  let removedFromFilter = false;
  if (_histFavFilter && !next) {
    // v1.39.1 GROUP-42-b：fav-filter ON で当該エントリが外れる時、全体再描画ではなく
    // 該当タイルだけ DOM 除去（他の GIF タイルの再デコードを避ける）
    _histSelected.delete(entryId);
    const { individualCards, groupWrappers } = _findHistCardsByEntryId(entryId);
    for (const card of individualCards) {
      _destroyGifSessionsInTree(card); // v1.40.0 GROUP-43 Phase 2
      card.remove();
    }
    for (const wrapper of groupWrappers) {
      _refreshGroupWrapper(wrapper, entryId, null);
    }
    _updateHistCount();
    removedFromFilter = true;
  }

  // ② 裏で永続化、失敗時はロールバック
  try {
    const stored = await browser.storage.local.get("saveHistory");
    const history = stored.saveHistory || [];
    const entry = history.find(e => e.id === entryId);
    if (!entry) {
      // ストレージ側にエントリが見つからない（削除済み等）→ ロールバックして警告
      throw new Error("saveHistory にエントリが見つかりません");
    }
    entry.favorite = next;
    await browser.storage.local.set({ saveHistory: history });
    _historyData = history;
  } catch (err) {
    // ロールバック：DOM／メモリを元に戻す
    if (memEntry) memEntry.favorite = prev;
    _updateFavButtonsForEntry(entryId, prev);
    if (removedFromFilter) {
      // フィルタ ON で除去したタイルを取り戻すため、全体再描画にフォールバック
      // （ロールバック経路は稀なので GIF 再デコードコストは許容）
      renderHistoryGrid();
    }
    console.warn("[fav] お気に入りトグル失敗、ロールバック", err);
    showStatus(`⚠️ お気に入りの保存に失敗しました（${err.message || err}）`, true);
  }
}

// v1.37.0 GROUP-36-fav：選択した複数エントリへ favorite を一括で代入
// v1.39.1 GROUP-42-b：fav-filter ON で外れた場合、全体再描画ではなく該当タイルのみ除去
async function _setBulkFavorite(targetIds, value) {
  if (!targetIds || targetIds.length === 0) return 0;
  const stored = await browser.storage.local.get("saveHistory");
  const history = stored.saveHistory || [];
  const idSet = new Set(targetIds);
  let changed = 0;
  for (const e of history) {
    if (idSet.has(e.id) && !!e.favorite !== !!value) {
      e.favorite = !!value;
      changed++;
    }
  }
  if (changed > 0) {
    await browser.storage.local.set({ saveHistory: history });
    _historyData = history;
    for (const id of targetIds) _updateFavButtonsForEntry(id, value);
  }
  // フィルタ ON で解除した場合、該当タイルのみ DOM 除去（GIF 再デコード回避）
  if (_histFavFilter && !value) {
    for (const id of targetIds) {
      _histSelected.delete(id);
      const { individualCards, groupWrappers } = _findHistCardsByEntryId(id);
      for (const card of individualCards) {
        _destroyGifSessionsInTree(card); // v1.40.0 GROUP-43 Phase 2
        card.remove();
      }
      for (const wrapper of groupWrappers) {
        _refreshGroupWrapper(wrapper, id, null);
      }
    }
    _updateHistCount();
  }
  return changed;
}

// v1.37.0 GROUP-36-fav：DOM 上の該当エントリのハートボタン（複数箇所：hist-card / Lightbox / modal）を一括更新
function _updateFavButtonsForEntry(entryId, isFav) {
  document.querySelectorAll(`.hist-card-fav-btn[data-fav-entry-id="${entryId}"]`).forEach(btn => {
    btn.dataset.fav = isFav ? "1" : "0";
    btn.textContent = isFav ? "❤️" : "🤍";
    btn.title = isFav ? "お気に入り解除" : "お気に入り登録";
    btn.setAttribute("aria-pressed", isFav ? "true" : "false");
  });
}

// =============================================================================
// v1.40.0 GROUP-43 Phase 2：GIF を <canvas> ＋ Worker パイプラインで再生
// =============================================================================
// - Module Worker（src/decoders/gif-decoder.worker.js）を単一共有で起動
// - タイル毎に sessionId を発行、Worker 内で独立に decode
// - 失敗時は <img> + dataUrl にフォールバック（既存経路保持）
// - tile DOM 削除前に _destroyGifSession でクリーンアップ
// =============================================================================
let _gifWorker = null;
let _gifSessionSeq = 0;
const _gifSessions = new Map();
// session = { id, canvas, ctx, ready, frameCount, dims, currentIndex, timerId, entryId }

function _getGifWorker() {
  if (_gifWorker) return _gifWorker;
  try {
    _gifWorker = new Worker(
      browser.runtime.getURL("src/decoders/gif-decoder.worker.js"),
      { type: "module" }
    );
    _gifWorker.onmessage = _onGifWorkerMessage;
    _gifWorker.onerror = (err) => {
      console.warn("[gif-worker] error", err);
    };
  } catch (err) {
    console.warn("[gif-worker] 起動失敗", err);
    _gifWorker = null;
  }
  return _gifWorker;
}

function _onGifWorkerMessage(e) {
  const msg = e.data || {};
  const sess = _gifSessions.get(msg.id);
  if (!sess) {
    if (msg.bitmap?.close) try { msg.bitmap.close(); } catch (_) {}
    return;
  }
  if (msg.type === "READY") {
    sess.ready = true;
    sess.frameCount = msg.frameCount || 1;
    sess.dims = msg.dims;
    if (msg.dims) {
      sess.canvas.width  = msg.dims.width;
      sess.canvas.height = msg.dims.height;
    }
    sess.currentIndex = 0;
    if (_gifWorker) _gifWorker.postMessage({ type: "REQ_FRAME", id: sess.id, index: 0 });
  } else if (msg.type === "FRAME") {
    if (sess.canvas && msg.bitmap) {
      try {
        sess.ctx.drawImage(msg.bitmap, 0, 0);
      } catch (err) {
        console.warn("[gif-worker] drawImage 失敗", err);
      }
      try { msg.bitmap.close(); } catch (_) {}
    }
    const nextIndex = (msg.index + 1) % (sess.frameCount || 1);
    sess.currentIndex = nextIndex;
    sess.timerId = setTimeout(() => {
      if (!_gifSessions.has(sess.id)) return;
      if (_gifWorker) _gifWorker.postMessage({ type: "REQ_FRAME", id: sess.id, index: nextIndex });
    }, msg.delay || 100);
  } else if (msg.type === "ERROR") {
    console.warn("[gif-worker] session error", msg.id, msg.message);
    _destroyGifSession(sess.id);
  }
}

async function _initGifTile(canvas, entry) {
  const id = ++_gifSessionSeq;
  const ctx = canvas.getContext("2d");
  const sess = {
    id, canvas, ctx,
    ready: false, frameCount: 0, dims: null,
    currentIndex: 0, timerId: null,
    entryId: entry.id,
  };
  _gifSessions.set(id, sess);
  canvas.dataset.gifSessionId = String(id);
  let binResp;
  try {
    binResp = await browser.runtime.sendMessage({
      type:    "GET_THUMB_BINARY",
      thumbId: entry.thumbId,
    });
  } catch (err) {
    _destroyGifSession(id);
    return null;
  }
  if (!binResp?.ok || !binResp.buffer) {
    _destroyGifSession(id);
    return null;
  }
  const w = _getGifWorker();
  if (!w) {
    _destroyGifSession(id);
    return null;
  }
  try {
    w.postMessage(
      { type: "INIT", id, gifBuffer: binResp.buffer },
      [binResp.buffer]
    );
  } catch (err) {
    console.warn("[gif-worker] INIT postMessage 失敗", err);
    _destroyGifSession(id);
    return null;
  }
  return id;
}

function _destroyGifSession(id) {
  const sess = _gifSessions.get(id);
  if (!sess) return;
  if (sess.timerId) {
    try { clearTimeout(sess.timerId); } catch (_) {}
    sess.timerId = null;
  }
  _gifSessions.delete(id);
  if (_gifWorker) {
    try { _gifWorker.postMessage({ type: "DESTROY", id }); } catch (_) {}
  }
  if (sess.canvas) {
    try { delete sess.canvas.dataset.gifSessionId; } catch (_) {}
  }
}

/** DOM ツリー内のすべての GIF canvas タイルのセッションを破棄（DOM 除去前に呼ぶ） */
function _destroyGifSessionsInTree(rootEl) {
  if (!rootEl) return;
  const canvases = rootEl.matches?.("canvas[data-gif-session-id]")
    ? [rootEl]
    : Array.from(rootEl.querySelectorAll?.("canvas[data-gif-session-id]") || []);
  for (const cv of canvases) {
    const id = parseInt(cv.dataset.gifSessionId, 10);
    if (id) _destroyGifSession(id);
  }
}

/** GIF タイルかどうか判定 */
function _isGifEntry(entry) {
  return /\.gif$/i.test(entry?.filename || "");
}

/** GIF placeholder を canvas で置換し Worker セッション開始（失敗時は <img> にフォールバック） */
function _setupGifCanvasInPlaceholder(card, entry, onThumbClick, opts) {
  const placeholder = card.querySelector(".hist-card-thumb-placeholder");
  if (!placeholder) return;
  const canvas = document.createElement("canvas");
  canvas.className = "hist-card-thumb";
  canvas.title = "クリックで拡大";
  canvas.style.cursor = "zoom-in";
  canvas.addEventListener("click", async (e) => {
    e.stopPropagation();
    // Click 時に dataUrl を取得して Lightbox へ。Phase 4 で Lightbox も canvas 化予定
    let dataUrl = null;
    try {
      const r = await browser.runtime.sendMessage({ type: "GET_THUMB_DATA_URL", thumbId: entry.thumbId });
      dataUrl = r?.dataUrl;
    } catch (_) { /* ignore */ }
    if (!dataUrl) return;
    if (onThumbClick) {
      onThumbClick(dataUrl, canvas);
    } else {
      const _navData = _currentFilteredHistory ?? _historyData;
      const gIdx = _navData.findIndex(h => h.id === entry.id);
      showGroupLightbox([dataUrl], 0, [entry], { startEntryIndex: gIdx });
    }
  });
  placeholder.replaceWith(canvas);
  _initGifTile(canvas, entry).then(sessId => {
    if (!sessId) {
      // fallback：canvas を img + dataUrl 経路に置換
      _fallbackCanvasToImg(canvas, entry, onThumbClick);
    }
  }).catch(() => {
    _fallbackCanvasToImg(canvas, entry, onThumbClick);
  });
}

function _fallbackCanvasToImg(canvas, entry, onThumbClick) {
  if (!canvas?.parentNode) return;
  browser.runtime.sendMessage({ type: "GET_THUMB_DATA_URL", thumbId: entry.thumbId })
    .then(r => {
      if (!r?.dataUrl) return;
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
          const _navData = _currentFilteredHistory ?? _historyData;
          const gIdx = _navData.findIndex(h => h.id === entry.id);
          showGroupLightbox([r.dataUrl], 0, [entry], { startEntryIndex: gIdx });
        }
      });
      canvas.replaceWith(img);
    }).catch(() => {});
}

// =============================================================================
// /v1.40.0 GROUP-43 Phase 2
// =============================================================================

function _buildHistCardInner(card, entry, onThumbClick) {
  card.dataset.entryId = entry.id;
  const paths   = Array.isArray(entry.savePaths) ? entry.savePaths : (entry.savePath ? [entry.savePath] : []);
  const primary = paths[0] ?? "";
  const date    = new Date(entry.savedAt).toLocaleString("ja-JP");
  const tagHtml = (entry.tags || [])
    .map(t => `<span class="hist-card-tag" data-tag="${escHtml(t)}">${escHtml(t)}<button class="hist-tag-del-btn delete-guarded" data-tag="${escHtml(t)}" title="${escHtml(t)}を削除" tabindex="-1">×</button></span>`).join("");
  const entryAuthors = getEntryAuthors(entry);
  const authorHtml = entryAuthors.map(a =>
    `<span class="hist-card-author" data-author="${escHtml(a)}">✏️ ${escHtml(a)}</span>`
  ).join("");

  // v1.31.4 GROUP-28 mvdl：関連音声あり時は wrap 内にスピーカーアイコンを重ねる
  // v1.32.0：data-audio-entry-id 追加、Lightbox / viewer 等外部からも状態同期できるように
  const audioIconHtml = entry.audioFilename
    ? `<button class="hist-card-audio-icon" data-muted="${_histAudioPlayingIds.has(entry.id) ? "0" : "1"}" data-audio-entry-id="${entry.id}" title="音声再生: ${escHtml(entry.audioFilename)}">${_histAudioPlayingIds.has(entry.id) ? "🔊" : "🔇"}</button>`
    : "";
  // v1.37.0 GROUP-36-fav-tile：右上にお気に入りハートボタン
  const isFav = !!entry.favorite;
  const favBtnHtml = `<button class="hist-card-fav-btn" data-fav-entry-id="${entry.id}" data-fav="${isFav ? "1" : "0"}" title="${isFav ? "お気に入り解除" : "お気に入り登録"}" aria-pressed="${isFav}">${isFav ? "❤️" : "🤍"}</button>`;
  let thumbHtml = `
    <div class="hist-card-thumb-wrap">
      <div class="hist-card-thumb-placeholder">🖼</div>
      ${audioIconHtml}
      ${favBtnHtml}
    </div>
  `;
  // v1.41.0 GROUP-43 Phase 2 §5 案 A：サムネ読込ブロックは card.innerHTML
  // 設定の後に実行する（placeholder element が DOM に存在することを保証）。
  // 元コードは GIF 経路（同期 querySelector）でこのブロックを innerHTML 設定前に
  // 実行していたため placeholder=null でフォールバックも発火せず、🖼 が表示されたまま
  // になる v1.40.0 のバグがあった。本実装では innerHTML 設定後に呼び出す。
  // v1.31.4 GROUP-28 mvdl：音声アイコンのクリックハンドラ
  if (entry.audioFilename) {
    setTimeout(() => {
      const audioBtn = card.querySelector(".hist-card-audio-icon");
      if (audioBtn && !audioBtn.dataset.handlerAttached) {
        audioBtn.dataset.handlerAttached = "1";
        audioBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          _toggleHistAudio(entry, audioBtn);
        });
      }
    }, 0);
  }
  // v1.37.0 GROUP-36-fav-tile：お気に入りハートボタンのクリックハンドラ
  setTimeout(() => {
    const favBtn = card.querySelector(".hist-card-fav-btn");
    if (favBtn && !favBtn.dataset.handlerAttached) {
      favBtn.dataset.handlerAttached = "1";
      favBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await _toggleEntryFavorite(entry.id);
      });
    }
  }, 0);

  const pageUrlHtml = entry.pageUrl
    ? `<a class="hist-card-pageurl" href="${escHtml(entry.pageUrl)}" target="_blank" rel="noopener noreferrer" title="${escHtml(entry.pageUrl)}">${escHtml(entry.pageUrl)}</a>`
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

  // v1.41.0 GROUP-43 Phase 2 §5 案 A：thumbHtml が DOM に組み込まれた後に
  // サムネ読込を開始（GIF は canvas + Worker、非 GIF は <img> + dataUrl）
  if (entry.thumbId) {
    if (_isGifEntry(entry)) {
      _setupGifCanvasInPlaceholder(card, entry, onThumbClick);
    } else {
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
  }

  card.querySelector(".hist-select-box").addEventListener("change", (e) => {
    if (e.target.checked) _histSelected.add(entry.id);
    else                  _histSelected.delete(entry.id);
    card.classList.toggle("selected", e.target.checked);
    document.getElementById("hist-delete-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-deselect-all").disabled = _histSelected.size === 0;
    document.getElementById("hist-add-tag-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-add-author-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-replace-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-remove-selected").disabled = _histSelected.size === 0;
    document.getElementById("hist-sync-global-tags").disabled = _histSelected.size === 0;
    document.getElementById("hist-group-selected").disabled = _histSelected.size < 2;
    document.getElementById("hist-ungroup-selected").disabled = _histSelected.size === 0;
    _updateAudioToggleSelectedBtn();
    _updateFavBulkButtons();
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
    if (isOpen) { closeInfoEditor(); return; }
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

  // パネルを閉じる際の共通処理：タイル差分更新・絞り込み非合致なら非表示
  function closeInfoEditor() {
    infoEditor.classList.remove("open");
    _refreshHistCardByEntryId(entry.id);
    _updateHistCount();
  }

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
    closeInfoEditor();
  });

  // オーバーレイ背景クリックで閉じる
  infoEditor.addEventListener("click", (e) => {
    if (e.target === infoEditor) {
      closeInfoEditor();
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
      closeInfoEditor();
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
  async function commitPathChange() {
    const newPath = pathInput.value.trim();
    if (newPath !== _prevPath) {
      _undoStack.push({ type: "changePath", oldPath: _prevPath, newPath });
      _prevPath = newPath;
      await saveEntryNow();
      updateUndoBtn();
    }
  }
  pathInput.addEventListener("blur", commitPathChange);
  pathInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") { e.preventDefault(); await commitPathChange(); }
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
        _refreshHistCardByEntryId(entry.id);
        _updateHistCount();
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
    // v1.22.9: 拡張ページ viewer.html を開き、大容量 GIF も含めてそこで描画する。
    //   viewer.js 側で FETCH_FILE_AS_DATAURL を叩いて dataUrl / chunksB64 を処理する。
    // v1.32.0 GROUP-28 mvdl Phase 2：関連音声があれば audioPath / audioMime も query 経由で viewer へ。
    let viewerUrl = browser.runtime.getURL("src/viewer/viewer.html") + "?path=" + encodeURIComponent(filePath);
    if (entry.audioFilename) {
      const audioFilePath = primary.replace(/[\\/]+$/, "") + "\\" + entry.audioFilename;
      viewerUrl += "&audioPath=" + encodeURIComponent(audioFilePath);
      viewerUrl += "&audioMime=" + encodeURIComponent(entry.audioMimeType || "audio/webm");
    }
    window.open(viewerUrl, "_blank");
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
    _refreshHistCardByEntryId(entry.id);
    _updateHistToolbarButtons();
    _updateHistCount();
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
        <button class="lb-audio hist-card-audio-icon" data-muted="1" title="音声再生" style="display:none; position:relative; left:auto; bottom:auto;">🔇</button>
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

    // v1.32.0 GROUP-28 mvdl Phase 2：Lightbox の音声ボタン
    const audioBtn = overlay.querySelector(".lb-audio");

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

      // v1.32.0：現在エントリに音声ファイルがあれば Lightbox の音声ボタンを表示
      if (entry && entry.audioFilename) {
        const playing = _histAudioPlayingIds.has(entry.id);
        audioBtn.style.display = "";
        audioBtn.dataset.muted = playing ? "0" : "1";
        audioBtn.dataset.audioEntryId = entry.id;
        audioBtn.textContent = playing ? "🔊" : "🔇";
        audioBtn.title = `音声再生: ${entry.audioFilename}`;
      } else {
        audioBtn.style.display = "none";
        audioBtn.removeAttribute("data-audio-entry-id");
      }
    }

    audioBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const entry = items[currentIdx];
      if (!entry || !entry.audioFilename) return;
      _toggleHistAudio(entry, audioBtn);
    });

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

  // v1.20.0: 1枚ずつ形式の初期化（形式切替ラジオ・c1/c2・セッション一覧・b1 画面）
  try {
    await _setupExtPerItemMode();
  } catch (e) {
    console.error("[ext per-item] setup failed:", e);
  }
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
  // v1.22.0: 各エントリに sourceRoot / completionRoot を付与（複数ルート対応の基礎）
  const deduped = res.entries
    .filter(e => !existingKeys.has(`${e.savePath}\0${e.fileName}`))
    .map(e => ({ ...e, sourceRoot: path, completionRoot: path }));
  const skipped = res.entries.length - deduped.length;

  _extScanResult = {
    ...res,
    entries: deduped,
    roots: [{
      rootPath:     path,
      scanPath:     path,
      displayRoot:  path,
      allFolders:   res.allFolders || [],
      folderTokens: res.folderTokens || {},
    }],
  };

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

/** v1.22.0: ルートパス+相対フォルダから _extFolderTagMap のキーを生成 */
function _extTagKey(rootPath, relFolder) {
  return `${rootPath || ""}\0${relFolder || ""}`;
}

/** フォルダ別タグ設定テーブル描画
 *  - v1.22.0 より複数ルート対応（rootsInfo 優先）。_extFolderTagMap はルート修飾キーで統一。
 *  - 後方互換: rootsInfo を省略した場合は folders/folderTokens/scanPath から単一ルートとして扱う。
 *
 *  folders:       Python の allFolders（"." = ルート直下、"sub" や "sub\\child" = サブフォルダ）
 *  folderTokens:  Python の folderTokens（{ relFolder: [token, ...] }）
 *  scanPath:      スキャン対象パス（ルートフォルダ名の表示に使用）
 *  rootsInfo:     [{rootPath, scanPath, displayRoot, allFolders, folderTokens}, ...]
 */
async function renderFolderTable(folders, folderTokens, scanPath, rootsInfo = null) {
  const tbody = document.getElementById("ext-folder-tbody");
  tbody.innerHTML = "";
  _extFolderTagMap = {};

  if (!rootsInfo) {
    rootsInfo = [{
      rootPath:     scanPath,
      scanPath:     scanPath,
      displayRoot:  scanPath,
      allFolders:   folders || [],
      folderTokens: folderTokens || {},
    }];
  }

  const totalFolders = rootsInfo.reduce((n, r) => n + (r.allFolders?.length || 0), 0);
  if (totalFolders === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="2" style="padding:8px;color:#aaa;font-size:12px;border:1px solid #e0e0e0;">
      フォルダが見つかりませんでした</td>`;
    tbody.appendChild(tr);
    return;
  }

  // チップの背景色・ボーダー色をタイプ別に定義
  const chipStyle = {
    main: "background:#e8f5e9;border:1px solid #a5d6a7;",
    sub:  "background:#e3f2fd;border:1px solid #90caf9;",
    auth: "background:#fff3e0;border:1px solid #ffcc80;",
  };

  const multiRoot = rootsInfo.length > 1;

  for (const ri of rootsInfo) {
    const rootPath    = ri.rootPath;
    const rootDisplay = ri.displayRoot || ri.scanPath || ri.rootPath || "";
    // スキャンルートの最後のフォルダ名を取得（"."セル表示用）
    const rootName = (rootDisplay || "").replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean).pop() || rootDisplay;

  for (const folder of (ri.allFolders || [])) {
    const tagKey = _extTagKey(rootPath, folder);
    // 初期メインタグ: Python から受け取った絶対パストークン（除外ワード適用済み）
    const initialMainTags = (ri.folderTokens || {})[folder] || [];
    _extFolderTagMap[tagKey] = { mainTags: [...initialMainTags], subTags: [], authTags: [] };

    // フォルダ表示: 複数ルートなら X-3（薄字ルート + 太字相対パス）
    let displayName;
    if (multiRoot) {
      const rootLine = `<div style="font-size:10px;color:#888;font-weight:400;word-break:break-all;line-height:1.3;">${escHtml(rootDisplay)}</div>`;
      const relLine  = folder === "."
        ? `<div style="font-size:11px;font-weight:600;color:#2c3e50;line-height:1.3;">${escHtml(rootName)} <span style="font-size:10px;color:#888;font-weight:400;">（ルート直下）</span></div>`
        : `<div style="font-size:11px;font-weight:600;color:#2c3e50;word-break:break-all;line-height:1.3;">${escHtml(folder)}</div>`;
      displayName = rootLine + relLine;
    } else {
      displayName = folder === "."
        ? `${escHtml(rootName)} <span style="font-size:10px;color:#888;">（ルート）</span>`
        : escHtml(folder);
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="padding:4px 8px;border:1px solid #e0e0e0;${multiRoot ? "" : "white-space:nowrap;"}font-size:11px;
        ${multiRoot ? "" : "font-weight:600;"}color:#2c3e50;vertical-align:top;">${displayName}</td>
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
      const arr = _extFolderTagMap[tagKey][type + "Tags"];
      const el  = chipsEls[type];
      el.innerHTML = "";
      arr.forEach((tag, i) => {
        const chip = document.createElement("span");
        chip.draggable = true;
        chip.style.cssText = `${chipStyle[type]}border-radius:10px;padding:1px 8px;font-size:11px;display:inline-flex;align-items:center;gap:3px;cursor:grab;`;
        chip.innerHTML = `${escHtml(tag)}<span data-idx="${i}" style="cursor:pointer;color:#999;font-size:10px;line-height:1;padding-left:2px;">✕</span>`;
        chip.querySelector("span").addEventListener("click", (ev) => {
          _extFolderTagMap[tagKey][type + "Tags"].splice(Number(ev.target.dataset.idx), 1);
          renderChips(type);
        });
        // ドラッグ開始: 移動元情報を記録・同行チップの pointer-events を無効化
        chip.addEventListener("dragstart", (e) => {
          _extDragData = { folder: tagKey, type, idx: i, tag };
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
        if (!_extDragData || _extDragData.folder !== tagKey) return;
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
        if (!_extDragData || _extDragData.folder !== tagKey) return;
        const { type: srcType, idx: srcIdx, tag } = _extDragData;
        if (srcType === targetType) return;
        // ソースから削除、ターゲットに追加（重複なし）
        _extFolderTagMap[tagKey][srcType + "Tags"].splice(srcIdx, 1);
        const targetArr = _extFolderTagMap[tagKey][targetType + "Tags"];
        if (!targetArr.includes(tag)) targetArr.push(tag);
        renderChips(srcType);
        renderChips(targetType);
        _extDragData = null;
      });
    });

    const addTag = (input, type) => {
      const v = input.value.trim();
      if (!v) return;
      const arr = _extFolderTagMap[tagKey][type + "Tags"];
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
  } // end for rootsInfo
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
  // v1.22.0: ルート修飾キー（${sourceRoot}\0${relFolder}）で _extFolderTagMap を参照。
  //          後方互換として relFolder 単独キーへのフォールバックも保持。
  const pendingEntries = entries.map(e => {
    const tagKey = e.sourceRoot ? _extTagKey(e.sourceRoot, e.relFolder) : e.relFolder;
    const fm = _extFolderTagMap[tagKey]
            || _extFolderTagMap[e.relFolder]
            || { mainTags: [], subTags: [], authTags: [] };
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
      // 完了履歴の集計用に保持（saveHistory には載せない方が良いが、軽量なので残す）
      _completionRoot: e.completionRoot || e.sourceRoot || null,
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
          const mime = thumbRes.thumbMimes?.[entry.filePath] || "image/jpeg";
          await browser.runtime.sendMessage({
            type:   "IMPORT_IDB_THUMBS",
            thumbs: [{ id: pending.id, dataUrl: `data:${mime};base64,${b64}` }],
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

  // v1.22.0: 一括取り込みの完了履歴を記録（ルートパスごとに集計）
  const rootCounts = new Map(); // rootPath → { doneCount, total }
  for (const pe of pendingEntries) {
    const rp = pe._completionRoot;
    if (!rp) continue;
    if (!rootCounts.has(rp)) rootCounts.set(rp, { doneCount: 0, total: 0 });
    const c = rootCounts.get(rp);
    c.doneCount++;
    c.total++;
  }
  if (rootCounts.size > 0) {
    for (const [rp, c] of rootCounts) {
      _extCompletedRoots = _extCompletedRoots.filter(r =>
        (r.rootPath || "").toLowerCase() !== rp.toLowerCase());
      _extCompletedRoots.unshift({
        rootPath:     rp,
        completedAt:  new Date().toISOString(),
        totalCount:   c.total,
        doneCount:    c.doneCount,
        skippedCount: 0,
        source:       "batch",
      });
    }
    await browser.storage.local.set({ extImportCompletedRoots: _extCompletedRoots });
    _extRenderCompletedRoots();
  }

  // v1.25.4 IMPROVE-ext-bulk-refresh: 一括取込完了後に統合テーブル（状態バッジ・進捗・サムネ統計）を再描画
  //   ページ全体リロード不要で完了状態を即反映
  _extRenderFolderList();

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
    // v1.25.4 IMPROVE-ext-bulk-refresh: undo 後も統合テーブルを再描画（取消で「完了」が巻き戻った状態を反映）
    _extRenderFolderList();
  });
  actionsEl.appendChild(undoBtn);
  actionsEl.style.display = "";
}

// ================================================================
// v1.20.0: 外部取り込み 1枚ずつ形式（b1/b2/b3/c1/c2 + 完了履歴）
// ================================================================

/** 外部取り込みタブ setup の末尾で呼ばれる初期化 */
async function _setupExtPerItemMode() {
  const stored = await browser.storage.local.get([
    "extImportMode", "extImportSessions", "extImportFolderList", "extImportCompletedRoots",
    // v1.23.0: GROUP-1-a2 / GROUP-1-b 設定
    "extImportCarryover", "extImportCopyToDest",
    // v1.27.0 GROUP-19: アクティブタブの永続化
    "extImportFlActiveTab",
    // v1.28.0 GROUP-19 Phase B/C: ソート・タブ順序・テーブル高さ
    "extImportFlSortModes", "extImportFlTabOrder", "extImportFlTableHeight",
  ]);
  _extMode           = stored.extImportMode       || "batch";
  _extSessions       = stored.extImportSessions   || [];
  _extFolderList     = stored.extImportFolderList || [];
  _extCompletedRoots = stored.extImportCompletedRoots || [];
  _extFlActiveTab    = stored.extImportFlActiveTab || "single";
  _extFlSortModes    = stored.extImportFlSortModes || {};
  _extFlTabOrder     = stored.extImportFlTabOrder || [];
  _extFlTableHeight  = stored.extImportFlTableHeight || null;
  // v1.23.0
  _extCarryover = Object.assign(
    { tags: false, subtags: false, authors: false, savepath: false },
    stored.extImportCarryover || {}
  );
  _extB1CopyToDest = !!stored.extImportCopyToDest;

  // モード切替の初期反映
  const rBatch = document.getElementById("ext-mode-batch");
  const rPer   = document.getElementById("ext-mode-per-item");
  if (_extMode === "per_item" && rPer) rPer.checked = true;
  else if (rBatch) rBatch.checked = true;
  _applyExtModeUI();

  // モード切替イベント
  rBatch?.addEventListener("change", async () => {
    if (rBatch.checked) {
      _extMode = "batch";
      await browser.storage.local.set({ extImportMode: "batch" });
      _applyExtModeUI();
    }
  });
  rPer?.addEventListener("change", async () => {
    if (rPer.checked) {
      _extMode = "per_item";
      await browser.storage.local.set({ extImportMode: "per_item" });
      _applyExtModeUI();
    }
  });

  // c1 フォルダリスト操作（v1.22.0 で per-item 専用→共通化）
  document.getElementById("ext-fl-add-single")?.addEventListener("click", _extFlAddSingle);
  document.getElementById("ext-fl-add-subfolders")?.addEventListener("click", _extFlOpenSubfolderPicker);
  document.getElementById("ext-fl-picker-ok")?.addEventListener("click", _extFlApplySubfolders);
  document.getElementById("ext-fl-picker-cancel")?.addEventListener("click", () => {
    document.getElementById("ext-fl-subfolder-picker").style.display = "none";
    _extSubfolderCands = [];
  });
  // v1.22.0: ピッカーヘッダー一括ボタン
  document.getElementById("ext-fl-picker-all")?.addEventListener("click", () => _extPickerSetAll(true));
  document.getElementById("ext-fl-picker-none")?.addEventListener("click", () => _extPickerSetAll(false));
  document.getElementById("ext-fl-picker-invert")?.addEventListener("click", () => _extPickerInvertAll());

  // v1.22.0: フォルダリスト一括操作バー
  document.getElementById("ext-fl-bulk-all")?.addEventListener("click",     () => _extFlSelectAll(true));
  document.getElementById("ext-fl-bulk-none")?.addEventListener("click",    () => _extFlSelectAll(false));
  document.getElementById("ext-fl-bulk-invert")?.addEventListener("click",  () => _extFlSelectInvert());
  document.getElementById("ext-fl-bulk-batch")?.addEventListener("click",   () => _extFlBulkImport("batch"));
  document.getElementById("ext-fl-bulk-peritem")?.addEventListener("click", () => _extFlBulkImport("per_item"));
  document.getElementById("ext-fl-bulk-delete")?.addEventListener("click",  () => _extFlBulkDelete());

  // C 完了履歴トグル
  document.getElementById("ext-completed-toggle")?.addEventListener("click", () => {
    const panel = document.getElementById("ext-completed-panel");
    const toggle = document.getElementById("ext-completed-toggle");
    const isOpen = panel.style.display !== "none";
    panel.style.display = isOpen ? "none" : "";
    toggle.textContent = (isOpen ? "▸" : "▾")
      + " 完了ルートフォルダ履歴 ";
    const cntSpan = document.createElement("span");
    cntSpan.style.cssText = "font-size:11px;color:#888;font-weight:400;";
    cntSpan.textContent = `(${_extCompletedRoots.length} 件)`;
    toggle.appendChild(cntSpan);
  });

  // v1.23.4: GROUP-11-carryover-move
  // 引き継ぎチェックの UI は 1枚ずつ取り込みモーダル内の各項目ラベル横へ移設済み。
  // イベント配線は _extB1SetupEvents() 内の _wireCarry で行う。

  // b1 オーバーレイのイベント設定
  _extB1SetupEvents();

  // 初期レンダリング
  _extRenderFolderList();
  _extRenderSessionsList();
  _extRenderCompletedRoots();
}

function _applyExtModeUI() {
  const batchEl = document.getElementById("ext-batch-mode");
  const perEl   = document.getElementById("ext-per-item-mode");
  const hintEl  = document.getElementById("ext-mode-hint");
  // v1.23.4: 引き継ぎ設定ボックスはモーダル内へ移設したため、ここでの表示切替は不要
  if (!batchEl || !perEl) return;
  if (_extMode === "per_item") {
    batchEl.style.display = "none";
    perEl.style.display   = "";
    if (hintEl) hintEl.textContent = "1枚ずつプレビュー表示しながら取り込みます。中断・再開、複数セッション並行可。";
  } else {
    batchEl.style.display = "";
    perEl.style.display   = "none";
    if (hintEl) hintEl.textContent = "従来の一括取り込み形式です。";
  }
}

// ---------- c1/c2: 取り込み予定フォルダリスト ----------

async function _extFlSave() {
  await browser.storage.local.set({ extImportFolderList: _extFolderList });
}

/**
 * v1.26.4 (BUG-tyfl-dup-import): フォルダパスの正規化共通関数。
 * Windows パス差異（末尾 `\` の有無、`\\` 連続、`/` 混在、大小文字）を吸収する。
 * 既存 `_extFlIsCompleted` 内のインライン `n` 関数と同じ仕様を共通化した。
 */
function _normalizeExtPath(p) {
  return (p || "").replace(/[\\/]+/g, "/").replace(/\/$/, "").toLowerCase();
}

function _extFlIsCompleted(rootPath) {
  return _extCompletedRoots.some(r => _normalizeExtPath(r.rootPath) === _normalizeExtPath(rootPath));
}

async function _extFlAddSingle() {
  const inputEl = document.getElementById("ext-fl-path");
  const path    = (inputEl?.value || "").trim();
  if (!path) { showStatus("⚠️ フォルダパスを入力してください", true); return; }
  // v1.26.4: 正規化比較＋子パスも走査。v1.26.5: ハード拒否 → 確認ダイアログに変更
  const np = _normalizeExtPath(path);
  const conflicts = _extFolderList.filter(f =>
    _normalizeExtPath(f.rootPath) === np ||
    (f.mode === "subfolders" && (f.subfolders || []).some(sub => _normalizeExtPath(sub.path) === np))
  );
  if (conflicts.length > 0) {
    if (!confirm(`⚠️ 「${path}」は既に登録されています。\n既存のエントリを削除して登録し直しますか？`)) return;
    // 既存を削除。subfolders エントリは該当子パスのみ除去（他の子は保持）
    for (const f of conflicts) {
      if (f.mode === "subfolders") {
        f.subfolders = (f.subfolders || []).filter(sub => _normalizeExtPath(sub.path) !== np);
        if (f.subfolders.length === 0) {
          _extFolderList = _extFolderList.filter(x => x.id !== f.id);
        }
      } else {
        _extFolderList = _extFolderList.filter(x => x.id !== f.id);
      }
    }
  }
  _extFolderList.push({
    id: crypto.randomUUID(),
    rootPath: path,
    mode: "single",
    subfolders: [],
    done: false,
    createdAt: new Date().toISOString(),
  });
  await _extFlSave();
  _extRenderFolderList();
  if (inputEl) inputEl.value = "";
  showStatus("✅ フォルダを登録しました");
}

async function _extFlOpenSubfolderPicker() {
  const inputEl = document.getElementById("ext-fl-path");
  const parent  = (inputEl?.value || "").trim();
  if (!parent) { showStatus("⚠️ 親フォルダパスを入力してください", true); return; }

  const pickerEl = document.getElementById("ext-fl-subfolder-picker");
  const parentEl = document.getElementById("ext-fl-picker-parent");
  const listEl   = document.getElementById("ext-fl-picker-list");
  if (parentEl) parentEl.textContent = parent;
  if (listEl)   listEl.innerHTML = "⏳ サブフォルダを取得中...";
  pickerEl.style.display = "";

  let res;
  try {
    res = await browser.runtime.sendMessage({ type: "LIST_SUBFOLDERS", path: parent });
  } catch (e) {
    listEl.innerHTML = `<div style="color:#c0392b;">エラー: ${escHtml(e.message || "")}</div>`;
    return;
  }
  if (!res?.ok) {
    listEl.innerHTML = `<div style="color:#c0392b;">取得失敗: ${escHtml(res?.error || "")}</div>`;
    return;
  }

  _extSubfolderCands = (res.subfolders || []).map(s => ({
    path: s.path, name: s.name, checked: false,
  }));
  _extPickerLastClickedIdx = -1;
  _extPickerDrag           = null;

  if (_extSubfolderCands.length === 0) {
    listEl.innerHTML = `<div style="color:#888;">直下にサブフォルダがありません。</div>`;
    _extPickerUpdateCount();
    return;
  }

  listEl.innerHTML = "";
  _extSubfolderCands.forEach((s, idx) => {
    // v1.22.0: <label> → <div> に変更。cb のデフォルト toggle を使わず mousedown で制御
    const row = document.createElement("div");
    row.dataset.idx = String(idx);
    row.style.cssText = "display:flex;align-items:center;gap:6px;padding:3px 4px;cursor:pointer;border-radius:3px;";
    row.onmouseover = () => { if (!_extPickerDrag) row.style.background = "#f0f6ff"; };
    row.onmouseout  = () => { row.style.background = ""; };

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.idx = String(idx);
    cb.checked = s.checked;
    // cb 自身のクリックでのデフォルト toggle を殺す（mousedown で一元管理するため）
    cb.addEventListener("click", (ev) => { ev.preventDefault(); });

    const label = document.createElement("span");
    label.style.cssText = "font-size:12px;color:#2c3e50;pointer-events:none;user-select:none;";
    label.textContent = s.name;
    if (_extFlIsCompleted(s.path)) {
      const sp = document.createElement("span");
      sp.innerHTML = ' <span style="font-size:10px;color:#e67e22;">（過去に完了）</span>';
      label.appendChild(sp);
    }

    row.appendChild(cb);
    row.appendChild(label);

    row.addEventListener("mousedown", (ev) => {
      // クリック／ドラッグ開始を拾う
      if (ev.button !== 0) return;  // 左クリック以外は無視
      ev.preventDefault();          // テキスト選択・デフォルト toggle 抑止
      const i = idx;

      // Shift 押下: 範囲選択（起点～現在）
      if (ev.shiftKey && _extPickerLastClickedIdx >= 0) {
        const from = Math.min(_extPickerLastClickedIdx, i);
        const to   = Math.max(_extPickerLastClickedIdx, i);
        if (ev.altKey) {
          // Alt+Shift: 範囲反転
          for (let j = from; j <= to; j++) {
            _extSubfolderCands[j].checked = !_extSubfolderCands[j].checked;
          }
        } else {
          // 通常 Shift: 範囲を「現在行の反転後状態」に揃える
          const newState = !_extSubfolderCands[i].checked;
          for (let j = from; j <= to; j++) {
            _extSubfolderCands[j].checked = newState;
          }
        }
        _extPickerLastClickedIdx = i;
        _extPickerDrag = null;  // Shift 時はドラッグ追従しない
        _extPickerSyncDOM();
        return;
      }

      // 通常クリック/ドラッグ開始
      const isInvert = !!ev.altKey;
      if (isInvert) {
        _extSubfolderCands[i].checked = !_extSubfolderCands[i].checked;
      } else {
        _extSubfolderCands[i].checked = !_extSubfolderCands[i].checked;
      }
      _extPickerLastClickedIdx = i;
      _extPickerDrag = {
        mode:      isInvert ? "invert" : "unify",
        target:    _extSubfolderCands[i].checked,   // unify 用
        processed: new Set([i]),
      };
      _extPickerSyncDOM();
    });

    row.addEventListener("mouseenter", () => {
      if (!_extPickerDrag) return;
      const i = idx;
      if (_extPickerDrag.processed.has(i)) return;
      _extPickerDrag.processed.add(i);
      if (_extPickerDrag.mode === "invert") {
        _extSubfolderCands[i].checked = !_extSubfolderCands[i].checked;
      } else {
        _extSubfolderCands[i].checked = _extPickerDrag.target;
      }
      _extPickerSyncDOM();
    });

    listEl.appendChild(row);
  });

  // ドラッグ終了のグローバルハンドラ（重複登録を避けつつ必ずクリアできるように）
  document.removeEventListener("mouseup", _extPickerMouseUp);
  document.addEventListener("mouseup",    _extPickerMouseUp);

  _extPickerSyncDOM();
}

/** v1.22.0: ピッカー側の DOM チェックボックスを _extSubfolderCands に同期＋件数表示更新 */
function _extPickerSyncDOM() {
  const listEl = document.getElementById("ext-fl-picker-list");
  if (listEl) {
    listEl.querySelectorAll("input[type='checkbox'][data-idx]").forEach(cb => {
      const i = Number(cb.dataset.idx);
      if (!Number.isFinite(i) || !_extSubfolderCands[i]) return;
      cb.checked = !!_extSubfolderCands[i].checked;
    });
  }
  _extPickerUpdateCount();
}

/** v1.22.0: ピッカー上部の件数表示 */
function _extPickerUpdateCount() {
  const el = document.getElementById("ext-fl-picker-count");
  if (!el) return;
  const total = _extSubfolderCands.length;
  const n     = _extSubfolderCands.filter(s => s.checked).length;
  el.textContent = total > 0 ? `${n} / ${total} 件選択中` : "";
}

/** v1.22.0: ピッカー全選択/全解除 */
function _extPickerSetAll(state) {
  _extSubfolderCands.forEach(s => { s.checked = !!state; });
  _extPickerSyncDOM();
}

/** v1.22.0: ピッカー反転 */
function _extPickerInvertAll() {
  _extSubfolderCands.forEach(s => { s.checked = !s.checked; });
  _extPickerSyncDOM();
}

/** v1.22.0: mouseup でドラッグ状態をクリア（document レベル） */
function _extPickerMouseUp() {
  _extPickerDrag = null;
}

async function _extFlApplySubfolders() {
  const selected = _extSubfolderCands.filter(s => s.checked);
  if (selected.length === 0) {
    showStatus("⚠️ サブフォルダを1つ以上選択してください", true);
    return;
  }
  const parent = document.getElementById("ext-fl-picker-parent")?.textContent || "";
  const nparent = _normalizeExtPath(parent);
  // v1.26.5: 親重複 → 確認ダイアログ（置き換え / キャンセル）
  const parentConflict = _extFolderList.find(f => _normalizeExtPath(f.rootPath) === nparent);
  if (parentConflict) {
    if (!confirm(`⚠️ 親フォルダ「${parent}」は既に登録されています。\n既存エントリを削除して再登録しますか？`)) return;
    _extFolderList = _extFolderList.filter(f => f.id !== parentConflict.id);
  }
  // v1.26.5: 子パス重複 → 3 択ダイアログ（スキップ / 置き換え / キャンセル）
  // childConflicts: { selectedPath, entry, type: "single"|"subfolder", subPath? } の配列
  const childConflicts = [];
  for (const sel of selected) {
    const sp = _normalizeExtPath(sel.path);
    for (const f of _extFolderList) {
      if (f.mode === "single" && _normalizeExtPath(f.rootPath) === sp) {
        childConflicts.push({ selectedPath: sel.path, entry: f, type: "single" });
      } else if (f.mode === "subfolders") {
        for (const sub of (f.subfolders || [])) {
          if (_normalizeExtPath(sub.path) === sp) {
            childConflicts.push({ selectedPath: sel.path, entry: f, subPath: sub.path, type: "subfolder" });
          }
        }
      }
    }
  }
  let finalSelected = selected;
  if (childConflicts.length > 0) {
    const action = await _showBulkConflictDialog(selected.length, childConflicts);
    if (action === "cancel") return;
    if (action === "skip") {
      const conflictSet = new Set(childConflicts.map(c => _normalizeExtPath(c.selectedPath)));
      finalSelected = selected.filter(s => !conflictSet.has(_normalizeExtPath(s.path)));
      if (finalSelected.length === 0) {
        showStatus("⚠️ 登録可能なサブフォルダがありません（すべて重複）", true);
        return;
      }
    } else if (action === "replace") {
      // 重複分を既存側から除去。subfolders エントリの子は該当 path のみ除去
      for (const c of childConflicts) {
        if (c.type === "single") {
          _extFolderList = _extFolderList.filter(f => f.id !== c.entry.id);
        } else if (c.type === "subfolder") {
          c.entry.subfolders = (c.entry.subfolders || []).filter(
            sub => _normalizeExtPath(sub.path) !== _normalizeExtPath(c.subPath)
          );
          if (c.entry.subfolders.length === 0) {
            _extFolderList = _extFolderList.filter(f => f.id !== c.entry.id);
          }
        }
      }
    }
  }
  _extFolderList.push({
    id: crypto.randomUUID(),
    rootPath: parent,
    mode: "subfolders",
    subfolders: finalSelected.map(s => ({ path: s.path, done: false })),
    done: false,
    createdAt: new Date().toISOString(),
  });
  await _extFlSave();
  document.getElementById("ext-fl-subfolder-picker").style.display = "none";
  _extSubfolderCands = [];
  _extRenderFolderList();
  showStatus(`✅ ${finalSelected.length} 件のサブフォルダを登録しました`);
}

/**
 * v1.26.5 (BUG-tyfl-dup-import UX): 一括サブフォルダ登録時に子パス重複が検出された場合のダイアログ。
 * Promise<"skip" | "replace" | "cancel"> を返す。
 * childConflicts: { selectedPath, entry, type: "single"|"subfolder", subPath? }[]
 */
function _showBulkConflictDialog(totalSelected, childConflicts) {
  return new Promise((resolve) => {
    const existing = document.querySelector(".bulk-conflict-overlay");
    if (existing) existing.remove();

    // 重複パス一覧（表示用、重複除去）
    const uniquePaths = [...new Set(childConflicts.map(c => c.selectedPath))];
    const sample = uniquePaths.slice(0, 5);
    const more = uniquePaths.length - sample.length;
    const sampleHtml = sample.map(p => `<li style="font-family:monospace;font-size:11px;word-break:break-all;">${escHtml(p)}</li>`).join("");
    const moreHtml = more > 0 ? `<li style="color:#888;font-size:11px;">…他 ${more} 件</li>` : "";

    const canRegisterAfterSkip = totalSelected - uniquePaths.length;

    const overlay = document.createElement("div");
    overlay.className = "bulk-conflict-overlay period-dialog-overlay";
    overlay.innerHTML = `
      <div class="period-dialog" style="max-width:520px">
        <h3>⚠️ サブフォルダの一部が既に登録されています</h3>
        <div style="font-size:13px;color:#444;line-height:1.7;margin-bottom:10px">
          選択中 <b>${totalSelected} 件</b> のうち <b>${uniquePaths.length} 件</b> が既存エントリ（単体登録 or 他のサブフォルダグループ）と重複しています：
        </div>
        <ul style="margin:0 0 14px 16px;padding:0;max-height:180px;overflow:auto;border:1px solid #eee;padding:6px 12px;border-radius:4px;">
          ${sampleHtml}${moreHtml}
        </ul>
        <div class="pd-footer" style="gap:6px;flex-wrap:wrap;justify-content:flex-end">
          <button class="pd-cancel">キャンセル</button>
          <button class="btn-skip pd-ok" style="background:#3498db"
            ${canRegisterAfterSkip === 0 ? "disabled" : ""}>重複をスキップして ${canRegisterAfterSkip} 件登録</button>
          <button class="btn-replace pd-ok" style="background:#e67e22">重複を置き換えて ${totalSelected} 件登録</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    overlay.querySelector(".btn-skip").addEventListener("click", () => { overlay.remove(); resolve("skip"); });
    overlay.querySelector(".btn-replace").addEventListener("click", () => { overlay.remove(); resolve("replace"); });
    overlay.querySelector(".pd-cancel").addEventListener("click", () => { overlay.remove(); resolve("cancel"); });
    overlay.addEventListener("click", e => { if (e.target === overlay) { overlay.remove(); resolve("cancel"); } });
  });
}

/**
 * v1.22.0: 取り込み予定リストの行キー生成
 *   - single   行: item.id 単独
 *   - subfolders 行: `${item.id}\0${sub.path}`（グループヘッダ行は選択対象外）
 */
function _extFlRowKey(itemId, subPath) {
  return subPath ? `${itemId}\0${subPath}` : itemId;
}

/**
 * v1.22.0: 選択中の論理エントリ一覧を返す
 *   返り値: [{ folderListItem, rootPath, subfolderPath|null }, ...]
 *   - subfolderPath が null の場合: rootPath をそのまま取り込み対象とする
 *   - subfolderPath があれば、その物理パスが取り込み対象（rootPath は親）
 */
function _extFlGetSelectedEntries() {
  // v1.27.0 GROUP-19 Phase A: 現在アクティブなタブ内のエントリに限定
  // 他タブの選択状態は保持するが、一括操作や件数表示の対象外とする
  const source = (typeof _extFlActiveTab !== "undefined") ? _extFlFilterByTab(_extFlActiveTab) : _extFolderList;
  const out = [];
  for (const item of source) {
    if (item.mode === "single") {
      if (_extFlSelectedKeys.has(_extFlRowKey(item.id, null))) {
        out.push({ folderListItem: item, rootPath: item.rootPath, subfolderPath: null });
      }
    } else if (item.mode === "subfolders") {
      for (const sub of (item.subfolders || [])) {
        if (_extFlSelectedKeys.has(_extFlRowKey(item.id, sub.path))) {
          out.push({ folderListItem: item, rootPath: item.rootPath, subfolderPath: sub.path });
        }
      }
    }
  }
  return out;
}

/** v1.27.0 GROUP-19 Phase A: 現在タブ内の全行 key 集合を返す（全選択／反転で使用） */
function _extFlKeysInTab(tabId) {
  const items = _extFlFilterByTab(tabId);
  const keys = new Set();
  for (const item of items) {
    if (item.mode === "single") {
      keys.add(_extFlRowKey(item.id, null));
    } else if (item.mode === "subfolders") {
      for (const sub of (item.subfolders || [])) {
        keys.add(_extFlRowKey(item.id, sub.path));
      }
    }
  }
  return keys;
}

/** v1.22.0: 一括バー右端の選択件数表示更新 */
function _extFlUpdateBulkCount() {
  const el = document.getElementById("ext-fl-bulk-count");
  if (!el) return;
  const n = _extFlGetSelectedEntries().length;
  el.textContent = n > 0 ? `${n} 件選択中` : "（未選択）";
}

/** v1.22.0: ☑ 一括選択／全解除
 *  v1.27.0 GROUP-19 Phase A: 現在アクティブなタブ内のエントリのみに操作を限定。
 *  他タブのチェック状態は保持する（Qu-Z1=A、Qu-19-10=A）。 */
function _extFlSelectAll(state) {
  const tabKeys = _extFlKeysInTab(_extFlActiveTab);
  if (state) {
    for (const k of tabKeys) _extFlSelectedKeys.add(k);
  } else {
    for (const k of tabKeys) _extFlSelectedKeys.delete(k);
  }
  _extRenderFolderList();
}

/** v1.22.0: ☑ 反転
 *  v1.27.0 GROUP-19 Phase A: 現在アクティブなタブ内のエントリのみを反転。他タブは影響なし。 */
function _extFlSelectInvert() {
  const tabKeys = _extFlKeysInTab(_extFlActiveTab);
  for (const k of tabKeys) {
    if (_extFlSelectedKeys.has(k)) _extFlSelectedKeys.delete(k);
    else _extFlSelectedKeys.add(k);
  }
  _extRenderFolderList();
}

/** v1.22.0: 選択行を一括削除 */
async function _extFlBulkDelete() {
  const sel = _extFlGetSelectedEntries();
  if (sel.length === 0) { showStatus("⚠️ 選択行がありません", true); return; }
  if (!confirm(`選択した ${sel.length} 件を取り込み予定リストから削除しますか？`)) return;
  // single 行: そのまま除外。subfolders 行: 該当 sub を抜き、空になったらグループも削除
  const removeKeys = _extFlSelectedKeys;
  _extFolderList = _extFolderList
    .map(item => {
      if (item.mode === "single") {
        return removeKeys.has(_extFlRowKey(item.id, null)) ? null : item;
      } else if (item.mode === "subfolders") {
        const remaining = (item.subfolders || []).filter(s =>
          !removeKeys.has(_extFlRowKey(item.id, s.path))
        );
        if (remaining.length === 0) return null;
        return { ...item, subfolders: remaining };
      }
      return item;
    })
    .filter(Boolean);
  _extFlSelectedKeys.clear();
  await _extFlSave();
  _extRenderFolderList();
  showStatus(`✅ ${sel.length} 件を削除しました`);
}

/** v1.22.0: 選択行を一括 / 1枚ずつ取り込みに渡す */
async function _extFlBulkImport(mode /* "batch" | "per_item" */) {
  const sel = _extFlGetSelectedEntries();
  if (sel.length === 0) { showStatus("⚠️ 選択行がありません", true); return; }
  if (mode === "per_item") {
    // 1枚ずつ：選択行ごとに既存のセッション開始フローを呼ぶ
    if (!confirm(`選択した ${sel.length} 件を 1枚ずつ取り込みのセッションとして開始しますか？`)) return;
    // モードを 1枚ずつ形式に切替（ユーザーがすぐ見えるように）
    const rPer = document.getElementById("ext-mode-per-item");
    if (rPer && !rPer.checked) { rPer.checked = true; rPer.dispatchEvent(new Event("change")); }
    for (const e of sel) {
      try {
        await _extStartSessionFromFolderList(
          e.folderListItem,
          e.subfolderPath || e.rootPath,
          e.subfolderPath || null
        );
      } catch (err) {
        console.error("[ext] start session failed", err);
      }
    }
    showStatus(`📥 ${sel.length} 件のセッションを作成しました`);
  } else {
    // 一括取り込み：複数ルートを順次スキャンして 1 つのタグ設定テーブルへ統合
    if (!confirm(`選択した ${sel.length} 件を一括スキャンして、フォルダ別タグ設定画面を開きますか？`)) return;
    // モードを一括形式に切替（ユーザーがすぐ見えるように）
    const rBatch = document.getElementById("ext-mode-batch");
    if (rBatch && !rBatch.checked) { rBatch.checked = true; rBatch.dispatchEvent(new Event("change")); }
    await _extScanMultiRootForBatch(sel);
  }
}

/**
 * v1.22.0: β動線 — 選択エントリ（複数ルート可）を順次スキャンし、
 *  1 つのフォルダ別タグ設定テーブルへ統合してインポート準備状態にする。
 *
 *  selEntries: [{ folderListItem, rootPath, subfolderPath }, ...]
 *  - subfolderPath が null なら rootPath でスキャン
 *  - subfolderPath があればその物理パスでスキャン（ルート修飾キーには rootPath を使用）
 */
async function _extScanMultiRootForBatch(selEntries) {
  if (!selEntries || selEntries.length === 0) {
    showStatus("⚠️ 取り込み対象が選択されていません", true);
    return;
  }

  // UI 上のスキャン結果エリアをリセット
  const resultEl = document.getElementById("ext-scan-result");
  if (resultEl) {
    resultEl.innerHTML = "";
    resultEl.className = "import-result";
    resultEl.style.display = "block";
  }
  const log = (msg) => { if (resultEl) resultEl.innerHTML += escHtml(msg) + "\n"; };

  // 除外ワードを収集
  const stored = await browser.storage.local.get(["extImportExcludes", "extImportCutoffDate", "saveHistory"]);
  const savedExcludes  = stored.extImportExcludes || [];
  const allExcludes    = [...savedExcludes, ..._extTempExcludes];
  const excludesNorm   = allExcludes.map(s => s.normalize("NFKC").toLowerCase());
  const cutoffIso      = stored.extImportCutoffDate
    ? new Date(stored.extImportCutoffDate).toISOString() : "";

  // 既存 saveHistory から重複チェック用 Set を準備
  const existingKeys = new Set(
    (stored.saveHistory || []).map(e => {
      const p = Array.isArray(e.savePaths) ? (e.savePaths[0] || "") : (e.savePath || "");
      return `${p}\0${e.filename || e.fileName || ""}`;
    })
  );

  let totalScanned = 0;
  let totalDeduped = 0;
  let totalSkipped = 0;
  const allEntries  = [];
  const rootsInfo   = [];

  log(`⏳ ${selEntries.length} 件のフォルダをスキャン中...`);

  for (const sel of selEntries) {
    const scanTarget = sel.subfolderPath || sel.rootPath;
    // rootPath: _extFolderTagMap のキー上位部分（完了履歴キー兼）
    const rootPath   = sel.rootPath;

    let res;
    try {
      res = await browser.runtime.sendMessage({
        type:       "SCAN_EXTERNAL_IMAGES",
        path:       scanTarget,
        cutoffDate: cutoffIso,
        excludes:   excludesNorm,
      });
    } catch (e) {
      log(`❌ スキャン失敗 (${scanTarget}): ${e.message || ""}`);
      continue;
    }
    if (!res?.ok) {
      log(`❌ スキャン失敗 (${scanTarget}): ${res?.error || "不明なエラー"}`);
      continue;
    }

    const deduped = (res.entries || [])
      .filter(e => !existingKeys.has(`${e.savePath}\0${e.fileName}`))
      .map(e => ({
        ...e,
        sourceRoot:      rootPath,
        completionRoot:  rootPath,
      }));

    totalScanned += res.scanned || 0;
    totalDeduped += deduped.length;
    totalSkipped += (res.entries?.length || 0) - deduped.length;

    allEntries.push(...deduped);

    rootsInfo.push({
      rootPath,
      scanPath:    rootPath,
      displayRoot: rootPath,
      allFolders:   res.allFolders   || [],
      folderTokens: res.folderTokens || {},
    });

    log(`  ✓ ${scanTarget}: ${res.scanned} 件スキャン / ${deduped.length} 件対象`);
  }

  if (allEntries.length === 0) {
    log(`📋 対象エントリが 0 件でした（スキャン: ${totalScanned} 件）`);
    if (resultEl) resultEl.className = "import-result success";
    return;
  }

  // _extScanResult をβ動線の形式で更新
  _extScanResult = {
    ok:      true,
    entries: allEntries,
    roots:   rootsInfo,
  };

  // タグ設定テーブルを多ルート形式で描画
  await renderFolderTable([], {}, "", rootsInfo);

  // タグ設定・インポート実行セクションを表示
  document.getElementById("ext-tag-section").style.display    = "";
  document.getElementById("ext-import-section").style.display = "";
  const countEl = document.getElementById("ext-entry-count");
  if (countEl) countEl.textContent = allEntries.length;
  const warnEl = document.getElementById("ext-thumb-warning");
  if (warnEl) warnEl.style.display = document.getElementById("ext-gen-thumb").checked ? "" : "none";

  if (resultEl) {
    resultEl.className = "import-result success";
    resultEl.innerHTML = "";
    log(`✅ スキャン完了: 合計 ${totalScanned} 件スキャン`);
    log(`📋 対象: ${totalDeduped} 件（重複スキップ: ${totalSkipped} 件）`);
  }
}

// v1.25.0 GROUP-12-merge / GROUP-7-b-ui: 外部取り込み統合テーブル用ヘルパー群
// ----------------------------------------------------------------
// サムネ統計キャッシュ（background.js の externalImportThumbStats を反映）
let _extThumbStatsCache = {};

// ステータスバッジ色（進行中=青、未開始=グレー、完了=緑、空=オレンジ）
const _EXT_STATUS_BADGE_COLOR = {
  notstarted: "#95a5a6",
  inprogress: "#3498db",
  done:       "#2ecc71",
  empty:      "#e67e22",
};

function _extBuildStatusBadge(kind, label) {
  const color = _EXT_STATUS_BADGE_COLOR[kind] || "#95a5a6";
  const span = document.createElement("span");
  span.style.cssText = `display:inline-block;font-size:10px;color:#fff;background:${color};padding:2px 7px;border-radius:8px;font-weight:600;white-space:nowrap;`;
  span.textContent = label;
  return span;
}

/** 対象パスに対応する最新セッションを返す（Q4=A: UI 側で 1:1 フィルタ） */
function _extFindLatestSession(targetPath) {
  if (!targetPath) return null;
  const norm = (p) => (p || "").toLowerCase();
  const t = norm(targetPath);
  let latest = null;
  for (const s of _extSessions) {
    // session.name（1 枚ずつ形式の画面上の表示名。subfolderPath または rootPath）と
    // session.rootPath の両方で一致を試みる
    if (norm(s.name) !== t && norm(s.rootPath) !== t) continue;
    if (!latest || new Date(s.updatedAt || s.createdAt || 0) > new Date(latest.updatedAt || latest.createdAt || 0)) {
      latest = s;
    }
  }
  return latest;
}

/** 行の状態を判定：未開始 / 進行中 / 完了 / 空 */
function _extDetermineStatus(targetPath) {
  const session = _extFindLatestSession(targetPath);
  if (session) {
    const queue = session.queue || [];
    if (queue.length === 0) return { kind: "empty", label: "空", session };
    const pending = queue.filter(q => q.status === "pending").length;
    if (pending > 0) return { kind: "inprogress", label: "進行中", session };
    return { kind: "done", label: "完了", session };
  }
  if (_extFlIsCompleted(targetPath)) return { kind: "done", label: "完了", session: null };
  return { kind: "notstarted", label: "未開始", session: null };
}

/** 進捗セル（縦積み：数値/% → バー → 完/skip/残） */
function _extBuildProgressCell(session) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:2px;";
  if (!session) {
    const dash = document.createElement("span");
    dash.style.cssText = "color:#aaa;font-size:11px;";
    dash.textContent = "—";
    wrap.appendChild(dash);
    return wrap;
  }
  const queue = session.queue || [];
  const total = queue.length;
  const done = queue.filter(q => q.status === "done").length;
  const skipped = queue.filter(q => q.status === "skipped").length;
  const pending = queue.filter(q => q.status === "pending").length;
  const pct = total > 0 ? ((done + skipped) / total * 100).toFixed(1) : "0.0";

  const line1 = document.createElement("div");
  line1.style.cssText = "font-size:11px;color:#2c3e50;";
  line1.textContent = `${done + skipped} / ${total}（${pct}%）`;
  wrap.appendChild(line1);

  const barBg = document.createElement("div");
  barBg.style.cssText = "position:relative;max-width:180px;height:6px;background:#e0e0e0;border-radius:3px;overflow:hidden;";
  if (total > 0) {
    const donePct = (done / total * 100);
    const skipPct = (skipped / total * 100);
    const doneBar = document.createElement("div");
    doneBar.style.cssText = `position:absolute;left:0;top:0;height:100%;width:${donePct}%;background:#2ecc71;`;
    const skipBar = document.createElement("div");
    skipBar.style.cssText = `position:absolute;left:${donePct}%;top:0;height:100%;width:${skipPct}%;background:#e67e22;`;
    barBg.appendChild(doneBar);
    barBg.appendChild(skipBar);
  }
  wrap.appendChild(barBg);

  const line3 = document.createElement("div");
  line3.style.cssText = "font-size:10px;color:#666;";
  line3.innerHTML = `<span style="color:#2ecc71;">完 ${done}</span>・<span style="color:#e67e22;">skip ${skipped}</span>・<span style="color:#888;">残 ${pending}</span>`;
  wrap.appendChild(line3);
  return wrap;
}

/** サムネ統計セル（GROUP-7-b-ui）：件数 / サイズ ＋ 🗑 削除 */
function _extBuildThumbCell(rootPath) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;gap:3px;font-size:11px;";
  const s = _extThumbStatsCache[rootPath];
  if (!s || !s.count) {
    const dash = document.createElement("span");
    dash.style.cssText = "color:#aaa;";
    dash.textContent = "—";
    wrap.appendChild(dash);
    return wrap;
  }
  const mb = (s.bytes || 0) / (1024 * 1024);
  const sizeLabel = mb >= 1
    ? `${mb.toFixed(1)} MB`
    : `${Math.max(1, Math.round((s.bytes || 0) / 1024))} KB`;
  const line1 = document.createElement("div");
  line1.style.cssText = "color:#2c3e50;";
  line1.textContent = `${s.count} 件 / ${sizeLabel}`;
  wrap.appendChild(line1);

  const btnDel = document.createElement("button");
  btnDel.className = "backup-btn";
  btnDel.style.cssText = "padding:1px 6px;font-size:10px;align-self:flex-start;";
  btnDel.textContent = "🗑 サムネ削除";
  btnDel.title = "このルートフォルダの取込用サムネを一括削除";
  btnDel.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`「${rootPath}」配下の取込用サムネ ${s.count} 件（${sizeLabel}）を削除しますか？`)) return;
    try {
      await browser.runtime.sendMessage({ type: "DELETE_EXT_THUMBS_BY_ROOT", rootPath });
      await _extRenderFolderList();  // 統計キャッシュを再ロードして再描画
    } catch (err) {
      showStatus(`❌ サムネ削除失敗: ${err.message || ""}`, true);
    }
  });
  wrap.appendChild(btnDel);
  return wrap;
}

/** 行の操作ボタン（ステータス別に切替） */
function _extBuildRowActions(item, targetPath, subfolderPath, statusInfo) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;gap:3px;flex-wrap:wrap;";
  const { kind, session } = statusInfo;

  // 完了行のみ：👁 閲覧
  if (kind === "done" && session) {
    const btnView = document.createElement("button");
    btnView.className = "backup-btn";
    btnView.style.cssText = "padding:2px 6px;font-size:10px;background:#e8f5e9;border-color:#a5d6a7;";
    btnView.title = "完了セッションを閲覧モードで開く";
    btnView.textContent = "👁 閲覧";
    btnView.addEventListener("click", () => {
      // v1.25.2 BUG-ext-view-autoclose:
      //   完了セッションは cursor が queue 末尾にあり cur=undefined かつ pendingRemain=0 で
      //   _extB1LoadCurrent が _extB1FinishSessionIfDone() を呼んでオーバーレイ自動クローズする。
      //   閲覧モードではまず cursor を先頭にリセットし、フィルタを全種 ON にして
      //   cur が有効な queue[0] を指すようにする（自動 Finish を回避）。
      session.cursor = 0;
      session.uiFilter = { done: true, skipped: true, pending: true };
      _extOpenB1(session);
    });
    wrap.appendChild(btnView);
  }

  // 🖼 1枚ずつ（進行中は再開、完了は再取込、未開始は ▶ 開始）
  const btnPer = document.createElement("button");
  btnPer.className = "backup-btn";
  btnPer.style.cssText = "padding:2px 6px;font-size:10px;background:#e3f2fd;border-color:#90caf9;";
  if (kind === "notstarted") {
    btnPer.textContent = "▶ 開始";
    btnPer.title = "このフォルダで 1 枚ずつ取り込みを開始";
  } else if (kind === "inprogress") {
    btnPer.textContent = "🖼 1枚ずつ";
    btnPer.title = "進行中セッションを再開";
  } else {
    btnPer.textContent = "🖼 1枚ずつ";
    btnPer.title = "このフォルダで 1 枚ずつ取り込み（再取込）";
  }
  btnPer.addEventListener("click", () => {
    const rPer = document.getElementById("ext-mode-per-item");
    if (rPer && !rPer.checked) { rPer.checked = true; rPer.dispatchEvent(new Event("change")); }
    if (kind === "inprogress" && session) {
      _extOpenB1(session);
    } else {
      _extStartSessionFromFolderList(item, targetPath, subfolderPath);
    }
  });
  wrap.appendChild(btnPer);

  // 🗑 リストから削除
  const btnDel = document.createElement("button");
  btnDel.className = "backup-btn";
  btnDel.style.cssText = "padding:2px 6px;font-size:10px;";
  btnDel.title = "リストから削除";
  btnDel.textContent = "🗑";
  btnDel.addEventListener("click", async () => {
    const label = subfolderPath || item.rootPath;
    if (!confirm(`「${label}」をリストから削除しますか？`)) return;
    if (item.mode === "single") {
      _extFolderList = _extFolderList.filter(f => f.id !== item.id);
      _extFlSelectedKeys.delete(_extFlRowKey(item.id, null));
    } else if (item.mode === "subfolders") {
      item.subfolders = (item.subfolders || []).filter(s => s.path !== subfolderPath);
      _extFlSelectedKeys.delete(_extFlRowKey(item.id, subfolderPath));
      if (item.subfolders.length === 0) {
        _extFolderList = _extFolderList.filter(f => f.id !== item.id);
      }
    }
    await _extFlSave();
    await _extRenderFolderList();
  });
  wrap.appendChild(btnDel);
  return wrap;
}

// ================================================================
// v1.27.0 GROUP-19 Phase A: タブ化ヘルパー
// ================================================================

/** 現在の _extFolderList からタブ一覧を計算
 *  - 単体タブ（"single"、固定、左端）
 *  - 各 subfolders エントリのルートごとに 1 タブ（"root:<normalizedPath>"、追加順）
 *  v1.28.0 Phase C: _extFlTabOrder に保存された順序を優先反映（D&D 並び替え結果）
 */
function _extFlGetTabs() {
  const tabs = [{ id: "single", label: "単体", fullPath: null }];
  // rootPath 集合を normalized で蓄積
  const rootMap = new Map(); // normRoot → { label, fullPath }
  for (const item of _extFolderList) {
    if (item.mode !== "subfolders") continue;
    const normRoot = _normalizeExtPath(item.rootPath);
    if (rootMap.has(normRoot)) continue;
    const parts = (item.rootPath || "").split(/[\\/]+/).filter(Boolean);
    const label = parts[parts.length - 1] || item.rootPath || "(root)";
    rootMap.set(normRoot, { label, fullPath: item.rootPath });
  }
  // 保存済み順序（_extFlTabOrder）に従って配置、未登録は末尾
  const orderedKeys = [
    ..._extFlTabOrder.filter(k => rootMap.has(k)),
    ...Array.from(rootMap.keys()).filter(k => !_extFlTabOrder.includes(k)),
  ];
  for (const normRoot of orderedKeys) {
    const info = rootMap.get(normRoot);
    tabs.push({ id: `root:${normRoot}`, label: info.label, fullPath: info.fullPath });
  }
  return tabs;
}

// ================================================================
// v1.28.0 GROUP-19 Phase B: ソート
// ================================================================

/** ステータス順序マップ（ステータス別ソート用） */
function _extFlStatusOrder(kind) {
  return ({ notstarted: 0, inprogress: 1, done: 2, empty: 3 })[kind] ?? 99;
}

/** エントリ／サブフォルダの targetPath からソート用メトリクスを抽出 */
function _extFlGetSortMetric(targetPath, mode) {
  if (mode === "path") return targetPath || "";
  if (mode === "status") {
    const s = _extDetermineStatus(targetPath);
    return _extFlStatusOrder(s.kind);
  }
  if (mode === "count") {
    const s = _extDetermineStatus(targetPath).session;
    return s?.queue?.length ?? -1;
  }
  if (mode === "progress") {
    const s = _extDetermineStatus(targetPath).session;
    if (!s?.queue?.length) return -1;
    const q = s.queue;
    const doneOrSkip = q.filter(x => x.status === "done" || x.status === "skipped").length;
    return doneOrSkip / q.length;
  }
  if (mode === "thumbsize") {
    return _extThumbStatsCache[targetPath]?.sizeBytes ?? -1;
  }
  return 0;
}

/** 単体タブのエントリ配列をソート */
function _extFlSortSingleEntries(items, mode) {
  if (!mode || mode === "insertion") return items;
  const metric = (item) => _extFlGetSortMetric(item.rootPath, mode);
  const cmp = mode === "path"
    ? (a, b) => String(metric(a)).localeCompare(String(metric(b)))
    : (a, b) => (metric(a) || 0) - (metric(b) || 0);
  return [...items].sort(cmp);
}

/** ルート別タブのサブフォルダ配列をソート */
function _extFlSortSubfolders(subfolders, mode) {
  if (!mode || mode === "insertion") return subfolders;
  const metric = (sub) => _extFlGetSortMetric(sub.path, mode);
  const cmp = mode === "path"
    ? (a, b) => String(metric(a)).localeCompare(String(metric(b)))
    : (a, b) => (metric(a) || 0) - (metric(b) || 0);
  return [...subfolders].sort(cmp);
}

/** アクティブタブに該当する _extFolderList 項目を返す
 *  - "single": mode === "single" の全項目
 *  - "root:<normPath>": rootPath が一致する subfolders 項目（通常 1 件）
 */
function _extFlFilterByTab(tabId) {
  if (tabId === "single") {
    return _extFolderList.filter(f => f.mode === "single");
  }
  if (tabId.startsWith("root:")) {
    const target = tabId.slice(5);
    return _extFolderList.filter(f =>
      f.mode === "subfolders" && _normalizeExtPath(f.rootPath) === target
    );
  }
  return [];
}

/** タブバー描画。タブ切替時は storage.local.extImportFlActiveTab に保存＋再描画
 *  v1.28.0 Phase C: ルート別タブのみ D&D で並び替え可能（単体タブは左端固定） */
function _extFlRenderTabs() {
  const bar = document.getElementById("ext-fl-tabbar");
  if (!bar) return;
  bar.innerHTML = "";
  const tabs = _extFlGetTabs();

  // アクティブタブが消滅した場合（ルート削除など）は "single" フォールバック
  if (!tabs.some(t => t.id === _extFlActiveTab)) {
    _extFlActiveTab = "single";
    browser.storage.local.set({ extImportFlActiveTab: _extFlActiveTab }).catch(() => {});
  }

  for (const tab of tabs) {
    const btn = document.createElement("button");
    btn.className = "ext-fl-tab" + (tab.id === _extFlActiveTab ? " active" : "");
    btn.textContent = tab.label;
    if (tab.fullPath) btn.title = tab.fullPath;
    btn.dataset.tabId = tab.id;
    // 単体タブは D&D 不可。ルート別タブのみドラッグ可
    if (tab.id !== "single") {
      btn.draggable = true;
      btn.addEventListener("dragstart", (e) => {
        btn.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", tab.id);
      });
      btn.addEventListener("dragend", () => {
        btn.classList.remove("dragging");
        bar.querySelectorAll(".ext-fl-tab.drag-over").forEach(el => el.classList.remove("drag-over"));
      });
      btn.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        btn.classList.add("drag-over");
      });
      btn.addEventListener("dragleave", () => btn.classList.remove("drag-over"));
      btn.addEventListener("drop", async (e) => {
        e.preventDefault();
        btn.classList.remove("drag-over");
        const srcTabId = e.dataTransfer.getData("text/plain");
        if (!srcTabId || srcTabId === tab.id || !srcTabId.startsWith("root:") || !tab.id.startsWith("root:")) return;
        const srcKey = srcTabId.slice(5);
        const dstKey = tab.id.slice(5);
        // 現在の orderedKeys を再構築して srcKey を dstKey の前に差し込む
        const tabsNow = _extFlGetTabs().filter(t => t.id !== "single").map(t => t.id.slice(5));
        const without = tabsNow.filter(k => k !== srcKey);
        const dstIdx = without.indexOf(dstKey);
        without.splice(dstIdx, 0, srcKey);
        _extFlTabOrder = without;
        await browser.storage.local.set({ extImportFlTabOrder: _extFlTabOrder });
        _extFlRenderTabs();
      });
    }
    btn.addEventListener("click", () => {
      if (_extFlActiveTab === tab.id) return;
      _extFlActiveTab = tab.id;
      browser.storage.local.set({ extImportFlActiveTab: _extFlActiveTab }).catch(() => {});
      _extFlRenderTabs();
      _extFlSyncSortSelect();
      _extRenderFolderList();
    });
    bar.appendChild(btn);
  }
}

/** v1.28.0 Phase B: ソートセレクトを現在アクティブタブの保存値に同期 */
function _extFlSyncSortSelect() {
  const sel = document.getElementById("ext-fl-sort-select");
  if (!sel) return;
  sel.value = _extFlSortModes[_extFlActiveTab] || "insertion";
}

/** v1.28.0 Phase B: ソートセレクタのイベントリスナ登録（外部取込タブ初期化時に呼ぶ） */
function _extFlSetupSortUI() {
  const sel = document.getElementById("ext-fl-sort-select");
  if (!sel || sel.dataset.bound) return;
  sel.dataset.bound = "1";
  sel.addEventListener("change", () => {
    const mode = sel.value;
    _extFlSortModes = { ..._extFlSortModes, [_extFlActiveTab]: mode };
    browser.storage.local.set({ extImportFlSortModes: _extFlSortModes }).catch(() => {});
    _extRenderFolderList();
  });
}

/** v1.28.0 Phase C: テーブル高さリサイズ永続化のセットアップ */
function _extFlSetupTableResize() {
  const cont = document.getElementById("ext-fl-table-container");
  if (!cont || cont.dataset.bound) return;
  cont.dataset.bound = "1";
  // 保存済み高さを復元
  if (_extFlTableHeight) cont.style.height = _extFlTableHeight + "px";
  // ResizeObserver で変化検知、debounce 500ms で保存
  let saveTimer = null;
  const ro = new ResizeObserver(() => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      _extFlTableHeight = Math.round(cont.offsetHeight);
      browser.storage.local.set({ extImportFlTableHeight: _extFlTableHeight }).catch(() => {});
    }, 500);
  });
  ro.observe(cont);
}

/**
 * v1.22.0 のフォルダリスト描画を v1.25.0 GROUP-12-merge 向けに書き換え：
 * ☐ / 状態 / フォルダパス / 操作 / 進捗 / サムネ の 6 列で、セッション進捗と
 * 外部取り込みサムネ統計を同一行に統合表示する。
 */
async function _extRenderFolderList() {
  const tbody  = document.getElementById("ext-fl-tbody");
  const emptyEl = document.getElementById("ext-fl-empty");
  if (!tbody) return;

  // 描画前にサムネ統計キャッシュを最新化（単一 storage.local.get、コスト軽微）
  try {
    const r = await browser.storage.local.get("externalImportThumbStats");
    _extThumbStatsCache = r.externalImportThumbStats || {};
  } catch { _extThumbStatsCache = {}; }

  // v1.27.0 GROUP-19 Phase A: タブバー再描画＋アクティブタブで _extFolderList をフィルタ
  _extFlRenderTabs();
  // v1.28.0 Phase B/C: ソート UI・リサイズ UI の初期化（初回のみ有効）
  _extFlSetupSortUI();
  _extFlSetupTableResize();
  _extFlSyncSortSelect();
  const rawFiltered = _extFlFilterByTab(_extFlActiveTab);
  // v1.28.0 Phase B: アクティブタブのソートモードを適用
  const sortMode = _extFlSortModes[_extFlActiveTab] || "insertion";
  const filtered = _extFlActiveTab === "single"
    ? _extFlSortSingleEntries(rawFiltered, sortMode)
    : rawFiltered.map(item =>
        item.mode === "subfolders"
          ? { ...item, subfolders: _extFlSortSubfolders(item.subfolders || [], sortMode) }
          : item);

  tbody.innerHTML = "";
  if (filtered.length === 0) {
    if (emptyEl) {
      emptyEl.style.display = "";
      // タブ別にメッセージを差し替え
      emptyEl.textContent = _extFolderList.length === 0
        ? "登録されたフォルダはありません。"
        : (_extFlActiveTab === "single"
            ? "単体登録されたフォルダはありません。"
            : "このルートに属するサブフォルダ登録はありません。");
    }
    _extFlUpdateBulkCount();
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";

  // 選択チェック
  const makeSelectCb = (key) => {
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = _extFlSelectedKeys.has(key);
    cb.addEventListener("change", () => {
      if (cb.checked) _extFlSelectedKeys.add(key);
      else _extFlSelectedKeys.delete(key);
      _extFlUpdateBulkCount();
    });
    return cb;
  };

  // 6 列行ビルダー（single / subfolder 個別行共用）
  const buildRow = (item, targetPath, subfolderPath, opts = {}) => {
    const key = subfolderPath ? _extFlRowKey(item.id, subfolderPath) : _extFlRowKey(item.id, null);
    const tr = document.createElement("tr");

    const td0 = document.createElement("td");
    td0.style.cssText = "padding:5px 4px;border:1px solid #e0e0e0;text-align:center;vertical-align:top;";
    td0.appendChild(makeSelectCb(key));
    tr.appendChild(td0);

    const statusInfo = _extDetermineStatus(targetPath);

    const td1 = document.createElement("td");
    td1.style.cssText = "padding:5px 6px;border:1px solid #e0e0e0;text-align:center;vertical-align:top;";
    td1.appendChild(_extBuildStatusBadge(statusInfo.kind, statusInfo.label));
    tr.appendChild(td1);

    const td2 = document.createElement("td");
    td2.style.cssText = `padding:5px 8px;border:1px solid #e0e0e0;word-break:break-all;vertical-align:top;${opts.indent ? "padding-left:24px;" : ""}`;
    td2.textContent = targetPath;
    if (_extFlIsCompleted(targetPath) && statusInfo.kind !== "done") {
      // 現在「完了」扱いでない（セッション途中 or 未開始）で、過去完了履歴に当たる場合のみ追記
      const badge = document.createElement("span");
      badge.style.cssText = "margin-left:6px;font-size:10px;color:#fff;background:#e67e22;padding:1px 6px;border-radius:8px;";
      badge.textContent = "過去に完了";
      td2.appendChild(badge);
    }
    tr.appendChild(td2);

    const td3 = document.createElement("td");
    td3.style.cssText = "padding:5px 6px;border:1px solid #e0e0e0;vertical-align:top;";
    td3.appendChild(_extBuildRowActions(item, targetPath, subfolderPath, statusInfo));
    tr.appendChild(td3);

    const td4 = document.createElement("td");
    td4.style.cssText = "padding:5px 6px;border:1px solid #e0e0e0;vertical-align:top;";
    td4.appendChild(_extBuildProgressCell(statusInfo.session));
    tr.appendChild(td4);

    const td5 = document.createElement("td");
    td5.style.cssText = "padding:5px 6px;border:1px solid #e0e0e0;vertical-align:top;";
    td5.appendChild(_extBuildThumbCell(targetPath));
    tr.appendChild(td5);

    return tr;
  };

  // v1.27.0: filtered（タブ適用後）を回す
  for (const item of filtered) {
    if (item.mode === "single") {
      tbody.appendChild(buildRow(item, item.rootPath, null));
    } else if (item.mode === "subfolders") {
      // グループヘッダ（6 列 colspan）
      const trH = document.createElement("tr");
      trH.style.background = "#f9fbfd";
      const tdH = document.createElement("td");
      tdH.colSpan = 6;
      tdH.style.cssText = "padding:5px 8px;border:1px solid #e0e0e0;word-break:break-all;color:#2c3e50;font-weight:600;";
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:8px;";
      const label = document.createElement("span");
      label.textContent = item.rootPath + " （サブフォルダ別）";
      label.style.flex = "1";
      row.appendChild(label);
      const btnDelH = document.createElement("button");
      btnDelH.className = "backup-btn";
      btnDelH.style.cssText = "padding:2px 8px;font-size:11px;";
      btnDelH.textContent = "🗑 グループ削除";
      btnDelH.addEventListener("click", async () => {
        if (!confirm("このサブフォルダグループを削除しますか？")) return;
        for (const s of (item.subfolders || [])) {
          _extFlSelectedKeys.delete(_extFlRowKey(item.id, s.path));
        }
        _extFolderList = _extFolderList.filter(f => f.id !== item.id);
        await _extFlSave();
        await _extRenderFolderList();
      });
      row.appendChild(btnDelH);
      tdH.appendChild(row);
      trH.appendChild(tdH);
      tbody.appendChild(trH);

      for (const sub of (item.subfolders || [])) {
        tbody.appendChild(buildRow(item, sub.path, sub.path, { indent: true }));
      }
    }
  }
  _extFlUpdateBulkCount();
}

// ---------- セッション開始 ----------

async function _extStartSessionFromFolderList(folderListItem, rootPath, subfolderPath) {
  // 過去完了の注意喚起
  if (_extFlIsCompleted(rootPath)) {
    const entry = _extCompletedRoots.find(r => (r.rootPath || "").toLowerCase() === rootPath.toLowerCase());
    const msg = `このフォルダは過去に取り込みが完了しています。\n\n` +
      `パス: ${rootPath}\n` +
      `完了日時: ${entry?.completedAt?.slice(0, 10) || "―"}\n` +
      `取込: ${entry?.doneCount ?? "?"} 件 / スキップ: ${entry?.skippedCount ?? "?"} 件\n\n` +
      `再度取り込みますか？`;
    if (!confirm(msg)) return;
  }

  showStatus("⏳ スキャン中...");
  const stored = await browser.storage.local.get(["extImportExcludes", "saveHistory"]);
  const excludes = stored.extImportExcludes || [];
  let scanRes;
  try {
    scanRes = await browser.runtime.sendMessage({
      type:       "SCAN_EXTERNAL_IMAGES",
      path:       rootPath,
      cutoffDate: "",
      excludes:   excludes,
    });
  } catch (e) {
    showStatus(`❌ スキャン失敗: ${e.message || ""}`, true);
    return;
  }
  if (!scanRes?.ok) {
    showStatus(`❌ スキャン失敗: ${scanRes?.error || ""}`, true);
    return;
  }

  const existingSet = new Set((stored.saveHistory || []).map(h => (h.savePaths || [])[0]).filter(Boolean));
  const entries = (scanRes.entries || []).filter(e => !existingSet.has(e.filePath || e.savePath));

  if (entries.length === 0) {
    showStatus("⚠️ 対象ファイルが見つかりませんでした（既存の履歴を除外済み）", true);
    return;
  }

  // セッション生成
  const session = {
    id: crypto.randomUUID(),
    name: subfolderPath || rootPath,
    rootPath: rootPath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cursor: 0,
    queue: entries.map(e => ({
      filePath: e.filePath || e.savePath,
      fileName: e.fileName,
      mtime: e.savedAt,
      status: "pending",
      entryId: null,
      // v1.25.2 BUG-ext-thumb-cache-miss: サムネ一覧モーダルで Native fetch 成功後に
      // SAVE_EXT_THUMB へ渡すルートパス。v1.25.0 までは未付与で ext-persist 永続化が
      // 空振りしていたため、1 枚ずつ形式の queue 作成時点で付与する
      sourceRoot: e.sourceRoot || rootPath,
    })),
    folderListRef: folderListItem ? {
      folderListId: folderListItem.id,
      subfolderPath: subfolderPath,
    } : null,
  };
  _extSessions.unshift(session);
  await browser.storage.local.set({ extImportSessions: _extSessions });
  _extRenderSessionsList();
  _extOpenB1(session);
}

// ---------- セッション一覧 ----------

function _extRenderSessionsList() {
  const listEl  = document.getElementById("ext-sessions-list");
  const emptyEl = document.getElementById("ext-sessions-empty");
  if (!listEl) return;
  listEl.innerHTML = "";
  if (_extSessions.length === 0) {
    if (emptyEl) emptyEl.style.display = "";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";

  for (const s of _extSessions) {
    const pending = s.queue.filter(q => q.status === "pending").length;
    const done    = s.queue.filter(q => q.status === "done").length;
    const skipped = s.queue.filter(q => q.status === "skipped").length;
    const total   = s.queue.length;

    const card = document.createElement("div");
    card.style.cssText = "border:1px solid #d0dae5;border-radius:6px;padding:8px 10px;margin-bottom:6px;background:#fafcff;";

    const header = document.createElement("div");
    header.style.cssText = "display:flex;align-items:center;gap:8px;flex-wrap:wrap;";
    const title = document.createElement("div");
    title.style.cssText = "font-size:12px;font-weight:600;color:#2c3e50;flex:1;word-break:break-all;min-width:200px;";
    title.textContent = s.name || s.rootPath;
    header.appendChild(title);

    const stat = document.createElement("div");
    stat.style.cssText = "font-size:11px;color:#555;";
    stat.innerHTML = `完了 <b style="color:#1abc9c;">${done}</b> / スキップ <b style="color:#e67e22;">${skipped}</b> / 残り <b>${pending}</b> / 合計 ${total}`;
    header.appendChild(stat);
    card.appendChild(header);

    const meta = document.createElement("div");
    meta.style.cssText = "font-size:11px;color:#888;margin-top:3px;";
    meta.textContent = `更新: ${s.updatedAt?.slice(0, 16).replace("T", " ") || "―"}`;
    card.appendChild(meta);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;";

    if (pending > 0) {
      const btn = document.createElement("button");
      btn.className = "backup-btn";
      btn.style.cssText = "padding:2px 10px;font-size:11px;";
      btn.textContent = "▶ 再開";
      btn.addEventListener("click", () => _extOpenB1(s));
      actions.appendChild(btn);
    }
    if (skipped > 0) {
      const btn = document.createElement("button");
      btn.className = "backup-btn";
      btn.style.cssText = "padding:2px 10px;font-size:11px;";
      btn.textContent = "⏭ スキップ分再処理";
      btn.addEventListener("click", () => _extResumeSkipped(s));
      actions.appendChild(btn);
    }
    const btnDel = document.createElement("button");
    btnDel.className = "backup-btn";
    btnDel.style.cssText = "padding:2px 10px;font-size:11px;";
    btnDel.textContent = "🗑 削除";
    btnDel.addEventListener("click", async () => {
      if (!confirm("このセッションを削除しますか？\n（保存済みの履歴エントリは削除されません）")) return;
      _extSessions = _extSessions.filter(x => x.id !== s.id);
      await browser.storage.local.set({ extImportSessions: _extSessions });
      _extRenderSessionsList();
    });
    actions.appendChild(btnDel);

    card.appendChild(actions);
    listEl.appendChild(card);
  }
}

async function _extResumeSkipped(session) {
  // スキップ分の最初のインデックスへ cursor を戻し、skipped を pending に戻す
  for (const q of session.queue) {
    if (q.status === "skipped") q.status = "pending";
  }
  session.cursor = session.queue.findIndex(q => q.status === "pending");
  if (session.cursor < 0) session.cursor = 0;
  session.updatedAt = new Date().toISOString();
  await browser.storage.local.set({ extImportSessions: _extSessions });
  _extOpenB1(session);
}

// ---------- 完了ルートフォルダ履歴 ----------

function _extRenderCompletedRoots() {
  const tbody  = document.getElementById("ext-completed-tbody");
  const emptyEl = document.getElementById("ext-completed-empty");
  const cntEl   = document.getElementById("ext-completed-count");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (cntEl) cntEl.textContent = `(${_extCompletedRoots.length} 件)`;
  if (_extCompletedRoots.length === 0) {
    if (emptyEl) emptyEl.style.display = "";
    return;
  }
  if (emptyEl) emptyEl.style.display = "none";

  // 新しい順
  const sorted = [..._extCompletedRoots].sort(
    (a, b) => new Date(b.completedAt) - new Date(a.completedAt));

  for (const r of sorted) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="padding:5px 8px;border:1px solid #e0e0e0;word-break:break-all;"></td>
      <td style="padding:5px 8px;border:1px solid #e0e0e0;"></td>
      <td style="padding:5px 8px;border:1px solid #e0e0e0;text-align:right;font-size:11px;color:#555;"></td>
      <td style="padding:5px 8px;border:1px solid #e0e0e0;"></td>`;
    const tds = tr.querySelectorAll("td");
    tds[0].textContent = r.rootPath;
    tds[1].textContent = (r.completedAt || "").slice(0, 10);
    tds[2].textContent = `✓${r.doneCount ?? 0} / ⏭${r.skippedCount ?? 0}`;
    const btn = document.createElement("button");
    btn.className = "backup-btn";
    btn.style.cssText = "padding:2px 8px;font-size:11px;";
    btn.textContent = "🗑";
    btn.addEventListener("click", async () => {
      if (!confirm("履歴から削除しますか？")) return;
      _extCompletedRoots = _extCompletedRoots.filter(x =>
        (x.rootPath || "").toLowerCase() !== (r.rootPath || "").toLowerCase());
      await browser.storage.local.set({ extImportCompletedRoots: _extCompletedRoots });
      _extRenderCompletedRoots();
      _extRenderFolderList();
    });
    tds[3].appendChild(btn);
    tbody.appendChild(tr);
  }
}

// ---------- b1: プレビュー + 入力画面 ----------

function _extB1SetupEvents() {
  document.getElementById("ext-b1-save-next")?.addEventListener("click", _extB1SaveAndNext);
  document.getElementById("ext-b1-skip")?.addEventListener("click", _extB1Skip);
  document.getElementById("ext-b1-close")?.addEventListener("click", _extB1Close);
  document.getElementById("ext-b1-pick-folder")?.addEventListener("click", _extB1OpenFolderPicker);

  // v1.23.0: GROUP-1-a1 ナビゲーションボタン群
  document.getElementById("ext-b1-nav-prev")?.addEventListener("click",   () => _extB1NavMove(-1));
  document.getElementById("ext-b1-nav-next")?.addEventListener("click",   () => _extB1NavMove(+1));
  document.getElementById("ext-b1-nav-jump")?.addEventListener("click",   _extB1NavJump);
  document.getElementById("ext-b1-nav-thumbs")?.addEventListener("click", _extB1OpenThumbsModal);
  document.getElementById("ext-b1-thumbs-close")?.addEventListener("click", () => {
    document.getElementById("ext-b1-thumbs-modal").style.display = "none";
  });
  // v1.25.4 BUG-ext-thumbs-scroll-paging (真因対応):
  //   サムネ一覧モーダル内では水平方向の wheel/scroll イベントでブラウザが
  //   横スクロールや戻る/進むジェスチャを発火し、一部環境で OS 側が矢印キー化して
  //   ページ送りが発生する報告があった。モーダル表示中の水平 wheel は preventDefault で
  //   抑制する（垂直スクロールは通常のコンテンツ閲覧に必要なので残す）
  document.getElementById("ext-b1-thumbs-modal")?.addEventListener("wheel", (e) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
    }
  }, { passive: false });
  // v1.23.2: GROUP-7-a ページング前後ボタン
  // v1.25.3: ユーザー要望でループ構造化（最終ページから「次」で先頭、先頭から「前」で最終ページへ）
  document.getElementById("ext-b1-thumbs-prev")?.addEventListener("click", () => {
    if (!_extActiveSession) return;
    const filtered = _extB1GetFilteredIndices(_extActiveSession);
    const totalPages = Math.max(1, Math.ceil(filtered.length / _EXT_B1_THUMB_PAGE_SIZE));
    _extB1ThumbsPage = (_extB1ThumbsPage - 1 + totalPages) % totalPages;
    _extB1RenderThumbsPage(_extActiveSession, filtered);
  });
  document.getElementById("ext-b1-thumbs-next")?.addEventListener("click", () => {
    if (!_extActiveSession) return;
    const filtered = _extB1GetFilteredIndices(_extActiveSession);
    const totalPages = Math.max(1, Math.ceil(filtered.length / _EXT_B1_THUMB_PAGE_SIZE));
    _extB1ThumbsPage = (_extB1ThumbsPage + 1) % totalPages;
    _extB1RenderThumbsPage(_extActiveSession, filtered);
  });

  // v1.23.3: GROUP-8-kbd ← / → キーナビゲーション
  //   - 1 枚ずつオーバーレイ表示中：前後画像へ移動
  //   - サムネ一覧モーダル表示中：前後ページへ送り（キーリピート負荷回避のため 250ms スロットル）
  //   - 無効条件：IME 変換中／入力要素フォーカス中／フォルダピッカー開放中／セッション無し
  document.addEventListener("keydown", _extB1HandleArrowKey);

  // v1.23.0: GROUP-4 絞り込みチェックボックス
  ["done", "skipped", "pending"].forEach((k) => {
    document.getElementById(`ext-b1-flt-${k}`)?.addEventListener("change", async () => {
      if (!_extActiveSession) return;
      _extActiveSession.uiFilter = _extB1ReadFilterFromUI();
      await browser.storage.local.set({ extImportSessions: _extSessions });
      // フィルタ変更でカーソルが範囲外になったら最も近い該当項目に寄せる
      _extB1AdjustCursorToFilter(_extActiveSession);
      await _extB1LoadCurrent();
    });
  });

  // v1.23.0: GROUP-1-b コピー作成トグル
  const copyEl = document.getElementById("ext-b1-copy-file");
  if (copyEl) {
    copyEl.checked = !!_extB1CopyToDest;
    copyEl.addEventListener("change", async () => {
      _extB1CopyToDest = !!copyEl.checked;
      await browser.storage.local.set({ extImportCopyToDest: _extB1CopyToDest });
    });
  }

  // v1.23.4: GROUP-11-carryover-move 引き継ぎチェック（モーダル内・各項目ラベル横）
  // 設定画面側の一括ボックスは廃止し、各項目の入力欄直上にチェックを配置。
  // ストレージキー extImportCarryover は据え置き（挙動・互換性維持）。
  const _wireB1Carry = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("change", async () => {
      _extCarryover[key] = !!el.checked;
      await browser.storage.local.set({ extImportCarryover: _extCarryover });
      // 引き継ぎ OFF にしたら蓄積値も破棄（意図しない残留を防ぐ）
      if (!el.checked) {
        if (key === "tags")     _extB1LastCarryValues.tags     = [];
        if (key === "subtags")  _extB1LastCarryValues.subtags  = [];
        if (key === "authors")  _extB1LastCarryValues.authors  = [];
        if (key === "savepath") _extB1LastCarryValues.savepath = "";
      }
    });
  };
  _wireB1Carry("ext-b1-carry-tags",     "tags");
  _wireB1Carry("ext-b1-carry-subtags",  "subtags");
  _wireB1Carry("ext-b1-carry-authors",  "authors");
  _wireB1Carry("ext-b1-carry-savepath", "savepath");

  // チップ入力（タグ・サブタグ・権利者）
  _extB1SetupChipInput("tag");
  _extB1SetupChipInput("subtag");
  _extB1SetupChipInput("author");

  // フォルダピッカー
  document.getElementById("ext-b1-fp-close")?.addEventListener("click", () => {
    document.getElementById("ext-b1-folder-picker").style.display = "none";
  });
  document.getElementById("ext-b1-fp-apply")?.addEventListener("click", () => {
    if (_extFpSelectedPath) {
      const inp = document.getElementById("ext-b1-savepath");
      if (inp) inp.value = _extFpSelectedPath;
      document.getElementById("ext-b1-folder-picker").style.display = "none";
    } else {
      showStatus("⚠️ フォルダを選択してください", true);
    }
  });
  document.getElementById("ext-b1-fp-mkdir")?.addEventListener("click", _extFpMakeDir);
  document.getElementById("ext-b1-fp-tagdir")?.addEventListener("click", _extFpMakeTagDir);

  // リサイザ
  _extB1SetupResizer();
}

function _extB1SetupResizer() {
  const resizer = document.getElementById("ext-b1-resizer");
  const left    = document.getElementById("ext-b1-left");
  const right   = document.getElementById("ext-b1-right");
  if (!resizer || !left || !right) return;
  let startX = 0, startLeftW = 0, startRightW = 0;
  resizer.addEventListener("mousedown", (e) => {
    startX = e.clientX;
    startLeftW  = left.getBoundingClientRect().width;
    startRightW = right.getBoundingClientRect().width;
    document.body.style.cursor = "col-resize";
    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const newL = Math.max(280, startLeftW + dx);
      const newR = Math.max(320, startRightW - dx);
      left.style.flex  = `0 0 ${newL}px`;
      right.style.flex = `0 0 ${newR}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}

// 現在の b1 画面の入力状態
let _extB1MainTags = [];
let _extB1SubTags  = [];
let _extB1Authors  = [];
// v1.23.0: GROUP-1-a2 項目別引き継ぎ設定（storage: extImportCarryover）
let _extCarryover = { tags: false, subtags: false, authors: false, savepath: false };
// v1.23.0: GROUP-1-a2 直前保存値（次画像に引き継ぐ値）
let _extB1LastCarryValues = { tags: [], subtags: [], authors: [], savepath: "" };
// v1.23.0: GROUP-1-b コピー作成トグル（storage: extImportCopyToDest）
let _extB1CopyToDest = false;
// v1.23.0: GROUP-4 絞り込み状態（セッション開始直後は「残り」のみ ON）
//   session.uiFilter として保持するが、初期値として使用
const _EXT_B1_FILTER_DEFAULT = { done: false, skipped: false, pending: true };
// v1.23.0: GROUP-4 ステータス色（パターン 2）
const _EXT_STATUS_COLOR = {
  done:    "#2ecc71",
  skipped: "#e67e22",
  pending: "#3498db",
};

function _extB1SetupChipInput(kind) {
  const input   = document.getElementById(`ext-b1-${kind === "tag" ? "tag" : kind === "subtag" ? "subtag" : "author"}-input`);
  const sugg    = document.getElementById(`ext-b1-${kind === "tag" ? "tag" : kind === "subtag" ? "subtag" : "author"}-sugg`);
  if (!input) return;
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      _extB1AddChip(kind, v);
      input.value = "";
      if (sugg) sugg.style.display = "none";
    }
  });
  input.addEventListener("input", () => _extB1UpdateSugg(kind));
  input.addEventListener("blur", () => setTimeout(() => { if (sugg) sugg.style.display = "none"; }, 150));
}

function _extB1UpdateSugg(kind) {
  const input = document.getElementById(`ext-b1-${kind === "tag" ? "tag" : kind === "subtag" ? "subtag" : "author"}-input`);
  const sugg  = document.getElementById(`ext-b1-${kind === "tag" ? "tag" : kind === "subtag" ? "subtag" : "author"}-sugg`);
  if (!input || !sugg) return;
  const q = input.value.trim().toLowerCase();
  if (!q) { sugg.style.display = "none"; return; }
  const source = (kind === "author") ? globalAuthors : globalTags;
  const existing = (kind === "tag") ? _extB1MainTags
                  : (kind === "subtag") ? _extB1SubTags
                  : _extB1Authors;
  const cands = (source || []).filter(s =>
    s.toLowerCase().includes(q) && !existing.includes(s)).slice(0, 10);
  if (cands.length === 0) { sugg.style.display = "none"; return; }
  sugg.innerHTML = "";
  for (const c of cands) {
    const item = document.createElement("div");
    item.style.cssText = "padding:4px 8px;cursor:pointer;";
    item.textContent = c;
    item.onmouseover = () => item.style.background = "#f0f6ff";
    item.onmouseout  = () => item.style.background = "";
    item.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      _extB1AddChip(kind, c);
      input.value = "";
      sugg.style.display = "none";
    });
    sugg.appendChild(item);
  }
  sugg.style.display = "";
}

function _extB1AddChip(kind, value) {
  const arr = (kind === "tag") ? _extB1MainTags
              : (kind === "subtag") ? _extB1SubTags
              : _extB1Authors;
  if (arr.includes(value)) return;
  arr.push(value);
  _extB1RenderChips(kind);
  if (kind === "tag") _extB1RenderSavepathSugg();
}

function _extB1RenderChips(kind) {
  const el  = document.getElementById(`ext-b1-${kind === "tag" ? "tag" : kind === "subtag" ? "subtag" : "author"}-chips`);
  if (!el) return;
  const arr = (kind === "tag") ? _extB1MainTags
              : (kind === "subtag") ? _extB1SubTags
              : _extB1Authors;
  el.innerHTML = "";
  arr.forEach((v, idx) => {
    const chip = document.createElement("span");
    const color = (kind === "tag") ? "#1abc9c" : (kind === "subtag") ? "#3498db" : "#9b59b6";
    chip.style.cssText = `display:inline-flex;align-items:center;gap:4px;background:${color};color:#fff;border-radius:10px;padding:1px 8px;font-size:11px;`;
    chip.textContent = v;
    const x = document.createElement("span");
    x.style.cssText = "cursor:pointer;opacity:.8;";
    x.textContent = "×";
    x.addEventListener("click", () => {
      arr.splice(idx, 1);
      _extB1RenderChips(kind);
      if (kind === "tag") _extB1RenderSavepathSugg();
    });
    chip.appendChild(x);
    el.appendChild(chip);
  });
}

function _extB1RenderSavepathSugg() {
  const el = document.getElementById("ext-b1-savepath-sugg");
  if (!el) return;
  el.innerHTML = "";
  const cands = new Set();
  for (const t of _extB1MainTags) {
    const dests = tagDestinations[t] || [];
    for (const d of dests) if (d.path) cands.add(d.path);
  }
  if (cands.size === 0) return;
  const note = document.createElement("span");
  note.style.cssText = "font-size:10px;color:#888;margin-right:4px;";
  note.textContent = "タグに対応する保存先:";
  el.appendChild(note);
  for (const path of cands) {
    const btn = document.createElement("button");
    btn.className = "backup-btn";
    btn.style.cssText = "padding:1px 8px;font-size:10px;";
    btn.textContent = path;
    btn.title = path;
    btn.addEventListener("click", () => {
      const inp = document.getElementById("ext-b1-savepath");
      if (inp) inp.value = path;
    });
    el.appendChild(btn);
  }
}

async function _extOpenB1(session) {
  _extActiveSession = session;
  // v1.23.0: 絞り込み設定（なければ初期値）。GROUP-1-a2 引き継ぎキャッシュ初期化
  if (!session.uiFilter) session.uiFilter = { ..._EXT_B1_FILTER_DEFAULT };
  _extB1LastCarryValues = { tags: [], subtags: [], authors: [], savepath: "" };
  // cursor を pending の先頭に合わせる（絞り込み内で）
  if (session.queue[session.cursor]?.status !== "pending") {
    const nextIdx = session.queue.findIndex(q => q.status === "pending");
    session.cursor = nextIdx >= 0 ? nextIdx : session.queue.length;
  }
  _extB1AdjustCursorToFilter(session);
  _extB1ApplyFilterToUI(session.uiFilter);
  // GROUP-1-b コピートグルを反映
  const copyEl = document.getElementById("ext-b1-copy-file");
  if (copyEl) copyEl.checked = !!_extB1CopyToDest;
  // v1.23.4: GROUP-11-carryover-move 引き継ぎチェック状態をモーダル内 UI に反映
  const _cb = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
  _cb("ext-b1-carry-tags",     _extCarryover.tags);
  _cb("ext-b1-carry-subtags",  _extCarryover.subtags);
  _cb("ext-b1-carry-authors",  _extCarryover.authors);
  _cb("ext-b1-carry-savepath", _extCarryover.savepath);
  document.getElementById("ext-b1-overlay").style.display = "flex";
  document.getElementById("ext-b1-session-name").textContent = session.name || session.rootPath;
  await _extB1LoadCurrent();
}

// v1.24.0 GROUP-10-a: メイン画像プレビューの世代カウンタ
//   `_extB1LoadCurrent` 発火時にインクリメントし、クロージャで保存した世代 ID と
//   レスポンス受領時の世代 ID を照合。古ければ `imgEl.src` に書き込まない。
//   サムネ一覧モーダル側は GROUP-10-a B-1(ア) の DOM 保持（Map<qIdx, cardElement>）で
//   遅延レスポンスの視覚的実害が消えるため、世代カウンタは不要。
let _extB1PreviewGen = 0;

// v1.24.0 GROUP-10-c: サムネ一覧モーダル用セマフォ（同時 5 件まで）
//   L6542 / L6551 の async IIFE で取得・解放。他経路（b1 保存時のサムネ生成・メイン画像・
//   一括インポート）はすでに単発 or 逐次のため対象外。
const _EXT_B1_SEMAPHORE_LIMIT = 5;
let _extB1SemaActive = 0;
const _extB1SemaQueue = [];
function _extB1SemaAcquire() {
  return new Promise((resolve) => {
    if (_extB1SemaActive < _EXT_B1_SEMAPHORE_LIMIT) {
      _extB1SemaActive++;
      resolve();
    } else {
      _extB1SemaQueue.push(resolve);
    }
  });
}
function _extB1SemaRelease() {
  if (_extB1SemaQueue.length > 0) {
    const next = _extB1SemaQueue.shift();
    next(); // スロット維持のまま次に転送
  } else {
    _extB1SemaActive--;
  }
}

// v1.24.0 GROUP-10-a: サムネ一覧モーダル内の DOM キャッシュ（B-1(ア) 採用）
//   キー: qIdx、値: cardElement。ページ送り時は `innerHTML=""` を廃止し、display 切替で表示制御
//   セッション切替時にクリア（qIdx がセッションローカルのため）
const _extB1ThumbsCardCache = new Map();
let _extB1ThumbsCacheSessionKey = null;

async function _extB1LoadCurrent() {
  const session = _extActiveSession;
  if (!session) return;

  // v1.23.0: 絞り込み反映・進捗表示更新
  _extB1RenderNavAndProgress(session);

  const cur = session.queue[session.cursor];

  // v1.23.0: 全 pending が完了していれば従来通りセッション完了。
  // 絞り込みで現在アイテムが非該当の場合は「絞り込み結果内に移動」するが、
  // pending が残っていれば完了処理にはしない（ユーザーがフィルタ変更で再開できるよう）
  const pendingRemain = session.queue.filter(q => q.status === "pending").length;
  if (!cur) {
    if (pendingRemain === 0) await _extB1FinishSessionIfDone();
    return;
  }

  // 絞り込みに現在インデックスが該当しない場合は、該当する位置にカーソル移動
  const filtered = _extB1GetFilteredIndices(session);
  if (filtered.length === 0) {
    // 絞り込みが全 OFF 等で該当なし → プレビュー空表示で待機
    _extB1RenderEmptyPreview("⚠️ 絞り込み結果が空です。上部のフィルタを変更してください。");
    return;
  }
  if (!filtered.includes(session.cursor)) {
    _extB1AdjustCursorToFilter(session);
    await browser.storage.local.set({ extImportSessions: _extSessions });
    _extB1RenderNavAndProgress(session);
  }
  const cur2 = session.queue[session.cursor];

  // pending 以外（完了済・スキップ）の項目でも閲覧可能。編集は pending のみ（下で分岐）
  const isPending = cur2 && cur2.status === "pending";

  // 初期値セット（v1.23.0: GROUP-1-a2 引き継ぎに応じて前回値を復元）
  if (isPending && _extCarryover.tags)    _extB1MainTags = [..._extB1LastCarryValues.tags];
  else                                    _extB1MainTags = [];
  if (isPending && _extCarryover.subtags) _extB1SubTags  = [..._extB1LastCarryValues.subtags];
  else                                    _extB1SubTags  = [];
  if (isPending && _extCarryover.authors) _extB1Authors  = [..._extB1LastCarryValues.authors];
  else                                    _extB1Authors  = [];
  // 完了済み表示の場合は保存済みエントリから値を復元
  if (!isPending && cur2?.entryId) {
    try {
      const stored = await browser.storage.local.get("saveHistory");
      const hist = (stored.saveHistory || []).find(e => e.id === cur2.entryId);
      if (hist) {
        _extB1MainTags = [...(hist.tags || [])];
        _extB1Authors  = [...(hist.authors || [])];
        _extB1SubTags  = [];
      }
    } catch (_) {}
  }

  _extB1RenderChips("tag");
  _extB1RenderChips("subtag");
  _extB1RenderChips("author");
  _extB1RenderSavepathSugg();

  const fnameEl = document.getElementById("ext-b1-filename");
  const pathEl  = document.getElementById("ext-b1-filepath");
  const mtimeEl = document.getElementById("ext-b1-mtime");
  const saveEl  = document.getElementById("ext-b1-savepath");
  if (fnameEl) fnameEl.textContent = cur2.fileName || "";
  if (pathEl)  { pathEl.textContent  = cur2.filePath || ""; pathEl.title = cur2.filePath || ""; }
  if (mtimeEl) mtimeEl.textContent = (cur2.mtime || "").replace("T", " ").slice(0, 19);
  // デフォルト保存先: 引き継ぎ ON なら前回値、OFF なら元ファイルの場所
  let defaultDir;
  if (isPending && _extCarryover.savepath && _extB1LastCarryValues.savepath) {
    defaultDir = _extB1LastCarryValues.savepath;
  } else {
    defaultDir = _extDirname(cur2.filePath || "");
  }
  if (saveEl) saveEl.value = defaultDir;

  // v1.23.0: 非 pending は保存・スキップボタンを無効化（閲覧専用）
  _extB1ApplyStatusReadonly(cur2?.status);

  // プレビュー取得
  const imgEl  = document.getElementById("ext-b1-preview-img");
  const infoEl = document.getElementById("ext-b1-preview-info");
  if (imgEl)  imgEl.src = "";
  if (infoEl) infoEl.textContent = "⏳ プレビュー読み込み中...";

  // v1.24.0 GROUP-10-a: 世代カウンタを前進し、このフェッチに対応する世代 ID をクロージャ保存。
  //   連打で `_extB1LoadCurrent` が重なって発火した場合でも、古いレスポンスが後から届いた際に
  //   `imgEl.src` を上書きしないよう、DOM 書き込み直前に世代照合する。
  _extB1PreviewGen++;
  const _myPreviewGen = _extB1PreviewGen;

  try {
    const res = await browser.runtime.sendMessage({
      type: "READ_LOCAL_IMAGE_BASE64",
      path: cur2.filePath,
      maxSize: 1600,
    });
    // v1.24.0 GROUP-10-a: 世代照合。古いレスポンスは破棄（DOM 反映しない）
    if (_myPreviewGen !== _extB1PreviewGen) return;
    if (res?.ok && res.dataUrl) {
      if (imgEl) imgEl.src = res.dataUrl;
      if (infoEl) infoEl.textContent = `${res.width}×${res.height}` + (res.resized ? "（縮小表示）" : "");
    } else if (res?.ok && Array.isArray(res.chunksB64)) {
      // v1.22.9: GIF は base64 チャンクで返るので Blob URL に組み立てる
      try {
        const arrays = [];
        for (const b64 of res.chunksB64) {
          const bin = atob(b64);
          const arr = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          arrays.push(arr);
        }
        const blob = new Blob(arrays, { type: res.mime || "image/gif" });
        if (imgEl) {
          // 前の Blob URL があれば解放
          if (imgEl.dataset.blobUrl) {
            try { URL.revokeObjectURL(imgEl.dataset.blobUrl); } catch (_) {}
          }
          const blobUrl = URL.createObjectURL(blob);
          imgEl.dataset.blobUrl = blobUrl;
          imgEl.src = blobUrl;
        }
        if (infoEl) {
          const wh = (res.width && res.height) ? `${res.width}×${res.height}` : "GIF";
          infoEl.textContent = `${wh}（アニメーション）`;
        }
      } catch (err) {
        if (infoEl) infoEl.textContent = `⚠ プレビュー組み立て失敗: ${err?.message || err}`;
      }
    } else {
      if (infoEl) infoEl.textContent = `⚠ プレビュー取得失敗: ${res?.error || "unknown"}`;
    }
  } catch (e) {
    // v1.24.0 GROUP-10-a: エラー表示も古い世代なら出さない（新しい世代が処理中 or 成功済みの可能性）
    if (_myPreviewGen !== _extB1PreviewGen) return;
    if (infoEl) infoEl.textContent = `⚠ プレビュー取得エラー: ${e.message || ""}`;
  }
}

function _extDirname(p) {
  if (!p) return "";
  const n = p.replace(/\\/g, "/");
  const idx = n.lastIndexOf("/");
  if (idx < 0) return "";
  return p.slice(0, idx);
}

async function _extB1Skip() {
  const session = _extActiveSession;
  if (!session) return;
  const cur = session.queue[session.cursor];
  if (cur && cur.status === "pending") {
    cur.status = "skipped";
    // v1.23.0: 絞り込み結果内で次の pending / 該当アイテムへ進む
    _extB1AdvanceCursorInFiltered(session);
    session.updatedAt = new Date().toISOString();
    await browser.storage.local.set({ extImportSessions: _extSessions });
  }
  await _extB1LoadCurrent();
  _extRenderSessionsList();
}

async function _extB1Close() {
  const session = _extActiveSession;
  if (session) {
    session.updatedAt = new Date().toISOString();
    await browser.storage.local.set({ extImportSessions: _extSessions });
  }
  _extActiveSession = null;
  document.getElementById("ext-b1-overlay").style.display = "none";
  _extRenderSessionsList();
  // v1.25.3: 閉鎖時に統合テーブルのステータス・進捗・サムネ統計を再描画（ページ全体リロード不要）
  _extRenderFolderList();
}

// v1.24.0 GROUP-5-A: メタ付与ファイル名生成（background.js L460 `buildFilenameWithMeta` と仕様を一致させること）
// 片側だけ更新して不整合を起こさないよう、仕様変更時は両方同時に修正する
function _extB1BuildFilenameWithMeta(filename, tags, subTags, authors, settings) {
  const { filenameIncludeTag, filenameIncludeSubtag, filenameIncludeAuthor } = settings;
  if (!filenameIncludeTag && !filenameIncludeSubtag && !filenameIncludeAuthor) return filename;
  const dotIdx = filename.lastIndexOf(".");
  const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
  const ext  = dotIdx > 0 ? filename.slice(dotIdx) : "";
  const sanitize = (s) => s
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/[\s.]+$/, "")
    .trim();
  const parts = [];
  if (filenameIncludeTag    && tags?.length)    parts.push(...tags.map(sanitize).filter(Boolean));
  if (filenameIncludeSubtag && subTags?.length) parts.push(...subTags.map(sanitize).filter(Boolean));
  if (filenameIncludeAuthor && authors?.length) parts.push(...authors.map(sanitize).filter(Boolean));
  if (parts.length === 0) return filename;
  return `${stem}-${parts.join("-")}${ext}`;
}

// v1.24.0 GROUP-5-A: 同一フォルダ判定（background.js COPY_LOCAL_FILE ハンドラの判定と揃える）
//   大文字小文字無視、区切り正規化、末尾スラッシュ除去
function _extB1IsSameFolder(dirA, dirB) {
  const norm = (p) => (p || "").replace(/\\/g, "/").toLowerCase().replace(/\/+$/, "");
  return norm(dirA) === norm(dirB);
}

async function _extB1SaveAndNext() {
  const session = _extActiveSession;
  if (!session) return;
  const cur = session.queue[session.cursor];
  if (!cur) return;
  if (cur.status !== "pending") {
    showStatus("⚠️ 完了済み／スキップ済みのため保存できません", true);
    return;
  }

  const savePathInput = document.getElementById("ext-b1-savepath");
  const savePath = (savePathInput?.value || "").trim() || _extDirname(cur.filePath);

  const tags    = [..._extB1MainTags];
  const subTags = [..._extB1SubTags];
  const authors = [..._extB1Authors];
  const allTags = [...new Set([...tags, ...subTags])];

  // v1.23.0: GROUP-1-a2 引き継ぎ値を更新
  _extB1LastCarryValues.tags     = [...tags];
  _extB1LastCarryValues.subtags  = [...subTags];
  _extB1LastCarryValues.authors  = [...authors];
  _extB1LastCarryValues.savepath = savePath;

  // v1.24.0 GROUP-5-A: メタ付与名を一本化（saveHistory と物理操作の両方で同じ値を使う）
  //   v1.23.1 の「両側原名で整合」を逆向きに「両側メタ名で整合」へ揃える改修
  const fnameSettings = await browser.storage.local.get(["filenameIncludeTag", "filenameIncludeSubtag", "filenameIncludeAuthor"]);
  const effectiveFilename = _extB1BuildFilenameWithMeta(cur.fileName, tags, subTags, authors, {
    filenameIncludeTag:    !!fnameSettings.filenameIncludeTag,
    filenameIncludeSubtag: !!fnameSettings.filenameIncludeSubtag,
    filenameIncludeAuthor: !!fnameSettings.filenameIncludeAuthor,
  });
  const metaChanged = (effectiveFilename !== cur.fileName);

  // v1.24.0 GROUP-5-A: 物理的同一フォルダ判定
  //   - `_extB1CopyToDest` OFF：物理ファイルはその場（原フォルダ）に残るため「同一フォルダ扱い」
  //   - `_extB1CopyToDest` ON かつ savePath == 原フォルダ：同上
  const srcDir = _extDirname(cur.filePath);
  const physicallySameFolder = !_extB1CopyToDest || _extB1IsSameFolder(srcDir, savePath);

  // v1.24.0 GROUP-5-A: 同一フォルダ × メタ付与 ON の場合は RENAME_FILE を先に発火
  //   RENAME 失敗は「保存なし扱い」で即終了（saveHistory にも書かず、カーソルも進めない）
  //   衝突時（ターゲット既存）も勝手に別名で残さず失敗として扱う（Native 側で ok:false）
  if (physicallySameFolder && metaChanged) {
    const newPath = `${srcDir}\\${effectiveFilename}`;
    let renameRes;
    try {
      renameRes = await browser.runtime.sendMessage({
        type:    "RENAME_FILE",
        srcPath: cur.filePath,
        dstPath: newPath,
      });
    } catch (e) {
      showStatus(`⚠️ リネーム送信エラー: ${e.message || ""}`, true);
      return;
    }
    if (!renameRes?.ok) {
      showStatus(`⚠️ リネーム失敗: ${renameRes?.error || "不明"}`, true);
      return;
    }
    // queue 側のパスも更新（後続のサムネ生成・閲覧・エクスポートで使う）
    cur.filePath = renameRes.savedPath || newPath;
    cur.fileName = effectiveFilename;
  }

  // サムネイル生成（Python 経由）— リネーム後のパスを使う
  let thumbId = null;
  try {
    const res = await browser.runtime.sendMessage({
      type:  "GENERATE_THUMBS_BATCH",
      paths: [cur.filePath],
    });
    const b64 = res?.thumbs?.[cur.filePath];
    if (b64) {
      thumbId = crypto.randomUUID();
      const mime = res?.thumbMimes?.[cur.filePath] || "image/jpeg";
      await browser.runtime.sendMessage({
        type:   "IMPORT_IDB_THUMBS",
        thumbs: [{ id: thumbId, dataUrl: `data:${mime};base64,${b64}` }],
      });
    }
  } catch (_) { /* サムネ失敗は無視 */ }

  // v1.24.0 GROUP-5-A: saveHistory にエントリ追加（filename はメタ付与後の effectiveFilename）
  const entry = {
    id:         crypto.randomUUID(),
    savedAt:    cur.mtime || new Date().toISOString(),
    imageUrl:   "",
    pageUrl:    "",
    savePaths:  [savePath],
    filename:   effectiveFilename,
    tags:       allTags,
    authors:    authors,
    thumbId:    thumbId,
    source:     "external_import",
  };

  const stored = await browser.storage.local.get(["saveHistory", "globalTags", "globalAuthors", "recentTags", "recentSubTags", "recentAuthors"]);
  const merged = [...(stored.saveHistory || []), entry]
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
  const gTagSet    = new Set([...(stored.globalTags    || []), ...allTags]);
  const gAuthorSet = new Set([...(stored.globalAuthors || []), ...authors]);

  // recentTags / recentSubTags / recentAuthors の更新（先頭に追加して重複排除）
  const recentTags    = [...tags,    ...(stored.recentTags    || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 100);
  const recentSubTags = [...subTags, ...(stored.recentSubTags || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 20);
  const recentAuthors = [...authors, ...(stored.recentAuthors || [])].filter((v, i, a) => a.indexOf(v) === i).slice(0, 20);

  // tagDestinations の更新（メインタグのみ）
  for (const t of tags) {
    if (!tagDestinations[t]) tagDestinations[t] = [];
    if (!tagDestinations[t].some(d => d.path === savePath)) {
      tagDestinations[t].push({ id: crypto.randomUUID(), path: savePath, label: "" });
    }
  }

  await browser.storage.local.set({
    saveHistory:   merged,
    globalTags:    [...gTagSet],
    globalAuthors: [...gAuthorSet],
    recentTags, recentSubTags, recentAuthors,
    tagDestinations,
  });
  _historyData  = merged;
  globalTags    = [...gTagSet];
  globalAuthors = [...gAuthorSet];

  // queue を更新
  cur.status  = "done";
  cur.entryId = entry.id;
  // v1.25.0 GROUP-7-b-save-reuse（案 A）:
  //   サムネ一覧モーダルで再表示する際、保存済みアイテムは既存 `thumbnails` IDB から
  //   流用するため、queue 側にも thumbId を記録しておく（saveHistory 全走査を避ける）
  cur.thumbId = thumbId;
  // v1.23.0: 絞り込み結果内で次の該当アイテムへ進む
  _extB1AdvanceCursorInFiltered(session);
  session.updatedAt = new Date().toISOString();
  await browser.storage.local.set({ extImportSessions: _extSessions });

  _extRenderSessionsList();

  // v1.24.0 GROUP-5-A: 別フォルダの場合のみ COPY_LOCAL_FILE を発火（同一フォルダは RENAME で処理済み）
  //   COPY 失敗は v1.23.0 からの既存仕様を踏襲：saveHistory は書込済み、警告表示のみ
  if (_extB1CopyToDest && !physicallySameFolder) {
    try {
      const copyRes = await browser.runtime.sendMessage({
        type:    "COPY_LOCAL_FILE",
        srcPath: cur.filePath,
        dstDir:  savePath,
        filename: effectiveFilename,
        tags, subTags, authors,
      });
      if (!copyRes?.ok) {
        showStatus(`⚠️ 保存は成功、コピー失敗: ${copyRes?.error || "不明"}`, true);
      }
    } catch (e) {
      showStatus(`⚠️ 保存は成功、コピー送信エラー: ${e.message || ""}`, true);
    }
  }

  // 次へ
  await _extB1LoadCurrent();
}

// ---------- v1.23.0: GROUP-4 絞り込み / GROUP-1-a1 ナビ ヘルパー ----------

/** 絞り込み UI の現在値を読み取る */
function _extB1ReadFilterFromUI() {
  const rd = (id) => !!document.getElementById(id)?.checked;
  return {
    done:    rd("ext-b1-flt-done"),
    skipped: rd("ext-b1-flt-skipped"),
    pending: rd("ext-b1-flt-pending"),
  };
}

/** セッションの絞り込み設定を UI に反映（チェック状態） */
function _extB1ApplyFilterToUI(filter) {
  const f = filter || _EXT_B1_FILTER_DEFAULT;
  const setChk = (id, on) => { const el = document.getElementById(id); if (el) el.checked = !!on; };
  setChk("ext-b1-flt-done",    f.done);
  setChk("ext-b1-flt-skipped", f.skipped);
  setChk("ext-b1-flt-pending", f.pending);
  // 「選択中」であることを背景色で強調
  const decorate = (id, color, on) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.background = on ? _hexToTint(color) : "";
  };
  decorate("ext-b1-flt-done-lbl",    _EXT_STATUS_COLOR.done,    f.done);
  decorate("ext-b1-flt-skipped-lbl", _EXT_STATUS_COLOR.skipped, f.skipped);
  decorate("ext-b1-flt-pending-lbl", _EXT_STATUS_COLOR.pending, f.pending);
}

/** ステータス色を淡い背景色に変換（簡易: 15% 透過相当） */
function _hexToTint(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  // 15% の色 + 85% の白
  const mix = (c) => Math.round(c * 0.15 + 255 * 0.85);
  return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
}

/** セッションの絞り込み設定を取得（未設定なら初期値） */
function _extB1GetFilter(session) {
  if (!session) return { ..._EXT_B1_FILTER_DEFAULT };
  if (!session.uiFilter) session.uiFilter = { ..._EXT_B1_FILTER_DEFAULT };
  return session.uiFilter;
}

/** queue の中で絞り込み条件に合致するインデックス配列を返す */
function _extB1GetFilteredIndices(session) {
  if (!session) return [];
  const f = _extB1GetFilter(session);
  const out = [];
  session.queue.forEach((q, i) => {
    if (q.status === "done"    && f.done)    out.push(i);
    if (q.status === "skipped" && f.skipped) out.push(i);
    if (q.status === "pending" && f.pending) out.push(i);
  });
  return out;
}

/** cursor を絞り込み結果内に寄せる（範囲外なら最も近い後方、なければ前方） */
function _extB1AdjustCursorToFilter(session) {
  if (!session) return;
  const filtered = _extB1GetFilteredIndices(session);
  if (filtered.length === 0) return;
  if (filtered.includes(session.cursor)) return;
  // cursor 以上で最小の該当、それがなければ cursor 未満で最大の該当
  const next = filtered.find(i => i >= session.cursor);
  const prev = [...filtered].reverse().find(i => i < session.cursor);
  session.cursor = (next !== undefined) ? next : (prev !== undefined ? prev : filtered[0]);
}

/** ナビ: 絞り込み結果内で delta 分移動 */
async function _extB1NavMove(delta) {
  const session = _extActiveSession;
  if (!session) return;
  const filtered = _extB1GetFilteredIndices(session);
  if (filtered.length === 0) return;
  const len = filtered.length;
  const pos = filtered.indexOf(session.cursor);
  // v1.25.4: 前後ナビもループ構造（最後の次 → 先頭、先頭の前 → 最後）
  //   範囲外 cursor は、前進なら最後の次＝先頭、後退なら先頭の前＝最後 となるよう基準位置を選ぶ
  const basePos = pos >= 0 ? pos : (delta > 0 ? len - 1 : 0);
  const newPos = ((basePos + delta) % len + len) % len;
  session.cursor = filtered[newPos];
  session.updatedAt = new Date().toISOString();
  await browser.storage.local.set({ extImportSessions: _extSessions });
  await _extB1LoadCurrent();
}

/** ナビ: 番号ジャンプ（絞り込み結果内 1 オリジン） */
async function _extB1NavJump() {
  const session = _extActiveSession;
  if (!session) return;
  const filtered = _extB1GetFilteredIndices(session);
  if (filtered.length === 0) {
    showStatus("⚠️ 絞り込み結果が空です", true);
    return;
  }
  const cur = filtered.indexOf(session.cursor);
  const curPos = cur >= 0 ? (cur + 1) : 1;
  const input = prompt(`何枚目へジャンプ？（1 – ${filtered.length}、現在 ${curPos}）`, String(curPos));
  if (input === null) return;
  const n = parseInt(input, 10);
  if (!Number.isFinite(n) || n < 1 || n > filtered.length) {
    showStatus(`⚠️ 1 – ${filtered.length} の範囲で入力してください`, true);
    return;
  }
  session.cursor = filtered[n - 1];
  session.updatedAt = new Date().toISOString();
  await browser.storage.local.set({ extImportSessions: _extSessions });
  await _extB1LoadCurrent();
}

// v1.23.2: GROUP-7-a サムネ一覧ページング状態（1 ページ 100 件固定）
const _EXT_B1_THUMB_PAGE_SIZE = 100;
let _extB1ThumbsPage = 0;

/** サムネ一覧モーダルを開く（カーソルを含むページへ自動ジャンプ） */
async function _extB1OpenThumbsModal() {
  const session = _extActiveSession;
  if (!session) return;
  const filtered = _extB1GetFilteredIndices(session);
  const modal = document.getElementById("ext-b1-thumbs-modal");
  const grid  = document.getElementById("ext-b1-thumbs-grid");
  if (!modal || !grid) return;
  modal.style.display = "flex";

  // v1.24.0 GROUP-10-a: B-1(ア) DOM キャッシュのセッション整合チェック
  //   セッションが切り替わっていれば qIdx が別物を指すためキャッシュクリア
  //   同一セッション内のモーダル再オープン時はキャッシュ維持で再フェッチを避ける
  const sessionKey = session.id || session.createdAt || "default";
  if (_extB1ThumbsCacheSessionKey !== sessionKey) {
    _extB1ThumbsCardCache.clear();
    grid.innerHTML = "";
    _extB1ThumbsCacheSessionKey = sessionKey;
  }

  // v1.23.2: カーソル（現在表示中の画像）が含まれるページへ初期フォーカス
  const cursorPos = filtered.indexOf(session.cursor);
  _extB1ThumbsPage = (cursorPos >= 0)
    ? Math.floor(cursorPos / _EXT_B1_THUMB_PAGE_SIZE)
    : 0;

  _extB1RenderThumbsPage(session, filtered);
}

/** v1.23.2: GROUP-7-a サムネ一覧の 1 ページ分を描画
 *  v1.24.0 GROUP-10-a: B-1(ア) 採用 — `innerHTML=""` を廃止し、`_extB1ThumbsCardCache` で
 *    qIdx → cardElement の DOM を保持。ページ送り時は display の切替のみ。
 *    遅延レスポンスが正しいカードの `img` に書き込まれるため、世代カウンタ不要。
 */
function _extB1RenderThumbsPage(session, filtered) {
  const grid    = document.getElementById("ext-b1-thumbs-grid");
  const cnt     = document.getElementById("ext-b1-thumbs-count");
  const info    = document.getElementById("ext-b1-thumbs-pageinfo");
  const btnPrev = document.getElementById("ext-b1-thumbs-prev");
  const btnNext = document.getElementById("ext-b1-thumbs-next");
  if (!grid) return;

  const total      = filtered.length;
  const pageSize   = _EXT_B1_THUMB_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (_extB1ThumbsPage >= totalPages) _extB1ThumbsPage = totalPages - 1;
  if (_extB1ThumbsPage < 0) _extB1ThumbsPage = 0;

  const page = _extB1ThumbsPage;
  const from = page * pageSize;
  const to   = Math.min(total, from + pageSize);

  if (cnt)  cnt.textContent  = `${total} / ${session.queue.length} 件 ｜ 表示 ${total === 0 ? 0 : from + 1}-${to}`;
  if (info) info.textContent = `${page + 1} / ${totalPages} ページ`;
  // v1.25.3: ページャーをループ構造化したため境界での disabled は無効化（0 件時のみ disabled）
  if (btnPrev) btnPrev.disabled = (totalPages <= 1);
  if (btnNext) btnNext.disabled = (totalPages <= 1);

  // v1.24.0 GROUP-10-a: 既存カードをすべて display:none（破棄せず保持）
  for (const card of _extB1ThumbsCardCache.values()) {
    card.style.display = "none";
  }
  // 空表示メッセージがあれば除去（残り続けるのを防ぐ）
  const emptyMsg = grid.querySelector(".ext-thumbs-empty");
  if (emptyMsg) emptyMsg.remove();

  if (total === 0) {
    const msg = document.createElement("div");
    msg.className = "ext-thumbs-empty";
    msg.style.cssText = "grid-column:1/-1;padding:30px;text-align:center;color:#888;";
    msg.textContent = "絞り込み結果が空です";
    grid.appendChild(msg);
    return;
  }

  // v1.24.0 GROUP-10-a: 当ページのカードを表示。キャッシュになければ生成して追加。
  //   ステータス（完了/スキップ/残り）・カーソル枠・ファイル名は表示前に最新化する
  //   （セッション中に保存されて status が変化、GROUP-5-A で filename が変わる等に対応）
  const pageItems = filtered.slice(from, to).map((qIdx) => ({ qIdx, q: session.queue[qIdx] }));
  pageItems.forEach(({ qIdx, q }) => {
    let card = _extB1ThumbsCardCache.get(qIdx);
    if (!card) {
      card = _extB1CreateThumbCard(session, qIdx, q);
      _extB1ThumbsCardCache.set(qIdx, card);
      grid.appendChild(card);
    } else {
      card.style.display = "";
      _extB1RefreshThumbCardStatus(card, session, qIdx, q);
    }
  });
}

/** v1.24.0 GROUP-10-a: サムネカード新規生成
 *  フェッチは `_extB1FireThumbFetch` 経由でセマフォ越し（GROUP-10-c、同時 5 件制限）
 */
function _extB1CreateThumbCard(session, qIdx, q) {
  const card = document.createElement("div");
  // ベースのレイアウト（枠色・カーソル枠は _extB1RefreshThumbCardStatus で上書き）
  card.style.cssText = "border:3px solid #ccc;border-radius:4px;padding:4px;cursor:pointer;background:#fff;display:flex;flex-direction:column;gap:3px;min-width:0;";

  const thumbWrap = document.createElement("div");
  thumbWrap.style.cssText = "width:100%;aspect-ratio:1/1;background:#222;border-radius:3px;overflow:hidden;display:flex;align-items:center;justify-content:center;position:relative;";
  const img = document.createElement("img");
  img.style.cssText = "max-width:100%;max-height:100%;object-fit:contain;";
  img.alt = q.fileName || "";
  thumbWrap.appendChild(img);

  // インデックスバッジ（固定）
  const idxBadge = document.createElement("div");
  idxBadge.style.cssText = "position:absolute;top:2px;left:2px;background:rgba(0,0,0,.6);color:#fff;font-size:10px;padding:1px 5px;border-radius:2px;";
  idxBadge.textContent = `#${qIdx + 1}`;
  thumbWrap.appendChild(idxBadge);

  // ステータスバッジ（色・文言は _extB1RefreshThumbCardStatus で更新）
  const statBadge = document.createElement("div");
  statBadge.className = "ext-thumb-stat";
  thumbWrap.appendChild(statBadge);

  card.appendChild(thumbWrap);

  const name = document.createElement("div");
  name.className = "ext-thumb-name";
  name.style.cssText = "font-size:10px;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
  name.textContent = q.fileName || "";
  name.title = q.fileName || "";
  card.appendChild(name);

  card.addEventListener("click", async () => {
    document.getElementById("ext-b1-thumbs-modal").style.display = "none";
    session.cursor = qIdx;
    session.updatedAt = new Date().toISOString();
    await browser.storage.local.set({ extImportSessions: _extSessions });
    await _extB1LoadCurrent();
  });

  // 初期スタイル適用（ステータスバッジ・枠色・カーソル枠）
  _extB1RefreshThumbCardStatus(card, session, qIdx, q);

  // v1.23.2: GROUP-7-c GIF はアニメ付きサムネを使う
  //          GENERATE_THUMBS_BATCH は background.js で
  //          thumbChunkPaths（Python 一時ファイル）→ Base64 変換まで
  //          面倒を見る既存経路を流用。保存時サムネと同品質（600px アニメ GIF / quality=85 JPEG）。
  // v1.24.0 GROUP-10-c: セマフォで同時発射数を 5 に制限
  _extB1FireThumbFetch(img, q);

  return card;
}

/** v1.24.0 GROUP-10-a: カードのステータスバッジ色／枠色／カーソル枠／ファイル名を最新化
 *  キャッシュされたカード再表示時と、フェッチ未完了／失敗時の再発射に使う
 */
function _extB1RefreshThumbCardStatus(card, session, qIdx, q) {
  const color = _EXT_STATUS_COLOR[q.status] || _EXT_STATUS_COLOR.pending;
  card.style.borderColor = color;
  if (qIdx === session.cursor) {
    card.style.outline = "2px dashed #2c3e50";
    card.style.outlineOffset = "2px";
  } else {
    card.style.outline = "";
    card.style.outlineOffset = "";
  }
  const statBadge = card.querySelector(".ext-thumb-stat");
  if (statBadge) {
    statBadge.style.cssText = `position:absolute;bottom:2px;right:2px;background:${color};color:#fff;font-size:10px;padding:1px 5px;border-radius:2px;font-weight:600;`;
    statBadge.textContent = q.status === "done" ? "完了" : (q.status === "skipped" ? "スキップ" : "残り");
  }
  const nameEl = card.querySelector(".ext-thumb-name");
  if (nameEl) {
    // GROUP-5-A で RENAME 後に queue[i].fileName が更新されるためここで反映
    nameEl.textContent = q.fileName || "";
    nameEl.title = q.fileName || "";
  }
  // フェッチ未完了 or 失敗で img.src が空なら再発射（モーダル再オープン時のリカバリ）
  const img = card.querySelector("img");
  if (img && !img.src && !img.dataset.fetching) {
    _extB1FireThumbFetch(img, q);
  }
}

/** v1.24.0 GROUP-10-a / GROUP-10-c / v1.25.0 GROUP-7-b-save-reuse + b-modal-cache:
 *  サムネフェッチ発射（多段フォールバック + セマフォ越し）
 *
 *  呼び出し側は「カード img の src を埋める」という目的だけ持ち、どのソースから
 *  取得したかを意識しない（v1.25.0 の「一本化」方針。dataUrl キャッシュ Map は追加せず、
 *  v1.24.0 の DOM キャッシュ + 本関数の多段フォールバックで事足りる）。
 *
 *  フォールバック順：
 *    ① save-reuse：保存済みアイテム（`q.thumbId` あり）は既存 `thumbnails` IDB から取得
 *    ② ext-persist：外部取り込み用 `externalImportThumbs` IDB に過去取得済のサムネがあれば流用
 *    ③ Native fetch：①②いずれもヒットしなければ GENERATE_THUMBS_BATCH / READ_LOCAL_IMAGE_BASE64
 *      （セマフォで同時 5 件に制限、GROUP-10-c）
 *    ④ Native fetch 成功後 → ext-persist に put（Q3=A：モーダル閲覧時のみ蓄積）
 *
 *  img.dataset.fetching で多重発射防止（再発射経路での重複防止、GROUP-10-a）
 */
async function _extB1FireThumbFetch(img, q) {
  if (!img || img.dataset.fetching) return;
  img.dataset.fetching = "1";
  try {
    // ① save-reuse（GROUP-7-b-save-reuse）：q.thumbId あれば saveHistory 用 IDB から取得
    if (q.thumbId) {
      try {
        const r = await browser.runtime.sendMessage({
          type:    "GET_THUMB_DATA_URL",
          thumbId: q.thumbId,
        });
        if (r?.dataUrl) { img.src = r.dataUrl; return; }
      } catch (_) { /* 取得失敗時は次段へ */ }
    }

    // ② ext-persist（GROUP-7-b-ext-persist）：filePath キーで外部取り込み用 IDB を引く
    try {
      const r = await browser.runtime.sendMessage({
        type:     "GET_EXT_THUMB",
        filePath: q.filePath,
      });
      if (r?.ok && r.dataUrl) { img.src = r.dataUrl; return; }
    } catch (_) { /* 次段へ */ }

    // ③ Native fetch（セマフォ越し）：GIF は GENERATE_THUMBS_BATCH、非 GIF は READ_LOCAL_IMAGE_BASE64
    await _extB1SemaAcquire();
    let dataUrl = null;
    try {
      const lc = (q.filePath || "").toLowerCase();
      if (lc.endsWith(".gif")) {
        const r = await browser.runtime.sendMessage({
          type:  "GENERATE_THUMBS_BATCH",
          paths: [q.filePath],
        });
        const b64  = r?.thumbs?.[q.filePath];
        const mime = r?.thumbMimes?.[q.filePath] || "image/gif";
        if (b64) dataUrl = `data:${mime};base64,${b64}`;
      } else {
        const r = await browser.runtime.sendMessage({
          type:    "READ_LOCAL_IMAGE_BASE64",
          path:    q.filePath,
          maxSize: 180,
        });
        if (r?.ok && r.dataUrl) dataUrl = r.dataUrl;
      }
    } finally {
      _extB1SemaRelease();
    }

    if (!dataUrl) return;
    img.src = dataUrl;

    // ④ Q3=A: モーダル閲覧時の Native fetch 成功時のみ ext-persist に put
    //    rootPath はキュー項目の sourceRoot（v1.22.0 以降、スキャン結果に付与）から解決。
    //    v1.25.2: 1 枚ずつ形式の既存セッション（sourceRoot 未付与）は _extActiveSession.rootPath で
    //    フォールバックし、ext-persist 永続化が空振りする問題を回避
    const rootPath = q.sourceRoot || (_extActiveSession && _extActiveSession.rootPath) || "";
    if (rootPath) {
      browser.runtime.sendMessage({
        type:     "SAVE_EXT_THUMB",
        filePath: q.filePath,
        dataUrl,
        rootPath,
      }).catch(() => { /* put 失敗は無視（描画は既に完了している） */ });
    }
  } catch (_) { /* 無視 */ }
  finally {
    delete img.dataset.fetching;
  }
}

// v1.23.3: GROUP-8-kbd ← / → キーナビゲーション用スロットル時刻（サムネ一覧モーダル時のみ適用）
let _extB1ThumbsKbdLastAt = 0;
const _EXT_B1_THUMBS_KBD_THROTTLE_MS = 250;

/**
 * v1.23.3: GROUP-8-kbd ← / → キーハンドラ
 *   - 1 枚ずつオーバーレイ表示中：_extB1NavMove(-1/+1) で前後画像
 *   - サムネ一覧モーダル表示中：250ms スロットルで前後ページ
 *   - IME 変換中／入力要素フォーカス中／フォルダピッカー開放中／セッション無しは無効
 */
function _extB1HandleArrowKey(event) {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  if (event.isComposing) return;
  if (!_extActiveSession) return;

  // オーバーレイ自体が表示されていなければ無効（他タブ表示中の誤爆防止）
  const overlay = document.getElementById("ext-b1-overlay");
  if (!overlay || overlay.style.display !== "flex") return;

  // フォルダピッカーが開いている間は無効
  const fp = document.getElementById("ext-b1-folder-picker");
  if (fp && fp.style.display === "flex") return;

  // 入力系要素にフォーカスがある場合は無効（チップ入力・検索欄など）
  const t = event.target;
  if (t && t instanceof HTMLElement) {
    const tag = (t.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (t.isContentEditable) return;
  }

  const delta = (event.key === "ArrowLeft") ? -1 : +1;

  // サムネ一覧モーダル表示中：前後ページ送り（スロットル 250ms）
  const thumbsModal = document.getElementById("ext-b1-thumbs-modal");
  if (thumbsModal && thumbsModal.style.display === "flex") {
    const now = Date.now();
    if (now - _extB1ThumbsKbdLastAt < _EXT_B1_THUMBS_KBD_THROTTLE_MS) {
      event.preventDefault();
      return;
    }
    _extB1ThumbsKbdLastAt = now;
    event.preventDefault();
    // v1.25.4: v1.23.3 の挙動に戻し、サムネ一覧モーダル中の ← / → でページ送りを行う
    //   （v1.25.3 で誤って全面無効化していた。本来の要望はスクロールイベント側の抑制）
    //   ページャーはループ構造（v1.25.3 で実装済）と整合
    const filtered = _extB1GetFilteredIndices(_extActiveSession);
    const totalPages = Math.max(1, Math.ceil(filtered.length / _EXT_B1_THUMB_PAGE_SIZE));
    _extB1ThumbsPage = (_extB1ThumbsPage + delta + totalPages) % totalPages;
    _extB1RenderThumbsPage(_extActiveSession, filtered);
    return;
  }

  // 1 枚ずつオーバーレイ表示中：前後画像へ移動
  // （オーバーレイが閉じている間は `_extActiveSession === null` となるため、
  //   セッション有＆他モーダル無しで到達した時点でオーバーレイ表示中と判定できる）
  event.preventDefault();
  _extB1NavMove(delta);
}

/** 進捗カウンタ・ナビ表示を更新（ステータス色統一） */
function _extB1RenderNavAndProgress(session) {
  if (!session) return;
  const total   = session.queue.length;
  const done    = session.queue.filter(q => q.status === "done").length;
  const skipped = session.queue.filter(q => q.status === "skipped").length;
  const pending = session.queue.filter(q => q.status === "pending").length;

  const prog = document.getElementById("ext-b1-progress");
  if (prog) {
    prog.innerHTML = "";
    const mk = (label, n, color) => {
      const span = document.createElement("span");
      span.innerHTML = `${label} <b style="color:${color};">${n}</b>`;
      span.style.color = "#555";
      return span;
    };
    prog.appendChild(mk("完了",    done,    _EXT_STATUS_COLOR.done));
    prog.appendChild(mk("スキップ", skipped, _EXT_STATUS_COLOR.skipped));
    prog.appendChild(mk("残り",    pending, _EXT_STATUS_COLOR.pending));
    const tot = document.createElement("span");
    tot.style.color = "#888";
    tot.textContent = `合計 ${total}`;
    prog.appendChild(tot);
  }

  // 絞り込み内での位置表示
  const filtered = _extB1GetFilteredIndices(session);
  const pos = filtered.indexOf(session.cursor);
  const posEl = document.getElementById("ext-b1-nav-pos");
  if (posEl) {
    if (filtered.length === 0) {
      posEl.textContent = "– / –";
      posEl.style.color = "#999";
    } else if (pos < 0) {
      posEl.textContent = `– / ${filtered.length}`;
      posEl.style.color = "#999";
    } else {
      posEl.textContent = `${pos + 1} / ${filtered.length}`;
      posEl.style.color = "#2c3e50";
    }
  }

  // ◀/▶ ボタンの有効化
  const prevBtn = document.getElementById("ext-b1-nav-prev");
  const nextBtn = document.getElementById("ext-b1-nav-next");
  if (prevBtn) prevBtn.disabled = filtered.length === 0 || (pos <= 0 && pos !== -1);
  if (nextBtn) nextBtn.disabled = filtered.length === 0 || (pos >= filtered.length - 1 && pos !== -1);
}

/** 絞り込み結果が空 / 非 pending 時の空表示 */
function _extB1RenderEmptyPreview(msg) {
  const imgEl  = document.getElementById("ext-b1-preview-img");
  const infoEl = document.getElementById("ext-b1-preview-info");
  if (imgEl)  imgEl.src = "";
  if (infoEl) infoEl.textContent = msg || "";
  ["ext-b1-filename", "ext-b1-filepath", "ext-b1-mtime"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = "";
  });
}

/** ステータスに応じて「保存して次へ」「スキップ」を有効/無効化 */
function _extB1ApplyStatusReadonly(status) {
  const saveBtn = document.getElementById("ext-b1-save-next");
  const skipBtn = document.getElementById("ext-b1-skip");
  const readonly = (status === "done" || status === "skipped");
  if (saveBtn) {
    saveBtn.disabled = readonly;
    saveBtn.title = readonly ? `${status === "done" ? "完了済み" : "スキップ済み"}のため保存できません` : "";
  }
  if (skipBtn) {
    skipBtn.disabled = readonly;
    skipBtn.title = readonly ? `${status === "done" ? "完了済み" : "スキップ済み"}のため操作できません` : "";
  }
}

/** 次の絞り込み該当位置へカーソルを進める（cursor 後にいなければ先頭へ巻き戻し。すべて処理済みで終了判定は呼び出し元で） */
function _extB1AdvanceCursorInFiltered(session) {
  const filtered = _extB1GetFilteredIndices(session);
  if (filtered.length === 0) {
    session.cursor = session.queue.length;
    return;
  }
  // 現在 cursor より大きい最小の該当インデックスへ
  const next = filtered.find(i => i > session.cursor);
  if (next !== undefined) {
    session.cursor = next;
  } else {
    // 後方に該当なし → 先頭の該当へ巻き戻し（飛ばした pending を拾えるように）
    session.cursor = filtered[0];
  }
}

async function _extB1FinishSessionIfDone() {
  const session = _extActiveSession;
  if (!session) return;
  const pending = session.queue.filter(q => q.status === "pending").length;
  if (pending > 0) return;

  const done    = session.queue.filter(q => q.status === "done").length;
  const skipped = session.queue.filter(q => q.status === "skipped").length;
  const total   = session.queue.length;

  // 完了ルートフォルダ履歴に追加（既存は上書き）
  const rootPathKey = session.rootPath;
  _extCompletedRoots = _extCompletedRoots.filter(r =>
    (r.rootPath || "").toLowerCase() !== rootPathKey.toLowerCase());
  _extCompletedRoots.unshift({
    rootPath:     rootPathKey,
    completedAt:  new Date().toISOString(),
    totalCount:   total,
    doneCount:    done,
    skippedCount: skipped,
  });
  await browser.storage.local.set({ extImportCompletedRoots: _extCompletedRoots });

  // folderListRef があれば対応フォルダを done にマーク
  if (session.folderListRef?.folderListId) {
    const fl = _extFolderList.find(f => f.id === session.folderListRef.folderListId);
    if (fl) {
      if (fl.mode === "single") {
        fl.done = true;
      } else if (fl.mode === "subfolders" && session.folderListRef.subfolderPath) {
        const sub = fl.subfolders.find(s => s.path === session.folderListRef.subfolderPath);
        if (sub) sub.done = true;
        fl.done = fl.subfolders.every(s => s.done);
      }
      await _extFlSave();
    }
  }

  // オーバーレイを閉じる
  _extActiveSession = null;
  document.getElementById("ext-b1-overlay").style.display = "none";

  _extRenderSessionsList();
  _extRenderFolderList();
  _extRenderCompletedRoots();

  const msg = skipped > 0
    ? `✅ セッション完了: 取込 ${done} / スキップ ${skipped}（スキップ分はセッション一覧から再処理できます）`
    : `✅ セッション完了: ${done} 件を取り込みました`;
  showStatus(msg);
}

// ---------- b1 フォルダピッカー（簡易 tree-view） ----------

async function _extB1OpenFolderPicker() {
  const inp = document.getElementById("ext-b1-savepath");
  const cur = (inp?.value || "").trim();
  _extFpSelectedPath = cur || null;
  document.getElementById("ext-b1-folder-picker").style.display = "flex";
  await _extFpNavigate(cur || null);
}

async function _extFpNavigate(path) {
  _extFpCurrent = path;
  _extFpSelectedPath = path;
  const bc = document.getElementById("ext-b1-fp-breadcrumb");
  if (bc) bc.textContent = path || "（ドライブ一覧）";
  const listEl = document.getElementById("ext-b1-fp-list");
  if (listEl) listEl.innerHTML = "⏳ 取得中...";

  let res;
  try {
    res = await browser.runtime.sendMessage({ type: "LIST_DIR", path: path ?? null });
  } catch (e) {
    listEl.innerHTML = `<div style="color:#c0392b;">エラー: ${escHtml(e.message || "")}</div>`;
    return;
  }
  if (!res?.ok) {
    listEl.innerHTML = `<div style="color:#c0392b;">取得失敗: ${escHtml(res?.error || "")}</div>`;
    return;
  }
  listEl.innerHTML = "";

  // 親へ戻る
  if (path) {
    const up = document.createElement("div");
    up.style.cssText = "padding:5px 8px;cursor:pointer;border-radius:3px;font-size:12px;color:#555;";
    up.textContent = "↑ 親フォルダへ";
    up.onmouseover = () => up.style.background = "#f0f6ff";
    up.onmouseout  = () => up.style.background = "";
    up.addEventListener("click", () => {
      const parentPath = _extDirname(path);
      _extFpNavigate(parentPath || null);
    });
    listEl.appendChild(up);
  }

  const dirs = (res.entries || []).filter(e => e.isDir);
  for (const d of dirs) {
    const row = document.createElement("div");
    row.style.cssText = "padding:5px 8px;cursor:pointer;border-radius:3px;font-size:12px;color:#2c3e50;display:flex;align-items:center;gap:6px;";
    row.innerHTML = `<span>📁</span><span></span>`;
    row.children[1].textContent = d.name;
    row.onmouseover = () => row.style.background = "#f0f6ff";
    row.onmouseout  = () => row.style.background = "";
    row.addEventListener("click", () => {
      const sep = path && !path.endsWith("\\") && !path.endsWith("/") ? "\\" : "";
      const child = path ? (path + sep + d.name) : (d.name.endsWith(":") ? d.name + "\\" : d.name);
      _extFpNavigate(child);
    });
    listEl.appendChild(row);
  }

  if (dirs.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "padding:8px;color:#888;font-size:12px;";
    empty.textContent = "サブフォルダはありません。";
    listEl.appendChild(empty);
  }
}

async function _extFpMakeDir() {
  if (!_extFpCurrent) {
    showStatus("⚠️ ドライブ一覧では新規フォルダを作成できません", true);
    return;
  }
  const name = prompt("新規フォルダ名を入力してください");
  if (!name) return;
  const sep = _extFpCurrent && !_extFpCurrent.endsWith("\\") && !_extFpCurrent.endsWith("/") ? "\\" : "";
  const newPath = _extFpCurrent + sep + name;
  let res;
  try {
    res = await browser.runtime.sendMessage({
      type: "MKDIR", path: newPath, contextPath: _extFpCurrent,
    });
  } catch (e) {
    showStatus(`❌ 作成失敗: ${e.message || ""}`, true);
    return;
  }
  if (!res?.ok) {
    showStatus(`❌ 作成失敗: ${res?.error || ""}`, true);
    return;
  }
  showStatus(`✅ 作成しました: ${newPath}`);
  await _extFpNavigate(_extFpCurrent);
}

async function _extFpMakeTagDir() {
  if (!_extFpCurrent) {
    showStatus("⚠️ ドライブ一覧ではフォルダを作成できません", true);
    return;
  }
  if (_extB1MainTags.length === 0) {
    showStatus("⚠️ メインタグが入力されていません", true);
    return;
  }
  const name = _extB1MainTags[0];
  const sep = _extFpCurrent && !_extFpCurrent.endsWith("\\") && !_extFpCurrent.endsWith("/") ? "\\" : "";
  const newPath = _extFpCurrent + sep + name;
  let res;
  try {
    res = await browser.runtime.sendMessage({
      type: "MKDIR", path: newPath, contextPath: _extFpCurrent,
    });
  } catch (e) {
    showStatus(`❌ 作成失敗: ${e.message || ""}`, true);
    return;
  }
  if (!res?.ok) {
    showStatus(`❌ 作成失敗: ${res?.error || ""}`, true);
    return;
  }
  showStatus(`✅ 作成しました: ${newPath}`);
  await _extFpNavigate(_extFpCurrent);
}
