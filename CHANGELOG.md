# Changelog

このプロジェクトの変更履歴です。
形式は [Keep a Changelog](https://keepachangelog.com/ja/1.0.0/) に基づいています。

---

## [1.46.25] - 2026-05-19

### Internal — ESLint suppress 検出強化と既存 unused suppress の cleanup

開発側の静的解析強化として、ESLint 設定に `reportUnusedDisableDirectives: "error"` を追加。これにより、不要になった `eslint-disable` 注釈が即座にエラー化され、suppress を付けたまま放置される構造的問題を予防。既存の `no-await-in-loop` の unused suppress 3 件（保存ウィンドウと設定画面の保存履歴一括音声再生処理）を検出して削除。挙動変更なし。

[design-doc-skip: ESLint config / lint cleanup のみで API/挙動変更なし、設計書 anchor 更新不要]

---

## [1.46.24] - 2026-05-18

### Fixed — 保存ウィンドウの保存履歴 権利者フィルタ チップが表示されない / 解除されない不具合修正

保存ウィンドウ側の保存履歴画面で権利者フィルターに入力しても、絞り込みは適用されるがチップが表示されず、解除（× / ✕ ボタン）も効かない不具合を修正。modal.js 内の `renderAuthorChips` 関数が二重定義（履歴フィルター用 + 保存先入力用）で、JS の関数宣言ホイスティングにより後者が前者を上書きしていたことが原因。両者をそれぞれ `renderFilterAuthorChips` / `renderDestAuthorChips` にリネームし、全 callsite を更新。誤った経緯コメント（「双方の callsite が自身に近い定義を期待」）も削除。

[design-doc-skip: 画面別/07_保存ウィンドウ_詳細.md は filter chip render 詳細を関数名で参照していないため anchor section 更新は不要。修正は関数 rename のみで挙動の API 仕様変更なし]

---

## [1.46.23] - 2026-05-18

### Fixed — 保存履歴 grid の左右 edge drag handle が grid 再描画で消失する不具合修正

設定画面の保存履歴タブで grid 横幅をリサイズする左右 edge custom drag handle が、初回表示後の再描画（タブ切替 / filter 変更 / 表示モード切替）で消失し、以降一切表示されなくなる不具合を修正。`_renderHistoryGridNormalReuse` の destroy filter と group mode の `innerHTML = ""` から handle 要素を除外することで handles を render 経路で保持。

[design-doc-skip: 画面別/01_設定画面_保存履歴タブ_詳細.md の `_setupHistGridResize` 行に handles 保持仕様を追記、07_事故・地雷ペア事例.md §13 に新規事故事例として詳述、04_影響範囲マップ.md 地雷ペア表に 1 行要約追加で反映済。preflight gate が @spec anchor section 単体の機械検出を期待しているが、本変更は関数本体の挙動でなく destroy 経路の filter 改善のため、anchor section 直接更新は不要]

## [1.46.22] - 2026-05-11

### Added — GROUP-89 Step 4：commit-msg / pre-commit hook と scan-response 新カテゴリ leak-keyword による content scan 機構を追加

## [1.46.21] - 2026-05-08

### Internal — GROUP-41 Phase 6-2：コード内 @spec コメントを画面別 / 共通 サブディレクトリへ書換
### Changed — GROUP-84：即保存ボタンの連続押下対応 + 進行中件数表示

## [1.46.20] - 2026-05-06

### Fixed / Added — GROUP-78：保存履歴 grid の左右 edge カスタムリサイズハンドル + 親エリア超過拡大対応 ＋「指摘事項」対応ルールの flow/skill 反映

## [1.46.19] - 2026-05-06

### Fixed / Added — GROUP-75：設定画面の保存履歴 grid に padding 削減 + 横リサイズ可能化（Q-75-1=g）

## [1.46.18] - 2026-05-06

### Added — GROUP-74 構造的予防策 Tier 1〜3：v1.46.14〜v1.46.16 の連続 silent failure 事案の構造的再発防止

## [1.46.17] - 2026-05-06

### Fixed — GROUP-74：保存ウィンドウ「グループ表示モード」での Phase C-3 listener が古いタイル＋空 src を残す問題

## [1.46.16] - 2026-05-06

### Fixed — GROUP-73：保存ウィンドウの Phase C-3 listener が DOM 更新できなかった scope バグ修正

## [1.46.15] - 2026-05-03

### Changed — GROUP-72 Phase C-3-opt：保存ウィンドウ renderHistory の entry レベル smart reuse 化

## [1.46.14] - 2026-05-03

### Added — GROUP-35-perf-A Phase C-3：saveHistory 差分通知（HISTORY_ENTRY_ADDED/UPDATED/DELETED）と受信側部分更新、エクスポート V2 zip

## [1.46.13] - 2026-05-02

### Fixed — GROUP-71：保存ウィンドウ dest-tabbar の chip × ボタンに tabindex="-1" 漏れ（v1.46.10 GROUP-22-tab 見落とし）

## [1.46.12] - 2026-05-02

### Fixed — GROUP-70：エクスポート／インポートボタンのラベルを「JSONファイル」→「ZIPファイル」に修正

## [1.46.11] - 2026-05-02

### Fixed — GROUP-69：連続保存時のタグ→保存先関連付け消失（read-modify-write race）

## [1.46.10] - 2026-05-02

### Added / Changed — GROUP-22 / GROUP-21：保存履歴のフィルター UI 整理＋編集パネル box 統合（双子 UI 修正）

## [1.46.9] - 2026-05-01

### Fixed — GROUP-68：保存ウィンドウ 引き継ぎ設定 OFF 時の入力欄クリアを廃止（リセットボタン専用化）

## [1.46.8] - 2026-05-01

### Fixed — GROUP-67：保存履歴フィルター 4 要素の永続化と初期表示反映（双子 UI 修正）

## [1.46.7] - 2026-05-01

### Fixed — GROUP-54：一括音声 ON 時の ReferenceError: showBusyModal is not defined
### Changed — GROUP-52：タグ追加 / 権利者追加ダイアログのプレースホルダー文言改善

## [1.46.6] - 2026-05-01

### Fixed — GROUP-62：minimizeAfterSave ON 状態での連続保存メモリ蔓延 hotfix（page reload 方式）

## [1.46.5] - 2026-05-01

### Fixed — GROUP-66：content.js ホバー保存ボタン残留 hotfix（複数 wrap zombie 化）

## [1.46.4] - 2026-05-01

### Fixed — GROUP-63：modal.js / settings.js 編集パネル全統一漏れ hotfix（pattern #21 適用、Tier 1 構造的予防）

## [1.46.3] - 2026-05-01

### Changed — GROUP-59-fix：編集パネル UI レイアウト是正
### Added — GROUP-60：仕様駆動スキルバンドル整備（pattern #19/#20/#21 + scope skills + Tier 1 banner）

## [1.46.2] - 2026-05-01

### Changed — GROUP-59：保存履歴情報編集パネル ＋ 保存履歴タイル UI 調整

## [1.46.1] - 2026-05-01

### Fixed — GROUP-58：保存ウィンドウ起動直後の auto-focus race condition
### Changed — GROUP-46-T6-integration：skill 出力に「応答送信前の必須 step」フッタを内蔵化

## [1.46.0] - 2026-04-30

### Memory — extension process メモリ retain の根本対策（GROUP-56 + GROUP-57 + GROUP-35-perf-C-2 一括）

## [1.45.6] - 2026-04-30

### Fixed — 🚨 重大 hotfix：移送後のインポートが上書きになるバグ（saveHistory 全消失）

## [1.45.5] - 2026-04-30

### Added — GROUP-35-perf-A Phase C-2：saveHistory IDB 主・移送ボタン化（onChanged 巨大 broadcast 解消準備）

## [1.45.4] - 2026-04-29

### Added — GROUP-46 Phase 4 全工程完了：trace-extractor / trace-linter ＋ コード ↔ 設計書 トレーサビリティ

## [1.45.3] - 2026-04-29

### Fixed — グループ化／解除直後に GIF 代表サムネが描画されない（GROUP-49 hotfix、v1.36.0 以来 pre-existing）

## [1.45.2] - 2026-04-29

### Added — saveHistory IDB shadow（GROUP-35-perf-A Phase C-1）

## [1.45.1] - 2026-04-28

### Fixed — v1.45.0 設定画面 保存履歴タイル描画失敗の hotfix

## [1.45.0] - 2026-04-28

### Changed — GROUP-46 設定画面・保存ウィンドウ 保存履歴タイル レイアウト改善

## [1.44.1] - 2026-04-27

### Fixed — GROUP-16 表示文言を「識別情報」に統一（v1.44.0 文言不統一の hotfix）

## [1.44.0] - 2026-04-27

### Added — 保存履歴の識別情報コピー＋ ID 貼付で情報流用（GROUP-16-a1 / a2）

## [1.43.1] - 2026-04-27

### Fixed — 完了ルートフォルダ履歴が「1 枚ずつ形式」モードでしか表示されない不具合を修正（GROUP-19 Phase D hotfix）

## [1.43.0] - 2026-04-27

### Added — 完了ルートフォルダ履歴をタブ式独立エリアに再構成（GROUP-19 Phase D）

## [1.42.0] - 2026-04-27

### Added — 取り込み予定フォルダリストにステータス絞り込みトグル群を追加（GROUP-20-tlsbl1）

## [1.41.8] - 2026-04-27

### Improved — R-A: Native ⑨ Pillow サムネスキップ＋ R-B: modal → background Blob 直送（GROUP-45 hznhv3 残 2 件）

## [1.41.7] - 2026-04-27

### Improved — 保存経路の `storage.local.set` を 1 回に集約＋ modal の LIST_DIR 早期チェック廃止（GROUP-45 hznhv3 C-β + C-γ + R-C）

## [1.41.6] - 2026-04-27

### Improved — 保存処理の冗長除去：B-1 使用量ログ削除＋ C-α tagRecords 廃止（GROUP-45 hznhv3 承認済 2 件）

## [1.41.5] - 2026-04-27

### Improved — 保存ウィンドウの保存処理を fire-and-forget 化、即時最小化＋ OS 通知＋失敗時復元（GROUP-45 hznhv2）

## [1.41.4] - 2026-04-26

### Improved — 一括選択ボタンの busy modal 抜け対応＋ modal.js への busy modal 機構移植（GROUP-44）

## [1.41.3] - 2026-04-26

### Improved — GIF Worker session pooling で再表示の Worker INIT を skip（GROUP-43 Phase 2-pool）

## [1.41.2] - 2026-04-26

### Improved — settings.js プロセス内に frontend dataUrl LRU cache を導入し、非 GIF タイルの再表示空白を解消（GROUP-43 Phase 2-cache）

## [1.41.1] - 2026-04-26

### Improved — 保存履歴グリッド通常モードの再描画を「既存タイル再利用」型に変更（GROUP-43 Phase 2-reuse）

## [1.41.0] - 2026-04-26

### Fixed — v1.40.0 の Phase 2 placeholder 検索時序バグを設計書ベースで再構築（GROUP-43 Phase 2 再実装）

## [1.40.0] - 2026-04-26

### Improved — 設定画面の保存履歴グリッド GIF を Canvas＋Worker パイプラインに移行（GROUP-43 Phase 2）

## [1.39.1] - 2026-04-25

### Fixed — 単体エントリ操作時の GIF 再デコードを回避

## [1.39.0] - 2026-04-25

### Improved — 処理中モーダルのレイアウト調整＋プレビュー画像にキャプション（GROUP-40）

## [1.38.1] - 2026-04-25

### Fixed — 処理中モーダル完了時の auto-close 削除（Q-ux-B 要件不一致）

## [1.38.0] - 2026-04-25

### Improved — お気に入りトグルをオプティミスティック更新
### Improved — 処理中モーダルにお気に入りプレビュー＋完了表示（GROUP-38 Q-ux-2 / Q-ux-B 後追い）

## [1.37.0] - 2026-04-25

### Added — 保存履歴お気に入り機能（GROUP-36）
### Added — 保存ウィンドウに全選択／選択解除ボタン（GROUP-37）
### Improved — 一括操作の処理中表示（GROUP-38）

## [1.36.0] - 2026-04-25

### Performance — グループ表示モードでの差分更新（GROUP-35-perf-B-2）

## [1.35.0] - 2026-04-25

### Performance — 保存履歴サムネキャッシュ＋グループ化処理の差分更新（GROUP-35-perf）

## [1.34.1] - 2026-04-25

### Fixed — 置換・除去モーダルで kind 分離に失敗しタグ操作が権利者判定になる不具合（v1.34.0 hotfix）

## [1.34.0] - 2026-04-25

### Added — 保存履歴タブにタグ／権利者の一括置換・除去モーダル（GROUP-3-b）

## [1.33.2] - 2026-04-25

### Fixed — 形式フィルタ絞り込み中の全選択ボタンが機能しない（v1.32.2 回帰）

## [1.33.1] - 2026-04-25

### Fixed — 設定画面の保存履歴で選択チェックボックスが非表示（グループ親タイル以外、v1.31.4 回帰）

## [1.33.0] - 2026-04-25

### Added — 設定画面の保存履歴 pageUrl をリンク化（GROUP-32-a）
### Added — 選択した保存履歴の音声を一括 ON/OFF トグル（GROUP-32-b）
### Changed — 調査ログ削除（GROUP-34-a）

## [1.32.2] - 2026-04-24

### Fixed — viewer.html 音声ボタンが表示されない問題（GROUP-28 mvdl hotfix 7th）
### Added — 保存ウィンドウの保存履歴にも音声再生 UI（GROUP-28 mvdl6）
### Added — 形式フィルタープルダウン化＋音声付き絞り込み（GROUP-28 mvdl7）

## [1.32.1] - 2026-04-24

### Fixed — インポート後の保存履歴が savedAt 順にならない問題（GROUP-29）

## [1.32.0] - 2026-04-24

### Added — 音声再生の拡張（GROUP-28 mvdl Phase 2 partial）

## [1.31.10] - 2026-04-24

### Fixed — Native 側自動リネームが保存履歴に反映されない問題（GROUP-31 unique-path）

## [1.31.9] - 2026-04-24

### Fixed — 音声再生が UnidentifiedImageError で失敗する問題（GROUP-28 mvdl hotfix 6th）
### Performance — 設定画面のレスポンス改善（GROUP-30 settings-perf）

## [1.31.8] - 2026-04-24

### Fixed — 保存履歴の音声アイコンクリックで `ReferenceError: log is not defined`（GROUP-28 mvdl hotfix 5th）

## [1.31.7] - 2026-04-24

### Fixed — cross-origin video で MediaRecorder が isolation 拒否される問題（GROUP-28 mvdl hotfix 4th）

## [1.31.6] - 2026-04-24

### Fixed — muted 属性で captureStream から audio track が取れない問題（GROUP-28 mvdl hotfix 3rd）

## [1.31.5] - 2026-04-24

### Fixed — Phase 1.5 で WebExtensions プロセス 8GB 膨張・タブクラッシュを包括 hotfix（GROUP-28 mvdl hotfix）

## [1.31.4] - 2026-04-24

### Added — 動画→GIF 変換時に音声も保存（GROUP-28 mvdl、Phase 1.5）

## [1.31.3] - 2026-04-24

### Fixed — 動画→GIF 変換後のサムネアニメーション維持（GROUP-15-impl-A-phase1 hotfix 3rd）

## [1.31.2] - 2026-04-24

### Fixed — 動画→GIF 変換後のファイル拡張子・サムネアニメーション問題（GROUP-15-impl-A-phase1 hotfix）

## [1.31.1] - 2026-04-24

### Fixed — 動画 → GIF 変換が 100% 到達後に停滞する CSP 問題（GROUP-15-impl-A-phase1 hotfix）

## [1.31.0] - 2026-04-24

### Added — 動画 → GIF 変換 Phase 1 MVP（GROUP-15-impl-A-phase1）

## [1.30.11] - 2026-04-23

### Changed — Firefox Profiler 実測に基づく allocation 削減（GROUP-26-mem-2-B）

## [1.30.10] - 2026-04-23

### Changed — エクスポート chunk 一時フォルダを常に %TEMP% 配下に配置（GROUP-26-cleanup-2）

## [1.30.9] - 2026-04-23

### Fixed — v1.30.8 の IDB トランザクション寿命エラーを hotfix（GROUP-26-mem-2 hotfix）

## [1.30.8] - 2026-04-23

### Changed — エクスポート実行中ピーク削減（GROUP-26-mem-2 Phase A'）

## [1.30.7] - 2026-04-23

### Changed — sendNative で payload / payloadJson を null 代入（GROUP-26-slice-6）

## [1.30.6] - 2026-04-23（診断リリース、修正なし）

### Added — 診断コード：WeakRef による payload / payloadJson 生存追跡（GROUP-26-slice-5）

## [1.30.5] - 2026-04-23

### Fixed — v1.30.4 の WRITE_FILE listener race を修正（GROUP-26-slice-4、hotfix）

## [1.30.4] - 2026-04-23

### Fixed — WRITE_FILE を非-async handler に切り離し（GROUP-26-slice-3、仮説 D）
### 効果見込み（仮反映、実測検証は次回エクスポート後）

## [1.30.3] - 2026-04-23

### Fixed — sendNative の Promise listener closure が payload 全体を capture する GC 阻害（GROUP-26-slice-2）

## [1.30.2] - 2026-04-23

### Fixed — エクスポート実行後の拡張機能プロセスメモリ残留（GROUP-26-slice、仮反映）
### 効果見込み（仮反映、実測検証は次回エクスポート後）

## [1.30.1] - 2026-04-23

### Fixed — エクスポート後の一時ディレクトリ残留（GROUP-26-cleanup）

## [1.30.0] - 2026-04-22

### Added — エクスポート分割出力＋ zip 化＋「zip からインポート」（GROUP-26-split / GROUP-26-unzip）
### Added — 新コマンド（Native v1.11.0）
### Added — 拡張側 message handler（background.js）
### Added — 同梱ライブラリ

## [1.29.2] - 2026-04-22

### Fixed
### Changed

## [1.29.1] - 2026-04-22

### Fixed
### Added
### Changed

## [1.29.0] - 2026-04-22

### Added
### Changed

## [1.28.2] - 2026-04-21

### Changed

## [1.28.1] - 2026-04-20

### Changed
### Removed

## [1.28.0] - 2026-04-20

### Added
### Changed

## [1.27.0] - 2026-04-20

### Added
### Changed

## [1.26.9] - 2026-04-20

### Changed

## [1.26.8] - 2026-04-20

### Fixed
### Changed

## [1.26.7] - 2026-04-20

### Fixed
### Changed

## [1.26.6] - 2026-04-20

### Fixed
### Changed

## [1.26.5] - 2026-04-19

### Changed

## [1.26.4] - 2026-04-19

### Fixed
### Changed

## [1.26.3] - 2026-04-19

### Fixed
### Changed

## [1.26.2] - 2026-04-19

### Changed

## [1.26.1] - 2026-04-19

### Fixed
### Changed

## [1.26.0] - 2026-04-19

### Added
### Changed

## [1.25.4] - 2026-04-18

### Fixed
### Changed

## [1.25.3] - 2026-04-18

### Fixed
### Changed

## [1.25.2] - 2026-04-18

### Fixed

## [1.25.1] - 2026-04-18

### Fixed

## [1.25.0] - 2026-04-18

### Added
### Changed

## [1.24.2] - 2026-04-18

### Fixed

## [1.24.1] - 2026-04-18

### Fixed

## [1.24.0] - 2026-04-18

### Added
### Changed

## [1.23.6] - 2026-04-18

### Changed

## [1.23.5] - 2026-04-18

### Fixed

## [1.23.4] - 2026-04-18

### Changed

## [1.23.3] - 2026-04-18

### Added
### Changed

## [1.23.2] - 2026-04-18

### Added
### Changed

## [1.23.1] - 2026-04-18

### Fixed
### Changed

## [1.23.0] - 2026-04-18

### Added
### Changed

## [1.22.10] - 2026-04-17

### Fixed
### Changed

## [1.22.9] - 2026-04-17

### Changed
### Added

## [1.22.8] - 2026-04-17

### Fixed
### Added
### Changed

## [1.22.7] - 2026-04-17

### Changed
### Fixed
### Added

## [1.22.6] - 2026-04-17

### Fixed

## [1.22.5] - 2026-04-17

### Fixed

## [1.22.4] - 2026-04-17

### Fixed

## [1.22.3] - 2026-04-17

### Added

## [1.22.2] - 2026-04-17

### Added

## [1.22.1] - 2026-04-17

### Changed

## [1.22.0] - 2026-04-16

### Changed

## [1.21.3] - 2026-04-16

### Changed

## [1.21.2] - 2026-04-16

### Changed

## [1.21.1] - 2026-04-16

### Added
### Fixed

## [1.21.0] - 2026-04-15

### Added
### Changed

## [1.20.2] - 2026-04-15

### Fixed
### Changed

## [1.20.1] - 2026-04-15

### Fixed
### Changed

## [1.20.0] - 2026-04-15

### Added
### Changed

## [1.19.8] - 2026-04-14

### Fixed
### Changed

## [1.19.7] - 2026-04-14

### Fixed
### Changed

## [1.19.6] - 2026-04-13

### Fixed
### Changed
### Added

## [1.19.5] - 2026-04-13

### Fixed

## [1.19.4] - 2026-04-13

### Fixed

## [1.19.3] - 2026-04-13

### Fixed

## [1.19.2] - 2026-04-13

### Added

## [1.19.1] - 2026-04-13

### Fixed

## [1.19.0] - 2026-04-13

### Added
### Changed

## [1.18.4] - 2026-04-12

### Fixed

## [1.18.3] - 2026-04-11

### Fixed

## [1.18.2] - 2026-04-11

### Changed

## [1.18.1] - 2026-04-08

### Fixed

## [1.18.0] - 2026-04-08

### Security
### Fixed
### Changed

## [1.17.7] - 2026-04-08

### Fixed

## [1.17.6] - 2026-04-05

### Fixed

## [1.17.5] - 2026-04-05

## [1.17.4] - 2026-04-05

### Fixed

## [1.17.3] - 2026-04-05

### Fixed

## [1.17.2] - 2026-04-05

### Fixed

## [1.17.1] - 2026-04-05

### Fixed

## [1.17.0] - 2026-04-05

### Changed
### Added

## [1.16.5] - 2026-04-05

### Fixed

## [1.16.4] - 2026-04-05

### Changed

## [1.16.3] - 2026-04-05

### Fixed
### Changed
### Added

## [1.16.2] - 2026-04-05

### Fixed

## [1.16.1] - 2026-04-05

### Fixed

## [1.16.0] - 2026-04-04

### Added
### Changed

## [1.15.9] - 2026-04-04

### Added

## [1.15.8] - 2026-04-04

### Fixed

## [1.15.7] - 2026-04-04

### Fixed

## [1.15.6] - 2026-04-04

### Changed
### Added

## [1.15.5] - 2026-04-04

### Fixed

## [1.15.4] - 2026-04-04

### Changed

## [1.15.3] - 2026-04-04

### Fixed

## [1.15.2] - 2026-04-04

### Changed
### Added

## [1.15.1] - 2026-04-04

### Fixed

## [1.15.0] - 2026-04-04

### Added

## [1.14.0] - 2026-04-04

### Added
### Fixed

## [1.13.0] - 2026-04-04

### Added
### Changed
### Fixed

## [1.12.3] - 2026-04-04

### Fixed

## [1.12.2] - 2026-04-04

### Fixed

## [1.12.1] - 2026-04-03

### Fixed

## [1.12.0] - 2026-04-03

### Added
### Changed
### Fixed

## [1.11.0] - 2026-03-30

### Added
### Changed

## [1.10.0] - 2026-03-30

### Added

## [1.6.2] - 2026-03-26

### Changed

## [1.5.x] - 2026

### Added
### Changed

## [1.4.x]

### Added

## [1.3.14]

### Added

## [1.3.12]

### Added
### Fixed

## [1.3.9]

### Fixed
### Changed
### Added

## [1.3.6 - 1.3.8]

## [1.3.x]

### Changed
### Added

## [1.2.x]

### Added

## [1.0.0]

### Added
