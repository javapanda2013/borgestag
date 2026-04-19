# Changelog

このプロジェクトの変更履歴です。
形式は [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に基づいています。

---

## [1.26.9] - 2026-04-20

### Changed
- **保存ウィンドウのタグ・サブタグ・権利者入力欄のレイアウト再調整**（GROUP-22 改）
  - v1.26.6〜v1.26.8 で実装したリサイズ＋ chip 後置き設計が、v1.26.7 でリサイズを撤回した結果「サブタグ欄の chip が画面右端付近で input から遠い」UX 低下を引き起こした問題への対応。
  - 対策：
    - `#tag-toolbar` を `flex-direction: column` に変更し、タグ行とサブタグ行を独立した 2 行に分離
    - 両 wrap を全幅ストレッチ（flex: 0 1 auto、max-width: 100%）
    - CSS `order` でタグ・サブタグ・権利者の全 3 欄で chip を input の前に配置（`.dest-tabbar-tag-input { order: 1; }`、`#author-input-clear { order: 2; }`）
  - 権利者 box も chip 前置きに統一（main-tabbar 内で幅の余裕は限定的だが統一性優先）。

### Changed
- manifest.json: 1.26.8 → 1.26.9
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.26.8] - 2026-04-20

### Fixed
- **権利者入力欄の未入力時サジェスト非表示を訂正**（v1.26.6 BUG-modal-suggest-match の過剰修正）
  - v1.26.6 の修正で「未入力時はサジェスト非表示」を権利者欄にも適用したが、保存ウィンドウの権利者欄は autocomplete 用途（入力欄フォーカスで候補から選ぶ）であり、検索用途のタグ絞り込み（v1.21.2 未入力時非表示）とは文脈が異なる。
  - 対策：`showAuthorSuggestions` を「未入力時は全権利者表示、1 文字以上で前方一致」に変更（v1.21.2 整合から v1.26.5 以前の autocomplete 挙動へ戻す）。
  - 1 文字以上の前方一致化自体は維持（BUG-modal-suggest-match の本質は保持）。

### Changed
- manifest.json: 1.26.7 → 1.26.8
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.26.7] - 2026-04-20

### Fixed
- **保存ウィンドウのタグ・サブタグ・権利者サジェストが全く表示されない緊急リグレッション修正**
  - v1.26.6 で入力欄にリサイズ機能（CSS `resize: horizontal`）を付与した際、必要な `overflow: auto` が suggestions ドロップダウン（`position: absolute`、box の下に表示）を clipping してしまい、**サジェスト全体が非表示**になる致命的不具合が発生。
  - 対策：リサイズ機能（CSS `resize` ＋ ResizeObserver による永続化）を一旦撤回。固定の flex-basis 比率（タグ:サブタグ = 1:2、権利者 180px）のみ維持し、chip 配置・権利者ボックススタイル・サジェスト前方一致統一は継続。
  - リサイズ機能は overflow を使わない方式（JS カスタムリサイズハンドル等）で後続バージョンに再実装予定。

### Changed
- manifest.json: 1.26.6 → 1.26.7
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.26.6] - 2026-04-20

### Fixed
- **保存ウィンドウのタグ・サブタグ・権利者サジェストを前方一致に統一**（BUG-modal-suggest-match）
  - 旧実装では 1 文字時は前方一致・2 文字以上で部分一致（`tagMatches` 関数内の分岐）、権利者は常に部分一致という不整合があった。
  - 対策：`tagMatches` を常に前方一致（5 variants：半角／ひらがな／カタカナ／全半角変換）に統一。権利者サジェストも `tagMatches` を流用し、未入力時は非表示（v1.21.2 ルールと整合）。
  - 設定画面の保存履歴タグ絞り込み（v1.21.2〜v1.21.3）と同等の挙動に揃えた。

### Changed
- **保存ウィンドウのタグ／サブタグ／権利者入力欄をリニューアル**（GROUP-22）
  - **chip 配置変更**：chip 表示位置を「input 前」→「input 後ろ」へ変更。chip 追加で input 位置が右にズレる問題を解消。
  - **権利者欄の大サイズ化**：`✏️ 権利者:` ラベルを削除し placeholder「✏️ 権利者を入力（Enter）…」で代替。タグ入力と同じボックススタイル（border rounded box、紫系 border）に統一。
  - **デフォルト幅比率の変更**：タグ：サブタグ = 1:2（旧 340px:240px ≒ 1.4:1）。`main-tabbar` 内の権利者 box はデフォルト 180px。
  - **ユーザーリサイズ可能化**：3 ボックスすべてに CSS `resize: horizontal` 適用。右下ハンドルドラッグで幅調整可能。
  - **リサイズ永続化**：`ResizeObserver` ＋ debounce 500ms で `storage.local.modalBoxWidths` に保存、次回起動時復元。
  - **chip 格納位置の変更（内部）**：旧 `#main-chip-area`（タグ・サブタグが混在していた単一 div）を廃止し、各 chip は対応する box 内に配置。`addTag` → `#dest-tabbar-tag-area`、`addSubTag` → `#dest-tabbar-subtag-area` にターゲット変更。
- manifest.json: 1.26.5 → 1.26.6
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.26.5] - 2026-04-19

### Changed
- **取り込み予定フォルダの重複検出時 UX をハード拒否 → 確認ダイアログに変更**（BUG-tyfl-dup-import UX 改善）
  - 単体登録（`_extFlAddSingle`）：重複検出時、`confirm()` で「既存を削除して登録し直しますか？」を表示。OK で既存エントリを削除（subfolders の子の場合は該当子のみ削除・他の子は保持）してから新規追加。キャンセルで従来通り何もしない。
  - 一括サブフォルダ登録（`_extFlApplySubfolders`）：
    - 親パス重複時は `confirm()` で「既存を削除して再登録しますか？」を表示。
    - 子パス重複時は**カスタム 3 択ダイアログ**（`_showBulkConflictDialog`）：重複サブフォルダのサンプル一覧＋件数を表示し、`重複をスキップして N 件登録` / `重複を置き換えて N 件登録` / `キャンセル` から選択。
  - 既存 `showThumbGenConfirmDialog` の `period-dialog-overlay` スタイルを踏襲し、見た目を統一。
  - テスト運用時の「既に登録を繰り返しブロックされて進まない」状況を解消し、ユーザーの意図的な再登録を許容する。

### Changed
- manifest.json: 1.26.4 → 1.26.5
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.26.4] - 2026-04-19

### Fixed
- **取り込み予定フォルダの二重登録チェックを正規化比較＋子パス対応に拡張**（BUG-tyfl-dup-import 徹底対応）
  - v1.26.3 で追加した比較は `toLowerCase` のみの片手落ちで、末尾 `\` の有無・`\\` 連続・`/` 混在などのパス形式差で同一フォルダが別文字列扱いですり抜けるケースがあった。
  - 対策：同ファイル内 `_extFlIsCompleted` が使っていた正規化ロジック（`[\\/]+` → `/` 統一、末尾 `/` 削除、小文字化）を `_normalizeExtPath` 共通関数に昇格し、両関数の判定に適用。
  - 追加で **P2（子パス重複）** を塞ぐ：
    - `_extFlAddSingle`：入力パスが既存 subfolders エントリの `subfolders[].path` と一致する場合もブロック
    - `_extFlApplySubfolders`：選択した子パスのいずれかが既存 single エントリの `rootPath` または他 subfolders エントリの `subfolders[].path` と一致する場合もブロック
  - これにより「same-parent 親衝突」「cross-mode 親衝突」「cross-mode 子パス衝突」のすべてが検出される。

### Changed
- manifest.json: 1.26.3 → 1.26.4
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.26.3] - 2026-04-19

### Fixed
- **取り込み予定フォルダリストの二重登録チェック漏れを修正**（BUG-tyfl-dup-import）
  - 旧実装では `_extFlAddSingle`（単体登録）の重複チェックが `&& f.mode === "single"` に限定されており、既にサブフォルダ選択で登録済みの親フォルダでも単体登録できてしまう片方向のチェック漏れがあった。逆方向（単体登録済み→サブフォルダ選択）については `_extFlApplySubfolders` に重複チェック自体が無く、同じく二重登録できていた。
  - 対策：両関数とも mode 指定を外して `rootPath` だけで判定するよう修正。single↔single / single↔subfolders / subfolders↔single / subfolders↔subfolders の 4 組合せすべてで同一親フォルダの二重登録をブロックする。
  - 実害：ステータスは保持されるため上書き事故はなかったが、統合テーブルに同一パスが 2 行並ぶ不整合が発生していた。

### Changed
- manifest.json: 1.26.2 → 1.26.3
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.26.2] - 2026-04-19

### Changed
- **保存ウィンドウ保存履歴のファーストビュー高速化**（GROUP-18-w1）
  - 保存履歴描画を「初期 6 件の同期描画＋残りは `requestIdleCallback` による裏描画（1 チャンク 3 件）」に変更。1 ページ 100 件設定でも、保存ウィンドウ起動直後の DOM 構築を 6 件に抑える。
  - 裏描画中に絞り込み変更・ページ遷移・ページサイズ変更などが発生した場合、既存の `_historyRenderGen` 世代番号による中断機構で古い裏描画を自動停止。描画の重複や無駄なサムネ IDB クエリを防ぐ。
  - グループ表示モードでも同仕様を適用。グループ内子アイテムは従来通り「展開ボタンクリック時に初めて描画」の遅延初期化のため、初期 6 件＝グループ 6 個で先頭タイルのみ描画される。
  - `requestIdleCallback` 未対応環境（古い Firefox）では `setTimeout(0)` にフォールバック。
  - 初回 `renderHistory()` 呼出前に `modalHistoryPageSize` の storage 読込を待機させ、設定値（20 / 50 / 100 / 200）が初回描画に反映されない race condition も併せて解消。
- manifest.json: 1.26.1 → 1.26.2
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.26.1] - 2026-04-19

### Fixed
- **保存ウィンドウ移動後のフォーカスが旧ウィンドウ位置に戻る不具合を修正**（BUG-modal-focus-jump）
  - 連続保存モードまたは `minimizeAfterSave` でウィンドウが持続する状態で、保存ウィンドウの「保存ウィンドウタブ」を別ウィンドウへ移動したあと、次回保存呼出時に移動前の元ウィンドウ位置へフォーカスが移動してしまう不具合を修正。
  - 原因：`background.js` の `openModalWindow` は `modalWindowId` をキャッシュして既存ウィンドウを再利用するが、タブ移動を検知する仕組みがなく、旧 windowId が残り続けていた。`browser.windows.update(modalWindowId, { focused: true })` が古い位置へフォーカスし、`tabs.query` も空振りしてタブアクティブ化と `MODAL_NEW_IMAGE` メッセージ送信がスキップされていた。
  - 対策：`browser.tabs.onAttached` リスナーを追加し、`/modal/modal.html` タブが別ウィンドウへ移動された際に `modalWindowId` を新 windowId へ自動更新する。

- **保存ウィンドウ通常保存・連続保存で gif 画像のサムネイルが静止画になる不具合を修正**（GROUP-14-a / 14-b）
  - `modal.js` の `fetchThumbnailInPage` が gif URL でも Canvas → JPEG 変換を強制しており、`background.js:564` の優先度ロジック（`thumbDataUrl || pyThumb`）によって Python 生成の gif アニメサムネが上書き・破棄されていた。即保存は modal.js を通らないため `thumbDataUrl = undefined` となり Python 由来の gif サムネがそのまま採用されており、通常保存との挙動差となっていた。
  - 対策：`fetchThumbnailInPage` 冒頭に URL 拡張子 `.gif` 判定を追加し、true なら null を返して Python の gif サムネ経路へ委譲。fetch 経路（②）では追加で `Content-Type: image/gif` も検出して同様に null を返却（拡張子隠蔽 URL への保険）。
  - これにより**通常保存／連続保存／即保存の全保存経路で gif アニメが保持されたサムネイルが生成される**。外部取込は既に動作していたため変更なし。
  - 既存の静止画サムネで保存済みの gif 履歴は、設定画面「🖼 サムネイル生成」の overwrite モードで再生成可能。

### Changed
- manifest.json: 1.26.0 → 1.26.1
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.26.0] - 2026-04-19

### Added
- **保存ウィンドウの保存履歴タブに「GIF のみ表示」フィルターを追加**（GROUP-13-a）
  - 設定画面の保存履歴タブに既にあった「GIF のみ」フィルターを保存ウィンドウ側にも追加。
  - 判定ロジックは設定画面側と同じく `filename` 拡張子 `.gif` ベース。タグ・権利者フィルターと AND 統合。
  - 既存の絞り込み入力欄（タグ／権利者チップ、AND/OR select）を中央配置から左寄せ寄りへ移動し、GIF チェックボックスは AND/OR select の右隣に配置。

### Changed
- manifest.json: 1.25.4 → 1.26.0
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.25.4] - 2026-04-18

### Fixed
- **外部取り込みサムネ統計が実際の取得件数より少なく表示される不具合を修正**（BUG-ext-thumb-stats-race）
  - `background.js` の `_updateExtStats` が `storage.local.get → compute → set` の read-modify-write 構造で、並列発射された複数の `SAVE_EXT_THUMB` が stats オブジェクトの更新を競合させ、lost update が発生していた（例：100 件閲覧で 368/413 のようなズレ）。
  - 対策：Promise チェーンによる mutex で `_updateExtStats` を serialize。並列呼出を順次実行に変換し、lost update を排除。

- **サムネ一覧モーダル中の ← / → キーによるページ送りを復活**（v1.25.3 の誤無効化を訂正）
  - v1.25.3 で「横スクロールで意図しないページ遷移」の要件を誤解釈し、キー入力までブロックしていた。
  - 対策：矢印キーでのページ送りを元通り復活。代わりに**サムネ一覧モーダル内の水平 wheel イベントを `preventDefault`** する実装を追加し、トラックパッド横スワイプや tilt-wheel マウス由来の誤ページ送りのみを抑制（v1.23.3 GROUP-8-kbd の設計を踏襲）。

- **1 枚ずつオーバーレイの前後画像ナビをループ構造化**（IMPROVE-b1-nav-loop）
  - `_extB1NavMove` を改修。最後の画像で「次」を押すと先頭へ、先頭で「戻る」を押すと最後へ巡回する。← / → キー、◀ 戻る / ▶ 次 ボタン両方に適用（絞り込み結果内での巡回）。

- **一括取込完了後に外部取り込み統合テーブルの状態バッジ・進捗・サムネ統計が古いまま表示される不具合を修正**（IMPROVE-ext-bulk-refresh）
  - 一括取込の完了経路および取消（undo）経路の両方で `_extRenderFolderList()` を呼び出し、ページ全体リロード不要で即時反映するよう改修。

### Changed
- **統合テーブル「サムネ」列ヘッダの tooltip 文言を内部名フリーに書き直し**
  - v1.25.2 / v1.25.3 の文面は `externalImportThumbs IDB` / `thumbnails IDB` など実装識別子を含んでおり、ユーザー向け説明として不適切だった。「このフォルダに対して取り込み作業中に一時保存されたサムネの件数・合計サイズです。保存済みアイテムのサムネは別管理のため、ここには含まれません。」へ簡潔化。
  - ⓘ アイコンの視認性を改善（`#888` 10px → `#2c3e50` 13px / font-weight:600）。

