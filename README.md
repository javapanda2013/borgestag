# Image Saver with Tags

Firefox 拡張機能 + Windows ネイティブアプリで構成された画像保存ツールです。  
Web ページ上の画像を**タグ付きで任意のフォルダに保存**できます。

![version](https://img.shields.io/badge/version-1.6.2-1abc9c?style=flat-square)
![platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)
![browser](https://img.shields.io/badge/browser-Firefox-orange?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)

---

## 目次

- [概要](#概要)
- [主な機能](#主な機能)
- [動作環境](#動作環境)
- [インストール](#インストール)
- [使い方](#使い方)
- [システム構成](#システム構成)
- [データ構造](#データ構造)
- [既知の制約](#既知の制約)
- [ライセンス](#ライセンス)

---

## 概要

右クリックまたは画像ホバーボタンから保存ウィンドウを起動し、保存先フォルダとタグをワンウィンドウで管理できます。  
ここでいう「タグ」は OS のファイルタグとは別の、この拡張機能独自の管理情報です。保存先フォルダとの関連付けや履歴の絞り込みに使用します。

---

## 主な機能

| 機能 | 説明 |
|------|------|
| 🏷 タグ × フォルダ連携保存 | タグと保存先フォルダを関連付け。次回から同じタグを入力するだけで保存先が自動提案 |
| 🔄 連続保存モード | 保存後もウィンドウを最小化して待機。タグ・保存先を次回に引き継ぎ |
| 💾 ホバー保存ボタン | 画像にマウスを乗せると 💾 保存ボタンと ⚡ 即保存ボタンが表示 |
| ⚡ 即保存ボタン | 保存ウィンドウを開かずにその場で即時保存 |
| 📂 フォルダエクスプローラー | 保存ウィンドウ内でローカルフォルダを直接閲覧・選択（Windows エクスプローラー互換ソート） |
| 🏷 サブタグ | 保存先関連付けを除いてタグと同じ管理の補助タグ。キャラクター名・シリーズ名などの記録に |
| 📋 保存履歴 | 上限なしのサムネイル付きタイル表示。タグ絞り込み・ライトボックス拡大・ファイルを開く対応 |
| 🖼 グループ表示 | 連続保存した画像を 1 タイルにまとめて表示。展開ボタンで個別閲覧 |
| ⭐ ブックマーク | よく使うフォルダをワンクリックで登録・呼び出し |
| 🔄 バックアップ / 復元 | 全設定＋サムネイルを JSON エクスポート。別 PC への移行も簡単 |

---

## 動作環境

| 項目 | 要件 |
|------|------|
| ブラウザ | Mozilla Firefox（最新版推奨） |
| OS | Windows 10 / 11 |
| Python | 3.8 以上（PATH が通っていること） |
| Python ライブラリ | Pillow（`install.bat` で自動インストール） |

---

## インストール

### 1. ファイルの準備

配布 ZIP（`ImageSaverWithTags.x.x.x.zip`）を任意のフォルダに展開します。

```
ImageSaverWithTags/
├── manifest.json
├── icons/
├── src/
│   ├── background/background.js
│   ├── content/content.js
│   ├── modal/modal.html
│   ├── modal/modal.js
│   └── settings/settings.html / settings.js
└── native/
    ├── image_saver.py
    └── install.bat
```

> ⚠️ 展開先フォルダは移動・削除しないでください。ネイティブアプリがこのパスを参照します。

### 2. ネイティブアプリの設定

`native/install.bat` をダブルクリックして実行します。以下が自動実行されます。

- Pillow（画像処理ライブラリ）のインストール
- Windows レジストリへのネイティブメッセージングホストの登録

> `native/image_saver.py` を更新した場合は `install.bat` の再実行が必要です。

### 3. 拡張機能のインストール

1. Firefox のアドレスバーに `about:debugging` と入力
2. 左メニューの **「この Firefox」** をクリック
3. **「一時的なアドオンを読み込む...」** をクリック
4. 展開フォルダ内の **`manifest.json`** を選択

> Firefox を再起動すると拡張機能がリセットされます。再起動後は手順 3〜4 を繰り返してください。  
> データは **エクスポート / インポート** 機能で保持できます。

---

## 使い方

### 画像を保存する

**右クリック保存**：画像を右クリック → 「Image Saver で保存」を選択  
**ホバーボタン保存**：画像にマウスを乗せて 💾 をクリック  
**即保存**：画像にマウスを乗せて ⚡ をクリック（ウィンドウなしで即時保存）

### 連続保存モード

1. 1 枚目を保存する際に「連続保存」チェックを ON
2. 保存後ウィンドウが最小化された状態で待機
3. 次の画像を右クリック or 💾 で起動すると前回設定を引き継ぎ
4. ⚡ 即保存ボタンでウィンドウを開かずに連続保存も可能

### 設定画面を開く

拡張機能アイコンを右クリック → 「拡張機能のオプション」

| タブ | 内容 |
|------|------|
| ⚙️ 全般 | 初期フォルダ・即保存設定・エクスポート / インポート・動作ログ |
| ⭐ ブックマーク | よく使うフォルダの管理 |
| 🏷 タグ・保存先 | タグ別保存先の管理（名前変更・削除） |
| 📋 保存履歴 | 履歴確認・タグ追加 / 削除・グループ操作・サムネイル生成 |

---

## システム構成

Firefox 拡張機能（Manifest V2）と Windows ネイティブアプリ（Python）による 2 層アーキテクチャです。  
ブラウザの制約で OS のファイルシステムへ直接アクセスできないため、Native Messaging を経由して Python プロセスに処理を委譲します。

```
Web Page → content.js → background.js → modal.js ⇄ image_saver.py → Windows FS
```

### Native Messaging コマンド

| コマンド | 用途 |
|----------|------|
| `LIST_DIR` | ドライブ一覧 / ディレクトリ内容取得 |
| `SAVE_IMAGE` | URL からダウンロードして指定パスに保存。Pillow でサムネイルも返却 |
| `MKDIR` | 新規フォルダ作成 |
| `WRITE_FILE` | テキストファイルを指定パスに書き出す |
| `FETCH_PREVIEW` | Referer 付きで画像取得・リサイズして返す（pixiv 等対応） |
| `OPEN_EXPLORER` | エクスプローラーを起動 |
| `OPEN_FILE` | ファイルを関連アプリで開く |
| `READ_FILE_BASE64` | 保存済みファイルを Base64 で読み込む |

---

## データ構造

設定・履歴は `browser.storage.local` に保存されます。サムネイル画像本体は IndexedDB に保存されます。

| キー | 型 | 説明 |
|------|----|------|
| `tagDestinations` | Object | `{"タグ名": [{id, path, label}]}` タグ別保存先マップ |
| `globalTags` | string[] | 全タグ名リスト（オートコンプリート用） |
| `saveHistory` | Array | `[{id, imageUrl, filename, savePaths[], tags[], savedAt, thumbId, sessionId}]` 保存履歴 |
| `folderBookmarks` | Array | ブックマーク済みフォルダ一覧 |
| `recentTags` | string[] | 直近に使用したタグ（最大 20 件） |
| `continuousSession` | Object | `{id, tags[], subTags[], savePaths[], count}` 連続保存セッション情報 |

---

## 既知の制約

- **Windows 専用**：`os.startfile`・エクスプローラー起動・`ctypes.windll` は Windows 専用 API
- **一時的なアドオン**：Firefox 再起動で拡張機能がリセット（署名済み `.xpi` で解消予定）
- **タブバー表示**：保存ウィンドウにタブバーが表示される（スクロール動作確保のトレードオフ）
- **Pillow 依存**：Pillow がない場合はサムネイルなしで保存は成功

---

## ライセンス

MIT License — 詳細は [LICENSE](./LICENSE) を参照してください。
