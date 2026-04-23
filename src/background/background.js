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
  // GROUP-26-slice (v1.30.2): SpiderMonkey の dependent string 対策
  // 呼出側で largeString.slice(0, N) されたプレビュー文字列は、親文字列への参照を
  // 内部的に保持（JSDependentString）するため、appLogs / storage に短い文字列として
  // 格納しても親の数十 MB 級文字列が GC されずに残り続ける。
  // JSON.parse(JSON.stringify(...)) で明示的に新規 linear string を生成し、
  // 親文字列への参照を切ることで GC 可能にする。詳細：設計書類 07 §8
  if (typeof detail === "string" && detail.length > 0) {
    try {
      detail = JSON.parse(JSON.stringify(detail));
    } catch (_) { /* JSON 化失敗は極めて稀、元のまま続行 */ }
  } else if (typeof message === "string" && message.length > 0) {
    // message も同様の経路で dependent になり得るため念のため
    try {
      message = JSON.parse(JSON.stringify(message));
    } catch (_) {}
  }

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

// GROUP-2-a: ツールバーアイコン右クリック → ホバーボタン一時非表示トグル（v1.29.0）
browser.contextMenus.create({
  id: "toggle-hover-buttons-temp-hidden",
  title: "ホバーボタンを一時非表示にする",
  contexts: ["browser_action"],
});

async function refreshHoverHiddenBadge() {
  const { hoverButtonsTempHidden } = await browser.storage.local.get("hoverButtonsTempHidden");
  const hidden = !!hoverButtonsTempHidden;
  browser.browserAction.setBadgeText({ text: hidden ? "OFF" : "" });
  browser.browserAction.setBadgeBackgroundColor({ color: "#c0392b" });
  try {
    await browser.contextMenus.update("toggle-hover-buttons-temp-hidden", {
      title: hidden ? "ホバーボタンを表示する" : "ホバーボタンを一時非表示にする",
    });
  } catch (_) { /* メニュー登録前の初期呼出しで発生しうるため無視 */ }
}
refreshHoverHiddenBadge();
browser.storage.onChanged.addListener((changes) => {
  if ("hoverButtonsTempHidden" in changes) refreshHoverHiddenBadge();
});

// アイコンクリックで設定タブを開く（popup を使わない）
browser.browserAction.onClicked.addListener(() => {
  browser.runtime.openOptionsPage();
});

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  // GROUP-2-a: ホバーボタン一時非表示トグル（v1.29.0）
  if (info.menuItemId === "toggle-hover-buttons-temp-hidden") {
    const { hoverButtonsTempHidden } = await browser.storage.local.get("hoverButtonsTempHidden");
    await browser.storage.local.set({ hoverButtonsTempHidden: !hoverButtonsTempHidden });
    return;
  }
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
        // modal.js に再初期化を通知（モーダルタブを明示的にアクティブ化してからフォーカス）
        const tabs = await browser.tabs.query({ windowId: modalWindowId });
        if (tabs[0]) {
          await browser.tabs.update(tabs[0].id, { active: true });
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
  if (windowId === videoConvertWindowId) videoConvertWindowId = null;
});

// ----------------------------------------------------------------
// 動画 → GIF 変換ウィンドウ管理（GROUP-15-impl-A-phase1、v1.31.0）
// ----------------------------------------------------------------
let videoConvertWindowId = null;

async function openVideoConvertWindow(payload) {
  const { videoUrl, pageUrl, videoWidth, videoHeight, duration } = payload;
  // 受領情報を storage に格納（video_convert.js が読む）
  await browser.storage.local.set({
    _pendingVideoConvert: { videoUrl, pageUrl, videoWidth, videoHeight, duration },
  });

  // 既存ウィンドウ再利用
  if (videoConvertWindowId !== null) {
    try {
      const win = await browser.windows.get(videoConvertWindowId);
      if (win) {
        if (win.state === "minimized") {
          await browser.windows.update(videoConvertWindowId, { state: "normal" });
        }
        await browser.windows.update(videoConvertWindowId, { focused: true });
        const tabs = await browser.tabs.query({ windowId: videoConvertWindowId });
        if (tabs[0]) await browser.tabs.reload(tabs[0].id);
        return;
      }
    } catch (_) {
      videoConvertWindowId = null;
    }
  }

  const win = await browser.windows.create({
    url: browser.runtime.getURL("src/video-convert/video_convert.html"),
    type: "normal",
    width: 720,
    height: 560,
  });
  videoConvertWindowId = win.id;
}

// v1.26.1 (BUG-modal-focus-jump): モーダルタブが別ウィンドウへ移動された場合、
// キャッシュしている modalWindowId を新 windowId へ自動更新する。
// 連続保存モード or minimizeAfterSave でウィンドウが持続するとき、タブ移動後に
// 旧 windowId のままだと次回呼出時に古い位置へフォーカスが行く不具合を防ぐ。
browser.tabs.onAttached.addListener(async (tabId, { newWindowId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.url && tab.url.includes("/modal/modal.html") && modalWindowId !== newWindowId) {
      modalWindowId = newWindowId;
    }
  } catch (_) {}
});

// ----------------------------------------------------------------
// onMessage handler — 単一 listener 構成（v1.30.5 GROUP-26-slice-4）
// ----------------------------------------------------------------
// v1.30.4 では WRITE_FILE を非-async handler、その他を async handler の
// 2 listener に分離したが、async 関数は case 不一致でも Promise<undefined> を返すため、
// Firefox の onMessage dispatcher が async 側の Promise<undefined> を先に resolve →
// sendMessage の応答が undefined になり「settings.json 書込失敗」エラー（v1.30.5 で修正）。
//
// 対策：単一 listener にして WRITE_FILE は非-async 同期 return、他は async handler に委譲。
// WRITE_FILE は outer listener が同期で抜けて writeFile の Promise のみ返すため、
// message 引数（= message.content 50-62MB）は outer 関数終了時に参照解放される（仮説 D）。
browser.runtime.onMessage.addListener((message, sender) => {
  if (!message) return;

  // WRITE_FILE は非-async path（message 引数を即 GC 可能に）
  if (message.type === "WRITE_FILE") {
    return writeFile(message.path, message.content);
  }

  // その他は async handler に委譲
  return handleAsyncMessage(message, sender);
});