- manifest.json: 1.25.3 → 1.25.4
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.25.3] - 2026-04-18

### Fixed
- **1 枚ずつ形式ウィンドウ閉鎖後に統合テーブルのステータス・進捗・サムネ統計が古いままになる**（IMPROVE-ext-close-refresh）
  - `_extB1Close` が `_extRenderSessionsList()` のみ呼んでいたため、統合テーブル（`ext-fl-table`）側のステータス・進捗バー・サムネ件数は古い表示のままだった。
  - 対策：`_extB1Close` 末尾に `_extRenderFolderList()` 呼び出しを追加し、統合テーブルも同時に再描画（ページ全体リロード不要）。
  - `_extB1FinishSessionIfDone`（完了時の自動クローズ経路）は既に `_extRenderFolderList()` を呼んでいるため影響なし。

### Changed
- **サムネ一覧モーダルで ← / → キーによるページ送りを無効化**（BUG-ext-thumbs-scroll-paging）
  - v1.23.3（GROUP-8-kbd）で追加した「サムネ一覧モーダル表示中の ← / → でページ送り」機能が、トラックパッドの横スワイプや tilt-wheel マウスでキーイベント化する環境で**意図しないページ遷移を誘発**するとの報告を受け、無効化。
  - 1 枚ずつオーバーレイでの ← / → による前後画像ナビは維持。
  - サムネ一覧モーダル内では event を consume して下層オーバーレイへの伝播も防止。ページ送りは〔◀ 前ページ〕〔次ページ ▶〕ボタンで明示操作する。

- **サムネ一覧モーダルのページャーをループ構造に変更**（IMPROVE-pager-loop）
  - 最終ページで〔次ページ ▶〕を押すと先頭ページへ、先頭ページで〔◀ 前ページ〕を押すと最終ページへ巡回する。境界での disabled 状態を解除（1 ページしか無い場合のみ disabled）。
  - 保存履歴タブのページャーは番号選択式（1/2/3…/N）のため、prev/next ループの概念に該当せず今回は対象外。

- **統合テーブルの「サムネ」列ヘッダに明示的な ⓘ アイコンを追加**
  - v1.25.2 は `th` に `title` 属性を付けていたが、ホバー領域が小さく tooltip が発見しづらかった。ヘッダ内に `ⓘ`（小さい案内アイコン）を併置し、`cursor: help` で視覚的にも確認しやすくした。

- manifest.json: 1.25.2 → 1.25.3
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.25.2] - 2026-04-18

### Fixed
- **完了セッションの〔👁 閲覧〕がクリック直後にオーバーレイが自動クローズする不具合を修正**（BUG-ext-view-autoclose）
  - 完了セッションは `session.cursor` が queue 末尾にあり、`_extB1LoadCurrent` 内で `cur = session.queue[session.cursor]` が `undefined`、かつ `pendingRemain === 0` のため `_extB1FinishSessionIfDone()` が発火してオーバーレイが閉じられていた。
  - 対策：閲覧クリック時に `session.cursor = 0` と `session.uiFilter = { done: true, skipped: true, pending: true }` を設定してから `_extOpenB1(session)` を呼び、`cur` が有効な `queue[0]` を指すようにして自動 Finish を回避。

- **外部取り込みサムネキャッシュ（ext-persist）の populate 空振り修正**（BUG-ext-thumb-cache-miss）
  - v1.25.0 実装時、1 枚ずつ形式のセッション `queue` 作成で `sourceRoot` を付与し忘れていたため（`_extStartSessionFromFolderList` 内）、サムネ一覧モーダルの `_extB1FireThumbFetch` が Native fetch 成功時に `SAVE_EXT_THUMB` を送信する際の `rootPath` が空になり、`externalImportThumbs` への永続化も `externalImportThumbStats` への加算も行われていなかった。
  - 結果：2 回目以降のモーダル開閉でも ext-persist ヒットが発生せず Native fetch が再実行され、統合テーブルの「サムネ」列も常に「—」表示のまま（報告症状 2 / 3）。
  - 対策：
    - `_extStartSessionFromFolderList` の `queue.map(...)` に `sourceRoot: e.sourceRoot || rootPath` を追加。
    - `_extB1FireThumbFetch` で `rootPath` を解決する際、`q.sourceRoot` が無ければ `_extActiveSession.rootPath` を使うフォールバックを追加（v1.25.0 以前の既存セッションも救済）。

- **統合テーブルの「サムネ」列ヘッダに説明 tooltip を追加**
  - `externalImportThumbs` IDB の件数・合計サイズを表示している（saveHistory 保存済みアイテムの thumbnails IDB は別ストアで別カウント）ことを `title` 属性で明示し、ユーザーの誤解を防ぐ。

- manifest.json: 1.25.1 → 1.25.2
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.25.1] - 2026-04-18

### Fixed
- **外部取り込み統合テーブルが狭い viewport で表示崩れする不具合を修正**（BUG-ext-table-narrow）
  - v1.25.0 の `ext-fl-table` は固定列幅の合計（28 + 68 + 230 + 200 + 140 = 666px）が大きく、720px body の余剰 54px しか「フォルダパス」列（flex）に残っていなかった。`table-layout: fixed` ＋ `word-break: break-all` の組合せで、wide-tab breakpoint（1000px）未満の狭い viewport ではヘッダ「フォルダパス」もパス内容も 1 文字ずつ改行される表示崩れが発生していた。
  - 固定列幅を引き締め：☑ 28（同）／状態 60（←68）／操作 160（←230）／進捗 160（←200）／サムネ 110（←140）。総固定幅 518px に削減し、パス列へ余剰を回す。
  - `ext-fl-table` に `min-width: 700px` を付与し、極端に狭い viewport では外側 `div` の `overflow-x: auto` で横スクロールに逃がす（視認性維持）。
  - wide-tab（1000px / 1280px / 1600px breakpoints）では従来通り余裕のある列幅で表示される。
- manifest.json: 1.25.0 → 1.25.1
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.25.0] - 2026-04-18

### Added
- **外部取り込み用サムネ永続 IDB ストア**（GROUP-7-b-ext-persist）
  - `background.js` に新ストア `externalImportThumbs`（keyPath: `filePath`、インデックス `rootPath`）を新設。既存 `thumbnails`（saveHistory 用、keyPath: `id`）とは用途別物で、未保存の外部取り込みアイテムのサムネを永続化する。
  - `IDB_VERSION` を 1 → 2 にインクリメント（onupgradeneeded で新ストア追加、既存 `thumbnails` は保持）。
  - 新メッセージハンドラ：`SAVE_EXT_THUMB` / `GET_EXT_THUMB` / `DELETE_EXT_THUMBS_BY_ROOT`。put 時に `storage.local.externalImportThumbStats[rootPath] = {count, bytes}` を差分加算し、読み出しは storage 参照のみで即時表示（IDB 走査不要）。

- **サムネ一覧モーダルの多段フォールバック取得**（GROUP-7-b-save-reuse + GROUP-7-b-modal-cache 一本化）
  - `_extB1FireThumbFetch` を 3 層フォールバックへリファクタ。`q.thumbId` ある保存済みアイテムは既存 `thumbnails` IDB から取得（save-reuse）、なければ `externalImportThumbs` IDB から取得（ext-persist）、それでもなければ Native fetch（`GENERATE_THUMBS_BATCH` / `READ_LOCAL_IMAGE_BASE64`、セマフォ 5 件制限は v1.24.0 で既設）。
  - Native fetch が成功した場合のみ `SAVE_EXT_THUMB` で `externalImportThumbs` に put（Q3=A：モーダル閲覧時のみ蓄積、スキャン時や保存時には蓄積しない）。
  - dataUrl の追加 Map キャッシュは導入せず、v1.24.0 B-1(ア) のカード DOM キャッシュ（`_extB1ThumbsCardCache = Map<qIdx, cardElement>`）と本関数のフォールバックに一本化（`img.src` を DOM が保持＝実質 dataUrl 永続）。

- **保存時の queue.thumbId 追記**（GROUP-7-b-save-reuse、案 A 採用）
  - `_extB1SaveAndNext` 内で saveHistory エントリ生成後に `cur.thumbId` を同時記録し、後続のサムネ一覧モーダル描画で saveHistory 全走査を避ける。突合キーは queue 側に閉じる。

- **外部取り込みタブの統合テーブル**（GROUP-12-merge + GROUP-12-width）
  - 従来の「取り込み予定フォルダリスト」と「セッション一覧」を 1 テーブルに統合。1 行 = 1 rootPath の 1:1 関係（UI 側フィルタ、Q4=A）。
  - 列順：☐ / 状態 / フォルダパス / 操作 / 進捗 / サムネ（列幅：28 / 68 / flex / 230 / 200 / 140 px）。
  - 状態バッジ：進行中＝青（`#3498db`）／ 未開始＝グレー（`#95a5a6`）／ 完了＝緑（`#2ecc71`）／ 空＝オレンジ（`#e67e22`）。
  - 進捗セル：「完了+スキップ / 総数（pct%）」→ 進捗バー（完＝緑／スキップ＝オレンジ、max-width 180px）→「完 N・skip M・残 P」。
  - 行ボタン（ステータス別）：未開始＝〔▶ 開始〕〔🗑〕／ 進行中＝〔🖼 1枚ずつ〕〔🗑〕／ 完了＝〔👁 閲覧〕〔🖼 1枚ずつ〕〔🗑〕。「📦 一括取込」行ボタンは撤去（ワークフロー不成立のため）。
  - 独立の「セッション一覧」セクションは非表示化（統合テーブル内に吸収）。既存 `_extSessions` 構造は温存（UI 側で最新 1 件に絞って表示）。

- **レスポンシブ幅**（GROUP-12-width、C 案）
  - 外部取り込みタブ表示時のみ `document.body` に `wide-tab` クラスを付与。ビューポート幅に応じて `max-width` を 720 → 960 → 1200 → 1480 px へ段階拡張（breakpoints：1000 / 1280 / 1600 px）。他タブでは従来通り 720 px 固定。

- **外部取り込みサムネの件数／サイズ表示 ＋ ルート単位削除**（GROUP-7-b-ui）
  - 統合テーブルの各行サムネ列に「N 件 / X.X MB」を表示（`externalImportThumbStats` 参照）。0 件の行は「—」表示。
  - 行内の〔🗑 サムネ削除〕ボタンで当該 rootPath 配下のサムネを `externalImportThumbs` から一括削除＋ stats エントリも除去。確認ダイアログで件数／サイズを提示してから実行。

### Changed
- manifest.json: 1.24.2 → 1.25.0
- native/image_saver.py は変更なし（version 1.10.0 据え置き、IDB 変更は JS 側のみ）

---

## [1.24.2] - 2026-04-18

### Fixed
- **X 拡大画像で保存ボタンが出ない問題の真因を修正**（BUG-x-photo-2 真因対応）
  - v1.24.1 で追加した④ フォールバック（aria-label + depth walk）は**防御としては有効だが今回の症状の直接原因ではなかった**。実際の原因は <code>content.js</code> の scroll イベントハンドラが即 `hideNow` を呼んでいたこと。
  - X の <code>/status/.../photo/N</code> 拡大モーダルは内部スクロール可能コンテナ（<code>data-testid="swipe-to-dismiss"</code> 等）を持ち、モーダル表示中に scroll イベントが頻発する。従来は `document.addEventListener("scroll", hideNow, { capture: true })` で即座にボタンを隠していたため、mouseover →①が IMG に hit → `showAt` で `opacity=1` → 直後の scroll で `hideNow` により `opacity=0`、以降マウスが img 上に静止＝新たな mouseover が発火せず、ボタンは「作られているが常に透明」という状態が続いていた（`document.getElementById('__image-saver-wrap__')` は要素を返すが opacity は "0"）。
  - 対策：scroll ハンドラを「img がまだマウス下なら `showAt` で位置のみ再計算（opacity=1 維持）／マウスが離れていれば従来通り `hideNow`」に変更。
    - **X photo モーダル**：img は動かない → `inImg=true` → ボタン維持
    - **通常ページのスクロール**：img が視界外へ → `inImg=false` → hide（従来挙動維持）
    - **スクロール追従**：img が画面内で動く場合 → `inImg=true` → ボタンが追従（副次的 UX 改善）
  - v1.24.1 の④フォールバックは削除せず保持。将来 X が再び `<a>` を撤廃した状態で別種の blur-up 構造を採用した場合の防御として有用。
