/**
 * background.js
 * - コンテキストメニューの登録
 * - Native Messaging でネイティブアプリ（image_saver.py）と通信
 *   - LIST_DIR   : ディレクトリ一覧の取得
 *   - SAVE_IMAGE : 画像の保存（任意の絶対パスへ）
 * - タグデータの永続化（storage.local）
 */

const NATIVE_APP_ID = "image_saver_host";

// ----------------------------------------------------------------
// 動作ログ（最大200件・新しい順）
// ----------------------------------------------------------------
const LOG_MAX = 200;

async function addLog(level, message, detail = null) {
  const entry = {
    time:    new Date().toISOString(),
    level,   // "INFO" | "WARN" | "ERROR"
    message,
    detail,
  };
  // コンソールにも出力
  const fn = level === "ERROR" ? console.error : level === "WARN" ? console.warn : console.log;
  fn(`[ImageSaver][${level}] ${message}`, detail ?? "");

  const stored = await browser.storage.local.get("appLogs");
  const logs = stored.appLogs || [];
  logs.unshift(entry);
  if (logs.length > LOG_MAX) logs.length = LOG_MAX;
  await browser.storage.local.set({ appLogs: logs });
}

async function getLogs() {
  const stored = await browser.storage.local.get("appLogs");
  return { logs: stored.appLogs || [] };
}

async function clearLogs() {
  await browser.storage.local.set({ appLogs: [] });
  return { ok: true };
}

// ----------------------------------------------------------------
// コンテキストメニュー登録
// ----------------------------------------------------------------
browser.contextMenus.create({
  id: "save-image-with-tags",
  title: "画像をタグ付きで保存",
  contexts: ["image"],
});

// アイコンクリックで設定タブを開く（popup を使わない）
browser.browserAction.onClicked.addListener(() => {
  browser.runtime.openOptionsPage();
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "save-image-with-tags") return;
  browser.tabs.sendMessage(tab.id, {
    type: "OPEN_SAVE_MODAL",
    imageUrl: info.srcUrl,
    pageUrl:  info.pageUrl,
  });
});

// ----------------------------------------------------------------
// モーダルウィンドウ管理
// ----------------------------------------------------------------
let modalWindowId = null;

async function openModalWindow(imageUrl, pageUrl) {
  // 既存ウィンドウが開いていれば再利用
  if (modalWindowId !== null) {
    try {
      const win = await browser.windows.get(modalWindowId);
      if (win) {
        // 新しい画像情報を一時保存
        await browser.storage.local.set({ _pendingModal: { imageUrl, pageUrl } });
        // 最小化されている場合は通常状態に戻してからフォーカス
        if (win.state === "minimized") {
          await browser.windows.update(modalWindowId, { state: "normal" });
        }
        await browser.windows.update(modalWindowId, { focused: true });
        // modal.js に再初期化を通知
        const tabs = await browser.tabs.query({ windowId: modalWindowId });
        if (tabs[0]) {
          browser.tabs.sendMessage(tabs[0].id, { type: "MODAL_NEW_IMAGE", imageUrl, pageUrl });
        }
        return;
      }
    } catch (_) {
      modalWindowId = null;
    }
  }

  // ウィンドウサイズを storage から取得
  const { modalSize } = await browser.storage.local.get("modalSize");
  const w = modalSize?.width       || 920;
  const h = modalSize?.height      || 580;

  // 画像情報を一時保存
  await browser.storage.local.set({ _pendingModal: { imageUrl, pageUrl } });

  const win = await browser.windows.create({
    url:    browser.runtime.getURL("src/modal/modal.html"),
    type:   "normal",  // popup だとホイールイベントがJSに届かないため normal に変更
    width:  w,
    height: h,
  });
  modalWindowId = win.id;
}

// ウィンドウが閉じられたら ID をリセット
browser.windows.onRemoved.addListener((windowId) => {
  if (windowId === modalWindowId) modalWindowId = null;
});

// ----------------------------------------------------------------
// Content Script からのメッセージを受信
// ----------------------------------------------------------------
browser.runtime.onMessage.addListener(async (message) => {
  switch (message.type) {
    case "OPEN_MODAL_WINDOW":
      openModalWindow(message.imageUrl, message.pageUrl);
      return;
    case "LIST_DIR":
      return listDir(message.path);
    case "EXECUTE_SAVE":
      return handleSave(message.payload);
    case "EXECUTE_SAVE_MULTI":
      return handleSaveMulti(message.payload);
    case "GET_ALL_TAGS":
      return getAllTags();
    case "GET_LAST_SAVE_DIR":
      return getLastSaveDir();
    case "MKDIR":
      return makeDir(message.path);
    case "WRITE_FILE":
      return writeFile(message.path, message.content);
    // ---- タグ別保存先 ----
    case "GET_TAG_DESTINATIONS":
      return getTagDestinations();
    case "SET_TAG_DESTINATIONS":
      return setTagDestinations(message.data);
    case "RECORD_TAG_DESTINATION":
      return recordTagDestination(message.tags, message.path);
    // ---- エクスプローラー設定 ----
    case "GET_EXPLORER_SETTINGS":
      return getExplorerSettings();
    case "SET_EXPLORER_VIEW_MODE":
      return setExplorerViewMode(message.mode);
    case "SET_EXPLORER_START_PRIORITY":
      return setExplorerStartPriority(message.priority);
    // ---- 直近タグ ----
    case "GET_RECENT_TAGS":
      return getRecentTags();
    case "GET_RECENT_SUBTAGS":
      return getRecentSubTags();
    case "UPDATE_RECENT_SUBTAGS":
      return updateRecentSubTags(message.tags);
    // ---- ブックマーク ----
    case "GET_BOOKMARKS":
      return getBookmarks();
    case "SET_BOOKMARKS":
      return setBookmarks(message.data);
    // ---- モーダルサイズ ----
    case "GET_MODAL_SIZE":
      return getModalSize();
    case "SET_MODAL_SIZE":
      return setModalSize(message.size);
    // ---- 保存履歴 ----
    case "GET_SAVE_HISTORY":
      return getSaveHistory();
    case "UPDATE_HISTORY_ENTRY_TAGS":
      return updateHistoryEntryTags(message.id, message.tags);
    case "UPDATE_HISTORY_ENTRY":
      return updateHistoryEntry(message.id, message.tags, message.authors);
    // ---- 作者 ----
    case "GET_GLOBAL_AUTHORS":
      return getGlobalAuthors();
    case "GET_RECENT_AUTHORS":
      return getRecentAuthors();
    case "GET_AUTHOR_DESTINATIONS":
      return getAuthorDestinations();
    case "SET_AUTHOR_DESTINATIONS":
      return setAuthorDestinations(message.data);
    case "GET_CONTINUOUS_SESSION":
      return getContinuousSession();
    case "SET_CONTINUOUS_SESSION":
      return setContinuousSession(message.session);
    case "FETCH_IMAGE_AS_DATAURL":
      return fetchImageAsDataUrl(message.url);
    case "FETCH_PREVIEW":
      return fetchPreviewViaNative(message.url);
    case "GET_THUMB_DATA_URL":
      return getThumbDataUrl(message.thumbId || message.id);
    case "DELETE_THUMB":
      await deleteThumbFromIDB(message.thumbId);
      return { ok: true };
    case "GENERATE_MISSING_THUMBS":
      return generateMissingThumbs(message.targetIds || null, message.overwrite || false);
    case "EXPORT_IDB_THUMBS":
      return exportIdbThumbs();
    case "IMPORT_IDB_THUMBS":
      return importIdbThumbs(message.thumbs);
    case "GET_STORAGE_SIZE":
      return getStorageSize();
    // ---- エクスプローラーで開く ----
    case "OPEN_EXPLORER":
      return openExplorer(message.path);
    case "OPEN_FILE":
      return openFile(message.path);
    case "INSTANT_SAVE":
      return handleInstantSave(message.imageUrl, message.pageUrl);
    case "FETCH_FILE_AS_DATAURL":
      return fetchFileAsDataUrl(message.path);
    case "DEBUG_LOG":
      addLog("DEBUG", message.msg || "");
      return { ok: true };
    // ---- 動作ログ ----
    case "GET_LOGS":
      return getLogs();
    case "CLEAR_LOGS":
      return clearLogs();
    default:
      break;
  }
});