// ----------------------------------------------------------------
// Content Script からのメッセージを受信（async 本体）
// ----------------------------------------------------------------
async function handleAsyncMessage(message, sender) {
  switch (message.type) {
    case "OPEN_MODAL_WINDOW":
      openModalWindow(message.imageUrl, message.pageUrl);
      return;
    case "OPEN_VIDEO_CONVERT":
      // GROUP-15-impl-A-phase1：動画 → GIF 変換ウィンドウを開く
      openVideoConvertWindow({
        videoUrl: message.videoUrl,
        pageUrl: message.pageUrl,
        videoWidth: message.videoWidth,
        videoHeight: message.videoHeight,
        duration: message.duration,
      });
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
      return makeDir(message.path, message.contextPath);
    // v1.30.4 GROUP-26-slice-3: WRITE_FILE は上記の非-async handler で処理済み
    // ここに case を残すと async 暗黙 capture が再発するため case 自体を削除
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
      return updateHistoryEntry(message.id, message.tags, message.authors, message.savePaths);
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
    case "GET_IDB_THUMBS_BY_IDS":
      return getIdbThumbsByIds(message.ids);
    case "IMPORT_IDB_THUMBS":
      return importIdbThumbs(message.thumbs);
    // v1.25.0 GROUP-7-b-ext-persist: 外部取り込み用サムネ永続 IDB ストア
    case "SAVE_EXT_THUMB":
      return saveExtThumb(message.filePath, message.dataUrl, message.rootPath);
    case "GET_EXT_THUMB": {
      const dataUrl = await getExtThumb(message.filePath);
      return { ok: true, dataUrl };
    }
    case "DELETE_EXT_THUMBS_BY_ROOT":
      return deleteExtThumbsByRoot(message.rootPath);
    case "SCAN_EXTERNAL_IMAGES":
      return sendNative({
        cmd:        "SCAN_EXTERNAL_IMAGES",
        path:       message.path       || "",
        cutoffDate: message.cutoffDate || "",
        excludes:   message.excludes   || [],
        extensions: message.extensions || [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"],
      });
    case "GENERATE_THUMBS_BATCH": {
      // v1.22.10: Python 側は GIF について thumbChunkPaths[p]={tempPath,totalSize} を返す
      //   （SAVE_IMAGE 系の 1MB 応答上限と同根の対策）。ここで分割読み取り→Base64 化し、
      //   呼び出し側（settings.js の外部取り込み 2 箇所）の既存コード（thumbs[p] + thumbMimes[p]）に
      //   変更を要さない形で統合する。
      const batchRes = await sendNative({
        cmd:   "GENERATE_THUMBS_BATCH",
        paths: message.paths || [],
      });
      if (batchRes?.ok && batchRes.thumbChunkPaths) {
        batchRes.thumbs      = batchRes.thumbs      || {};
        batchRes.thumbMimes  = batchRes.thumbMimes  || {};
        batchRes.errors      = batchRes.errors      || {};
        for (const [p, info] of Object.entries(batchRes.thumbChunkPaths)) {
          const tempPath = info?.tempPath;
          if (!tempPath) continue;
          const r = await _fetchThumbB64FromChunkPath(tempPath);
          if (r.ok) {
            batchRes.thumbs[p]     = r.b64;
            batchRes.thumbMimes[p] = "image/gif";
          } else {
            batchRes.errors[p] = `GIF チャンク取得失敗: ${r.error}`;
          }
        }
        // 呼び出し側は thumbChunkPaths を参照しない前提だが念のため削除
        delete batchRes.thumbChunkPaths;
      }
      return batchRes;
    }
    case "LIST_SUBFOLDERS":
      return sendNative({
        cmd:  "LIST_SUBFOLDERS",
        path: message.path || "",
      });
    case "READ_LOCAL_IMAGE_BASE64": {
      // v1.22.9: .gif ファイルはアニメーションを保持するため
      //          READ_FILE_CHUNK で元ファイルを分割読み取りし、chunksB64 で返す。
      const _p = (message.path || "");
      if (_p.toLowerCase().endsWith(".gif")) {
        const chunkRes = await readNativeFileChunksB64(_p);
        if (!chunkRes.ok) return { ok: false, error: chunkRes.error };
        return {
          ok:        true,
          chunksB64: chunkRes.chunksB64,
          mime:      "image/gif",
          totalSize: chunkRes.totalSize,
          resized:   false,
        };
      }
      return sendNative({
        cmd:     "READ_LOCAL_IMAGE_BASE64",
        path:    message.path    || "",
        maxSize: message.maxSize || 1200,
      });
    }
    // v1.23.0: GROUP-1-b 外部取り込み時に指定保存先へローカルファイルをコピー
    // v1.23.1: buildFilenameWithMeta 除去（saveHistory と整合）＋同一フォルダならスキップ
    case "COPY_LOCAL_FILE": {
      const { srcPath, dstDir, filename } = message;
      if (!srcPath || !dstDir || !filename) {
        return { ok: false, error: "COPY_LOCAL_FILE: srcPath/dstDir/filename は必須" };
      }
      // 同一フォルダ判定（大文字小文字を無視して正規化後比較）
      const srcDir = srcPath.replace(/[\\/][^\\/]+$/, "");
      const normSrcDir = normalizePath(srcDir).toLowerCase();
      const normDstDir = normalizePath(dstDir).toLowerCase();
      if (normSrcDir === normDstDir) {
        addLog("INFO", `外部取り込みコピー: 同一フォルダのためスキップ: ${srcPath}`);
        return { ok: true, skipped: true };
      }
      const dstPath = `${normalizePath(dstDir)}\\${filename}`;
      addLog("INFO", `外部取り込みコピー: ${srcPath}`, `→ ${dstPath}`);
      return sendNative({ cmd: "COPY_FILE", srcPath, dstPath });
    }
    // v1.24.0: GROUP-5-A 外部取り込み 1 枚ずつ形式で同一フォルダ内メタ付与リネーム
    //   - 呼び出し側（settings.js の _extB1SaveAndNext）は「同一フォルダ × メタ付与 ON」時のみ発火
    //   - RENAME 失敗は呼び出し側で「保存なし扱い」に落ちる設計（saveHistory にも書かない、カーソル進めない）
    //   - ターゲット既存時は Native が ok:false を返す（勝手に別名で残すと queue と saveHistory の整合が壊れるため）
    case "RENAME_FILE": {
      const { srcPath, dstPath } = message;
      if (!srcPath || !dstPath) {
        return { ok: false, error: "RENAME_FILE: srcPath/dstPath は必須" };
      }
      addLog("INFO", `外部取り込みリネーム: ${srcPath}`, `→ ${dstPath}`);
      return sendNative({ cmd: "RENAME_FILE", srcPath, dstPath });
    }
    // v1.30.0 GROUP-26-split: エクスポート分割出力用の一時ディレクトリ作成
    //   - parentPath=null で %TEMP%\borgestag_chunk_cache\export_tmp_<ts>\ に作成（AutoSave OFF 経路）
    //   - parentPath 指定で {parentPath}\_borgestag_export_tmp_<ts>\ に作成（AutoSave ON 経路）
    case "MKDIR_EXPORT_TMP": {
      const { parentPath } = message;
      return sendNative({ cmd: "MKDIR_EXPORT_TMP", parentPath: parentPath || null });
    }
    // v1.30.0 GROUP-26-split: ディレクトリを zip 化（zipfile.ZIP_DEFLATED、deleteSrc で src 削除）
    case "ZIP_DIRECTORY": {
      const { srcDir, dstZipPath, deleteSrc } = message;
      if (!srcDir || !dstZipPath) {
        return { ok: false, error: "ZIP_DIRECTORY: srcDir/dstZipPath は必須" };
      }
      return sendNative({ cmd: "ZIP_DIRECTORY", srcDir, dstZipPath, deleteSrc: deleteSrc !== false });
    }
    // v1.30.0 GROUP-26-split: エクスポート zip を chunk 読込（AutoSave OFF 経路、既存 readNativeFileChunksB64 を公開）
    case "READ_FILE_CHUNKS_B64": {
      const { path } = message;
      if (!path) return { ok: false, error: "READ_FILE_CHUNKS_B64: path は必須" };
      return readNativeFileChunksB64(path);
    }
    // v1.30.0 GROUP-26-split: 一時ファイル削除（Native 側で _CHUNK_TEMP_DIR 配下のみ許可）
    case "DELETE_CHUNK_FILE": {
      const { path } = message;
      if (!path) return { ok: false, error: "DELETE_CHUNK_FILE: path は必須" };
      return sendNative({ cmd: "DELETE_CHUNK_FILE", path });
    }
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
}

// ----------------------------------------------------------------
// Native Messaging ヘルパー
// ----------------------------------------------------------------

/**
 * ネイティブアプリに1回だけメッセージを送り、応答を返す。
 * Native Messaging は常時接続ではなく、リクエスト毎に接続・切断する。
 */
// Native Messaging のペイロード上限（Firefox 仕様 4MB）に対する安全マージン
const NATIVE_PAYLOAD_MAX_BYTES = 3 * 1024 * 1024;

function sendNative(payload) {
  return new Promise((resolve, reject) => {
    // ① 入力検証: 型・必須フィールド・JSONシリアライズ可否・サイズ上限
    if (!payload || typeof payload !== "object") {
      addLog("ERROR", "sendNative: payload が object ではありません");
      reject(new Error("payload が不正です（object ではない）"));
      return;
    }
    if (typeof payload.cmd !== "string" || !payload.cmd) {
      addLog("ERROR", "sendNative: cmd が文字列ではありません");
      reject(new Error("payload.cmd が不正です"));
      return;
    }

    // GROUP-26-slice-2 (v1.30.3): listener / timeout closure が payload object 全体を
    // capture することで content 50MB 級文字列が Promise 完了後も GC されない問題の対策。
    // cmd を独立 linear string として退避し、以降の log / 判定は全て cmdName のみを参照する。
    // ※ payload 自体は port.postMessage(payload) に最後に渡すのみで、それ以外の closure 経路で
    //   payload を参照しないことで、Promise 解決後に payload.content を GC 可能にする。
    // 詳細：設計書類 07 §8
    const cmdName = JSON.parse(JSON.stringify(payload.cmd));

    // v1.30.11 GROUP-26-mem-2-B: payloadJson の構築を廃止（Firefox Profiler 実測で判明）。
    // 過去 v1.29.1 GROUP-26-I の手動組立は port.postMessage に使われておらず、
    // size check / log preview のための中間データでしかなかった。chunk ごとに 50MB 級の
    // 文字列を生成していたため、cumulative で ~1.5GB の割当を削減。
    // Firefox の Port.postMessage(payload) は内部で独自に JSON.stringify するため、
    // 我々が事前に JSON 化する必要はない。
    // 詳細：07 §8 / 09_メモリ調査ツール候補.md の Firefox Profiler 計測結果

    // Size check：大容量 string フィールド（content / dataUrl）の length で概算。
    // WRITE_FILE / SAVE_IMAGE_BASE64 / READ_LOCAL_IMAGE_BASE64 は exempt（想定内の大容量）。
    // それ以外のコマンドで想定外の巨大ペイロードが来た場合は早期リジェクト。
    const exemptCmds = ["WRITE_FILE", "SAVE_IMAGE_BASE64", "READ_LOCAL_IMAGE_BASE64"];
    if (!exemptCmds.includes(cmdName)) {
      let estimatedSize = 0;
      if (typeof payload.content === "string") estimatedSize += payload.content.length;
      if (typeof payload.dataUrl === "string") estimatedSize += payload.dataUrl.length;
      if (estimatedSize > NATIVE_PAYLOAD_MAX_BYTES) {
        const kb = (estimatedSize / 1024).toFixed(0);
        addLog("ERROR", `sendNative: payload 過大 ${cmdName}`, `${kb} KB（推定）`);
        reject(new Error(`payload が大きすぎます（推定）: ${kb} KB（上限 ${NATIVE_PAYLOAD_MAX_BYTES / 1024 / 1024} MB）`));
        return;
      }
    }

    let port;
    try {
      port = browser.runtime.connectNative(NATIVE_APP_ID);
    } catch (e) {
      addLog("ERROR", `connectNative 失敗`, e.message);
      reject(new Error(`ネイティブアプリへの接続に失敗しました: ${e.message}`));
      return;
    }

    // v1.30.11: payloadJson を廃止したので preview は content / path / 小 payload から直接取得。
    // addLog 内で JSON round-trip による linear copy（v1.30.2）が走るため dependent string 対策は不要。
    let __logPreview = "";
    try {
      if (typeof payload.content === "string") {
        __logPreview = payload.content.slice(0, 200);
      } else if (typeof payload.path === "string") {
        __logPreview = payload.path.slice(0, 200);
      } else {
        // 小 payload 想定：JSON.stringify しても軽い（大フィールドは上記でハンドル済）
        __logPreview = JSON.stringify(payload).slice(0, 200);
      }
    } catch (_) { /* preview 生成失敗は無視 */ }
    addLog("INFO", `Native送信: ${cmdName}`, __logPreview);

    // v1.20.2: コマンド別タイムアウト（v1.20.1 の対象をさらに拡大）。
    // 長時間処理の可能性があるコマンドは 300 秒に延長。瞬時操作は従来どおり 10 秒でハング検知。
    //   - WRITE_FILE / SAVE_IMAGE_BASE64 / READ_LOCAL_IMAGE_BASE64: 大容量ペイロード（v1.20.1 から）
    //   - SCAN_EXTERNAL_IMAGES: 大規模フォルダ再帰スキャン（数万〜数十万ファイル）
    //   - GENERATE_THUMBS_BATCH: サムネイル一括生成（Pillow 処理が枚数線形）
    //   - LIST_SUBFOLDERS: ネットワークドライブ等で遅くなり得る（念のため）
    //   - SAVE_IMAGE: 内部 urllib タイムアウト 30 秒 + 403 リトライがあり 10 秒では不足
    //   - FETCH_PREVIEW: 内部 urllib 15 秒 + Pillow リサイズ
    //   - READ_FILE_BASE64: 大容量ローカル画像読込（サムネイル再生成で使用）
    // 既知懸念（04_影響範囲マップ G1「大ファイル書き込みは超過リスク」）の解消。
    const LONG_TIMEOUT_CMDS = [
      "WRITE_FILE", "SAVE_IMAGE_BASE64", "READ_LOCAL_IMAGE_BASE64",
      "SCAN_EXTERNAL_IMAGES", "GENERATE_THUMBS_BATCH", "LIST_SUBFOLDERS",
      "SAVE_IMAGE", "FETCH_PREVIEW", "READ_FILE_BASE64",
      // v1.22.9: 大容量 GIF 分割読み込み関連
      "READ_FILE_CHUNK", "MAKE_GIF_THUMB_FILE", "FETCH_PREVIEW_GIF",
      // v1.30.0 GROUP-26-split: 大容量 zip 化（数百 MB の deflate 処理で数十秒かかる可能性）
      "ZIP_DIRECTORY",
    ];
    const timeoutMs = LONG_TIMEOUT_CMDS.includes(cmdName) ? 300000 : 10000;

    const timer = setTimeout(() => {
      port.disconnect();
      addLog("ERROR", `Native タイムアウト: ${cmdName}`, `${timeoutMs / 1000}s`);
      reject(new Error("ネイティブアプリからの応答がタイムアウトしました"));
    }, timeoutMs);

    // GROUP-26-slice-2 (v1.30.3): listener 内では payload ではなく退避済 cmdName のみ参照。
    // こうすることで listener の closure が payload object 全体（及び content 50MB）を
    // capture しなくなり、Promise resolve 後に payload が GC 対象になる。
    port.onMessage.addListener((response) => {
      clearTimeout(timer);
      port.disconnect();
      addLog(response.ok === false ? "WARN" : "INFO",
        `Native応答: ${cmdName}`,
        JSON.stringify(response).slice(0, 200));
      resolve(response);
    });

    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      const err = browser.runtime.lastError?.message || "ネイティブアプリが切断されました";
      addLog("ERROR", `Native切断: ${cmdName}`, err);
      reject(new Error(err));
    });

    port.postMessage(payload);

    // v1.30.7 GROUP-26-slice-6: payload の参照を明示的に切る。
    // 背景：v1.30.6 WeakRef 診断で payload_alive=true × 7 と判明。
    // sendNative scope 由来の JS 参照を切断することで、Firefox 内部での延命・
    // writeFile activation record の一時参照・Promise chain 経路のいずれであっても、
    // 少なくとも sendNative scope からの保持は確実に切断する。
    // 詳細：07 §8 / 09_メモリ調査ツール候補.md / memory/feedback_memory_debug.md
    // v1.30.11：payloadJson 廃止に伴い payload = null のみ残す
    payload = null;
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
  // - Windows禁止文字（\ / : * ? " < > |）
  // - 制御文字（\x00-\x1f）
  // - 末尾の空白・ドット（Windowsで無効）
  const sanitize = (s) => s
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/[\s.]+$/, "")
    .trim();

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
  const { imageUrl, filename, tags, subTags, authors, author, pageUrl, thumbDataUrl, thumbWidth, thumbHeight, skipTagRecord, sessionId, sessionIndex, associatedAudio } = payload;
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

  // v1.31.4 GROUP-28 mvdl：関連音声ファイル名（GIF と同じ basename + .webm 等）
  const audioFilename = (associatedAudio && associatedAudio.dataUrl && associatedAudio.extension)
    ? effectiveFilename.replace(/\.[^.]*$/, "") + "." + associatedAudio.extension
    : null;

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

    // v1.31.4 GROUP-28 mvdl：関連音声ファイルを同フォルダに書き出す
    if (audioFilename && associatedAudio && associatedAudio.dataUrl) {
      const audioFullPath = `${savePath}\\${audioFilename}`;
      try {
        const audioRes = await sendNative({
          cmd: "SAVE_IMAGE_BASE64",
          dataUrl: associatedAudio.dataUrl,
          savePath: audioFullPath,
        });
        if (audioRes.ok) {
          addLog("INFO", `関連音声保存成功: ${audioFullPath}`);
        } else {
          addLog("WARN", `関連音声保存失敗: ${audioFullPath}`, audioRes.error || "");
        }
      } catch (audioErr) {
        addLog("WARN", `関連音声保存例外: ${audioFullPath}`, audioErr.message);
      }
    }

    if (allTags.length > 0) {
      await saveTagRecord({ imageUrl, filename: fullPath, tags: allTags });
    }
    if (tags && tags.length > 0) {
      await updateRecentTags(tags); // recentTagsはメインタグのみ
    }
    if (tags && tags.length > 0 && !skipTagRecord) {
      await recordTagDestination(tags, savePath); // 保存先関連付けはサブタグ除く
    }

    // サムネイル優先度:
    // ① content側（DOM img / fetch）→ ② Python側（ダウンロード済みデータを再利用）→ ③ background XHR
    if (res.thumbError) {
      addLog("WARN", "サムネイル生成失敗 (Pillow未インストールの可能性)", res.thumbError);
    }
    // v1.22.10: Python が thumbData（非 GIF）と thumbChunkPath（大容量 GIF）を出し分けるため
    //           共通ヘルパーで統合する。content 由来の thumbDataUrl は最優先を維持。
    const pyThumb = await resolveThumbDataUrlFromNativeRes(res);
    const effectiveThumbDataUrl = thumbDataUrl || (pyThumb ? pyThumb.dataUrl : null);
    const effectiveThumbW = thumbDataUrl ? thumbWidth  : (pyThumb?.width  || null);
    const effectiveThumbH = thumbDataUrl ? thumbHeight : (pyThumb?.height || null);

    await addSaveHistory({
      imageUrl, filename: effectiveFilename, savePath, tags: allTags, authors: resolvedAuthors, pageUrl,
      thumbDataUrl: effectiveThumbDataUrl,
      thumbWidth:   effectiveThumbW,
      thumbHeight:  effectiveThumbH,
      sessionId:    sessionId    || null,
      sessionIndex: sessionIndex || null,
      // v1.31.4 GROUP-28 mvdl：関連音声メタ
      audioFilename,
      audioMimeType:    (associatedAudio && associatedAudio.mimeType) || null,
      audioDurationSec: (associatedAudio && associatedAudio.durationSec) || null,
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
  // v1.20.2: 上限 100 → 512 文字へ拡張。
  // 通常の直画像 URL は 100 文字未満に収まるが、Fanbox / CDN の署名付 URL
  // （?Expires=...&Signature=... 等が 200 文字以上付く）で先頭 100 文字が
  // 同一になり異なる記録が衝突していた。tagRecords は write-only（監査記録）
  // 用途のため、旧記録と共存しても機能影響はなくマイグレーション不要。
  const key = imageUrl.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 512);
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

/**
 * 既存ストレージから「フォルダ作成を許可するルート」一覧を集約して返す。
 * 集約元:
 *   - folderBookmarks[].path
 *   - tagDestinations[*][].path（全タグの全保存先）
 *   - explorerRootPath
 *   - lastSaveDir
 *   - 引数 contextPath（modal が現在表示中のフォルダ — 案 Z）
 * 重複・空文字は除去し、normalizePath で正規化済みの配列を返す。
 */
async function getAllowedRoots(contextPath) {
  const stored = await browser.storage.local.get([
    "folderBookmarks",
    "tagDestinations",
    "explorerRootPath",
    "lastSaveDir",
  ]);
  const roots = [];
  if (Array.isArray(stored.folderBookmarks)) {
    for (const b of stored.folderBookmarks) if (b?.path) roots.push(b.path);
  }
  if (stored.tagDestinations && typeof stored.tagDestinations === "object") {
    for (const tag of Object.keys(stored.tagDestinations)) {
      const list = stored.tagDestinations[tag];
      if (Array.isArray(list)) {
        for (const d of list) if (d?.path) roots.push(d.path);
      }
    }
  }
  if (stored.explorerRootPath) roots.push(stored.explorerRootPath);
  if (stored.lastSaveDir)      roots.push(stored.lastSaveDir);
  if (contextPath)             roots.push(contextPath);

  const normalized = roots
    .map((r) => normalizePath(r))
    .filter((r) => typeof r === "string" && r.length > 0);
  return Array.from(new Set(normalized));
}

/**
 * path が allowedRoots のいずれかと一致、または配下にあるか判定する。
 * Windows パス前提で大文字小文字を無視して比較する。
 */
function isPathUnderAllowedRoot(path, allowedRoots) {
  const norm = normalizePath(path);
  if (!norm) return false;
  const lower = norm.toLowerCase();
  for (const root of allowedRoots) {
    const r = root.toLowerCase();
    if (lower === r) return true;
    if (lower.startsWith(r + "\\")) return true;
  }
  return false;
}

async function makeDir(path, contextPath) {
  try {
    // ① プリチェック: 相対成分（..）を含むパスは即拒否
    if (typeof path !== "string" || !path) {
      return { ok: false, error: "パスが指定されていません" };
    }
    if (path.includes("..")) {
      addLog("WARN", `makeDir: 相対パス成分を含むパスを拒否: ${path}`);
      return { ok: false, error: "許可されていないパスです（相対成分を含む）" };
    }

    // ② ホワイトリスト検証
    const allowedRoots = await getAllowedRoots(contextPath);
    if (!isPathUnderAllowedRoot(path, allowedRoots)) {
      addLog("WARN", `makeDir: 許可ルート外のパスを拒否: ${path}`);
      return { ok: false, error: "許可されていないパスです（許可ルート外）" };
    }

    // ③ Native へ。Python 側で二次検証するため allowedRoots も同送する
    const res = await sendNative({ cmd: "MKDIR", path, allowedRoots });
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

  const normalizedSavePath = normalizePath(savePath);
  for (const tag of tags) {
    if (!dest[tag]) dest[tag] = [];
    // パス末尾の \ や \\ 連続の差で重複登録されないよう、正規化して比較する
    const alreadyExists = dest[tag].some((d) => normalizePath(d.path) === normalizedSavePath);
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
      browser.storage.local.get([
        "lastSaveDir", "continuousSession",
        "retainTag", "retainSubTag", "retainAuthor",
        "retainedTags", "retainedSubTags", "retainedAuthors",
        "filenameIncludeTag", "filenameIncludeSubtag", "filenameIncludeAuthor",
      ]),
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

    // ファイル名を生成（拡張子がなければ ?format= またはフォールバック .jpg で補完）
    const urlObj = new URL(imageUrl);
    let filename = urlObj.pathname.split("/").pop() || "image.jpg";
    if (!/\.\w{2,5}$/.test(filename)) {
      const fmt = urlObj.searchParams.get("format");
      const ext = fmt ? `.${fmt}` : ".jpg";
      filename = `${filename}${ext}`;
    }

    // 引き継ぎ設定からタグ・サブタグ・権利者を取得
    const session  = stored.continuousSession;
    const tags     = stored.retainTag    ? (stored.retainedTags    || []) : [];
    const subTags  = stored.retainSubTag ? (stored.retainedSubTags || []) : [];
    const authors  = stored.retainAuthor ? (stored.retainedAuthors || []) : [];
    const allTags  = [...new Set([...tags, ...subTags])];

    // ファイル名設定に基づいてタグ・サブタグ・権利者をファイル名に付加
    const effectiveFilenameInstant = buildFilenameWithMeta(filename, tags, subTags, authors, {
      filenameIncludeTag:    !!stored.filenameIncludeTag,
      filenameIncludeSubtag: !!stored.filenameIncludeSubtag,
      filenameIncludeAuthor: !!stored.filenameIncludeAuthor,
    });

    const fullPath = `${savePath}\\${effectiveFilenameInstant}`;

    let res = await sendNative({ cmd: "SAVE_IMAGE", url: imageUrl, savePath: fullPath });
    if (!res.ok && ((res.error || "").includes("403") || (res.error || "").includes("Forbidden"))) {
      addLog("INFO", `即保存 SAVE_IMAGE 403 → ブラウザ権限でフォールバック: ${imageUrl}`);
      const fetched = await fetchImageAsDataUrl(imageUrl);
      if (fetched.dataUrl) {
        res = await sendNative({ cmd: "SAVE_IMAGE_BASE64", dataUrl: fetched.dataUrl, savePath: fullPath });
      }
    }
    if (!res.ok) return { success: false, error: res.error };

    await browser.storage.local.set({ lastSaveDir: savePath });
    if (allTags.length > 0) {
      await saveTagRecord({ imageUrl, filename: fullPath, tags: allTags });
      if (tags.length > 0) await updateRecentTags(tags);
      if (subTags.length > 0) await updateRecentSubTags(subTags);
    }
    for (const a of authors) await updateRecentAuthors(a);

    // Python側が返すサムネイルデータを使用（通常保存と同じ処理）
    if (res.thumbError) {
      addLog("WARN", "即保存: サムネイル生成失敗 (Pillow未インストールの可能性)", res.thumbError);
    }
    // v1.22.10: thumbData / thumbChunkPath を共通ヘルパーで統合（即保存は content 由来サムネなし）
    const pyThumb = await resolveThumbDataUrlFromNativeRes(res);
    const thumbDataUrl = pyThumb?.dataUrl || null;
    const thumbWidth   = pyThumb?.width   || null;
    const thumbHeight  = pyThumb?.height  || null;

    // 履歴に追加
    await addSaveHistory({
      imageUrl, filename: effectiveFilenameInstant, savePath, tags: allTags, authors, pageUrl,
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

async function updateHistoryEntry(id, newTags, newAuthors, newSavePaths) {
  if (!id) return { ok: false };
  const stored  = await browser.storage.local.get(["saveHistory", "globalTags", "globalAuthors"]);
  const history = stored.saveHistory || [];
  const idx     = history.findIndex(e => e.id === id);
  if (idx === -1) return { ok: false };
  if (Array.isArray(newTags))      history[idx].tags      = newTags;
  if (Array.isArray(newAuthors))   { history[idx].authors = newAuthors; delete history[idx].author; }
  if (Array.isArray(newSavePaths)) history[idx].savePaths  = newSavePaths;
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
 *
 * v1.22.9: 大容量 GIF（Native Messaging 1MB 上限を超えるもの）は、Python 側が
 *   {ok:true, useChunks:true, totalSize, mime, sourcePath} を返す。
 *   ここで READ_FILE_CHUNK を使って分割取得し、呼び出し側へ chunksB64 配列を返す。
 *   呼び出し側（settings.js / modal.js / viewer.js）は Blob URL を組み立てて再生する。
 */
async function fetchFileAsDataUrl(path) {
  try {
    const res = await sendNative({ cmd: "READ_FILE_BASE64", path });
    if (res?.ok && res.dataUrl) return { ok: true, dataUrl: res.dataUrl };
    if (res?.ok && res.useChunks) {
      const chunkRes = await readNativeFileChunksB64(path);
      if (!chunkRes.ok) return { ok: false, error: chunkRes.error };
      return {
        ok:        true,
        chunksB64: chunkRes.chunksB64,
        mime:      res.mime || "image/gif",
        totalSize: chunkRes.totalSize,
      };
    }
    return { ok: false, error: res?.error || "取得失敗" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ----------------------------------------------------------------
// v1.22.9: 分割ファイル読み込み（Native Messaging 1MB 上限の回避）
// Python の READ_FILE_CHUNK を繰り返し呼び、chunksB64 配列で返す。
// ----------------------------------------------------------------
async function readNativeFileChunksB64(path) {
  try {
    const chunks = [];
    let offset = 0;
    let totalSize = 0;
    // 保険: 無限ループを防ぐため十分大きな安全上限（100 チャンク × 800KB = 80MB 程度までを想定）
    for (let i = 0; i < 256; i++) {
      const res = await sendNative({
        cmd:      "READ_FILE_CHUNK",
        path,
        offset,
        maxBytes: 700 * 1024,
      });
      if (!res?.ok) {
        return { ok: false, error: res?.error || "READ_FILE_CHUNK 失敗" };
      }
      totalSize = res.totalSize || totalSize;
      if (res.length > 0 && res.bytes) {
        chunks.push(res.bytes);
      }
      if (res.done) break;
      offset = (res.offset || offset) + (res.length || 0);
      if (offset >= totalSize && totalSize > 0) break;
    }
    return { ok: true, chunksB64: chunks, totalSize };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 一時ファイル（Python 側 _CHUNK_TEMP_DIR 配下）を削除する。fire-and-forget で使用。
 */
async function deleteNativeChunkFile(path) {
  try { await sendNative({ cmd: "DELETE_CHUNK_FILE", path }); } catch (_) { /* 無視 */ }
}

/**
 * v1.22.10: 一時ファイル（Python 側 _CHUNK_TEMP_DIR 配下）から Base64 文字列（prefix なし）を
 * 組み立てて返す。読み取り後は一時ファイルを fire-and-forget で削除する。
 *
 * 各チャンクは Python 側で独立に base64.b64encode されているため、文字列結合ではバイト境界が
 * 崩れる（chunk サイズが 3 の倍数でない場合）。そのため各チャンクをバイトに戻してから連結し、
 * 全体を再 btoa する必要がある。
 *
 * 戻り値: {ok:true, b64} or {ok:false, error}
 */
async function _fetchThumbB64FromChunkPath(tempPath) {
  try {
    const chunkRes = await readNativeFileChunksB64(tempPath);
    // 成否に関わらずクリーンアップを試みる
    deleteNativeChunkFile(tempPath);
    if (!chunkRes.ok) return { ok: false, error: chunkRes.error };
    const blob = _assembleBlobFromChunksB64(chunkRes.chunksB64, "application/octet-stream");
    const buf  = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binStr = "";
    const STEP = 0x8000;
    for (let i = 0; i < bytes.length; i += STEP) {
      binStr += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
    }
    // GROUP-26-mem (v1.29.2): btoa 実行で結果文字列を作った時点で binStr は不要
    // btoa 中も binStr が生存していると allocation ピークが高まるため、結果を別変数で受けて binStr 解放
    const b64Result = btoa(binStr);
    binStr = null;
    return { ok: true, b64: b64Result };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * v1.22.10: Native からの保存系応答（thumbData / thumbChunkPath）を data URL に統一変換する。
 *
 * - thumbData 優先（従来互換の小サイズ経路、非 GIF 保存はこちら）
 * - thumbChunkPath がある場合は一時ファイルを分割読み取りして Base64 data URL を組み立てる
 *   （GIF 保存で Native Messaging 応答 1MB 上限を超えたときの経路）
 *
 * 戻り値: {dataUrl, width, height} または null（サムネイル情報なし／取得失敗）
 */
async function resolveThumbDataUrlFromNativeRes(res) {
  try {
    if (!res) return null;
    const mime = res.thumbMime || "image/jpeg";
    if (res.thumbData) {
      return {
        dataUrl: `data:${mime};base64,${res.thumbData}`,
        width:   res.thumbWidth  || null,
        height:  res.thumbHeight || null,
      };
    }
    if (res.thumbChunkPath) {
      const r = await _fetchThumbB64FromChunkPath(res.thumbChunkPath);
      if (!r.ok) {
        addLog("WARN", "GIF サムネイルチャンク取得失敗", r.error);
        return null;
      }
      return {
        dataUrl: `data:${mime};base64,${r.b64}`,
        width:   res.thumbWidth  || null,
        height:  res.thumbHeight || null,
      };
    }
    return null;
  } catch (err) {
    addLog("WARN", "サムネイル URL 組立失敗", err?.message || String(err));
    return null;
  }
}

/**
 * background 内で chunksB64 配列を Blob にまとめるヘルパー。
 * generateMissingThumbs の GIF サムネイル生成経路で使用。
 */
function _assembleBlobFromChunksB64(chunksB64, mime) {
  const arrays = [];
  for (const b64 of chunksB64) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    arrays.push(arr);
  }
  return new Blob(arrays, { type: mime || "application/octet-stream" });
}

// ----------------------------------------------------------------
// IndexedDB — サムネイルキャッシュ
// storage.local より大容量。Blob をそのまま保存するため高画質化に使用。
// ----------------------------------------------------------------

const IDB_NAME    = "ImageSaverThumbDB";
const IDB_STORE   = "thumbnails";
// v1.25.0 GROUP-7-b-ext-persist: 外部取り込み用サムネ永続ストアを新設。
//   既存 `thumbnails` (saveHistory 用、keyPath: id) とは別物。
//   用途：未保存の外部取り込みアイテムのサムネを filePath で永続化し、
//         セッション再開・モーダル再オープン時の再生成コストを削減する。
//   構造：{ filePath: string(PK), blob: Blob, rootPath: string, bytes: number, savedAt: ISO }
//   インデックス：`rootPath` でルートフォルダ単位の一括削除を効率化
const IDB_EXT_STORE = "externalImportThumbs";
// v1.25.0: IDB_VERSION を 1→2 にインクリメント（新ストア追加のため）。
//   既存ユーザーは初回起動時に onupgradeneeded が発火し、既存 `thumbnails`
//   は保持したまま `externalImportThumbs` が追加される。
const IDB_VERSION = 2;

function openThumbDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "id" });
      }
      // v1.25.0 GROUP-7-b-ext-persist
      if (!db.objectStoreNames.contains(IDB_EXT_STORE)) {
        const extStore = db.createObjectStore(IDB_EXT_STORE, { keyPath: "filePath" });
        extStore.createIndex("rootPath", "rootPath", { unique: false });
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
/**
 * Blob を DataURL 文字列に変換する共通ヘルパー（v1.30.11 GROUP-26-mem-2-B）。
 *
 * 従来の `btoa(String.fromCharCode で組んだ binary 文字列)` 経路は、
 * 50MB 級 Blob で中間 binary 文字列（50MB）＋ btoa 出力（67MB）＋ rope 結合の
 * 累計 ~300MB 割当を発生させていた（Firefox Profiler 計測、2026-04-23）。
 *
 * 代替として `FileReader.readAsDataURL` を使用すると、Firefox 内部で直接 dataUrl を
 * 生成できるため中間 JS 文字列を発生させない。出力形式（`data:<mime>;base64,<base64>`）
 * は従来と完全互換。
 *
 * blob.type が空の古いエントリのみ、従来経路（image/jpeg 固定フォールバック）を維持して
 * 出力互換性を保つ。
 */
async function blobToDataUrl(blob) {
  if (blob && blob.type) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("FileReader error"));
      reader.readAsDataURL(blob);
    });
  }
  // Edge case：blob.type 不明 → 従来どおり image/jpeg 仮定でフォールバック
  const ab    = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary  = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return "data:image/jpeg;base64," + btoa(binary);
}

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

    // Blob → Base64 DataURL に変換（v1.30.11：FileReader 経路で中間文字列削減）
    const thumbs = [];
    for (const rec of records) {
      if (!rec.id || !rec.blob) continue;
      thumbs.push({
        id:      rec.id,
        dataUrl: await blobToDataUrl(rec.blob),
      });
    }
    return { ok: true, thumbs };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 指定された ID 配列に対応する IDB サムネイルだけを Base64 DataURL 化して返す。
 * GROUP-26-mem-2 (v1.30.8 Phase A'): エクスポート実行中ピーク削減のため、
 * 全サムネ一括取得 (`EXPORT_IDB_THUMBS`, 〜350MB) を避けて chunk 単位で都度取得する経路。
 * 想定呼出単位は CHUNK_SIZE = 500 件相当（応答 〜50MB）。
 *
 * v1.30.9 hotfix：IDB トランザクション寿命対策
 * - blob.arrayBuffer() の await は event loop へ戻るためトランザクションが closed
 * - 各 store.get() を await で順次処理すると 2 件目以降が「transaction not active」で失敗
 * - 既存 exportIdbThumbs と同じく「全 get() を同一トランザクション内で一括発行
 *   → 全レコード収集後に blob→base64 変換の await に入る」2 段階方式に変更
 */
async function getIdbThumbsByIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return { ok: true, thumbs: [] };
  try {
    const db = await openThumbDB();
    const validIds = ids.filter(Boolean);
    if (validIds.length === 0) return { ok: true, thumbs: [] };

    // Step 1：全 store.get() を同一トランザクション内で発行してレコードを収集
    //   （この間 await しない、event loop に戻さない）
    const records = await new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_STORE, "readonly");
      const store = tx.objectStore(IDB_STORE);
      const results = new Array(validIds.length);
      let pending = validIds.length;
      let errored = false;
      for (let i = 0; i < validIds.length; i++) {
        const idx = i;
        const req = store.get(validIds[i]);
        req.onsuccess = (e) => {
          if (errored) return;
          results[idx] = e.target.result || null;
          if (--pending === 0) resolve(results);
        };
        req.onerror = (e) => {
          if (errored) return;
          errored = true;
          reject(e.target.error);
        };
      }
    });

    // Step 2：トランザクションは閉じた状態で blob → base64 変換（await 安全）
    // v1.30.11：共通ヘルパー blobToDataUrl で FileReader 経由に統一（中間文字列削減）
    const thumbs = [];
    for (const rec of records) {
      if (!rec || !rec.blob) continue;
      thumbs.push({
        id:      rec.id,
        dataUrl: await blobToDataUrl(rec.blob),
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
      // GROUP-26-mem (v1.29.2): const → let、IDB put 後に即 null 化でループ内ピークメモリ削減
      let bin   = atob(b64);
      let buf   = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      let blob  = new Blob([buf], { type: mime });
      bin = null; // 中間バイナリ文字列は Blob 化後不要
      buf = null; // Uint8Array も Blob 内部で保持されるので外側参照不要

      await new Promise((resolve, reject) => {
        const tx    = db.transaction(IDB_STORE, "readwrite");
        const store = tx.objectStore(IDB_STORE);
        store.put({ id: thumb.id, blob });
        tx.oncomplete = () => resolve();
        tx.onerror    = (e) => reject(e.target.error);
      });
      blob = null; // IDB put 完了後、外側参照不要（IDB 側に保持）
      // thumb.dataUrl は呼出元 thumbs 配列の一部、ここでは解放できない（呼出元で対応）
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

// ----------------------------------------------------------------
// v1.25.0 GROUP-7-b-ext-persist: 外部取り込み用サムネ永続 IDB
// ----------------------------------------------------------------

/** data URL を Blob に変換するヘルパー（saveThumbToIDB 系と用途を揃える） */
function _dataUrlToBlob(dataUrl) {
  const [meta, b64] = (dataUrl || "").split(",");
  const mime = (meta?.match(/:(.*?);/) || [])[1] || "image/jpeg";
  const bin  = atob(b64 || "");
  const buf  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

/** Blob を data URL 文字列に変換（BG では FileReader が使えないため btoa 経由） */
async function _blobToDataUrl(blob) {
  const ab    = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  let binary  = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const type = blob.type || "image/jpeg";
  return `data:${type};base64,` + btoa(binary);
}

// v1.25.4 BUG-ext-thumb-stats-race: 並列 SAVE_EXT_THUMB で storage.local の
//   read-modify-write が競合し、lost update で件数が実際より少なく表示される
//   事象が発生していた（100 アイテム閲覧で 368/413 のようなズレ）。
//   mutex（Promise チェーン）で serialize することで解消する。
let _extStatsMutex = Promise.resolve();

/** storage.local.externalImportThumbStats を {count, bytes} で差分更新（mutex で serialize） */
function _updateExtStats(rootPath, deltaCount, deltaBytes) {
  if (!rootPath) return Promise.resolve();
  const next = _extStatsMutex.then(async () => {
    const { externalImportThumbStats } = await browser.storage.local.get("externalImportThumbStats");
    const stats = externalImportThumbStats || {};
    const cur   = stats[rootPath] || { count: 0, bytes: 0 };
    cur.count = Math.max(0, cur.count + deltaCount);
    cur.bytes = Math.max(0, cur.bytes + deltaBytes);
    if (cur.count === 0 && cur.bytes === 0) {
      delete stats[rootPath];
    } else {
      stats[rootPath] = cur;
    }
    await browser.storage.local.set({ externalImportThumbStats: stats });
  }).catch((err) => {
    // チェーンを切らないようエラーは呑む（個別ログは出さない、呼び出し側の起動タイミングに影響しない）
    try { addLog("WARN", "_updateExtStats 失敗", err?.message || String(err)); } catch (_) {}
  });
  _extStatsMutex = next;
  return next;
}

/**
 * 外部取り込みサムネを IDB `externalImportThumbs` に保存（upsert）。
 * 既存エントリがあれば bytes 差分だけ stats に反映、なければ count+1 / bytes+new。
 * @returns {{ ok: true, bytes: number } | { ok: false, error: string }}
 */
async function saveExtThumb(filePath, dataUrl, rootPath) {
  try {
    if (!filePath || !dataUrl) return { ok: false, error: "filePath/dataUrl は必須" };
    const blob = _dataUrlToBlob(dataUrl);
    const db   = await openThumbDB();

    // 既存レコードを先読みして stats 差分を決める
    const existing = await new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_EXT_STORE, "readonly");
      const store = tx.objectStore(IDB_EXT_STORE);
      const req   = store.get(filePath);
      req.onsuccess = (e) => resolve(e.target.result || null);
      req.onerror   = (e) => reject(e.target.error);
    });

    await new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_EXT_STORE, "readwrite");
      const store = tx.objectStore(IDB_EXT_STORE);
      store.put({
        filePath,
        blob,
        rootPath: rootPath || "",
        bytes:    blob.size,
        savedAt:  new Date().toISOString(),
      });
      tx.oncomplete = () => resolve();
      tx.onerror    = (e) => reject(e.target.error);
    });

    // stats 更新（同一 rootPath 前提。rootPath 変更は通常起きない想定）
    const deltaCount = existing ? 0 : 1;
    const deltaBytes = existing ? (blob.size - (existing.bytes || 0)) : blob.size;
    await _updateExtStats(rootPath || existing?.rootPath || "", deltaCount, deltaBytes);

    return { ok: true, bytes: blob.size };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 外部取り込みサムネを filePath で取得して data URL で返す。
 * 無ければ null を返す（呼び出し側は他ソースへフォールバック）。
 */
async function getExtThumb(filePath) {
  if (!filePath) return null;
  try {
    const db = await openThumbDB();
    const record = await new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_EXT_STORE, "readonly");
      const store = tx.objectStore(IDB_EXT_STORE);
      const req   = store.get(filePath);
      req.onsuccess = (e) => resolve(e.target.result || null);
      req.onerror   = (e) => reject(e.target.error);
    });
    if (!record || !record.blob) return null;
    return await _blobToDataUrl(record.blob);
  } catch (err) {
    addLog("WARN", "外部取り込みサムネ取得失敗", err.message);
    return null;
  }
}

/**
 * 指定 rootPath 配下の全外部取り込みサムネを一括削除し、stats からも当該エントリを除去。
 * GROUP-7-b-ui の🗑削除ボタンから呼ばれる想定。
 * @returns {{ ok: true, deleted: number } | { ok: false, error: string }}
 */
async function deleteExtThumbsByRoot(rootPath) {
  try {
    if (!rootPath) return { ok: false, error: "rootPath は必須" };
    const db = await openThumbDB();

    // index "rootPath" で primary key を列挙
    const keys = await new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_EXT_STORE, "readonly");
      const store = tx.objectStore(IDB_EXT_STORE);
      const idx   = store.index("rootPath");
      const req   = idx.getAllKeys(IDBKeyRange.only(rootPath));
      req.onsuccess = (e) => resolve(e.target.result || []);
      req.onerror   = (e) => reject(e.target.error);
    });

    if (keys.length === 0) {
      // IDB 側に無くても stats 側に残骸があれば掃除
      await _clearExtStatsEntry(rootPath);
      return { ok: true, deleted: 0 };
    }

    await new Promise((resolve, reject) => {
      const tx    = db.transaction(IDB_EXT_STORE, "readwrite");
      const store = tx.objectStore(IDB_EXT_STORE);
      for (const k of keys) store.delete(k);
      tx.oncomplete = () => resolve();
      tx.onerror    = (e) => reject(e.target.error);
    });

    await _clearExtStatsEntry(rootPath);
    return { ok: true, deleted: keys.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** stats から rootPath エントリを削除（count/bytes を 0 扱いにして clean up） */
async function _clearExtStatsEntry(rootPath) {
  const { externalImportThumbStats } = await browser.storage.local.get("externalImportThumbStats");
  const stats = externalImportThumbStats || {};
  if (stats[rootPath]) {
    delete stats[rootPath];
    await browser.storage.local.set({ externalImportThumbStats: stats });
  }
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

      // v1.22.9: GIF はアニメーションを保持したまま分割取得する別経路を使う。
      //   1. Python 側 MAKE_GIF_THUMB_FILE で縮小 GIF を一時ファイルへ書き出す
      //   2. READ_FILE_CHUNK で分割読み取りして Blob を組み立てる（全フレーム保持）
      //   3. そのまま IDB へ保存（Canvas 再リサイズは GIF アニメを破壊するためスキップ）
      const isGif = filePath.toLowerCase().endsWith(".gif");
      if (isGif) {
        const thumbRes = await sendNative({ cmd: "MAKE_GIF_THUMB_FILE", path: filePath, maxSize: 600 });
        if (!thumbRes?.ok || !thumbRes.tempPath) {
          failed++;
          addLog("WARN", `GIF サムネイル生成失敗: ${entry.filename}`, `path=${filePath} error=${thumbRes?.error || "unknown"}`);
          continue;
        }
        const chunkRes = await readNativeFileChunksB64(thumbRes.tempPath);
        // 一時ファイルのクリーンアップ（失敗しても継続）
        deleteNativeChunkFile(thumbRes.tempPath);
        if (!chunkRes.ok) {
          failed++;
          addLog("WARN", `GIF サムネイル取得失敗: ${entry.filename}`, `tempPath=${thumbRes.tempPath} error=${chunkRes.error}`);
          continue;
        }
        const gifBlob = _assembleBlobFromChunksB64(chunkRes.chunksB64, thumbRes.mime || "image/gif");
        const thumbId = await saveThumbToIDB(gifBlob);
        entry.thumbId     = thumbId;
        entry.thumbWidth  = thumbRes.width  || null;
        entry.thumbHeight = thumbRes.height || null;
        generated++;
        changed = true;
        addLog("INFO", `GIF サムネイル生成: ${entry.filename}`, `size=${gifBlob.size} ${thumbRes.width || "?"}x${thumbRes.height || "?"}`);
        continue;
      }

      // 通常画像（非 GIF）: 従来どおり READ_FILE_BASE64 で Base64 取得
      const res = await sendNative({ cmd: "READ_FILE_BASE64", path: filePath });
      if (!res?.ok || !res.dataUrl) {
        failed++;
        addLog("WARN", `サムネイル生成失敗: ${entry.filename}`, `path=${filePath} error=${res?.error || "unknown"}`);
        continue;
      }

      // Base64 → Blob → IDB 保存
      const [meta, b64] = res.dataUrl.split(",");
      const mimeMatch   = meta.match(/:(.*?);/);
      const mimeType    = mimeMatch ? mimeMatch[1] : "image/jpeg";
      // GROUP-26-mem (v1.29.2): const → let、bitmap.close 後に blob = null でピークメモリ削減
      let bin  = atob(b64);
      let buf  = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      let blob = new Blob([buf], { type: mimeType });
      bin = null;
      buf = null;

      // OffscreenCanvas でさらに 600px サムネイルサイズにリサイズ（保存時と同サイズ）
      const bitmap = await createImageBitmap(blob);
      const MAX    = 600;
      const scale  = Math.min(MAX / bitmap.width, MAX / bitmap.height, 1);
      const tw = Math.round(bitmap.width  * scale);
      const th = Math.round(bitmap.height * scale);
      const canvas = new OffscreenCanvas(tw, th);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, tw, th);
      bitmap.close();
      blob = null; // 元画像 Blob（最大数十 MB）を解放、サムネ Blob は独立
      let thumbBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });

      const thumbId = await saveThumbToIDB(thumbBlob);
      thumbBlob = null; // IDB put 完了後、外側参照不要
      entry.thumbId     = thumbId;
      entry.thumbWidth  = tw;
      entry.thumbHeight = th;
      generated++;
      changed = true;
      addLog("INFO", `サムネイル生成: ${entry.filename}`);
    } catch (err) {
      // v1.22.8: エラー型・メッセージ・スタック・対象パスを明記して原因特定を容易にする
      const detail = `path=${filePath} type=${err?.name || err?.constructor?.name || "Error"} msg=${err?.message || String(err)} stack=${(err?.stack || "").split("\n").slice(0, 3).join(" | ")}`;
      addLog("WARN", `サムネイル生成失敗(例外): ${entry.filename}`, detail);
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
  const { imageUrl, filename, tags, subTags, authors, author, savePaths, pageUrl, thumbDataUrl, thumbWidth, thumbHeight, skipTagRecord, sessionId, sessionIndex, associatedAudio } = payload;
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

  // v1.31.4 GROUP-28 mvdl：関連音声ファイル名（GIF と同じ basename + .webm 等）
  const audioFilenameMulti = (associatedAudio && associatedAudio.dataUrl && associatedAudio.extension)
    ? effectiveFilenameMulti.replace(/\.[^.]*$/, "") + "." + associatedAudio.extension
    : null;

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
        await recordTagDestination(tags, savePath);
      }
      // v1.22.10: ループ初回ぶんだけ Python サムネを採用する既存方針を維持。
      //           GIF も thumbChunkPath 経由で取り込めるよう共通ヘルパーへ差し替え。
      if (!pyThumbData) {
        const pt = await resolveThumbDataUrlFromNativeRes(res);
        if (pt) {
          pyThumbData = { dataUrl: pt.dataUrl, w: pt.width, h: pt.height };
        }
      }
      if (res.thumbError && !pyThumbData) {
        addLog("WARN", "サムネイル生成失敗 (Pillow未インストールの可能性)", res.thumbError);
      }

      // v1.31.4 GROUP-28 mvdl：関連音声ファイルをこの保存先にも書き出す
      if (audioFilenameMulti && associatedAudio && associatedAudio.dataUrl) {
        const audioFullPath = `${savePath}\\${audioFilenameMulti}`;
        try {
          const audioRes = await sendNative({
            cmd: "SAVE_IMAGE_BASE64",
            dataUrl: associatedAudio.dataUrl,
            savePath: audioFullPath,
          });
          if (audioRes.ok) {
            addLog("INFO", `関連音声保存成功: ${audioFullPath}`);
          } else {
            addLog("WARN", `関連音声保存失敗: ${audioFullPath}`, audioRes.error || "");
          }
        } catch (audioErr) {
          addLog("WARN", `関連音声保存例外: ${audioFullPath}`, audioErr.message);
        }
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
      // v1.31.4 GROUP-28 mvdl：関連音声メタ（ファイル名・MIME・秒数）
      audioFilename:    audioFilenameMulti,
      audioMimeType:    (associatedAudio && associatedAudio.mimeType) || null,
      audioDurationSec: (associatedAudio && associatedAudio.durationSec) || null,
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
async function addSaveHistory({ imageUrl, filename, savePath, tags, authors, pageUrl, thumbDataUrl, thumbWidth, thumbHeight, sessionId, sessionIndex, audioFilename, audioMimeType, audioDurationSec }) {
  await addSaveHistoryMulti({ imageUrl, filename, savePaths: [savePath], tags, authors, pageUrl, thumbDataUrl, thumbWidth, thumbHeight, sessionId, sessionIndex, audioFilename, audioMimeType, audioDurationSec });
}

/** 複数保存先対応の履歴登録 */
async function addSaveHistoryMulti({ imageUrl, filename, savePaths, tags, authors, pageUrl, thumbDataUrl, thumbWidth, thumbHeight, sessionId, sessionIndex, audioFilename, audioMimeType, audioDurationSec }) {
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
    // v1.31.4 GROUP-28 mvdl：関連音声メタ（無ければ null）
    audioFilename:    audioFilename    || null,
    audioMimeType:    audioMimeType    || null,
    audioDurationSec: audioDurationSec || null,
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
 *
 * v1.22.9: .gif URL は FETCH_PREVIEW_GIF で一時ファイルへ保存 → 分割読み取りして
 *   アニメーションを保持したまま chunksB64 で返す。呼び出し側が Blob URL を組み立てる。
 */
async function fetchPreviewViaNative(url) {
  try {
    const isGif = /\.gif(\?|#|$)/i.test(url || "");
    if (isGif) {
      const gifRes = await sendNative({ cmd: "FETCH_PREVIEW_GIF", url });
      if (!gifRes?.ok) return { dataUrl: null, error: gifRes?.error };
      const chunkRes = await readNativeFileChunksB64(gifRes.tempPath);
      deleteNativeChunkFile(gifRes.tempPath); // 非同期クリーンアップ
      if (!chunkRes.ok) return { dataUrl: null, error: chunkRes.error };
      return {
        chunksB64: chunkRes.chunksB64,
        mime:      gifRes.mime || "image/gif",
        width:     gifRes.width  || null,
        height:    gifRes.height || null,
        totalSize: chunkRes.totalSize,
      };
    }
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

/** 前回のモーダルサイズを返す */
async function getModalSize() {
  const stored = await browser.storage.local.get("modalSize");
  return { modalSize: stored.modalSize || null };
}

/**
 * モーダルサイズを保存する（リサイズ操作の終端から呼ばれる）
 * 既存フィールド（previewHeight など）を保持するため読み書きでマージする。
 * 単純上書きにすると v1.17.3 で修正した previewHeight 消失バグが再発するため注意。
 */
async function setModalSize(size) {
  const cur = await browser.storage.local.get("modalSize");
  const ms  = cur.modalSize || {};
  await browser.storage.local.set({ modalSize: { ...ms, ...size } });
  return { ok: true };
}