- manifest.json: 1.24.1 → 1.24.2
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.24.1] - 2026-04-18

### Fixed
- **X（旧 Twitter）拡大画像（`/status/.../photo/N`）でホバー保存ボタンが出ない不具合を再修正**（BUG-x-photo-2）
  - v1.23.5（BUG-x-photo）で追加した③（`<a href>` 祖先 → `querySelector("img")` 優先採用）は、タイムライン上の画像では機能していたが、**拡大ページでは X が `<a>` ラッパーを撤廃**していたため③が空振りしていた。
  - 拡大ページの構造は `<div aria-label="画像">` の子に「背景画像 `<div>`（blur-up 用）」と「実 `<img>`」が兄弟配置される blur-up パターン。ホバー対象の背景 `<div>` からは祖先に `<a>` も `<img>` も存在しないため、①②③すべてをすり抜けて保存ボタン非表示となっていた。
  - `src/content/content.js` の `mouseover` ハンドラに **④ 最終フォールバック**を追加：
    - **④a**：`aria-label="画像"` / `aria-label="Image"` の祖先を `closest` で特定し、配下の `<img>` を採用（X の日英ローカライズ両対応、将来の構造変更にも追従しやすい明示マーカー）。
    - **④b**：祖先を最大 5 階層まで遡って `querySelector("img")` を実行し、`isValidImg` を通る `<img>` を採用（汎用 depth walk）。
  - ①②③で捕まらない＝祖先に `<a>` も `<img>` も無い構造に限定されるため、通常ページへの誤爆リスクは小さい。タイムライン上の画像や bluesky 等の既存挙動は①②③で先に捕まえるため影響なし。
- manifest.json: 1.24.0 → 1.24.1
- **native/image_saver.py は変更なし**（version 1.10.0 据え置き）

---

## [1.24.0] - 2026-04-18

### Added
- **外部取り込み「1 枚ずつ形式」でファイル名にタグ・権利者を反映**（GROUP-5-A）
  - v1.23.1 で整合のため一時的に除去していた「メタ付与ファイル名」（`buildFilenameWithMeta`）を b1 保存経路に復帰。v1.23.1 は「両側原名で整合」だったのを、v1.24.0 で「両側メタ名で整合」に揃える。
  - 挙動マトリクス（`_extB1CopyToDest` と `filenameIncludeTag/Subtag/Author` の組合せ）：
    - **同一フォルダ × メタ付与 ON**：Native 側の新コマンド `RENAME_FILE` で原ファイルをメタ名へリネーム。`cur.filePath` / `cur.fileName` も queue に反映し、サムネ生成・saveHistory 記録・COPY 宛先のすべてで一貫したメタ名を使う。
    - **同一フォルダ × メタ付与 OFF**：no-op（原名で saveHistory に記録、物理操作なし）。
    - **別フォルダ × メタ付与 ON**：メタ名で `COPY_LOCAL_FILE`（saveHistory もメタ名）。
    - **別フォルダ × メタ付与 OFF**：原名で `COPY_LOCAL_FILE`（saveHistory も原名）。
  - 変数 `effectiveFilename` を `_extB1SaveAndNext` 内で一本化し、saveHistory 書き込みと物理操作（RENAME / COPY）の両方で同じ値を参照。片側だけ更新する事故を構造的に防ぐ。
  - **エラー処理**：
    - `RENAME_FILE` 失敗時は**保存なし扱い**（saveHistory にも書かず、カーソル進めず、`showStatus` でエラー提示）。再保存できる状態を維持。
    - ターゲット既存時は Native が `{ok:false, errorCode:"DST_EXISTS"}` を返し、フロント側で同様に保存なし扱いへ（勝手に別名で残さず、queue と saveHistory の整合を守る）。
    - `COPY_LOCAL_FILE` 失敗時は v1.23.0 からの既存仕様踏襲（saveHistory 書込済み＋`⚠️ 保存は成功、コピー失敗` 表示）。本リリースでは変更しない。

- **Native `RENAME_FILE` コマンド新設**（`native/image_saver.py`）
  - `os.rename` 単純ラップ。ターゲット既存時は `FileExistsError` 相当を `{ok:false, errorCode:"DST_EXISTS"}` として返す（`unique_path` で勝手に別名にしない）。
  - 同一パスへのリネーム要求（`os.path.samefile` で判定）は `{ok:true, noop:true}` として成功扱い。
  - `image_saver.py` 先頭 `version:` コメント：**1.9.9 → 1.10.0**。

### Changed
- **外部取り込み 1 枚ずつ形式メイン画像プレビューの連打耐性**（GROUP-10-a B-4）
  - `_extB1LoadCurrent` 内に世代カウンタ `_extB1PreviewGen` を導入。フェッチ発火時にインクリメントし、レスポンス受領時にクロージャ保存した世代と照合。古い世代のレスポンスは `#ext-b1-preview-img` に書き込まない。
  - ナビ連打（`_extB1NavMove` / ← → キー）時に遅延レスポンスが新しい画像を上書きしてしまう視覚的不整合を解消。

- **サムネ一覧モーダルの DOM 保持化**（GROUP-10-a B-1(ア)）
  - ページ送り時の `grid.innerHTML = ""` を廃止し、`Map<qIdx, cardElement>` で DOM をキャッシュ。ページ切替は `display` 切替のみで、旧ページのカード DOM は保持。
  - 効果：
    - 遅延レスポンスが正しいカードの `img` に書き込まれるため、視覚的実害が消失（世代カウンタはサムネ側には不要）。
    - ページを戻った際に既取得のサムネが即時表示される（再フェッチ不要）。
    - セッション切替時のみキャッシュクリア（qIdx がセッションローカルなため）。
  - カードのステータスバッジ色／枠色／カーソル枠／ファイル名は、キャッシュ再表示時に常に最新化（GROUP-5-A で RENAME 後の `fileName` 変化にも追従）。
  - フェッチ未完了または失敗で `img.src` が空なら、モーダル再オープン時に自動再発射（多重発射防止のため `img.dataset.fetching` ガード付き）。

- **サムネ一覧モーダルの同時発射数を 5 件に制限**（GROUP-10-c）
  - `GENERATE_THUMBS_BATCH` / `READ_LOCAL_IMAGE_BASE64` の発射を軽量セマフォ（`_EXT_B1_SEMAPHORE_LIMIT = 5`）越しにキューイング。
  - 1 ページ 100 件の並列発射による Native プロセス競合と、モーダル閉鎖後の残タスク滞留を抑制。
  - 対象は**サムネ一覧モーダル内の発射のみ**（`_extB1FireThumbFetch`）。他経路（b1 保存時のサムネ生成は単発、メイン画像プレビューは単発、一括インポートは既に逐次）は現行挙動を維持。

- manifest.json: 1.23.6 → 1.24.0
- native/image_saver.py: **version 1.9.9 → 1.10.0**（`RENAME_FILE` 追加）

---

## [1.23.6] - 2026-04-18

### Changed
- **保存ウィンドウのサブタグ入力欄：入力 1 文字以上のサジェスト母集合を拡張**（BUG-subtag-suggest）
  - 旧：`recentSubTagsList`（直近サブタグ 20 件のみ）からマッチ。21 件目以降の履歴や未使用でも保存履歴には存在する語は候補に出なかった。
  - 新：`existingTags`（メイン／サブを統合した全タグプール。`background.js` の `saveTagRecord` で `[...tags, ...subTags]` として既に統合蓄積されている）から前方一致／部分一致でサジェスト。判定ロジック（`tagMatches`：全角半角／ひらがなカタカナ／1 文字時は前方一致・2 文字以上は部分一致）はメインタグ欄と同一。
  - 既選択重複語の除外を追加：入力中サジェストから `selectedTags`（既選択メインタグ）と `selectedSubTags`（既選択サブタグ）の両方を除外（同一語を両系統に入れる操作を誤って出さない）。空入力（フォーカス時）の直近サブタグ表示にも同様の除外を適用。
  - 空入力時（フォーカス直後）の直近サブタグ 20 件表示は据え置き（近道用途として維持）。
- manifest.json: 1.23.5 → 1.23.6
- **native/image_saver.py は変更なし**（version 1.9.9 据え置き）

---

## [1.23.5] - 2026-04-18

### Fixed
- **X（旧 Twitter）の画像拡大表示で保存ボタンが出なくなった問題を修正**（BUG-x-photo）
  - `src/content/content.js` の `mouseover` フォールバック③ を拡張。従来は「`<a href>` が画像URL パターンを持つ場合のみ proxy で扱う」ロジックだったが、X の `/status/.../photo/N` ページでは href が photo ページ URL のため画像拡張子・`/media/` 等にマッチせず失敗していた。
  - 修正: `<a>` 内に実 `<img>` があればそれを優先的に採用する分岐を追加。href ベースの proxy は `<img>` が無い場合のフォールバックに降格（bluesky 等の既存挙動は維持）。
  - 透明オーバーレイで mouseover が `<img>` に直接届かない構造（X / 類似 SPA）でも拾えるようになった。
- manifest.json: 1.23.4 → 1.23.5
- **native/image_saver.py は変更なし**（version 1.9.9 据え置き）

---

## [1.23.4] - 2026-04-18

### Changed
- **「1 枚ずつ形式の引き継ぎ設定」UI をモーダル内へ移設**（GROUP-11-carryover-move）
  - 旧：設定画面「外部取り込み」タブ内に 4 項目（メインタグ / サブタグ / 権利者 / 保存先フォルダパス）の一括ボックスを配置。
  - 新：1 枚ずつ取り込みモーダル（`ext-b1-overlay`）内の**各項目ラベルの右横**にチェックボックスを配置（ラベル：`入力した情報を次の編集でも使用する`）。編集中の画面内で項目ごとに引き継ぎ可否をトグルできる。
  - ストレージキー `extImportCarryover.{tags|subtags|authors|savepath}` は据え置き（挙動・互換性維持）。
  - モーダル open 時にストレージから読み出してチェック状態を復元。トグル変更時は即時保存し、OFF 化で蓄積値（`_extB1LastCarryValues`）も破棄。
- manifest.json: 1.23.3 → 1.23.4
- **native/image_saver.py は変更なし**（version 1.9.9 据え置き）

---

## [1.23.3] - 2026-04-18

### Added
- **外部取り込み「1 枚ずつ形式」キーボードナビゲーション**（GROUP-8-kbd）
  - `← / →` キーで前後画像へ移動。既存の `◀ 戻る` / `▶ 次` ボタンと同等の挙動で、マウスを使わずにキューを巡回可能になった。
  - サムネ一覧モーダル表示中は `← / →` がページ送りに切り替わる（v1.23.2 で追加された 1 ページ 100 件ページングと連動）。キーリピートによる連打でサムネ生成が過負荷になるのを防ぐため、**250ms スロットル**を適用（連打しても 1 秒あたり 4 ページ送り以内に制限）。
  - 無効条件：IME 変換中（`event.isComposing`）／`input` / `textarea` / `select` / `contenteditable` 要素にフォーカス中／フォルダピッカー開放中／オーバーレイ非表示時（`ext-b1-overlay` の `display !== "flex"`）／セッション無し（`_extActiveSession === null`）。`event.preventDefault()` でブラウザデフォルトのスクロールを抑制。

### Changed
- **設定画面タブ順を変更**（GROUP-9-order）
  - 旧：全般 → ブックマーク → タグ・保存先 → 保存履歴 → 権利者 → SNS 連携 → 外部取り込み
  - 新：**全般 → 保存履歴 → 外部取り込み** → ブックマーク → タグ・保存先 → 権利者 → SNS 連携
  - 主要 3 タブを左側に寄せて使用頻度順に再配置。タブ切替 JS は `data-tab` 参照で動作するため、並び替え以外の改修は不要。
- manifest.json: 1.23.2 → 1.23.3
- **native/image_saver.py は変更なし**（version 1.9.9 据え置き）

---

## [1.23.2] - 2026-04-18

### Added
- **サムネ一覧モーダルのページング**（GROUP-7-a）
  - `設定画面 > 外部取り込み > 1 枚ずつ形式 > サムネ一覧` モーダルで **1 ページ 100 件**固定のページングを追加。フッターに `◀ 前ページ` / `N / M ページ` / `次ページ ▶` を配置。
  - モーダル起動時、現在のカーソル（表示中画像）が含まれるページへ自動フォーカス。絞り込み結果が縮んだ場合はページ番号を範囲内にクランプ。
  - 数千件規模のセッションでも初回描画が 100 件固定になるため、`grid.innerHTML` への DOM 一括挿入と `READ_LOCAL_IMAGE_BASE64` / `GENERATE_THUMBS_BATCH` の同時発射数が抑えられ、UI 固着リスクを解消。
- **GIF サムネイルのアニメーション表示**（GROUP-7-c）
  - 従来モーダルでは `.gif` を `img.src = ""` に置換して空白表示していた（コメントに「先頭フレーム JPEG にフォールバック」とあったが実装未接続）。
  - `src/settings/settings.js` の `_extB1OpenThumbsModal` → `_extB1RenderThumbsPage` で GIF パスに対し `GENERATE_THUMBS_BATCH`（`paths: [filePath]`）を呼び出すよう変更。background.js が `thumbChunkPaths` → Base64 変換まで面倒を見る既存経路を流用するため、追加の Native 変更は不要。
  - 結果：保存時サムネと同品質（600px アニメーション GIF）がモーダル上で動いて見えるようになった。