// ----------------------------------------------------------------
// Native Messaging ヘルパー
// ----------------------------------------------------------------

/**
 * ネイティブアプリに1回だけメッセージを送り、応答を返す。
 * Native Messaging は常時接続ではなく、リクエスト毎に接続・切断する。
 */
function sendNative(payload) {
  return new Promise((resolve, reject) => {
    let port;
    try {
      port = browser.runtime.connectNative(NATIVE_APP_ID);
    } catch (e) {
      addLog("ERROR", `connectNative 失敗`, e.message);
      reject(new Error(`ネイティブアプリへの接続に失敗しました: ${e.message}`));
      return;
    }

    addLog("INFO", `Native送信: ${payload.cmd}`, JSON.stringify(payload).slice(0, 200));

    const timer = setTimeout(() => {
      port.disconnect();
      addLog("ERROR", `Native タイムアウト: ${payload.cmd}`);
      reject(new Error("ネイティブアプリからの応答がタイムアウトしました"));
    }, 10000);

    port.onMessage.addListener((response) => {
      clearTimeout(timer);
      port.disconnect();
      addLog(response.ok === false ? "WARN" : "INFO",
        `Native応答: ${payload.cmd}`,
        JSON.stringify(response).slice(0, 200));
      resolve(response);
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      const err = browser.runtime.lastError?.message || "ネイティブアプリが切断されました";
      addLog("ERROR", `Native切断: ${payload.cmd}`, err);
      reject(new Error(err));
    });

    port.postMessage(payload);
  });
}

// ----------------------------------------------------------------
// ディレクトリ一覧取得
// ----------------------------------------------------------------
/**
 * ネイティブアプリにディレクトリ内容を問い合わせる。
 * path が null の場合はドライブ一覧（Windows）またはルート配下を返す。
 *
 * 返却形式:
 * {
 *   ok: true,
 *   path: "C:\\Users\\...",   // 現在のパス（絶対）
 *   entries: [
 *     { name: "Pictures", isDir: true },
 *     { name: "file.txt",  isDir: false },
 *   ]
 * }
 */
async function listDir(path) {
  try {
    const res = await sendNative({ cmd: "LIST_DIR", path: path ?? null });
    return res;
  } catch (err) {
    console.error("[ImageSaver] listDir error:", err);
    return { ok: false, error: err.message };
  }
}

// ----------------------------------------------------------------
// ファイル名メタデータ付与ヘルパー
// ----------------------------------------------------------------

/**
 * ファイル名設定に基づいて、ファイル名にタグ・サブタグ・権利者名を付加する。
 * ファイル名に使えない文字（\ / : * ? " < > |）は除去する。
 *
 * @param {string}   filename  元のファイル名（例: "image.jpg"）
 * @param {string[]} tags      メインタグ配列
 * @param {string[]} subTags   サブタグ配列
 * @param {string[]} authors   権利者名配列
 * @param {{ filenameIncludeTag: boolean, filenameIncludeSubtag: boolean, filenameIncludeAuthor: boolean }} settings
 * @returns {string} 新しいファイル名
 */
