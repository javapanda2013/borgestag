#!/usr/bin/env python3
"""
image_saver.py  —  Firefox Native Messaging ホスト
version: 1.6.9

受け取るコマンド:
  {"cmd": "LIST_DIR",      "path": null}
  {"cmd": "LIST_DIR",      "path": "C:\\\\Users"}
  {"cmd": "SAVE_IMAGE",    "url": "...", "savePath": "C:\\\\...\\\\photo.jpg"}
  {"cmd": "MKDIR",         "path": "C:\\\\...\\\\新フォルダ"}
  {"cmd": "OPEN_EXPLORER", "path": "C:\\\\...\\\\フォルダ"}
"""

import sys
import os
import json
import struct
import urllib.request
import urllib.error
import string
import base64
import ctypes

# ---------------------------------------------------------------
# Windows エクスプローラー互換ソート（StrCmpLogicalW）
# ---------------------------------------------------------------
_SORT_LOG_SENT = False  # 初回のみログ送信するフラグ

try:
    _shlwapi = ctypes.windll.shlwapi
    _StrCmpLogicalW = _shlwapi.StrCmpLogicalW
    _StrCmpLogicalW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p]
    _StrCmpLogicalW.restype  = ctypes.c_int
    USE_WIN_SORT = True
    WIN_SORT_ERROR = None
except Exception as e:
    USE_WIN_SORT = False
    WIN_SORT_ERROR = str(e)

import functools

def sort_entries(entries):
    """エントリ一覧をWindowsエクスプローラー互換順でソート"""
    if USE_WIN_SORT:
        return sorted(entries, key=lambda e: functools.cmp_to_key(
            lambda a, b: _StrCmpLogicalW(a["name"], b["name"]))(e))
    else:
        return sorted(entries, key=lambda e: e["name"].lower())

# ---------------------------------------------------------------
# Native Messaging プロトコル
# stdin/stdout で 4バイト長 + JSON のフレームをやり取りする
# ---------------------------------------------------------------

def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    message_length = struct.unpack("<I", raw_length)[0]
    data = sys.stdin.buffer.read(message_length)
    return json.loads(data.decode("utf-8"))


def send_message(obj):
    encoded = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


# ---------------------------------------------------------------
# コマンドハンドラ
# ---------------------------------------------------------------