### Changed
- manifest.json: 1.23.1 → 1.23.2
- **native/image_saver.py は変更なし**（version 1.9.9 据え置き）
- `src/settings/settings.html`：サムネ一覧モーダルにページングコントロール（`#ext-b1-thumbs-prev` / `#ext-b1-thumbs-pageinfo` / `#ext-b1-thumbs-next`）を追加
- `src/settings/settings.js`：モジュールレベル状態 `_EXT_B1_THUMB_PAGE_SIZE = 100` / `_extB1ThumbsPage` を新設。`_extB1OpenThumbsModal` をページ制御関数 `_extB1RenderThumbsPage` へ分割

### Known Limitations
- **保存済みサムネ（IDB の `thumbId`）流用は未実装**（GROUP-7-b）。モーダル開閉のたびに未保存分も既保存分も再取得する構造は変わっていない。流用は `saveHistory` と外部取り込みセッションの突合仕様が必要で、GROUP-5-A（RENAME_FILE 追加）と同時リリースになる v1.24.0 候補として 05 / 06 に残置。

---

## [1.23.1] - 2026-04-18

### Fixed
- **外部取り込み「1 枚ずつ形式」のコピー作成でファイル名不整合を解消**（GROUP-5 ホットフィックス）
  - v1.23.0 では `COPY_LOCAL_FILE` ハンドラが独自に `buildFilenameWithMeta` を適用してタグ・権利者付き別名でコピーしていた一方、`saveHistory` 側は `filename = cur.fileName`（原名）で書き込む設計になっており、`filenameIncludeTag` / `filenameIncludeSubtag` / `filenameIncludeAuthor` のいずれかが ON の場合に **saveHistory が存在しないファイルを指す** 状態になっていた。
  - `src/background/background.js` の `COPY_LOCAL_FILE` ハンドラから `buildFilenameWithMeta` 呼び出しを除去し、呼び出し元から渡された `filename`（= `cur.fileName`）をそのまま使用して saveHistory と整合させた。
- **同一フォルダ指定時の余分な複製を防止**
  - UI の保存先がスキャン元と同じフォルダの場合、コピー作成トグル ON では従来 `unique_path()` により `_2` 連番付きの重複ファイルが生成されていた。`normalizePath` ＋ `toLowerCase()` で同一判定し、同一なら `COPY_FILE` を送信せず `{ ok: true, skipped: true }` を返却。ログに `同一フォルダのためスキップ` を INFO で記録。

### Known Limitations
- 「ファイルへのタグ・権利者付与」（`filenameIncludeTag/Subtag/Author` を実ファイル名に反映）は本パッチでは未対応。v1.23.1 は saveHistory と実ファイルの整合回復のみを目的とする。該当機能は GROUP-5-A として別リリース（v1.24.0 候補）で RENAME_FILE 追加と合わせて検討する。

### Changed
- manifest.json: 1.23.0 → 1.23.1
- **native/image_saver.py は変更なし**（version 1.9.9 据え置き）

---

## [1.23.0] - 2026-04-18

### Added
- **外部取り込み「1 枚ずつ形式」の UX 大幅改善**（GROUP-1 取りこぼし解消）
  - **◀ 戻る / ▶ 次ボタン**：直前・直後の画像へ 1 ステップで移動。スキップ・保存済みアイテムも対象。
  - **🔢 番号ジャンプ**：絞り込み結果内の N 枚目を番号入力でジャンプ。
  - **🖼 サムネ一覧モーダル**：絞り込み結果のサムネグリッド（`READ_LOCAL_IMAGE_BASE64` で 180px 遅延取得）からクリック 1 回で任意の画像へジャンプ。各サムネは**ステータス色の太枠**（完了=緑 `#2ecc71` / スキップ=橙 `#e67e22` / 残り=青 `#3498db`）で一目で状態判別可能。現在の画像は点線アウトラインで強調。
  - **項目別引き継ぎ設定**（GROUP-1-a2）：設定画面「外部取り込み」タブに引き継ぎ設定ボックスを追加。メインタグ / サブタグ / 権利者 / 保存先フォルダパス の 4 項目を**個別に** ON/OFF 可能。既存の保存ウィンドウ引き継ぎ設定とは**別系統**（`storage.local.extImportCarryover`）。引き継ぎ OFF にした瞬間に蓄積値を破棄し、意図しない残留を防ぐ。
  - **指定保存先への画像コピー作成**（GROUP-1-b）：b1 ウィンドウ内のチェックボックス「保存先に画像をコピー作成」で ON にすると、履歴登録と同時に元ローカルファイルを `savePath` 配下へコピー。ファイル名はタグ・権利者を含む**通常保存と同形式**（`background.js:buildFilenameWithMeta` を再利用）。Native Messaging に新コマンド `COPY_FILE` を追加し、`shutil.copy2` で mtime / 権限を維持したまま `unique_path` で連番付与。
- **1 枚ずつ取り込み中のステータス絞り込み**（GROUP-4）
  - b1 ウィンドウ上部に「完了 / スキップ / 残り」の 3 種トグルを配置。**複数選択可**、**初期状態は「残り」のみ ON**（未処理のみ表示）。作業中にいつでも解除・変更可能。
  - ナビゲーション（◀ / ▶ / 🔢 / 🖼）の遷移対象は**絞り込み結果内のみ**を巡回。範囲外カーソルは自動的に最寄りの該当項目へ寄せる。保存・スキップ後の「次へ」も絞り込み内で進行し、末尾到達時は先頭に巻き戻して飛ばした pending を拾えるようにした。
  - 絞り込み状態はセッション単位（`session.uiFilter`）で永続化。セッション再開時に前回の絞り込みを復元。
  - 進捗カウンタ（完了 X / スキップ Y / 残り Z）もステータス色で統一。フィルタトグル自体も該当色の枠＋選択時淡い背景色で視覚判別を強化。
  - 完了・スキップ済みアイテム閲覧時は「保存して次へ」「スキップ」ボタンを無効化（完了済みは保存履歴からタグ・権利者を復元して閲覧可）。

### Changed
- **native/image_saver.py**: version 1.9.8 → 1.9.9（`handle_copy_file` 追加）
- **b1 ウィンドウ右ペイン上部**：進捗カウンタを単一テキストからステータス別 `<span>` に分割し、色分け表示に変更（機能互換）。

### Technical
- `settings.js` に GROUP-4 / GROUP-1-a1 用のヘルパー群を新設：`_extB1GetFilteredIndices` / `_extB1AdjustCursorToFilter` / `_extB1AdvanceCursorInFiltered` / `_extB1NavMove` / `_extB1NavJump` / `_extB1OpenThumbsModal` / `_extB1RenderNavAndProgress` / `_extB1RenderEmptyPreview` / `_extB1ApplyStatusReadonly` / `_hexToTint`。
- `background.js` に `COPY_LOCAL_FILE` メッセージハンドラを追加し、`buildFilenameWithMeta` を内部で適用してから `sendNative({cmd:"COPY_FILE"})` を呼ぶ形で責務分離。
- プランログ運用（CLAUDE.md の 6 ステップ + ⑦ 残タスク提示）の実稼働リリース第 1 弾。GROUP-1 / GROUP-4 の取りこぼし事故を遡及対応。

---

## [1.22.10] - 2026-04-17

### Fixed
- **保存系 GIF サムネイルでも Native Messaging 1MB 応答上限を回避する統一対応**：v1.22.9 で整備したチャンク経路をプレビュー／サムネイル生成／保存画像表示の 3 箇所に限定していたが、保存時の GIF サムネイルは依然として `thumbData`（Base64）を応答に直接詰め込んでおり、大容量 GIF（フレーム数・サイズが大きい場合）で Native Messaging の 1MB 応答上限に到達して保存成功レスポンスが返ってこなくなる残課題があった。以下 3 経路（および外部取り込み 2 経路）で一時ファイル＋`READ_FILE_CHUNK` 方式に統一：
  - `handle_save_image` / `handle_save_image_base64` / `handle_generate_thumbs_batch` の GIF ブランチで、縮小 GIF を `%TEMP%\borgestag_chunk_cache\savedgif_xxxx.gif` に書き出し、応答は `thumbChunkPath` / `thumbTotalSize` / `thumbMime` / `thumbWidth` / `thumbHeight` を返す（`thumbData` は返さない）。非 GIF 保存は従来どおり `thumbData` 経路で影響なし。
  - `background.js` に共通ヘルパー `resolveThumbDataUrlFromNativeRes(res)` と低レベル `_fetchThumbB64FromChunkPath(tempPath)` を新設。`handleSaveImage`（content 由来サムネ最優先を維持）／`handleInstantSave`／`handleSaveMulti`（ループ初回のみ採用する既存方針を維持）の 3 箇所で `res.thumbData → data:URL` 直組み立てを共通ヘルパーへ差し替え。
  - `GENERATE_THUMBS_BATCH` メッセージハンドラで `thumbChunkPaths` を後処理し、settings.js 側（外部取り込みバルク／1 件ずつの 2 経路）は既存の `thumbs[p]` / `thumbMimes[p]` のまま無改修で動作する形に統合。

### Changed
- **native/image_saver.py**: version 1.9.7 → 1.9.8

---

## [1.22.9] - 2026-04-17

### Changed
- **GIF アニメーション対応（3 箇所：プレビュー / サムネイル / 保存画像表示）**：Native Messaging の 1MB 上限を超える大容量 GIF を、**フレームを減らさずにアニメーションを保持したまま** 拡張機能内で扱えるようにした。`native/image_saver.py` に以下 4 コマンドを追加：`READ_FILE_CHUNK`（任意ファイルを最大 800KB ずつ分割送信）／`MAKE_GIF_THUMB_FILE`（Pillow でリサイズした GIF を一時ファイルに書き出し）／`FETCH_PREVIEW_GIF`（URL を Referer 付きで取得 → 一時ファイル化）／`DELETE_CHUNK_FILE`（一時ディレクトリ配下のみ許可する安全削除）。
- **拡張側 3 箇所を Blob URL 組み立てに対応**：
  - **プレビュー**（`src/modal/modal.js:FETCH_PREVIEW` フォールバック）：応答が `chunksB64` 配列の場合は base64 を `Uint8Array` へ展開して `Blob` + `URL.createObjectURL` で `<img>` に設定。
  - **サムネイル**（`src/background/background.js:generateMissingThumbs`）：GIF は `MAKE_GIF_THUMB_FILE` → チャンク読み取り → IDB に Blob を直接保存（Canvas リサイズを経由するとアニメが失われるため）。
  - **保存画像表示**（保存履歴「🖼 保存した画像」）：新設の拡張ページ `src/viewer/viewer.html` に遷移し、`viewer.js` が `FETCH_FILE_AS_DATAURL` の `chunksB64` 応答から Blob URL を組み立てて表示する。`settings.js` / `modal.js` の `open-file` ハンドラを viewer.html 経由に統一。
  - **モーダル内ライトボックス**（`modal.js:loadEntry`）：GIF の場合は chunksB64 から Blob URL を組み立てて `<img>` に設定。前の Blob URL は `URL.revokeObjectURL` で解放。
  - **外部取り込みプレビュー**（`settings.js:READ_LOCAL_IMAGE_BASE64` 呼び出し）：同様に chunksB64 → Blob URL 対応。
- **v1.22.8 の第 1 フレーム JPEG フォールバックを撤去**：分割送信でフルフレームが扱えるようになったため、`handle_read_file_base64` の GIF パスは `{useChunks:true, totalSize, mime, sourcePath}` を返す信号のみに簡素化した。

### Added
- **新規拡張ページ `src/viewer/viewer.html` / `viewer.js`**：`?path=...` クエリで指定されたローカルファイルを `FETCH_FILE_AS_DATAURL` 経由で読み込み、`dataUrl` 応答は `<img src>` へ直接、`chunksB64` 応答は `URL.createObjectURL` で Blob URL 化して表示する。ページ破棄時に `beforeunload` で Blob URL を解放。`manifest.json:web_accessible_resources` に両ファイルを追加。
- **background.js 汎用ヘルパー**：`readNativeFileChunksB64(path)`（256 イテレーション安全上限付きでチャンク収集）／`deleteNativeChunkFile(path)`（cleanup）／`_assembleBlobFromChunksB64(chunksB64, mime)`。`LONG_TIMEOUT_CMDS` に `READ_FILE_CHUNK` / `MAKE_GIF_THUMB_FILE` / `FETCH_PREVIEW_GIF` を追加。

### Changed
- **native/image_saver.py**: version 1.9.6 → 1.9.7

---

## [1.22.8] - 2026-04-17

### Fixed
- **大容量 GIF サムネイル生成失敗時に Native プロセスが黙って死ぬ問題への耐性強化**：`native/image_saver.py` の `main()` ループにトップレベル `try/except BaseException` を追加し、コマンドハンドラ内部で未捕捉例外（`MemoryError` 等を含む）が発生してもプロセスを継続動作させる。ディスパッチャを `_dispatch_command()` として分離し、各ハンドラの例外をメインループ側で一括処理してエラーレスポンスを返すよう変更。
- **`handle_read_file_base64` の GIF パスをステージ別に堅牢化**：
  - 各 `make_gif_thumbnail` 呼び出しを `try/except BaseException` で保護し、Pillow 内部の未捕捉例外で Native が落ちないように防御。
  - 全 `max_size`（800/400/200）試行で失敗した場合、**第1フレームを静止 JPEG に変換してフォールバック返却する暫定対策**を追加。`{ok: true, dataUrl, fallback: "first_frame_jpeg", diagnostic}` の形式で返すため、アニメーションは失われるが保存履歴タイルに画像は表示されるようになる。
  - 各ステージ（`open` / `gif meta` / `gif attempt` / `fallback`）で stderr にトレースログを出力し、Firefox の Native Messaging stderr 収集機構で拾えるようにした。
- **`background.js:generateMissingThumbs` の例外ログを詳細化**：catch ブロックで `err.name` / `err.message` / `err.stack` 先頭3行 / 対象パスを出力するよう変更。Native 応答 NG パスのログにも `path` を追加。