function buildFilenameWithMeta(filename, tags, subTags, authors, settings) {
  const { filenameIncludeTag, filenameIncludeSubtag, filenameIncludeAuthor } = settings;
  if (!filenameIncludeTag && !filenameIncludeSubtag && !filenameIncludeAuthor) return filename;

  // 拡張子を分離
  const dotIdx = filename.lastIndexOf(".");
  const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
  const ext  = dotIdx > 0 ? filename.slice(dotIdx) : "";

  // ファイル名に使えない文字を除去するヘルパー
  const sanitize = (s) => s.replace(/[\\/:*?"<>|]/g, "").trim();

  const parts = [];
  if (filenameIncludeTag    && tags?.length)    parts.push(...tags.map(sanitize).filter(Boolean));
  if (filenameIncludeSubtag && subTags?.length)  parts.push(...subTags.map(sanitize).filter(Boolean));
  if (filenameIncludeAuthor && authors?.length)  parts.push(...authors.map(sanitize).filter(Boolean));

  if (parts.length === 0) return filename;
  return `${stem}-${parts.join("-")}${ext}`;
}

// ----------------------------------------------------------------
// 保存処理
// ----------------------------------------------------------------
async function handleSave(payload) {
  const { imageUrl, filename, tags, subTags, authors, author, pageUrl, thumbDataUrl, thumbWidth, thumbHeight, skipTagRecord, sessionId, sessionIndex } = payload;
  const savePath = normalizePath(payload.savePath);
  const allTags = [...new Set([...(tags || []), ...(subTags || [])])]; // 履歴・saveTagRecord用（サブタグ含む）
  const resolvedAuthors = Array.isArray(authors) ? authors.filter(Boolean) : (author ? [String(author)] : []);

  // ファイル名設定に基づいてタグ・サブタグ・権利者名をファイル名に付加
  const { filenameIncludeTag, filenameIncludeSubtag, filenameIncludeAuthor } =
    await browser.storage.local.get(["filenameIncludeTag", "filenameIncludeSubtag", "filenameIncludeAuthor"]);
  const effectiveFilename = buildFilenameWithMeta(filename, tags || [], subTags || [], resolvedAuthors, {
    filenameIncludeTag:    !!filenameIncludeTag,
    filenameIncludeSubtag: !!filenameIncludeSubtag,
    filenameIncludeAuthor: !!filenameIncludeAuthor,
  });

  const fullPath = `${savePath}\\${effectiveFilename}`;

  addLog("INFO", `保存開始: ${filename}`, `→ ${savePath}`);

  try {
    let res = await sendNative({ cmd: "SAVE_IMAGE", url: imageUrl, savePath: fullPath });
    if (!res.ok && ((res.error || "").includes("403") || (res.error || "").includes("Forbidden"))) {
      // ブラウザで表示済みの画像を既存のログインセッションを使って取得（Fanbox など）
      addLog("INFO", `SAVE_IMAGE 403 → ブラウザ権限でフォールバック: ${imageUrl}`);
      const fetched = await fetchImageAsDataUrl(imageUrl);
      if (fetched.dataUrl) {
        res = await sendNative({ cmd: "SAVE_IMAGE_BASE64", dataUrl: fetched.dataUrl, savePath: fullPath });
      }
    }
    if (!res.ok) throw new Error(res.error || "不明なエラー");

    addLog("INFO", `保存成功: ${fullPath}`);
    await browser.storage.local.set({ lastSaveDir: savePath });

    if (allTags.length > 0) {
      await saveTagRecord({ imageUrl, filename: fullPath, tags: allTags });
    }
    if (tags && tags.length > 0) {
      await updateRecentTags(tags); // recentTagsはメインタグのみ
    }
    if (tags && tags.length > 0 && !skipTagRecord) {
      addLog("DEBUG", `recordTagDestination: tags=${JSON.stringify(tags)} subTags=${JSON.stringify(subTags || [])} savePath=${savePath}`);
      await recordTagDestination(tags, savePath); // 保存先関連付けはサブタグ除く
    }

    // サムネイル優先度:
    // ① content側（DOM img / fetch）→ ② Python側（ダウンロード済みデータを再利用）→ ③ background XHR
    if (res.thumbError) {
      addLog("WARN", "サムネイル生成失敗 (Pillow未インストールの可能性)", res.thumbError);
    }
    const mime = res.thumbMime || "image/jpeg";
    const effectiveThumbDataUrl = thumbDataUrl
      || (res.thumbData ? `data:${mime};base64,${res.thumbData}` : null);
    const effectiveThumbW = thumbDataUrl ? thumbWidth  : (res.thumbWidth  || null);
    const effectiveThumbH = thumbDataUrl ? thumbHeight : (res.thumbHeight || null);

    await addSaveHistory({
      imageUrl, filename: effectiveFilename, savePath, tags: allTags, authors: resolvedAuthors, pageUrl,
      thumbDataUrl: effectiveThumbDataUrl,
      thumbWidth:   effectiveThumbW,
      thumbHeight:  effectiveThumbH,
      sessionId:    sessionId    || null,
      sessionIndex: sessionIndex || null,
    });

    return { success: true };
  } catch (err) {
    addLog("ERROR", `保存失敗: ${fullPath}`, err.message);
    return { success: false, error: err.message };
  }
}

// ----------------------------------------------------------------
// タグ永続化
// ----------------------------------------------------------------
async function saveTagRecord({ imageUrl, filename, tags }) {
  const key = imageUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 100);
  const stored = await browser.storage.local.get("tagRecords");
  const tagRecords = stored.tagRecords || {};
  tagRecords[key] = { imageUrl, filename, tags, savedAt: new Date().toISOString() };
  await browser.storage.local.set({ tagRecords });
  await updateGlobalTagSet(tags);
}

async function updateGlobalTagSet(newTags) {
  const stored = await browser.storage.local.get("globalTags");
  const globalTags = new Set(stored.globalTags || []);
  newTags.forEach((t) => globalTags.add(t));
  await browser.storage.local.set({ globalTags: Array.from(globalTags) });
}

async function getAllTags() {
  const stored = await browser.storage.local.get("globalTags");
  return { tags: stored.globalTags || [] };
}

async function getLastSaveDir() {
  const stored = await browser.storage.local.get("lastSaveDir");
  return { lastSaveDir: stored.lastSaveDir || null };
}

// ----------------------------------------------------------------
// フォルダ作成
// ----------------------------------------------------------------
async function makeDir(path) {
  try {
    const res = await sendNative({ cmd: "MKDIR", path });
    return res;
  } catch (err) {
    console.error("[ImageSaver] makeDir error:", err);
    return { ok: false, error: err.message };
  }
}

// ----------------------------------------------------------------
// テキストファイル書き出し（エクスポート即出力用）
// ----------------------------------------------------------------
async function writeFile(path, content) {
  try {
    const res = await sendNative({ cmd: "WRITE_FILE", path, content });
    return res;
  } catch (err) {
    console.error("[ImageSaver] writeFile error:", err);
    return { ok: false, error: err.message };
  }
}

// ----------------------------------------------------------------
// タグ別保存先 — 取得・保存・自動記録
// ----------------------------------------------------------------

/**
 * storage.local から全タグの保存先マップを返す。
 * 形式: { "タグ名": [ { id, path, label }, ... ], ... }
 */
async function getTagDestinations() {
  const stored = await browser.storage.local.get("tagDestinations");
  return { tagDestinations: stored.tagDestinations || {} };
}

/**
 * タグ別保存先マップ全体を上書き保存する（設定画面から呼ばれる）。
 */
async function setTagDestinations(data) {
  await browser.storage.local.set({ tagDestinations: data });
  return { ok: true };
}

/**
 * 保存成功後に自動で呼ばれる。
 * 各タグに対して savePath を「記録済み保存先」として追加する。
 * 同じパスが既に登録済みの場合はスキップ（重複しない）。
 */
async function recordTagDestination(tags, savePath) {
  const stored = await browser.storage.local.get("tagDestinations");
  const dest = stored.tagDestinations || {};

  for (const tag of tags) {
    if (!dest[tag]) dest[tag] = [];
    const alreadyExists = dest[tag].some((d) => d.path === savePath);
    if (!alreadyExists) {
      dest[tag].push({
        id:    crypto.randomUUID(),
        path:  savePath,
        label: "", // ラベルは設定画面で後から付けられる
      });
    }
  }

  await browser.storage.local.set({ tagDestinations: dest });
  return { ok: true };
}

// ----------------------------------------------------------------
// エクスプローラー設定（表示形式・初期フォルダ）
// ----------------------------------------------------------------

/**
 * エクスプローラーの設定を一括取得する。
 * - viewMode     : "list" | "detail" | "tile"
 * - rootPath     : 初期表示フォルダの絶対パス（null = PC/ドライブ一覧）
 */
// ----------------------------------------------------------------
// 即保存処理
// ----------------------------------------------------------------
async function handleInstantSave(imageUrl, pageUrl) {
  try {
    // 保存先を「開始フォルダの優先順位」に従って決定
    const [explorerSettings, stored] = await Promise.all([
      getExplorerSettings(),
      browser.storage.local.get(["lastSaveDir", "continuousSession"]),
    ]);

    let savePath = null;
    if (explorerSettings.startPriority === "lastSave" && stored.lastSaveDir) {
      savePath = stored.lastSaveDir;
    } else if (explorerSettings.rootPath) {
      savePath = explorerSettings.rootPath;
    } else if (stored.lastSaveDir) {
      savePath = stored.lastSaveDir;
    }

    if (!savePath) {
      return { success: false, error: "保存先が設定されていません" };
    }

    // ファイル名を生成
    const urlObj = new URL(imageUrl);
    const basename = urlObj.pathname.split("/").pop() || "image.jpg";
    const filename = basename.split("?")[0] || "image.jpg";

    // 連続保存セッション中はタグ・サブタグを引き継ぎ
    const session = stored.continuousSession;
    const tags    = session?.tags    || [];
    const subTags = session?.subTags || [];
    const allTags = [...new Set([...tags, ...subTags])];

    // ファイル名設定に基づいてタグ・サブタグをファイル名に付加（即保存は権利者なし）
    const { filenameIncludeTag, filenameIncludeSubtag, filenameIncludeAuthor } =
      await browser.storage.local.get(["filenameIncludeTag", "filenameIncludeSubtag", "filenameIncludeAuthor"]);
    const effectiveFilenameInstant = buildFilenameWithMeta(filename, tags, subTags, [], {
      filenameIncludeTag:    !!filenameIncludeTag,
      filenameIncludeSubtag: !!filenameIncludeSubtag,
      filenameIncludeAuthor: !!filenameIncludeAuthor,
    });

    const fullPath = `${savePath}\\${effectiveFilenameInstant}`;

    const res = await sendNative({ cmd: "SAVE_IMAGE", url: imageUrl, savePath: fullPath });
    if (!res.ok) return { success: false, error: res.error };

    await browser.storage.local.set({ lastSaveDir: savePath });
    if (allTags.length > 0) {
      await saveTagRecord({ imageUrl, filename: fullPath, tags: allTags });
      if (tags.length > 0) await updateRecentTags(tags);
    }

    // Python側が返すサムネイルデータを使用（通常保存と同じ処理）
    if (res.thumbError) {
      addLog("WARN", "即保存: サムネイル生成失敗 (Pillow未インストールの可能性)", res.thumbError);
    }
    const mime = res.thumbMime || "image/jpeg";
    const thumbDataUrl = res.thumbData ? `data:${mime};base64,${res.thumbData}` : null;
    const thumbWidth   = res.thumbWidth  || null;
    const thumbHeight  = res.thumbHeight || null;

    // 履歴に追加
    await addSaveHistory({
      imageUrl, filename: effectiveFilenameInstant, savePath, tags: allTags, pageUrl,
      thumbDataUrl, thumbWidth, thumbHeight,
      sessionId: session?.id || null,
      sessionIndex: session ? (session.count + 1) : null,
    });
    // セッション更新
    if (session) {
      session.count = (session.count || 0) + 1;
      await browser.storage.local.set({ continuousSession: session });
    }

    addLog("INFO", `即保存: ${fullPath}`);
    return { success: true };
  } catch (err) {
    addLog("ERROR", `即保存失敗: ${err.message}`);
    return { success: false, error: err.message };
  }
}

async function getExplorerSettings() {
  const stored = await browser.storage.local.get([
    "explorerViewMode", "explorerRootPath", "explorerStartPriority", "explorerFolderSort",
  ]);
  return {
    viewMode:      stored.explorerViewMode      || "list",
    rootPath:      stored.explorerRootPath      || null,
    startPriority: stored.explorerStartPriority || "lastSave",
    folderSort:    stored.explorerFolderSort    || "name-asc",
  };
}

/** 表示形式を保存する */
async function setExplorerViewMode(mode) {
  await browser.storage.local.set({ explorerViewMode: mode });
  return { ok: true };
}

/** 初期フォルダの優先度を保存する（"lastSave" | "rootPath"） */
async function setExplorerStartPriority(priority) {
  await browser.storage.local.set({ explorerStartPriority: priority });
  return { ok: true };
}

// ----------------------------------------------------------------
// 直近タグ（保存時に使ったタグを最大20件記憶）
// ----------------------------------------------------------------

/**
 * 直近タグ一覧を返す。新しいものが先頭。
 * 返却: { recentTags: string[] }
 */
async function getRecentTags() {
  const stored = await browser.storage.local.get("recentTags");
  return { recentTags: stored.recentTags || [] };
}


/**
 * 保存成功後に呼ばれる。
 * 使ったタグを recentTags の先頭に追加し、重複除去・最大20件を保つ。
 */
async function getRecentSubTags() {
  const stored = await browser.storage.local.get("recentSubTags");
  return { recentSubTags: stored.recentSubTags || [] };
}

async function updateRecentSubTags(tags) {
  const stored = await browser.storage.local.get("recentSubTags");
  const current = stored.recentSubTags || [];
  const next = [...new Set([...tags, ...current])].slice(0, 20);
  await browser.storage.local.set({ recentSubTags: next });
  return { ok: true };
}

async function updateRecentTags(tags) {
  const stored = await browser.storage.local.get("recentTags");
  const current = stored.recentTags || [];
  // 使ったタグを先頭に挿入、既存の同タグは除去、100件上限（設定画面の最大表示件数に合わせる）
  const next = [
    ...tags,
    ...current.filter((t) => !tags.includes(t)),
  ].slice(0, 100);
  await browser.storage.local.set({ recentTags: next });
}

// ----------------------------------------------------------------
// ブックマーク
// ----------------------------------------------------------------

/**
 * ブックマーク一覧を返す。
 * 形式: { bookmarks: [ { id, path, label }, ... ] }
 */
async function getBookmarks() {
  const stored = await browser.storage.local.get("folderBookmarks");
  return { bookmarks: stored.folderBookmarks || [] };
}

/** ブックマーク一覧を丸ごと保存する（設定画面から呼ばれる） */
async function setBookmarks(data) {
  await browser.storage.local.set({ folderBookmarks: data });
  return { ok: true };
}

// ----------------------------------------------------------------
// モーダルサイズの保存・復元
// ----------------------------------------------------------------

/** 前回のモーダルサイズを返す */
async function getModalSize() {
  const stored = await browser.storage.local.get("modalSize");
  return { modalSize: stored.modalSize || null };
}

/** モーダルサイズを保存する（リサイズ操作の終端から呼ばれる） */
async function setModalSize(size) {
  await browser.storage.local.set({ modalSize: size });
  return { ok: true };
}

// ----------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------

/**
 * Windowsパスの正規化
 * - \\ の連続を \ 1個に統一
 * - 末尾の \ を除去
 */
function normalizePath(p) {
  if (!p) return p;
  return p.replace(/\\{2,}/g, "\\").replace(/\\+$/, "");
}

// ----------------------------------------------------------------
// 保存履歴（最大3件・新しい順）
// ----------------------------------------------------------------

async function getSaveHistory() {
  const stored = await browser.storage.local.get("saveHistory");
  return { saveHistory: stored.saveHistory || [] };
}

async function updateHistoryEntryTags(id, newTags) {
  if (!id || !Array.isArray(newTags)) return { ok: false };
  const stored  = await browser.storage.local.get("saveHistory");
  const history = stored.saveHistory || [];
  const idx     = history.findIndex(e => e.id === id);
  if (idx === -1) return { ok: false };
  history[idx]  = { ...history[idx], tags: newTags };
  await browser.storage.local.set({ saveHistory: history });
  return { ok: true };
}

async function updateHistoryEntry(id, newTags, newAuthors) {
  if (!id) return { ok: false };
  const stored  = await browser.storage.local.get(["saveHistory", "globalTags", "globalAuthors"]);
  const history = stored.saveHistory || [];
  const idx     = history.findIndex(e => e.id === id);
  if (idx === -1) return { ok: false };
  if (Array.isArray(newTags))    history[idx].tags    = newTags;
  if (Array.isArray(newAuthors)) { history[idx].authors = newAuthors; delete history[idx].author; }
  const gTagSet    = new Set([...(stored.globalTags    || []), ...(newTags    || [])]);
  const gAuthorSet = new Set([...(stored.globalAuthors || []), ...(newAuthors || [])]);
  await browser.storage.local.set({
    saveHistory:   history,
    globalTags:    [...gTagSet],
    globalAuthors: [...gAuthorSet],
  });
  return { ok: true };
}

// ----------------------------------------------------------------
// 作者（Author）ストレージ
// ----------------------------------------------------------------
async function getGlobalAuthors() {
  const stored = await browser.storage.local.get("globalAuthors");
  return { authors: stored.globalAuthors || [] };
}

async function updateGlobalAuthor(author) {
  if (!author) return;
  const stored  = await browser.storage.local.get("globalAuthors");
  const authors = stored.globalAuthors || [];
  if (!authors.includes(author)) {
    authors.push(author);
    await browser.storage.local.set({ globalAuthors: authors });
  }
}

async function getRecentAuthors() {
  const stored = await browser.storage.local.get("recentAuthors");
  return { recentAuthors: stored.recentAuthors || [] };
}

async function updateRecentAuthors(author) {
  if (!author) return;
  const stored  = await browser.storage.local.get("recentAuthors");
  const recents = (stored.recentAuthors || []).filter(a => a !== author);
  recents.unshift(author);
  await browser.storage.local.set({ recentAuthors: recents.slice(0, 10) });
}

async function getAuthorDestinations() {
  const stored = await browser.storage.local.get("authorDestinations");
  return { authorDestinations: stored.authorDestinations || {} };
}

async function setAuthorDestinations(data) {
  await browser.storage.local.set({ authorDestinations: data || {} });
  return { ok: true };
}

async function getContinuousSession() {
  const stored = await browser.storage.local.get("continuousSession");
  return { continuousSession: stored.continuousSession || null };
}

async function setContinuousSession(session) {
  if (session) {
    await browser.storage.local.set({ continuousSession: session });
  } else {
    await browser.storage.local.remove("continuousSession");
  }
  return { ok: true };
}

// ----------------------------------------------------------------

// ----------------------------------------------------------------
// エクスプローラーでフォルダを開く
// ----------------------------------------------------------------

async function openExplorer(path) {
  addLog("INFO", `エクスプローラーで開く: ${path}`);
  try {
    const res = await sendNative({ cmd: "OPEN_EXPLORER", path });
    if (res.ok) {
      addLog("INFO", `エクスプローラー起動成功: ${path}`);
    } else {
      addLog("ERROR", `エクスプローラー起動失敗: ${path}`, res.error);
    }
    return res;
  } catch (err) {
    addLog("ERROR", `openExplorer 例外: ${path}`, err.message);
    return { ok: false, error: err.message };
  }
}

async function openFile(path) {
  addLog("INFO", `ファイルを開く: ${path}`);
  try {
    const res = await sendNative({ cmd: "OPEN_FILE", path });
    if (res.ok) {
      addLog("INFO", `ファイル起動成功: ${path}`);
    } else {
      addLog("ERROR", `ファイル起動失敗: ${path}`, res.error);
    }
    return res;
  } catch (err) {
    addLog("ERROR", `openFile 例外: ${path}`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * ローカルファイルをNative経由でBase64 data URLとして取得する。
 * 設定画面・保存ウィンドウの「保存した画像を開く」で別タブ表示に使用。
 */
async function fetchFileAsDataUrl(path) {
  try {
    const res = await sendNative({ cmd: "READ_FILE_BASE64", path });
    if (res?.ok && res.dataUrl) return { ok: true, dataUrl: res.dataUrl };
    return { ok: false, error: res?.error || "取得失敗" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ----------------------------------------------------------------
// IndexedDB — サムネイルキャッシュ
// storage.local より大容量。Blob をそのまま保存するため高画質化に使用。
// ----------------------------------------------------------------

const IDB_NAME    = "ImageSaverThumbDB";
const IDB_STORE   = "thumbnails";
const IDB_VERSION = 1;

function openThumbDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

async function saveThumbToIDB(blob) {
  const id = crypto.randomUUID();
  const db = await openThumbDB();
  return new Promise((resolve, reject) => {
    const tx    = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    store.put({ id, blob });
    tx.oncomplete = () => resolve(id);
    tx.onerror    = (e) => reject(e.target.error);
  });
}

async function getThumbFromIDB(thumbId) {
  if (!thumbId) return null;
  try {
    const db = await openThumbDB();
    const result = await new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req   = store.get(thumbId);
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
    if (!result || !result.blob) return null;

    // FileReader は Background では使えないため arrayBuffer + btoa で変換
    const ab    = await result.blob.arrayBuffer();
    const bytes = new Uint8Array(ab);
    let binary  = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const type  = result.blob.type || "image/jpeg";
    return `data:${type};base64,` + btoa(binary);
  } catch (err) {
    addLog("WARN", "IDB サムネイル取得失敗", err.message);
    return null;
  }
}

/** IDB の全サムネイルを { id, dataUrl } の配列で返す（エクスポート用） */
async function exportIdbThumbs() {
  try {
    const db = await openThumbDB();
    const records = await new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req   = store.getAll();
      req.onsuccess = (e) => resolve(e.target.result || []);
      req.onerror   = (e) => reject(e.target.error);
    });

    // Blob → Base64 DataURL に変換
    const thumbs = [];
    for (const rec of records) {
      if (!rec.id || !rec.blob) continue;
      const ab    = await rec.blob.arrayBuffer();
      const bytes = new Uint8Array(ab);
      let binary  = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      thumbs.push({
        id:       rec.id,
        dataUrl:  `data:${rec.blob.type || "image/jpeg"};base64,` + btoa(binary),
      });
    }
    return { ok: true, thumbs };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** エクスポートした thumbs 配列を IDB に復元する（インポート用・差分追加） */
async function importIdbThumbs(thumbs) {
  if (!Array.isArray(thumbs)) return { ok: true, added: 0 };
  try {
    const db = await openThumbDB();

    // 既存 ID を取得
    const existingIds = await new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req   = store.getAllKeys();
      req.onsuccess = (e) => resolve(new Set(e.target.result));
      req.onerror   = (e) => reject(e.target.error);
    });

    let added = 0;
    for (const thumb of thumbs) {
      if (!thumb.id || !thumb.dataUrl || existingIds.has(thumb.id)) continue;
      // DataURL → Blob
      const [meta, b64] = thumb.dataUrl.split(",");
      const mime  = (meta.match(/:(.*?);/) || [])[1] || "image/jpeg";
      const bin   = atob(b64);
      const buf   = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const blob  = new Blob([buf], { type: mime });

      await new Promise((resolve, reject) => {
        const tx    = db.transaction(IDB_STORE, "readwrite");
        const store = tx.objectStore(IDB_STORE);
        store.put({ id: thumb.id, blob });
        tx.oncomplete = () => resolve();
        tx.onerror    = (e) => reject(e.target.error);
      });
      added++;
    }
    return { ok: true, added };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** content.js からのメッセージで呼ばれる：thumbId → data URL */
async function getThumbDataUrl(thumbId) {
  const dataUrl = await getThumbFromIDB(thumbId);
  return { dataUrl };
}

async function deleteThumbFromIDB(thumbId) {
  if (!thumbId) return;
  try {
    const db = await openThumbDB();
    await new Promise((resolve) => {
      const tx    = db.transaction(IDB_STORE, "readwrite");
      const store = tx.objectStore(IDB_STORE);
      store.delete(thumbId);
      tx.oncomplete = () => resolve();
    });
  } catch { /* 無視 */ }
}

/**
 * サムネイルがない保存履歴に対して、ローカル保存済み画像からサムネイルを生成する。
 * Python の READ_FILE_BASE64 でファイルを読み込み、OffscreenCanvas でリサイズして IDB に保存。
 * @returns {{ ok: true, generated: number, skipped: number, failed: number }}
 */
async function generateMissingThumbs(targetIds = null, overwrite = false) {
  const stored  = await browser.storage.local.get("saveHistory");
  const history = stored.saveHistory || [];

  // targetIds が指定された場合はその ID のみ対象
  // overwrite=true なら既存サムネイルも含む、false ならサムネイルなしのみ
  const targets = history.filter(e =>
    (overwrite || !e.thumbId) && (targetIds === null || targetIds.includes(e.id))
  );
  if (targets.length === 0) return { ok: true, generated: 0, skipped: 0, failed: 0 };

  let generated = 0, skipped = 0, failed = 0;
  let changed = false;

  for (const entry of targets) {
    const paths = Array.isArray(entry.savePaths)
      ? entry.savePaths : (entry.savePath ? [entry.savePath] : []);
    const filePath = paths[0]
      ? paths[0].replace(/[\\/]+$/, "") + "\\" + entry.filename
      : null;

    if (!filePath) { skipped++; continue; }

    try {
      // 上書きモードで既存サムネイルがある場合は先に削除
      if (overwrite && entry.thumbId) {
        await deleteThumbFromIDB(entry.thumbId);
        entry.thumbId = null;
      }

      // Python 経由でローカルファイルを Base64 取得（Pillow でリサイズ済み）
      const res = await sendNative({ cmd: "READ_FILE_BASE64", path: filePath });
      if (!res?.ok || !res.dataUrl) { failed++; continue; }

      // Base64 → Blob → IDB 保存
      const [meta, b64] = res.dataUrl.split(",");
      const mimeMatch   = meta.match(/:(.*?);/);
      const mimeType    = mimeMatch ? mimeMatch[1] : "image/jpeg";
      const bin  = atob(b64);
      const buf  = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      const blob = new Blob([buf], { type: mimeType });

      // OffscreenCanvas でさらに 600px サムネイルサイズにリサイズ（保存時と同サイズ）
      const bitmap = await createImageBitmap(blob);
      const MAX    = 600;
      const scale  = Math.min(MAX / bitmap.width, MAX / bitmap.height, 1);
      const tw = Math.round(bitmap.width  * scale);
      const th = Math.round(bitmap.height * scale);
      const canvas = new OffscreenCanvas(tw, th);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, tw, th);
      bitmap.close();
      const thumbBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });

      const thumbId = await saveThumbToIDB(thumbBlob);
      entry.thumbId     = thumbId;
      entry.thumbWidth  = tw;
      entry.thumbHeight = th;
      generated++;
      changed = true;
      addLog("INFO", `サムネイル生成: ${entry.filename}`);
    } catch (err) {
      addLog("WARN", `サムネイル生成失敗: ${entry.filename}`, err.message);
      failed++;
    }
  }

  if (changed) {
    await browser.storage.local.set({ saveHistory: history });
  }

  addLog("INFO", `サムネイル生成完了: ${generated}件成功 / ${failed}件失敗 / ${skipped}件スキップ`);
  return { ok: true, generated, skipped, failed };
}

// ----------------------------------------------------------------
// 複数保存先への一括保存
// ----------------------------------------------------------------

async function handleSaveMulti(payload) {
  const { imageUrl, filename, tags, subTags, authors, author, savePaths, pageUrl, thumbDataUrl, thumbWidth, thumbHeight, skipTagRecord, sessionId, sessionIndex } = payload;
  const allTags = [...new Set([...(tags || []), ...(subTags || [])])];
  if (!Array.isArray(savePaths) || savePaths.length === 0) {
    return { success: false, error: "savePaths が空です" };
  }

  // ファイル名設定に基づいてタグ・サブタグ・権利者名をファイル名に付加
  const resolvedAuthorsMulti = Array.isArray(authors) ? authors.filter(Boolean) : (author ? [String(author)] : []);
  const { filenameIncludeTag, filenameIncludeSubtag, filenameIncludeAuthor } =
    await browser.storage.local.get(["filenameIncludeTag", "filenameIncludeSubtag", "filenameIncludeAuthor"]);
  const effectiveFilenameMulti = buildFilenameWithMeta(filename, tags || [], subTags || [], resolvedAuthorsMulti, {
    filenameIncludeTag:    !!filenameIncludeTag,
    filenameIncludeSubtag: !!filenameIncludeSubtag,
    filenameIncludeAuthor: !!filenameIncludeAuthor,
  });

  addLog("INFO", `一括保存開始: ${effectiveFilenameMulti}`, `${savePaths.length} 件`);

  const results = [];
  let pyThumbData = null; // Python側で生成したサムネイル（最初の成功分を使用）
  for (const rawPath of savePaths) {
    const savePath = normalizePath(rawPath);
    const fullPath = `${savePath}\\${effectiveFilenameMulti}`;
    try {
      let res = await sendNative({ cmd: "SAVE_IMAGE", url: imageUrl, savePath: fullPath });
      if (!res.ok && ((res.error || "").includes("403") || (res.error || "").includes("Forbidden"))) {
        // ブラウザで表示済みの画像を既存のログインセッションを使って取得（Fanbox など）
        addLog("INFO", `SAVE_IMAGE 403 → ブラウザ権限でフォールバック: ${imageUrl}`);
        const fetched = await fetchImageAsDataUrl(imageUrl);
        if (fetched.dataUrl) {
          res = await sendNative({ cmd: "SAVE_IMAGE_BASE64", dataUrl: fetched.dataUrl, savePath: fullPath });
        }
      }
      if (!res.ok) throw new Error(res.error || "不明なエラー");
      addLog("INFO", `一括保存成功: ${fullPath}`);
      await browser.storage.local.set({ lastSaveDir: savePath });
      if (allTags.length > 0) {
        await saveTagRecord({ imageUrl, filename: fullPath, tags: allTags });
      }
      if (tags && tags.length > 0 && !skipTagRecord) {
        addLog("DEBUG", `recordTagDestination(multi): tags=${JSON.stringify(tags)} subTags=${JSON.stringify(subTags || [])} savePath=${savePath}`);
        await recordTagDestination(tags, savePath);
      }
      if (!pyThumbData && res.thumbData) {
        const mime = res.thumbMime || "image/jpeg";
        pyThumbData = { dataUrl: `data:${mime};base64,${res.thumbData}`, w: res.thumbWidth, h: res.thumbHeight };
      }
      if (res.thumbError && !pyThumbData) {
        addLog("WARN", "サムネイル生成失敗 (Pillow未インストールの可能性)", res.thumbError);
      }
      results.push({ savePath, ok: true });
    } catch (err) {
      addLog("ERROR", `一括保存失敗: ${fullPath}`, err.message);
      results.push({ savePath, ok: false, error: err.message });
    }
  }

  if (tags && tags.length > 0) await updateRecentTags(tags); // recentTagsはメインタグのみ

  const successPaths = results.filter(r => r.ok).map(r => r.savePath);
  if (successPaths.length > 0) {
    const effectiveThumbDataUrl = thumbDataUrl
      || (pyThumbData ? pyThumbData.dataUrl : null);
    const effectiveThumbW = thumbDataUrl ? thumbWidth  : (pyThumbData?.w  || null);
    const effectiveThumbH = thumbDataUrl ? thumbHeight : (pyThumbData?.h || null);
    await addSaveHistoryMulti({
      imageUrl, filename: effectiveFilenameMulti, savePaths: successPaths, tags: allTags, authors: resolvedAuthorsMulti, pageUrl,
      thumbDataUrl: effectiveThumbDataUrl,
      thumbWidth:   effectiveThumbW,
      thumbHeight:  effectiveThumbH,
      sessionId:    sessionId    || null,
      sessionIndex: sessionIndex || null,
    });
  }

  return {
    success: successPaths.length > 0,
    results,
    successCount: successPaths.length,
    failCount: results.length - successPaths.length,
  };
}

// ----------------------------------------------------------------
// 保存履歴（最大3件・複数保存先対応・IndexedDB サムネイル）
// ----------------------------------------------------------------

/** storage.local と IndexedDB の使用容量を返す */
async function getStorageSize() {
  // storage.local
  let storageSizeStr = "不明";
  try {
    const all   = await browser.storage.local.get(null);
    const bytes = new TextEncoder().encode(JSON.stringify(all)).length;
    storageSizeStr = bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  } catch {}

  // IndexedDB（全サムネイル blob の合計）
  let idbSizeStr = "不明";
  try {
    const db = await openThumbDB();
    const total = await new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const req   = store.getAll();
      req.onsuccess = (e) => {
        const records = e.target.result || [];
        resolve(records.reduce((sum, r) => sum + (r.blob?.size ?? 0), 0));
      };
      req.onerror = (e) => reject(e.target.error);
    });
    idbSizeStr = total < 1024 * 1024
      ? `${(total / 1024).toFixed(1)} KB`
      : `${(total / 1024 / 1024).toFixed(2)} MB`;
  } catch {}

  return { storageSizeStr, idbSizeStr };
}

/** 単一保存先の履歴登録 */
async function addSaveHistory({ imageUrl, filename, savePath, tags, authors, pageUrl, thumbDataUrl, thumbWidth, thumbHeight, sessionId, sessionIndex }) {
  await addSaveHistoryMulti({ imageUrl, filename, savePaths: [savePath], tags, authors, pageUrl, thumbDataUrl, thumbWidth, thumbHeight, sessionId, sessionIndex });
}

/** 複数保存先対応の履歴登録 */
async function addSaveHistoryMulti({ imageUrl, filename, savePaths, tags, authors, pageUrl, thumbDataUrl, thumbWidth, thumbHeight, sessionId, sessionIndex }) {
  const stored  = await browser.storage.local.get("saveHistory");
  const history = stored.saveHistory || [];

  // サムネイル：thumbDataUrl が渡された場合は直接 IDB へ保存
  // （pixiv等はファイル保存データを再利用し、XHR・fetchのCORS問題を回避）
  let thumbId = null;
  if (thumbDataUrl) {
    try {
      const [meta, b64] = thumbDataUrl.split(",");
      const mimeMatch   = meta.match(/:(.*?);/);
      const mimeType    = mimeMatch ? mimeMatch[1] : "image/jpeg";
      const bin  = atob(b64);
      const buf  = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      let blob = new Blob([buf], { type: mimeType });

      // サイズ情報が未取得の場合は createImageBitmap でリサイズして取得
      if (!thumbWidth || !thumbHeight) {
        const bitmap = await createImageBitmap(blob);
        const MAX    = 600;
        const scale  = Math.min(MAX / bitmap.width, MAX / bitmap.height, 1);
        thumbWidth   = Math.round(bitmap.width  * scale);
        thumbHeight  = Math.round(bitmap.height * scale);
        const canvas = new OffscreenCanvas(thumbWidth, thumbHeight);
        canvas.getContext("2d").drawImage(bitmap, 0, 0, thumbWidth, thumbHeight);
        bitmap.close();
        const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
        blob = jpegBlob;
      }

      thumbId = await saveThumbToIDB(blob);
      addLog("INFO", `サムネイル IDB 保存: ${thumbWidth}×${thumbHeight}`);
    } catch (err) {
      addLog("WARN", "サムネイル IDB 保存失敗", err.message);
    }
  } else {
    // フォールバック: Background XHR（Referer + クッキー付き）
    try {
      const referer = getRefererForUrl(imageUrl);
      addLog("INFO", `サムネイル取得開始 (XHR)`, `URL: ${imageUrl.slice(0, 80)} | Referer: ${referer}`);
      const blob    = await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", imageUrl, true);
        xhr.responseType = "blob";
        xhr.withCredentials = true;
        xhr.setRequestHeader("Referer", referer);
        xhr.onload  = () => {
          addLog("INFO", `サムネイル XHR 応答: HTTP ${xhr.status}`, `size: ${xhr.response?.size ?? "?"} bytes`);
          xhr.status < 400 ? resolve(xhr.response) : reject(new Error(`HTTP ${xhr.status}`));
        };
        xhr.onerror = () => reject(new Error("ネットワークエラー"));
        xhr.send();
      });
      const bitmap = await createImageBitmap(blob);
      const MAX    = 600;
      const scale  = Math.min(MAX / bitmap.width, MAX / bitmap.height, 1);
      thumbWidth   = Math.round(bitmap.width  * scale);
      thumbHeight  = Math.round(bitmap.height * scale);
      const canvas = new OffscreenCanvas(thumbWidth, thumbHeight);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, thumbWidth, thumbHeight);
      bitmap.close();
      const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
      thumbId = await saveThumbToIDB(jpegBlob);
      addLog("INFO", `サムネイル IDB 保存: ${thumbWidth}×${thumbHeight} (bg XHR: ${referer})`);
    } catch (err) {
      addLog("WARN", "サムネイル取得失敗", err.message);
    }
  }

  // 上限なし（storage.local の容量制限のみ）

  history.unshift({
    id:           crypto.randomUUID(),
    imageUrl,
    pageUrl:      pageUrl       || null,
    thumbId,
    thumbWidth,
    thumbHeight,
    filename,
    savePaths,
    tags:         tags    || [],
    authors:      Array.isArray(authors) ? authors.filter(Boolean) : [],
    savedAt:      new Date().toISOString(),
    sessionId:    sessionId     || null,
    sessionIndex: sessionIndex  || null,
  });

  for (const a of (Array.isArray(authors) ? authors.filter(Boolean) : [])) {
    await updateGlobalAuthor(a);
    await updateRecentAuthors(a);
  }

  await browser.storage.local.set({ saveHistory: history });

  // 使用容量を storage.local の総バイト数で概算してログ出力
  try {
    const all   = await browser.storage.local.get(null);
    const bytes = JSON.stringify(all).length;
    addLog("INFO", `storage.local 使用量: ${(bytes / 1024).toFixed(1)} KB`);
  } catch { /* 無視 */ }
}