def handle_list_dir(path):
    """
    path が None のとき: 利用可能なドライブ一覧を返す
    path が文字列のとき: そのディレクトリの内容を返す
    """
    try:
        if path is None:
            # Windowsのドライブ一覧を取得
            drives = []
            for letter in string.ascii_uppercase:
                drive = f"{letter}:\\"
                if os.path.exists(drive):
                    drives.append({"name": f"{letter}:", "isDir": True})
            return {"ok": True, "path": None, "entries": drives}

        # 通常のディレクトリ一覧
        if not os.path.isdir(path):
            return {"ok": False, "error": f"ディレクトリが存在しません: {path}"}

        entries = []
        with os.scandir(path) as it:
            for entry in it:
                try:
                    # 隠しファイル・システムファイルはスキップ
                    if entry.name.startswith("."):
                        continue
                    # Windows の隠し属性チェック
                    if hasattr(entry, "stat"):
                        import stat as stat_mod
                        s = entry.stat(follow_symlinks=False)
                        # FILE_ATTRIBUTE_HIDDEN (0x2) or SYSTEM (0x4)
                        try:
                            import ctypes
                            attrs = ctypes.windll.kernel32.GetFileAttributesW(entry.path)
                            if attrs != -1 and (attrs & 0x2 or attrs & 0x4):
                                continue
                        except Exception:
                            pass
                    entries.append({
                        "name": entry.name,
                        "isDir": entry.is_dir(follow_symlinks=True),
                        "createdAt": int(entry.stat().st_ctime),
                    })
                except PermissionError:
                    continue

        sorted_entries = sort_entries(entries)

        return {"ok": True, "path": path, "entries": sorted_entries}

    except PermissionError:
        return {"ok": False, "error": f"アクセス権がありません: {path}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}




def handle_save_image(url, save_path):
    """
    URL から画像をダウンロードして save_path に保存する。
    保存先ディレクトリが存在しない場合はエラーを返す（自動作成しない）。
    """
    try:
        save_dir = os.path.dirname(save_path)

        if not os.path.isdir(save_dir):
            return {
                "ok": False,
                "error": f"保存先フォルダが存在しません: {save_dir}",
                "errorCode": "DIR_NOT_FOUND",
            }

        final_path = unique_path(save_path)

        import urllib.parse
        parsed   = urllib.parse.urlparse(url)
        hostname = parsed.hostname or ""

        REFERER_MAP = {
            "i.pximg.net":            "https://www.pixiv.net/",
            "img-original.pixiv.net": "https://www.pixiv.net/",
        }
        referer = next(
            (v for k, v in REFERER_MAP.items() if hostname == k or hostname.endswith("." + k)),
            f"{parsed.scheme}://{hostname}/"
        )

        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Referer": referer,
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=30) as response:
            data = response.read()

        with open(final_path, "wb") as f:
            f.write(data)

        # サムネイル用: Pillow でリサイズして JPEG で返す
        # 元画像をそのまま Base64 化すると Native Messaging の 4MB 上限を超えるため必ずリサイズする
        try:
            from PIL import Image
            import io as _io
            img = Image.open(_io.BytesIO(data))
            img = img.convert("RGB")  # RGBA / P モードを JPEG 互換に変換
            MAX = 600
            w, h = img.size
            scale = min(MAX / w, MAX / h, 1.0)
            if scale < 1.0:
                new_w = max(1, int(w * scale))
                new_h = max(1, int(h * scale))
                img = img.resize((new_w, new_h), Image.LANCZOS)
            buf = _io.BytesIO()
            img.save(buf, format="JPEG", quality=85, optimize=True)
            thumb_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
            return {
                "ok": True,
                "savedPath": final_path,
                "thumbData": thumb_b64,
                "thumbMime": "image/jpeg",
            }
        except Exception as thumb_err:
            # Pillow 未インストールまたは処理失敗 → サムネイルなしで保存成功を返す
            # thumbError をログに含めることで background.js 側でWARN表示できる
            return {
                "ok": True,
                "savedPath": final_path,
                "thumbError": str(thumb_err),
            }

    except urllib.error.HTTPError as e:
        return {"ok": False, "error": f"ダウンロード失敗: HTTP {e.code} {e.reason}"}
    except urllib.error.URLError as e:
        return {"ok": False, "error": f"ダウンロード失敗: {e.reason}"}
    except PermissionError:
        return {"ok": False, "error": f"書き込み権限がありません: {save_path}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def handle_save_image_base64(data_url, save_path):
    """
    Base64 データURL から画像をファイルに保存する。
    ブラウザ側で取得した画像データ（認証済み）をそのまま書き出すため、
    Cookie が必要なサイト（Fanbox など）の画像保存に使用する。
    """
    try:
        b64_data = data_url.split(",", 1)[1]
        data = base64.b64decode(b64_data)
    except Exception as e:
        return {"ok": False, "error": f"Base64デコード失敗: {e}"}

    try:
        save_dir = os.path.dirname(save_path)
        if not os.path.isdir(save_dir):
            return {"ok": False, "error": f"保存先フォルダが存在しません: {save_dir}", "errorCode": "DIR_NOT_FOUND"}
        final_path = unique_path(save_path)
        with open(final_path, "wb") as f:
            f.write(data)
    except PermissionError:
        return {"ok": False, "error": f"書き込み権限がありません: {save_path}"}
    except Exception as e:
        return {"ok": False, "error": f"ファイル書き込み失敗: {e}"}

    # サムネイル生成（handle_save_image と同じロジック）
    try:
        from PIL import Image
        import io as _io
        img = Image.open(_io.BytesIO(data))
        img = img.convert("RGB")
        MAX = 600
        w, h = img.size
        scale = min(MAX / w, MAX / h, 1.0)
        if scale < 1.0:
            new_w = max(1, int(w * scale))
            new_h = max(1, int(h * scale))
            img = img.resize((new_w, new_h), Image.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format="JPEG", quality=85, optimize=True)
        thumb_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return {
            "ok": True,
            "savedPath": final_path,
            "thumbData": thumb_b64,
            "thumbMime": "image/jpeg",
        }
    except Exception as thumb_err:
        return {
            "ok": True,
            "savedPath": final_path,
            "thumbError": str(thumb_err),
        }


def handle_mkdir(path):
    """
    フォルダを新規作成する
    """
    try:
        os.makedirs(path, exist_ok=True)
        return {"ok": True}
    except PermissionError:
        return {"ok": False, "error": f"作成権限がありません: {path}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def handle_write_file(path, content):
    """
    テキストファイルをパス指定で書き出す（エクスポート即出力用）。
    保存先フォルダが存在しない場合はエラーを返す（自動作成しない）。
    """
    try:
        save_dir = os.path.dirname(path)
        if save_dir and not os.path.isdir(save_dir):
            return {
                "ok": False,
                "error": f"フォルダが存在しません: {save_dir}",
                "errorCode": "DIR_NOT_FOUND",
            }
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return {"ok": True}
    except PermissionError:
        return {"ok": False, "error": f"書き込み権限がありません: {path}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def handle_fetch_preview(url):
    """
    プレビュー表示用に画像をダウンロードし、Pillowでリサイズして Base64 で返す。
    pixiv 等のホットリンク保護に対応（Referer を付与してダウンロード）。
    """
    import urllib.parse
    import io as _io
    try:
        parsed   = urllib.parse.urlparse(url)
        hostname = parsed.hostname or ""

        REFERER_MAP = {
            "i.pximg.net":            "https://www.pixiv.net/",
            "img-original.pixiv.net": "https://www.pixiv.net/",
        }
        referer = next(
            (v for k, v in REFERER_MAP.items() if hostname == k or hostname.endswith("." + k)),
            f"{parsed.scheme}://{hostname}/"
        )

        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Referer": referer,
        }
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=15) as response:
            data = response.read()

        from PIL import Image
        img = Image.open(_io.BytesIO(data))
        img = img.convert("RGB")
        MAX = 600
        w, h = img.size
        scale = min(MAX / w, MAX / h, 1.0)
        if scale < 1.0:
            img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        buf = _io.BytesIO()
        img.save(buf, format="JPEG", quality=85, optimize=True)
        thumb_b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return {"ok": True, "dataUrl": f"data:image/jpeg;base64,{thumb_b64}"}

    except Exception as e:
        return {"ok": False, "error": str(e)}


def handle_open_explorer(path):
    """
    Windows エクスプローラーで指定フォルダを開く。
    パスが存在しない場合はエラーを返す。
    日本語パス対応のため shell=True + startfile を使用。
    """
    import subprocess
    try:
        if not os.path.isdir(path):
            return {"ok": False, "error": f"フォルダが存在しません: {path}"}

        # os.startfile は日本語パスも正しく扱える（Windows専用）
        # subprocess.Popen(["explorer", path]) はエンコード問題が発生するため不使用
        try:
            os.startfile(path)
        except AttributeError:
            # os.startfile が使えない環境（念のため）
            subprocess.Popen(
                f'explorer "{path}"',
                shell=True,
                creationflags=subprocess.CREATE_NO_WINDOW
            )
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def handle_open_file(path):
    """
    指定したファイルを関連付けられたアプリで開く（os.startfile）。
    ファイルが存在しない場合はエラーを返す。
    """
    try:
        if not os.path.isfile(path):
            return {"ok": False, "error": f"ファイルが存在しません: {path}"}
        os.startfile(path)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def handle_read_file_base64(path):
    """
    ローカルファイルを読み込み、Pillowでリサイズして Base64 data URL として返す。
    保存履歴の「保存した画像を開く」でブラウザ別タブ表示に使用。
    元画像をそのまま返すと Native Messaging の 4MB 上限を超えるため、必ずリサイズする。
    """
    try:
        if not os.path.isfile(path):
            return {"ok": False, "error": f"ファイルが存在しません: {path}"}

        with open(path, "rb") as f:
            data = f.read()

        from PIL import Image
        import io as _io
        img = Image.open(_io.BytesIO(data))
        img = img.convert("RGB")
        MAX = 1600
        w, h = img.size
        scale = min(MAX / w, MAX / h, 1.0)
        if scale < 1.0:
            img = img.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)

        # quality を調整して 2MB 以内に収める
        buf = _io.BytesIO()
        for quality in (90, 75, 60):
            buf = _io.BytesIO()
            img.save(buf, format="JPEG", quality=quality, optimize=True)
            if len(buf.getvalue()) < 2 * 1024 * 1024:
                break

        data_url = "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        return {"ok": True, "dataUrl": data_url}

    except Exception as e:
        return {"ok": False, "error": str(e)}