### Added
- **`background.js`：フォールバック適用時の INFO ログ**：Python 側が第1フレーム JPEG フォールバックを返した場合に `サムネイル GIF フォールバック適用: ...` を INFO ログに明記し、静止画化が発生したエントリをユーザーが認識できるようにした。

### Changed
- **native/image_saver.py**: version 1.9.5 → 1.9.6

---

## [1.22.7] - 2026-04-17

### Changed
- **保存ウィンドウ：メインタブバーのチップ表示エリアを左寄せに修正**：`#main-chip-area` 直前の `<div style="flex:1;"></div>` スペーサーを削除し、`justify-content:flex-end` を `flex-start` に変更。確定済みチップが「✏️ 権利者:」入力欄の右隣から左詰めで並ぶようになった。
- **保存ウィンドウ：「🔍 フォルダを絞り込み」「新しいフォルダ名」「＋ 作成」エリアを左寄せに修正**：内包する div から `margin:0 auto`（中央寄せ）を削除した。

### Fixed
- **native/image_saver.py の version コメント訂正**：v1.22.3 以降 manifest と誤って同期していたのを、別系統の連番に戻した（1.22.6 → 1.9.5）。CLAUDE.md の「native は manifest と別系統」ルールに整合させた。

### Added
- **GIF サムネイル生成失敗時の診断ログ**：`make_gif_thumbnail` に `_errors` 引数を追加し、`handle_read_file_base64` の GIF パスで以下を `diagnostic` として返すように変更：元ファイルサイズ・元サイズ・フレーム数・各 max_size 試行の結果（出力バイト数 or 例外メッセージ）。`background.js:generateMissingThumbs` で失敗時に `addLog("WARN", ...)` にこの診断情報を出力する。v1.22.8 で実装する本修正の原因特定に利用する。

---

## [1.22.6] - 2026-04-17

### Fixed
- **保存履歴：大容量 GIF の「保存した画像」押下で Native 切断が発生する問題を修正**：`handle_read_file_base64` の GIF パスで、`make_gif_thumbnail` が失敗した際に生 GIF をそのまま Base64 化して返すフォールバックがあり、Native Messaging の 1MB 上限を超えた瞬間にネイティブホストが強制終了していた。生データフォールバックを廃止し、max_size を 800 → 400 → 200 と段階的に縮小して 700KB 以内に収める処理に変更。いずれでも収まらない場合はエラーを返す。

---

## [1.22.5] - 2026-04-17

### Fixed
- **保存ウィンドウ：タグ入力欄の幅を固定幅に修正**：v1.22.1 で誤って削除されていた `.dest-tabbar-tag-wrap`（max-width:340px）・`.dest-tabbar-subtag-wrap`（max-width:240px）の固定幅指定を復元。`#tag-toolbar` に `justify-content:flex-start` を追加し左寄せを明示した。
- **保存ウィンドウ：「🔍 タグで絞り込み」「🏷 タグ名でフォルダを新規作成」ボタンを左寄せに修正**：「💡 候補から選ぶ」「📁 フォルダを選ぶ」タブがある行の右端（flex:1 スペーサーで押し出し）にあったボタンを、タブの右隣（左端寄り）に移動した。

---

## [1.22.4] - 2026-04-17

### Fixed
- **保存ウィンドウ：タグ・サブタグ入力欄が横いっぱいに広がる問題を修正**：tag-toolbar の各入力欄に付与していた `flex:1; max-width:none;` インラインスタイルを削除し、CSS 定義の幅（`max-width: 340px` / `240px`）を有効にした
- **外部取り込み画面：行操作ボタンのラベルを追加**：「📦」「📥」「🗑」のみだったボタンに「📦 一括取り込み」「📥 1枚ずつ取り込み」「🗑 リストから削除」のテキストを追加

---

## [1.22.3] - 2026-04-17

### Added
- **保存履歴：GIF アニメーションのサムネイル再生に対応**：従来 Pillow が `convert("RGB")` → JPEG 変換するため GIF アニメーションが静止画になっていた問題を修正。
  - `native/image_saver.py` に `make_gif_thumbnail()` ヘルパーを追加。`PIL.ImageSequence.Iterator` で全フレームを RGBA で読み出し、最大 600px にリサイズして再合成したアニメーション GIF バイト列を返す。
  - `handle_save_image` / `handle_save_image_base64`：保存時のサムネイル生成で `.gif` 拡張子の場合のみ `make_gif_thumbnail` を呼び出し、`thumbMime: "image/gif"`, `thumbWidth`, `thumbHeight` を付加して返すよう変更。`thumbWidth`/`thumbHeight` を明示することで `addSaveHistoryMulti` 内の Canvas → JPEG 変換バイパスを確保する。
  - `handle_read_file_base64`：「保存した画像」ボタン押下時、`.gif` ファイルは `make_gif_thumbnail(max_size=1600)` を経由してアニメーション GIF のまま返すよう変更（従来は JPEG 変換で静止画化していた）。
  - `handle_generate_thumbs_batch`：バッチ再生成でも `.gif` は `make_gif_thumbnail` を使用。レスポンスに `thumbMimes` フィールド（パス→ MIME type 辞書）を追加し、GIF 対象は `"image/gif"` をセット。
  - `src/settings/settings.js`：外部取り込みのサムネイル登録（一括形式・1枚ずつ形式の2箇所）で `thumbMimes` を参照して dataURL の MIME を動的に決定するよう修正（従来 `image/jpeg` ハードコード）。
  - JS 側の `<img src>` にはブラウザが `data:image/gif;base64,...` を自動再生するため追加変更不要。

---

## [1.22.2] - 2026-04-17

### Added
- **保存履歴：「GIF のみ」絞り込みフィルターを追加**：設定画面の保存履歴タブ・フィルター行に「GIF のみ」チェックボックスを追加。オンにすると `entry.filename` の拡張子が `.gif`（大小文字不問）のエントリのみ表示する。既存のタグ・権利者・取り込み元フィルターと AND 条件で動作する。

---

## [1.22.1] - 2026-04-17

### Changed
- **保存ウィンドウ：UIレイアウトを再構成（a1〜a3）**
  - **a1：候補パネル上部に currentPath バナーを追加**：「候補から選ぶ」表示中かつエクスプローラー側でフォルダを選択済みの場合、候補パネル上部に現在選択中パスを青字で表示するバナーを追加。`switchDestMode` および `navigateTo` 実行後に更新される。
  - **a2：タグ入力欄を独立した行（tag-toolbar）へ移動**：従来 dest-tabbar 内の中央エリアにあったタグ・サブタグ入力欄を `#tag-toolbar`（`panel-dest` の最上部、常時表示）として独立した行に移動。各入力欄は `flex:1` で均等幅に拡張。dest-tabbar はタブボタンのみの行とし、「🔍 タグで絞り込み」「🏷 タグ名でフォルダを新規作成」ボタンを右端へ移動。
  - **a3：権利者入力欄と確定チップを main-tabbar に移動**：従来 panel-dest 先頭の独立行だった権利者入力エリア（✏️ 権利者:）を main-tabbar の「保存先」「保存履歴」タブの右隣に移設。タグ・サブタグの確定チップ表示エリア（`#main-chip-area`）を main-tabbar の右端に追加。どちらも「保存先」タブ表示中のみ `display:flex`、「保存履歴」タブ切り替え時は `display:none`。チップは従来の tagArea/subTagArea ではなく `#main-chip-area` に `data-type="main"/"sub"` 属性付きで挿入するよう変更。

---

## [1.22.0] - 2026-04-16

### Changed
- **外部取り込み：取り込み予定フォルダリストを独立化・一括操作バーを追加**：従来「1枚ずつ形式」専用だった取り込み予定フォルダリストを形式切替ラジオの外（常時表示エリア）へ移設し、「一括形式」「1枚ずつ形式」どちらからも利用できる独立した機能として統一。
  - リスト表示テーブルに ☑ 選択列を追加。チェックボックスで複数行を選択し、一括操作バーから **📦 一括取り込み** / **📥 1枚ずつ取り込み** / **🗑 削除** を一括適用可能。
  - 一括操作バーには全選択 / 全解除 / 反転ボタンと選択件数表示を設置。各行にも個別の 📦 / 📥 / 🗑 ボタンを配置。
  - サブフォルダピッカーを大幅改善：表示高さを拡大（`min-height:300px; max-height:60vh; resize:vertical`）。ヘッダーに全選択 / 全解除 / 反転ボタンと選択件数表示を追加。**Shift+クリック** で範囲選択、**マウスドラッグ** で連続選択（unify/invert モード対応、`processedRowsThisDrag` Set でループ防止）、**Alt+ドラッグ** または **Alt+Shift+クリック** で範囲反転。
- **外部取り込み：β動線（複数ルート一括スキャン）を実装**：取り込み予定リストで複数行を選択して「📦 選択を一括取り込み」を押すと、各行を順次スキャンし結果を 1 つのフォルダ別タグ設定テーブルへ統合。各行は `sourceRoot` / `completionRoot` を保持し、インポート完了時にルートパスごとの完了履歴を記録。
- **外部取り込み：フォルダ別タグ設定テーブルを多ルート対応（X-3 形式）**：複数ルートからのスキャン結果を表示する際、フォルダ列を「薄字ルート + 太字相対パス」の 2 行表示に切り替え。`_extFolderTagMap` のキーをルート修飾形式（`${rootPath}\0${relFolder}`）に統一。
- **外部取り込み（一括形式）：インポート完了時に完了ルートフォルダ履歴を記録**：従来「1枚ずつ形式」のみ完了履歴に登録していたが、一括インポート完了時もルートパスごとに履歴（completedAt・件数）を記録するよう拡張。

---

## [1.21.3] - 2026-04-16

### Changed
- **保存履歴の絞り込みサジェスト：かな/カナ・半角/全角の差異を無視**：v1.21.1 で追加した履歴絞り込み入力欄のサジェストで、「あさひ」と入力しても「アサヒ」「ｱｻﾋ」「ＡＳＡＨＩ」などがヒットしない問題を修正。
  - 共通の正規化関数 `_normalizeForMatch()` を settings.js / modal.js に追加。
  - 処理内容：`String.normalize("NFKC")`（半角カナ→全角カナ・全角英数→半角英数など）→ `toLowerCase()` → カタカナ（U+30A1〜U+30F6）をひらがなへシフト（-0x60）。
  - サジェストの前方一致判定は、クエリ・候補の両方をこの正規化関数にかけたうえで比較する。
  - 設定画面・保存ウィンドウ両方に同じ挙動で適用。

---

## [1.21.2] - 2026-04-16

### Changed
- **保存履歴の絞り込みサジェスト：前方一致化／未入力時の全件表示を廃止**：v1.21.1 で追加した履歴絞り込み入力欄（タグ／権利者）のサジェスト挙動を調整。
  - 部分一致（`includes`）→ **前方一致（`startsWith`）** に変更。入力文字列の頭方向から一致する候補のみ表示し、ヒット過多を抑制。
  - 未入力時の全件表示（古い順 8 件固定）を廃止。未入力時はサジェスト自体を非表示とする（古い順固定では意味が薄かったため）。
  - 設定画面・保存ウィンドウ両方に同じ挙動で適用。

---

## [1.21.1] - 2026-04-16

### Added
- **保存履歴の絞り込み入力欄（タグ／権利者）をチップ UI 化＋サジェスト対応**：設定「保存履歴」タブとモーダル「保存履歴」パネルの両方で、ヘッダー絞り込み入力欄を 1 文字入力でサジェスト表示、Enter / カンマ（タグはスペースも）で確定してチップ化する構成に刷新。チップ単位で × ボタン削除・Backspace で末尾チップ削除・AND/OR モードでの複数条件絞り込みに対応。タグは完全一致、権利者は部分一致（設定側）／完全一致（モーダル側）の従来マッチ仕様を温存。既存の履歴カード内タグ／権利者チップクリック時のフィルタ追加・除去も、新しいチップ配列上のトグルに接続。
- **データ構造**：canonical はチップ配列 (`_histFilterTagChips` / `_histFilterAuthorChips`、モーダルは `historyFilterTagChips` / `historyFilterAuthorChips`)。`_histFilterTag` / `_histAuthorFilter` は既存呼び出しとの互換シャドーとして `chips.join(" ")` を保持。

### Fixed
- **保存ウィンドウ：サブタグ Enter 確定後にサジェストが閉じたままになる**：`addSubTag()` が無条件で `hideSubSuggestions()` を呼んでおり、続けて選びにくかった。入力欄にフォーカスが残っているとき（通常のユーザー入力経路）は `showSubSuggestions("")` で直近サブタグを再提示し、外部呼び出し（初期復元など）では従来どおり非表示のままとする。

---

## [1.21.0] - 2026-04-15

### Added
- **保存ウィンドウ：候補 1 件自動選択時にフォルダツリーも自動ナビゲート**：タグ選択後に候補が 1 件だけの場合、従来は候補リスト側だけにチェックが入り、右側のエクスプローラー表示とフォルダスタックが追従していなかった。今回から候補クリック時と同じ `navigateToCandidatePath()` を共通関数化し、自動選択時にも呼び出すことでフォルダツリー側の位置と選択状態を常に同期。候補クリック時のロジックも同じ関数を経由するよう整理。
- **保存ウィンドウ：サブタグ入力欄フォーカス時に直近サブタグを即表示**：これまでは空入力でフォーカスしても何も出なかった（条件式が `recentTags.length > 0`（タグ側の履歴）を誤って参照しており、サブタグ履歴が無い新規ユーザー挙動になっていた）。`recentSubTagsList.length > 0` を参照するよう修正し、直近サブタグ一覧を即提示する。

### Changed
- **設定画面：タグ／権利者追加ダイアログのサジェストを 1 文字入力から発火**：`showAddTagDialog` / `showAddAuthorDialog` のサジェスト条件 `if (!matches.length || !q)` から `!q` を除去。入力直後の 1 文字でも既存候補が表示されるようにし、登録済みタグ／権利者への素早い再利用を促す。