// ----------------------------------------------------------------
// ユーティリティ
// ----------------------------------------------------------------

function normalizePath(p) {
  if (!p) return p;
  return p.replace(/\\{2,}/g, "\\").replace(/\\+$/, "");
}

/**
 * 画像URLをReferer付きXHRで取得してBase64 data URLとして返す。
 * pixiv等のホットリンク保護に対応したプレビュー表示用。
 */
/**
 * Python経由でプレビュー画像を取得してdata URLで返す。
 * background XHRが403になるサイト（pixiv等）向けのフォールバック。
 */
async function fetchPreviewViaNative(url) {
  try {
    const res = await sendNative({ cmd: "FETCH_PREVIEW", url });
    if (res?.ok && res.dataUrl) return { dataUrl: res.dataUrl };
    return { dataUrl: null, error: res?.error };
  } catch (err) {
    return { dataUrl: null, error: err.message };
  }
}

async function fetchImageAsDataUrl(url) {
  try {
    const referer = getRefererForUrl(url);
    const blob = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "blob";
      xhr.withCredentials = true;
      xhr.setRequestHeader("Referer", referer);
      xhr.onload  = () => xhr.status < 400 ? resolve(xhr.response) : reject(new Error(`HTTP ${xhr.status}`));
      xhr.onerror = () => reject(new Error("ネットワークエラー"));
      xhr.send();
    });
    const ab    = await blob.arrayBuffer();
    const bytes = new Uint8Array(ab);
    let binary  = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const mime   = blob.type || "image/jpeg";
    const dataUrl = `data:${mime};base64,` + btoa(binary);
    return { dataUrl };
  } catch (err) {
    return { dataUrl: null, error: err.message };
  }
}

/**
 * URL に対して適切な Referer を返す。
 * ホットリンク保護があるサイト（pixiv 等）に対応。
 */
function getRefererForUrl(url) {
  try {
    const { hostname, origin } = new URL(url);
    const REFERER_MAP = {
      "i.pximg.net":            "https://www.pixiv.net/",
      "img-original.pixiv.net": "https://www.pixiv.net/",
      "downloads.fanbox.cc":    "https://www.fanbox.cc/",
    };
    return Object.entries(REFERER_MAP).find(
      ([k]) => hostname === k || hostname.endsWith("." + k)
    )?.[1] ?? (origin + "/");
  } catch { return ""; }
}

// ----------------------------------------------------------------
// モーダルサイズの保存・復元
// ----------------------------------------------------------------

async function getModalSize() {
  const stored = await browser.storage.local.get("modalSize");
  return { modalSize: stored.modalSize || null };
}

async function setModalSize(size) {
  await browser.storage.local.set({ modalSize: size });
  return { ok: true };
}