# ---------------------------------------------------------------
# ユーティリティ
# ---------------------------------------------------------------

def unique_path(path):
    """
    ファイルが既に存在する場合、連番を付与してユニークなパスを返す
    例: photo.jpg → photo (1).jpg → photo (2).jpg
    """
    if not os.path.exists(path):
        return path
    base, ext = os.path.splitext(path)
    i = 1
    while True:
        candidate = f"{base} ({i}){ext}"
        if not os.path.exists(candidate):
            return candidate
        i += 1


# ---------------------------------------------------------------
# メインループ
# ---------------------------------------------------------------

def main():
    while True:
        message = read_message()
        if message is None:
            break

        cmd = message.get("cmd")

        if cmd == "LIST_DIR":
            result = handle_list_dir(message.get("path"))

        elif cmd == "SAVE_IMAGE":
            result = handle_save_image(
                message.get("url", ""),
                message.get("savePath", ""),
            )

        elif cmd == "MKDIR":
            result = handle_mkdir(message.get("path", ""))

        elif cmd == "WRITE_FILE":
            result = handle_write_file(
                message.get("path", ""),
                message.get("content", "")
            )

        elif cmd == "SAVE_IMAGE_BASE64":
            result = handle_save_image_base64(
                message.get("dataUrl", ""),
                message.get("savePath", "")
            )

        elif cmd == "OPEN_EXPLORER":
            result = handle_open_explorer(message.get("path", ""))

        elif cmd == "OPEN_FILE":
            result = handle_open_file(message.get("path", ""))

        elif cmd == "READ_FILE_BASE64":
            result = handle_read_file_base64(message.get("path", ""))

        elif cmd == "FETCH_PREVIEW":
            result = handle_fetch_preview(message.get("url", ""))

        else:
            result = {"ok": False, "error": f"不明なコマンド: {cmd}"}

        send_message(result)


if __name__ == "__main__":
    main()