---

## [1.20.2] - 2026-04-15

### Fixed
- **長期利用・大規模データで顕在化する固定タイムアウトを一括見直し（H1）**：`sendNative()` の 300 秒タイムアウト対象コマンドを拡大。v1.20.1 で対応済みの 3 種（`WRITE_FILE` / `SAVE_IMAGE_BASE64` / `READ_LOCAL_IMAGE_BASE64`）に加え、以下を追加：
  - `SCAN_EXTERNAL_IMAGES`：大規模フォルダ再帰スキャン（数万ファイル級で 10 秒不足）
  - `GENERATE_THUMBS_BATCH`：サムネイル一括生成（Pillow 処理が枚数線形）
  - `LIST_SUBFOLDERS`：ネットワークドライブ等の遅延対策
  - `SAVE_IMAGE`：内部 urllib 30 秒 + 403 リトライが 10 秒を超え得る
  - `FETCH_PREVIEW`：内部 urllib 15 秒 + Pillow リサイズ
  - `READ_FILE_BASE64`：大容量ローカル画像読込（サムネイル再生成）
- **`saveTagRecord` のキー衝突リスクを緩和（H3）**：URL ベースのキー生成で 100 文字 slice が Fanbox / CDN の署名付 URL（`?Expires=...&Signature=...`）で衝突していた問題を、上限 512 文字へ拡張して解消。`tagRecords` は write-only（監査記録）用途のためマイグレーション不要で旧データと共存可能。

### Changed
- **Python 側 `urllib.request.urlopen` タイムアウトを延長（M4）**：`handle_save_image` 30s → 60s、`handle_fetch_preview` 15s → 60s。大容量画像・低速回線でのタイムアウト頻発を緩和。`native/image_saver.py` 1.9.1 → 1.9.2。
- 設計書 04_影響範囲マップ G1 を新しいタイムアウト分類（LONG 9 種 / SHORT 残り）に更新。

---

## [1.20.1] - 2026-04-15

### Fixed
- **大容量エクスポート（数百 MB）の直接保存がタイムアウトで失敗する問題を修正**：`sendNative()` のタイムアウトが全コマンド一律 10 秒固定だったため、サムネイル Base64 埋め込みのフルエクスポート（例: 286 MB）で WRITE_FILE が書き込み中にタイムアウトしていた。コマンド別タイムアウトマップを導入し、大容量ペイロード3種（`WRITE_FILE` / `SAVE_IMAGE_BASE64` / `READ_LOCAL_IMAGE_BASE64`）を 300 秒（5 分）に延長。その他は従来どおり 10 秒で素早くハング検知する。
  - 既知懸念項目（04_影響範囲マップ G1「タイムアウト値が全コマンドで妥当か」）の解消。

### Changed
- **Python 側 `handle_write_file` をアトミック書き込みに変更**：`<path>.tmp` へ書き出してから `os.replace()` で最終名へリネーム。書き込み途中で中断されても最終ファイルは汚れず、中途半端なデータは `.tmp` のまま残る。次回実行時に古い `.tmp` を事前削除してから再書き込みする。`native/image_saver.py` 1.9.0 → 1.9.1。

---

## [1.20.0] - 2026-04-15

### Added
- **外部取り込みタブに「1枚ずつ形式」を追加**（従来の一括形式と選択式）。プレビューを見ながら1枚ずつタグ・権利者・保存先を決めて取り込む新フロー。
  - **b1 プレビュー＋入力画面**：左に大きめプレビュー（サイズ変更可）／右に入力パネルの2カラムレイアウト。対象ファイル名・元パス・撮影日時・進捗・保存先・メインタグ/サブタグ/権利者を表示・編集。「保存して次へ」「スキップ」「閉じる（中断）」ボタン。
  - **b2 中断・再開**：セッションをストレージに保持し、後から再開可能。スキップ分のみ再処理もサポート。
  - **b3 複数セッション並行**：セッション一覧から任意のセッションを再開可能。
  - **c1 取り込み予定フォルダリスト**：単一パス追加・サブフォルダ選択モード（非再帰）の2種でリストを構築。各行から「開始」でセッション化。
  - **c2 完了チェック**：セッション完了時に予定リストの該当行へ自動で完了マーク。手動チェック/解除も可能。
  - **完了ルートフォルダ履歴**：取り込み完了済みのルートパスを別ストレージに蓄積し、再取り込み時は警告ダイアログで誤重複を防止。
  - **ハイブリッド保存先ピッカー**：b1 の保存先入力はテキスト直打ちに加え、「📁 フォルダを選ぶ」ボタンでツリービュー・MKDIR・タグ名フォルダ作成を備えたモーダルを開ける。
- **Native Messaging コマンド 2種追加**
  - `LIST_SUBFOLDERS`：指定フォルダ直下のサブフォルダ一覧（非再帰、隠し/システム属性フィルタ、Windows 自然順ソート）。
  - `READ_LOCAL_IMAGE_BASE64`：ローカル画像を Python 側で Pillow リサイズ（既定 1200px, JPEG 90%）し Base64 dataURL で返却（b1 プレビュー用）。`sendNative` 3MB 上限チェックの除外コマンドに追加。
- **ストレージキー 4種追加**：`extImportMode`（形式切替）、`extImportSessions`（セッション状態）、`extImportFolderList`（取り込み予定リスト）、`extImportCompletedRoots`（完了ルート履歴）。

### Changed
- `native/image_saver.py` を v1.9.0 に更新（新コマンド 2 種追加）。
- 設計書 01/02/04 を v1.20.0 / native v1.9.0 仕様に更新。影響範囲マップ G1・G9 に新コマンドと新ストレージキー、1枚ずつ形式の注意事項を追記。

---

## [1.19.8] - 2026-04-14

### Fixed
- **保存履歴編集後にページ全体が再描画される問題を修正**：設定画面・保存ウィンドウの情報編集パネル保存、タイル上のタグチップ×削除、個別タイル削除、選択タイルへのタグ/権利者一括追加の各操作で、従来はグリッド全体を再描画していたためスクロール位置・サムネイル読み込み状態・グループ展開状態がリセットされていた。編集対象のタイルのみ差分更新するよう変更。
- **設定画面の情報編集パネルで編集してもタイル本体に反映されない問題を修正**：`saveEntryNow()` がストレージ保存のみでタイル本体を更新しなかったため、パネルを閉じてタブ切替等で再描画するまで変更が見えなかった。情報編集パネルを閉じるタイミングで該当タイルを差分更新するよう修正。
- **保存ウィンドウの情報編集パネルで保存先パスを変更してもタイル表示に反映されない問題を修正**：メタ情報（タグ・権利者）は差分更新されていたが `.history-path` は未更新だった。パス変更時も差分更新するよう修正。

### Changed
- 差分更新では、編集結果が現在の絞り込み条件に合致しなくなったタイル（情報編集パネルを閉じるタイミング、またはタグチップ×削除時）は DOM から非表示化する。

---

## [1.19.7] - 2026-04-14

### Fixed
- **即保存でTwitter/X等のURLから保存すると拡張子なしになる問題を修正**：URLパスに拡張子がない場合（例: `pbs.twimg.com/media/XXXXX?format=jpg`）、クエリパラメータ `format=` から拡張子を取得する。それもなければ `.jpg` をフォールバック補完。
- **即保存時にファイル名にタグ・サブタグ・権利者が付与されない問題を修正**：引き継ぎ設定（`retainTag` / `retainSubTag` / `retainAuthor`）がONの場合、`retainedTags` / `retainedSubTags` / `retainedAuthors` を取得しファイル名に付与するよう修正。`recentSubTags` / `recentAuthors` の更新、保存履歴への権利者記録にも対応。

### Changed
- **設計書（01_基本設計書・02_詳細設計書）に即保存の拡張子補完・引き継ぎタグ取得の仕様を追記**

---

## [1.19.6] - 2026-04-13

### Fixed
- **連続保存モード終了時に保存先が前回の保存先のままになる問題を修正**：モード終了時に `selectedPath` / `selectedPaths` のリセットと UI のパス表示・保存ボタン状態の更新を追加。
- **設定画面 > 保存情報編集パネルで保存先パスを変更して Enter を押しても反映されない問題を修正**：`blur` と `keydown(Enter)` の両方で `commitPathChange()` を呼び出し、変更があれば即座に保存するよう修正。

### Changed
- **連続保存モード中の保存先を固定せず変更可能に**：従来はセッション開始時の保存先を固定していたが、候補パネルの通常操作で自由に変更できるよう仕様変更。`csSession` から `savePaths` / `selectedPath` フィールドを廃止。
- **設定画面 > 保存情報編集パネルを閉じた後の自動再描画を廃止**：パネルを閉じるたびに全タイル再描画が走り、スクロール位置やサムネイル読み込みがリセットされていた問題を解消。

### Added
- **設定画面 > 保存履歴タブにグループ単位の一括選択チェックボックスを追加**：グループカード左上のチェックボックスで、グループ内の全アイテムを一括選択・解除できる。展開エリア内の個別チェックボックスも連動して更新される。

---

## [1.19.5] - 2026-04-13

### Fixed
- **連続保存モードのセッション切り替え後に保存先が固定される問題（v1.19.4 の修正不足）**：v1.19.4 では `csSession` のフィールドのみリセットしていたが、モジュールレベルの `selectedPath` / `selectedPaths` 変数と UI のパス表示・保存ボタン状態もリセットする必要があった。これらを明示的にクリアするよう修正。

---

## [1.19.4] - 2026-04-13

### Fixed
- **連続保存モードのセッション切り替え後に保存先が前セッションで固定される問題を修正**：新セッション作成時に `csSession` の `savePaths` / `selectedPath` をリセットしていなかったため、旧セッションの保存先が引き継がれていた。新セッション開始時にこれらを明示的にクリアするよう修正。

---

## [1.19.3] - 2026-04-13

### Fixed
- **通常保存の 403 フォールバック（SAVE_IMAGE_BASE64）がペイロード上限に引っかかる問題を修正**：v1.18.4 で追加した 403 フォールバックにより、ブラウザの Cookie で取得した画像を Base64 化して `SAVE_IMAGE_BASE64` で送信するが、数 MB 以上の画像で `sendNative()` の 3MB 上限チェックに引っかかっていた。`WRITE_FILE` と同様に `SAVE_IMAGE_BASE64` も上限チェックから除外。

---

## [1.19.2] - 2026-04-13

### Added
- **設定画面 > 保存履歴タブに「権利者追加」ボタンを追加**：タグ追加ボタンの隣に配置。選択中の保存履歴がある場合のみ有効化。クリックでサジェスト付きの権利者入力ダイアログを表示し、選択中の全エントリに一括で権利者を追加する。globalAuthors にも自動追加。

---

## [1.19.1] - 2026-04-13

### Fixed
- **設定画面 > 保存履歴タブのタグ絞り込みが部分一致だった問題を完全一致に修正**：保存ウィンドウ側は既に完全一致だったが、設定画面側は `includes()` による部分一致のままだった。`===` による完全一致に統一。タグチップクリック時の大文字小文字正規化も修正。

---

## [1.19.0] - 2026-04-13

### Added
- **連続保存モード終了確認ダイアログに「新セッションで継続」ボタンを追加**：現在グループ化に用いているセッションIDを完了し、新しいセッションIDで連続保存モードを再開始できる。異なる画像群への切り替えがモードを終了せずに行える。
- **設定画面 > タグ保存先タブに手動追加UIを追加**：既存タグへの保存先追加（各タグ行内の「＋ 保存先を追加」ボタン）と、新規タグ＋保存先の追加（タグリスト上部の「＋ 新しいタグを追加」ボタン）に対応。パス重複チェック付き。

### Changed
- **保存情報編集パネルの保存先パス入力欄で Enter キーによる保存に対応**：保存ボタンクリックと同等の動作を Enter キーでも発動できるよう変更。

---

## [1.18.4] - 2026-04-12

### Fixed
- **即保存で pixiv fanbox の画像が 403 Forbidden で失敗する問題を修正**：即保存では URL を Python に直接渡してダウンロードしていたが、`downloads.fanbox.cc` は Cookie なしのリクエストを拒否するため失敗していた。通常保存と同様に、403 発生時にブラウザの認証情報を使って画像を取得し Base64 経由で保存するフォールバックを追加。

---

## [1.18.3] - 2026-04-11

### Fixed
- **保存ウィンドウ > 候補自動チェック時に保存先パスが反映されない問題を修正**：フォルダ候補が 1 件のみの場合に自動チェックされるが、`selectedPath` と表示パスが更新されず、保存ボタンを押しても正しいフォルダに保存されなかった。自動チェック時に `selectedPath` の設定・パス表示・保存ボタン状態の更新を追加。
- **保存ウィンドウ > 保存情報編集パネルの保存先パスが編集不可だった問題を修正**：保存先パスの表示要素を `<div>` から `<input>` に変更し、ユーザーが直接パスを編集して保存できるよう修正。`background.js` の `updateHistoryEntry()` に `savePaths` パラメータ対応を追加。

---

## [1.18.2] - 2026-04-11

### Changed
- **保存ウィンドウ > 引き継ぎチェックボックスをオフにした瞬間に入力欄をリセット**：従来は次回保存後のリセット時にのみクリアされていたが、チェックを外した時点でタグ / サブタグ / 権利者の入力欄を即座にクリアするよう変更。
- **設定画面 > 保存情報編集パネルに明示的な保存ボタンを追加**：リアルタイム保存は従来通り動作しつつ、ユーザーが「保存した」と実感できるよう「💾 保存」ボタンを併設。クリック後は「✔ 保存済み」の視覚フィードバックを表示。

---

## [1.18.1] - 2026-04-08

### Fixed
- **即エクスポートが失敗する問題を修正**：v1.18.0 で追加した `sendNative()` の 3MB ペイロード上限チェックにより、200MB 級の大容量 JSON を渡す `WRITE_FILE` コマンド（即エクスポート）が `payload が大きすぎます` エラーで失敗していた。`WRITE_FILE` を上限チェックから除外。Firefox の拡張→ネイティブ方向は実質的に大容量を許容するため、エクスポート用途では従来通り通過させる。型・`cmd`・JSON 化可否のチェックは引き続き全コマンドに適用。

---

## [1.18.0] - 2026-04-08

### Security
- **Path Traversal 対策（MKDIR）**：フォルダ作成パスを許可ルート（folderBookmarks / tagDestinations / explorerRootPath / lastSaveDir / 現在表示中のエクスプローラーパス）配下に限定。`..` を含むパスは即拒否。background.js / image_saver.py の二重検証で、Native Messaging を直接叩く悪意ある呼出にも対応。
- **Native Messaging ペイロード検証**：`sendNative()` で型・`cmd`・JSON化可能性・サイズ上限（3MB）を送信前に検証。Firefox の 4MB 上限超過による無言切断を防止。

### Fixed
- **保存ウィンドウ > プレビュー高さ消失バグの完全修正**：`background.js` 内で重複定義されていた `setModalSize()` の後定義が既存フィールドを単純上書きしていたため、v1.17.3 で修正したはずの `previewHeight` 消失バグが再発状態にあった。重複定義を解消し、スプレッド構文によるマージ版に統一。`getModalSize` / `normalizePath` の重複定義も併せて解消。

### Changed
- **native/image_saver.py**: version 1.8.3 → 1.8.4（`handle_mkdir` に二次検証追加）

---

## [1.17.7] - 2026-04-08

### Fixed
- **デバッグログ削除**：`recordTagDestination` 系の `addLog("DEBUG", ...)` 残存（background.js 2箇所）を削除。
- **ファイル名サニタイズ強化**：`buildFilenameWithMeta` の `sanitize()` で制御文字（`\x00-\x1f`）と末尾の空白・ドット（Windowsで無効）を追加除去するよう変更。
- **タグ→保存先関連付けの重複検出を強化**：`recordTagDestination` のパス比較を `normalizePath` 経由に変更し、末尾 `\` の有無や `\\` 連続の差で同一フォルダが重複登録される問題を修正。

### Docs
- **設計書 01_基本設計書.md の整合性修正**：
  - IndexedDB 名を実装に合わせて `ImageSaverThumbsDB` → `ImageSaverThumbDB` に修正。
  - `recentTags` の上限を実装に合わせて「最大20件」→「最大100件」に修正。

---

## [1.17.6] - 2026-04-05

### Fixed
- **デバッグログ削除**：v1.17.4〜v1.17.5 で追加していた調査用コンソールログ（`[BT-L1]`〜`[BT-L5]`）を削除。

---

## [1.17.5] - 2026-04-05

### Added (デバッグ用・後で削除)
- デバッグログ継続（AMO 再登録のためバージョンのみ更新）

---

## [1.17.4] - 2026-04-05

### Fixed
- **保存ウィンドウ > 起動時 img 高さが復元されない問題を修正**：`modalSize.previewHeight` が未保存（`#preview-resizer` を一度も使っていない場合）でも、`leftPanelHeights["preview"]` が保存済みであればラッパー高さ - 5px を img 高さとして適用するよう変更。
- **保存ウィンドウ > 小窓表示時に左パネルが比例縮小する問題を修正**：`.left-panel` に `flex-shrink: 0` を追加し、ウィンドウが小さい場合でもパネルが設定高さ以下に縮小されないよう変更。パネルが溢れる場合は `.col-left-scroll` のスクロールで対応。
- **保存ウィンドウ > プレビュー img のデフォルト高さを変更**：CSS デフォルト高さを `120px` から `360px` に変更。

### Added (デバッグ用・後で削除)
- **調査用ログ追加**：プレビュー縮小バグ調査用コンソールログ（`[BT-L1]`〜`[BT-L5]`）。原因特定後に削除予定。

---

## [1.17.3] - 2026-04-05

### Fixed
- **保存ウィンドウ > 起動時プレビュー縮小バグの根本修正**：`setupModalEvents()` 内の IIFE が `await browser.storage.local.get(["leftPanelOrder","leftPanelHeights"])` を実行することで非同期ギャップが発生し、ブラウザがラッパー生成前の状態を初回描画していた問題を修正。`leftPanelOrder`/`leftPanelHeights` を `initModal()` の `Promise.all` に移動し、`setupModalEvents()` の引数として渡すことで IIFE を完全同期化した。あわせて `_panelInitReady` フラグを追加し、初期化完了前のリサイザー mouseup 操作を無効化した。
- **v1.17.1 Fix1・Fix2 をリバート**：根本修正に伴い、暫定対処だった「`<img>` inline style 埋め込み（Fix1）」および「`#preview-resizer` mouseup での `leftPanelHeights["preview"]` 同時保存（Fix2）」を削除した。Fix3（ラッパー高さが img を下回らないガード）は存続。

---

## [1.17.2] - 2026-04-05

### Fixed
- **全般 > エクスポート/インポートで権利者データが欠落する問題を修正**：`globalAuthors`（権利者リスト）・`authorDestinations`（権利者別保存先）・`tagSortOrder`（タグ並び順）の3キーがエクスポート/インポート対象から漏れていた。エクスポートの取得キーに追加し、インポートの復元ブロックを追加した。

---

## [1.17.1] - 2026-04-05

### Fixed
- **保存ウィンドウ > 起動時にプレビューが縮小して見えるバグを修正（原因 A・B）**：
  - 原因 A（タイミング）：HTML 挿入直後の初回描画で CSS デフォルト `height: 120px` が一瞬表示される問題を修正。`buildModalHTML()` に `previewHeight` を渡し、`<img>` 要素に inline style として埋め込むことで HTML 挿入時点から正しい高さを反映するよう変更。
  - 原因 B（高さ不一致）：`#preview-resizer` ドラッグで img を拡大しても `leftPanelHeights["preview"]`（ラッパー高さ）が更新されないため、次回起動時にラッパーが img をクリップしていた問題を修正。`#preview-resizer` mouseup 時に `modalSize.previewHeight` と `leftPanelHeights["preview"]` を同時保存するよう変更。
  - 起動時ガード追加：IIFE でラッパー高さを適用する際、preview パネルは img 高さを下回らないようガード処理を追加。

---

## [1.17.0] - 2026-04-05

### Changed
- **保存履歴 > 「情報を編集」パネルをリアルタイム保存に変更（b1）**：タグ・権利者のチップ追加・削除・パス入力欄のフォーカス離脱のたびに即座に storage へ保存するよう変更。「✔ 保存」ボタンを廃止。

### Added
- **保存履歴 > 「情報を編集」パネルにアンドゥボタン追加（b2）**：「↩ アンドゥ」ボタンを追加。チップ追加・削除・パス変更を 1 操作ずつ取り消し可能。スタックが空のときはボタンが無効化される。

---

## [1.16.5] - 2026-04-05

### Fixed
- **全般 > 差分エクスポートの基準が全エクスポートでリセットされる問題を修正**：全エクスポート実行時にも `lastExportedAt`（差分基準日時）が更新されていたため、次回差分エクスポートが「全エクスポート以降」になっていた。`lastExportedAt` の更新を差分エクスポート完了時のみに限定し、全エクスポートでは更新しないよう修正。

---

## [1.16.4] - 2026-04-05

### Changed
- **全般 > subTags データ補正ボタンを削除**：データ補正完了のため、v1.16.3 で追加した「🔧 subTags データ補正」ボタン・補正関数・関連フラグを削除。
- **全般 > インポート時に subTags フィールドを自動正規化**：旧バックアップから復元する際、エントリに `subTags` フィールドが残存している場合は `tags` に統合してから保存するよう修正。
- **即保存 > デッドコード削除**：v1.12.0 で `csSession` から `subTags` が削除されて以降参照されていなかった `session?.subTags` の参照を background.js から削除。

---

## [1.16.3] - 2026-04-05

### Fixed
- **外部取り込み > サブタグが保存履歴タイルに表示されないバグを修正**：外部取り込みエントリ生成時に `subTags` を `tags` フィールドに統合するよう修正（background.js の通常保存と同じ形式に統一）。

### Changed
- **保存履歴 > 編集パネルのサブタグ分離保存を廃止**：編集パネルで追加・削除したタグはすべて `tags` に統合して保存。`subTags` フィールドへの書き込みを廃止。
- **保存履歴 > タグ絞り込み・globalTags 更新の workaround コード削除**：`entry.subTags` フィールドを別結合する workaround を削除し、`entry.tags` のみ参照するよう整理。

### Added
- **全般 > subTags データ補正ボタン追加**：バックアップセクションに「🔧 subTags データ補正」ボタンを追加。過去の外部取り込みエントリに残存している `subTags` フィールドを `tags` に統合して修正可能。

---

## [1.16.2] - 2026-04-05

### Fixed
- **外部取り込み > 「BorgesTag 最古保存日」ヒントに外部取り込みエントリが混入するバグを修正**：外部取り込み後に外部取り込みエントリの日付が最古として表示されてしまう問題を修正。`source: "external_import"` のエントリを除外し、通常保存のみで最古日を算出するよう変更。

---

## [1.16.1] - 2026-04-05

### Fixed
- **保存ウィンドウ > プレビュー高さ上限が実際には撤廃されていなかったバグを修正**：CSS の `.preview` に `max-height: 400px` が残存しており、ドラッグリサイズが 400px で止まっていた問題を修正。`max-height` を削除し上限なしにリサイズ可能に。

---

## [1.16.0] - 2026-04-04

### Added
- **外部取り込み > インポート中断ボタン追加**：サムネイル生成中に「🛑 中断」ボタンを表示し、クリックでインポートをキャンセル可能に。中断時は `saveHistory` への書き込みを行わない。
- **外部取り込み > インポート取り消しボタン追加**：インポート完了後に「↩ 取り消し」ボタンを表示。クリックで今回インポートしたエントリとサムネイルを `saveHistory` / IDB から削除して取り消し可能。

### Changed
- **外部取り込み > `savePath` → `savePaths` 形式に統一**：インポートエントリのパスフィールドを通常保存と同じ配列形式（`savePaths: [path]`）に変更。重複チェックも両形式に対応。
- **保存履歴 > 編集パネルのタグ編集でサブタグも表示・編集可能に**：タグ編集パネルにサブタグも一覧表示し、追加・削除が可能に。保存時はタグとサブタグを分離して保持。
- **保存履歴 > 「🔄 タグ・保存先反映」ボタンの機能を拡張**：選択エントリのメインタグを `tagDestinations`（タグ別保存先）にも反映するよう変更。サブタグは保存先に関連付けない。
- **外部取り込み > インポート時に `tagDestinations` を自動更新**：インポート完了時、メインタグと保存先の対応を `tagDestinations` に自動追記。

---

## [1.15.9] - 2026-04-04

### Added
- **保存履歴 > 取り込み元フィルター追加**：フィルターバーに「取り込み元: すべて / 外部取り込みのみ / 通常保存のみ」セレクトを追加。外部取り込みエントリのみ絞り込み可能。絞り込み状態では「全選択」ボタンも有効になる。
- **保存履歴 > 外部取り込みバッジ表示**：`source: "external_import"` のエントリのカードに 📥 バッジを表示。
- **保存履歴 > 「🔄 タグ反映」ボタン追加**：選択中のエントリのタグ・サブタグのうち、グローバルタグ未登録のものを `globalTags` に追加するボタンを追加。外部取り込みで絞り込み → 全選択 → タグ反映 の操作で一括反映が可能。

---

## [1.15.8] - 2026-04-04

### Fixed
- **外部取り込み > インポートしたタグ・サブタグ・権利者が「タグ・保存先」タブに反映されないバグを修正**：`executeExternalImport` が `saveHistory` のみ更新し `globalTags` / `globalAuthors` を更新していなかった問題を修正。インポート完了時に全エントリのタグ・サブタグ・権利者を `globalTags` / `globalAuthors` へ追記するよう変更。

---

## [1.15.7] - 2026-04-04

### Fixed
- **外部取り込み > タグチップのドロップが機能しないバグを修正**：空のコンテナで高さゼロになりドロップ先がなかった問題・`draggable` な子チップがドロップを妨害していた問題を修正。チップコンテナに最小高さを設定し、ドラッグ中は同行の全チップの `pointer-events` を無効化することで解消。

---

## [1.15.6] - 2026-04-04

### Changed
- **外部取り込み > 誤解を招く説明文を削除**：タグ設定テーブル上部の「子フォルダには親フォルダのタグも引き継がれます。」という記述を削除。

### Added
- **外部取り込み > タグチップをドラッグ&ドロップで種別移動可能に**：フォルダ行内のチップ（メイン/サブ/権利者）をドラッグして別の種別のコンテナへドロップすることで移動できるよう追加。例: メインタグの「ロクエさん」を権利者欄にドロップして移動。

---

## [1.15.5] - 2026-04-04

### Fixed
- **設定画面 > タブ選択時にはみ出したままになる問題を修正**：スクロールで隠れているタブをクリックした際、選択タブが表示領域に収まるようスクロールするよう修正（`scrollIntoView`）。

---

## [1.15.4] - 2026-04-04

### Changed
- **保存ウィンドウ > プレビューエリアの高さ上限を撤廃**：従来は 400px までしか拡張できなかったが、上限なしにドラッグでリサイズ可能に変更。

---

## [1.15.3] - 2026-04-04

### Fixed
- **設定画面 > タブバーが溢れて見栄えが悪い問題を修正**：タブバーを横スクロール可能に変更（スクロールバー非表示）。左右にタブが隠れている場合はグラデーション＋矢印インジケーターで方向を表示。

---

## [1.15.2] - 2026-04-04

### Changed
- **外部取り込み > タグ設定UIをフォルダ別構成に変更（a1）**：スキャン結果のフォルダ一覧をテーブルで表示し、各フォルダ行でメインタグ・サブタグ・権利者を個別に設定できるように変更。初期チップは絶対パスから除外ワードをフィルタしたトークン（例: `ero` フォルダ → `ミスズ`・`ero`）。各チップは ✕ で個別削除可能。
- **外部取り込み > トークン抽出を絶対パスベースに修正**：スキャンルート相対パスから絶対パス（除外ワードフィルタ適用）に差し戻し。除外ワード設定で不要な親フォルダ名を除外する従来の運用に戻す。

### Added
- **外部取り込み > サブタグ・権利者をフォルダ別に指定可能に（b）**：各フォルダ行にサブタグ・権利者の入力欄を追加（メイン/サブ/権利者の3段構成）。グローバル手動追加欄（全エントリ共通）も引き続き使用可能。

---

## [1.15.1] - 2026-04-04

### Fixed
- **外部取り込み > サムネイル生成バッチの Native 切断エラーを修正**：`GENERATE_THUMBS_BATCH` を 10件バッチから 1件ずつの呼び出しに変更し、Native Messaging 1MB 上限によるクラッシュを回避。サムネイル品質は MAX=600/quality=85（通常保存と同一）を維持
- **外部取り込み > インポートエントリの挿入順序を修正**：従来は先頭に一括追加していたが、各エントリの `savedAt`（ファイル更新日時）に基づいて保存履歴の時系列上の正しい位置に挿入するよう変更

---

## [1.15.0] - 2026-04-04

### Added
- **外部取り込み機能（設定画面 > 外部取り込みタブ）**：BorgesTag 導入以前に手動保存した画像を saveHistory にインポートする機能を追加
  - フォルダまたは単一ファイルパスを指定して再帰スキャン（シンボリックリンクループ防止付き）
  - 基準日時（ファイルの更新日時が指定日時より古いもののみ対象）でフィルタリング
  - フォルダパスからトークンを自動抽出。保存済み除外ワードと実行時のみ除外ワードの2種類を設定可能（全角半角・大文字小文字を無視して照合）
  - 抽出トークンを「メイン / サブ / 除外」に分類。既存タグと部分一致するトークンは「メイン」を初期候補として表示
  - メインタグ・権利者の手動追加（パスに含まれない文字列も可）。権利者入力欄に既存 globalAuthors からのサジェスト表示
  - サムネイル生成（Pillow）を選択可能。10件ずつバッチ処理して進捗表示
  - インポート済みエントリに `source: "external_import"` フィールドを付与
  - インポート実行中のタブ離脱に対して `beforeunload` 警告を表示
  - 新規ストレージキー: `extImportExcludes`（保存済み除外ワード）、`extImportCutoffDate`（最後に使用した基準日時）
- **`SCAN_EXTERNAL_IMAGES` ネイティブコマンド追加**（`native/image_saver.py`）
- **`GENERATE_THUMBS_BATCH` ネイティブコマンド追加**（`native/image_saver.py`）

---

## [1.14.0] - 2026-04-04

### Added
- **引き継ぎリセットボタン（b1）**：保存ウィンドウの引き継ぎチェックボックス右側に「↺」ボタンを追加。クリックすると引き継ぎチェック（タグ/サブタグ/権利者）を全てOFFにし、現在の入力フォームとストレージの保存済み引き継ぎ値（`retainedTags`/`retainedSubTags`/`retainedAuthors`）をクリアする

### Fixed
- **新規タブで保存ボタンが即時表示されない問題を修正（a1）**：タブを開いた直後にカーソルが既に画像上にある場合、`mouseover` が発火しないため保存ボタンが表示されなかった。コンテンツスクリプトの初回 `mousemove` 時にカーソル下の要素を検出して `mouseover` をエミュレートすることで、最初の微小なマウス移動でボタンが表示されるよう修正

---

## [1.13.0] - 2026-04-04

### Added
- **サブタグ入力欄のバックスペース削除（f1）**：入力が空の状態でバックスペースキーを押すと末尾のサブタグを削除できるよう追加。タグ入力欄と同仕様

### Changed
- **権利者入力欄を常時表示に変更（d1）**：権利者入力欄を `フォルダを選ぶ` モード専用エリアから移動し、タグ入力欄の上（`panel-dest` 先頭）に配置。「候補から選ぶ」「フォルダを選ぶ」いずれのモードでも常に表示される。中央寄せ表示
- **絞り込み中のライトボックスナビゲーションを絞り込み結果内に限定（a2）**：保存履歴タブで絞り込みを行った状態でプレビューの上下ナビゲーションを使うと、絞り込み結果の範囲内のみを移動するよう変更。ラベルも「全体」から「絞り込み結果」に変化する

### Fixed
- **プレビューリサイズがリセットされる問題を修正（c）**：`setModalSize()` がウィンドウリサイズのたびに `modalSize` オブジェクト全体を上書きするため `previewHeight` が消えていた。読み書き方式（スプレッド構文で既存フィールドを保持）に変更
- **保存ウィンドウのタブフォーカスを修正（b）**：既存の保存ウィンドウが開いている状態で同一ウィンドウ内の別タブから呼び出した際、モーダルタブを `active` にしてからウィンドウフォーカスを移すよう変更

---

## [1.12.3] - 2026-04-04

### Fixed
- **Fanbox フォールバックが発動しないバグを修正**：Python の `urllib.error.HTTPError` は `URLError` のサブクラスのため、従来は `except URLError` でまとめて捕捉され `e.reason` が `"Forbidden"`（数字なし）になっていた。`HTTPError` を先に個別キャッチして `"HTTP {code} {reason}"` 形式に変更し、background.js 側の検出条件（`.includes("403")`）と一致するよう修正。background.js 側にも `"Forbidden"` 文字列での検出を追加（保険）

---

## [1.12.2] - 2026-04-04

### Fixed
- **Fanbox 画像の 403 Forbidden エラーを修正**：Python ネイティブの `urllib.request` では認証 Cookie を送れないため Fanbox CDN（`downloads.fanbox.cc`）が 403 を返す問題に対応。`SAVE_IMAGE` が 403 エラーになった場合、ブラウザの Cookie を利用できる XHR（`fetchImageAsDataUrl`）で画像データを取得し、新設した `SAVE_IMAGE_BASE64` コマンドで保存するフォールバックを追加。403 以外のエラー（404 等）ではフォールバックしない
- `getRefererForUrl()` に `downloads.fanbox.cc` → `https://www.fanbox.cc/` のマッピングを追加

---

## [1.12.1] - 2026-04-03

### Fixed
- **引き継ぎチェックボックスが通常保存時に機能しないバグを修正**：保存成功時に `retainedTags/SubTags/Authors` を `storage.local` に保存し、次回モーダル起動時に各引き継ぎフラグがONなら初期値として復元するように変更。連続保存モード・保存後最小化モード以外の通常保存（モーダルを閉じて再起動）でも引き継ぎ設定が機能するようになった

---

## [1.12.0] - 2026-04-03

### Added
- **引き継ぎチェックボックス（a1）**：保存ウィンドウのヘッダーに「引き継ぎ: タグ / サブタグ / 権利者」チェックボックスを追加。各項目を個別にON/OFFで保持設定可能。設定は `storage.local` に保存され再起動後も維持される。連続保存モード・保存後最小化モードの両方に適用

### Changed
- **連続保存モードのタグ/サブタグ/権利者引き継ぎを廃止（a2）**：従来 `csSession` に格納していた `tags` / `subTags` を削除。引き継ぎ制御は a1 のチェックボックス設定に委ねる。`applyContinuousState()` のタグ・サブタグ復元処理を削除。`updateContinuousSession()` のシグネチャを `(usedSavePaths, usedSelectedPath)` に変更
- `_meta.version` を `1.12.0` に更新

### Fixed
- **連続保存モードで権利者情報が引き継がれないバグを修正**：`stayOpenForContinuous()` に権利者リセット処理を追加（引き継ぎOFF時のみクリア）

---

## [1.11.0] - 2026-03-30

### Added
- **エクスポート進捗表示（a2）**：エクスポートボタン押下時にステップ別の進捗ログを逐次表示（設定データ取得・サムネイル取得・JSON生成・ファイル書き込み・完了）
- **差分エクスポート機能（b）**：「差分エクスポートモード」チェックボックスを全般タブのバックアップセクションに追加。前回エクスポート以降の新規 saveHistory エントリとそれに紐付くサムネイルのみをエクスポート対象にする。エクスポート成功時に `lastExportedAt` を自動更新。差分0件時は処理を中断して通知する

### Changed
- `exportData()` を進捗表示対応にリファクタリング。差分エクスポート時のファイル名プレフィックスを `image-saver-diff-` に変更
- `_meta.version` を `1.11.0` に更新

---

## [1.10.0] - 2026-03-30

### Added
- **ファイル名設定（設定画面 > 全般）**：保存時のファイル名にタグ・サブタグ・権利者名を付加するオプションを追加。各項目はチェックボックスで個別にON/OFF可能。付加した値は `-`（ハイフン）で区切られ、ファイル名に使用できない文字（`\ / : * ? " < > |`）は自動除去される
- `buildFilenameWithMeta` ヘルパー関数を追加（background.js）
- ファイル名設定（`filenameIncludeTag` / `filenameIncludeSubtag` / `filenameIncludeAuthor`）をエクスポート・インポート対象に追加

---

## [1.6.2] - 2026-03-26

### Changed
- manifest.json の調整・最終ビルド

---

## [1.5.x] - 2026

### Added
- **ホバー保存ボタン（v1.5.22）**：画像ホバーで 💾 ボタンを表示。`mousemove` 座標ポーリング方式でオーバーレイ競合を解消
- **サブタグ機能（v1.5.30 系）**：保存先関連付けを除いてタグと同じ管理の補助タグ入力欄を追加。直近サブタグ専用サジェストを実装
- **即保存ボタン（v1.5.49）**：ホバーボタンに ⚡ 即保存ボタンを追加。保存ウィンドウを開かずに即時保存。連続保存モード中はタグ・サブタグを引き継ぎ
- **保存後最小化設定（v1.5.56）**：連続保存モード以外でも保存後にウィンドウを最小化して待機できる設定を追加
- **保存先候補の追加/解除切り替え（v1.5.56）**：全タグ登録済み時にボタンが「解除」に切り替わる
- フォルダ絞り込み入力欄をエクスプローラーのソートプルダウン横に追加（フォルダ遷移後に自動クリア）
- 設定画面保存履歴：タグ削除・全選択ボタン（絞り込み中のみ活性）・グループ個別解除を追加

### Changed
- **Windows エクスプローラー互換ソート（v1.5.55）**：`StrCmpLogicalW` によるフォルダ並び順を native 側で実装。JS 側の二重ソートを廃止

---

## [1.4.x]

### Added
- **連続保存モード（v1.4.0）**：保存後もウィンドウをバックグラウンドに残して次の保存に素早く対応。タグ・保存先を引き継ぎ
- **グループ表示（v1.4.0）**：連続保存した画像を 1 タイルにまとめて表示。展開ボタンで個別閲覧
- **プレビュー強化（v1.4.x）**：グループ内ナビゲーション（◀▶）と全体履歴ナビゲーション（▲▼）を搭載
- 保存履歴の 100 件制限を撤廃（上限なし）
- サムネイル生成機能（選択した保存済み画像からサムネイルを再生成）
- タグ追加（個別・一括）・グループ化・選択解除ボタンを追加
- バージョン表示を動的取得に変更

---

## [1.3.14]

### Added
- 設定画面タグ並び順（6 種）
- エクスプローラーで開くボタン
- 保存履歴に「保存した画像を開く」追加
- ブックマーク解除対応
- タグ入力 Enter 空押しで絞り込み実行
- フォルダ関連タグをフォーカス時にサジェスト表示
- SNS 連携タブ（後日実装）

---

## [1.3.12]

### Added
- 「候補から選ぶ」モードで保存した際のタグ→保存先自動紐付けをスキップする機能

### Fixed
- pixiv プレビュー非表示：Python `FETCH_PREVIEW` コマンドで根本解決

---

## [1.3.9]

### Fixed
- `SAVE_IMAGE` 成功時に Python+Pillow でリサイズ済みサムネイルを Base64 で返すよう変更
- Native Messaging 4MB 上限超過によるクラッシュを解消

### Changed
- `install.bat` に Pillow 自動インストールを追加

---

## [1.3.6 - 1.3.8]

### Added
- 設定画面保存履歴にライトボックス拡大表示・期間指定削除を追加
- タグ候補追加の複数選択ダイアログ

### Fixed
- `ShadowRoot` 判定の修正
- ZIP 構造・ファイル命名（ドット区切り）・`__pycache__` 除外を修正
- トーストを画面中央に変更

---

## [1.3.x]

### Changed
- 保存 UI を Shadow DOM モーダルから `browser.windows.create()` による独立ポップアップに移行

### Added
- 保存履歴タグ絞り込み
- 設定画面バックアップタブ
- 表示倍率タイトルバー表示
- エクスポート即出力
- Native `WRITE_FILE` コマンド
- トーストキュー方式

---

## [1.2.x]

### Added
- ブックマーク機能
- 直近に使用したタグ
- フォルダ移動履歴（◀▶）
- 保存履歴タイル
- 動作ログ
- サムネイルキャッシュ（IndexedDB）

---

## [1.0.0]

### Added
- 初版リリース
- 右クリック保存
- タグ入力（Enter / Tab・オートコンプリート）
- タグ別保存先候補
- フォルダエクスプローラー（3 表示形式）
- Native Messaging 基盤
