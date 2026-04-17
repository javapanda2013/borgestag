#!/usr/bin/env python3
"""
image_saver.py  —  Firefox Native Messaging ホスト
version: 1.9.9

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
import re
import tempfile
import hashlib
import unicodedata
from datetime import datetime

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




def make_gif_thumbnail(gif_bytes, max_size=600, _errors=None):
    """
    GIF バイト列の各フレームをリサイズして再合成し、
    アニメーション GIF バイト列と (幅, 高さ) を返す。
    失敗時は (None, None, None) を返す。
    _errors: list を渡すと例外発生時に型と文字列を追記する（診断用）。
    """
    try:
        from PIL import Image, ImageSequence
        import io as _io
        img = Image.open(_io.BytesIO(gif_bytes))
        orig_w, orig_h = img.size
        scale = min(max_size / orig_w, max_size / orig_h, 1.0)
        new_w = max(1, int(orig_w * scale))
        new_h = max(1, int(orig_h * scale))

        frames = []
        durations = []
        for frame in ImageSequence.Iterator(img):
            f = frame.convert("RGBA")
            if scale < 1.0:
                f = f.resize((new_w, new_h), Image.LANCZOS)
            frames.append(f)
            durations.append(frame.info.get("duration", 100))

        if not frames:
            if _errors is not None:
                _errors.append("no frames")
            return None, None, None

        buf = _io.BytesIO()
        frames[0].save(
            buf, format="GIF",
            save_all=True,
            append_images=frames[1:],
            loop=0,
            duration=durations,
            optimize=False,
        )
        return buf.getvalue(), new_w, new_h
    except Exception as e:
        if _errors is not None:
            _errors.append(f"{type(e).__name__}: {e}")
        return None, None, None


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
        # v1.9.2: 30 → 60 秒へ延長（大容量画像・低速回線で頻発していたタイムアウト対策）
        with urllib.request.urlopen(req, timeout=60) as response:
            data = response.read()

        with open(final_path, "wb") as f:
            f.write(data)

        # サムネイル用: Pillow でリサイズして返す
        # 元画像をそのまま Base64 化すると Native Messaging の 4MB 上限を超えるため必ずリサイズする
        try:
            # GIF はアニメーション情報を維持するため専用ヘルパーで処理する
            # v1.9.8: Native Messaging 1MB 応答上限対策として一時ファイル経由へ統一
            if save_path.lower().endswith(".gif"):
                gif_bytes, thumb_w, thumb_h = make_gif_thumbnail(data, max_size=600)
                if gif_bytes is not None:
                    tmp_path, tmp_size = _write_gif_thumb_to_temp(gif_bytes)
                    if tmp_path:
                        return {
                            "ok": True,
                            "savedPath": final_path,
                            "thumbChunkPath": tmp_path,
                            "thumbTotalSize": tmp_size,
                            "thumbMime": "image/gif",
                            "thumbWidth": thumb_w,
                            "thumbHeight": thumb_h,
                        }
                    return {"ok": True, "savedPath": final_path, "thumbError": "GIF thumbnail temp write failed"}
                # GIF サムネイル生成失敗時はサムネイルなしで保存成功を返す
                return {"ok": True, "savedPath": final_path, "thumbError": "GIF thumbnail failed"}

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
        # GIF はアニメーション情報を維持するため専用ヘルパーで処理する
        # v1.9.8: Native Messaging 1MB 応答上限対策として一時ファイル経由へ統一
        if save_path.lower().endswith(".gif"):
            gif_bytes, thumb_w, thumb_h = make_gif_thumbnail(data, max_size=600)
            if gif_bytes is not None:
                tmp_path, tmp_size = _write_gif_thumb_to_temp(gif_bytes)
                if tmp_path:
                    return {
                        "ok": True,
                        "savedPath": final_path,
                        "thumbChunkPath": tmp_path,
                        "thumbTotalSize": tmp_size,
                        "thumbMime": "image/gif",
                        "thumbWidth": thumb_w,
                        "thumbHeight": thumb_h,
                    }
                return {"ok": True, "savedPath": final_path, "thumbError": "GIF thumbnail temp write failed"}
            return {"ok": True, "savedPath": final_path, "thumbError": "GIF thumbnail failed"}

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


def _norm_for_compare(p):
    """
    パス比較用の正規化:
      - abspath で絶対化
      - normpath で .. や // を解決
      - 末尾セパレータ除去
      - Windows 前提で大文字小文字を無視するため小文字化
    """
    if not p:
        return ""
    n = os.path.normpath(os.path.abspath(p))
    n = n.rstrip("\\/")
    return n.lower()


def handle_mkdir(path, allowed_roots=None):
    """
    フォルダを新規作成する。
    background.js 側で一次検証済みだが、Native Messaging を直接叩く悪意ある呼出に
    備えて二次検証を行う:
      - path に .. が含まれるなら拒否
      - allowed_roots が与えられた場合、その配下でなければ拒否
    allowed_roots が None / 空 の場合は後方互換のため従来動作（検証なし）。
    """
    try:
        if not isinstance(path, str) or not path:
            return {"ok": False, "error": "パスが指定されていません"}
        if ".." in path:
            return {"ok": False, "error": "許可されていないパスです（相対成分を含む）"}

        if allowed_roots:
            target = _norm_for_compare(path)
            allowed_norm = [_norm_for_compare(r) for r in allowed_roots if r]
            ok = False
            for r in allowed_norm:
                if not r:
                    continue
                if target == r or target.startswith(r + os.sep.lower()) or target.startswith(r + "\\"):
                    ok = True
                    break
            if not ok:
                return {"ok": False, "error": "許可されていないパスです（許可ルート外）"}

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

    v1.9.1: アトミック書き込みに変更。<path>.tmp に書き出してから os.replace で最終名へリネーム。
    書き込み途中で中断されても最終ファイルは汚れず、中途半端なファイルは .tmp のまま残る。
    次回実行時に古い .tmp を事前削除して再試行する。
    """
    tmp_path = path + ".tmp"
    try:
        save_dir = os.path.dirname(path)
        if save_dir and not os.path.isdir(save_dir):
            return {
                "ok": False,
                "error": f"フォルダが存在しません: {save_dir}",
                "errorCode": "DIR_NOT_FOUND",
            }
        # 残骸の .tmp を事前削除
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        # 一時ファイルへ書き込み
        with open(tmp_path, "w", encoding="utf-8") as f:
            f.write(content)
        # アトミックに最終名へリネーム（Windows でも上書き可）
        os.replace(tmp_path, path)
        return {"ok": True}
    except PermissionError:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
        return {"ok": False, "error": f"書き込み権限がありません: {path}"}
    except Exception as e:
        try:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)
        except Exception:
            pass
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
        # v1.9.2: 15 → 60 秒へ延長（プレビュー取得の安定性向上・sendNative 側も 300 秒へ拡張済み）
        with urllib.request.urlopen(req, timeout=60) as response:
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
    ローカルファイルを読み込み、Base64 data URL として返す。
    保存履歴の「保存した画像を開く」でブラウザ別タブ表示に使用。
    非GIF は Pillow で JPEG 変換し 2MB 以内に収める。

    v1.9.7:
      - GIF は第1フレーム JPEG フォールバックを廃止し、全フレーム保持のまま
        JS 側から READ_FILE_CHUNK で分割取得させる方針へ変更。
      - GIF の場合は {ok: true, useChunks: true, totalSize, mime: "image/gif"}
        を返し、JS 側で読み取りとアニメーション再生を行う。
    """
    def _slog(msg):
        try:
            sys.stderr.write(f"[read_file_base64] {msg}\n")
            sys.stderr.flush()
        except Exception:
            pass

    try:
        if not os.path.isfile(path):
            return {"ok": False, "error": f"ファイルが存在しません: {path}"}

        # GIF は分割読み込みに切り替える（第1フレームへの縮退はしない）
        if path.lower().endswith(".gif"):
            try:
                total_size = os.path.getsize(path)
                _slog(f"gif defer to chunks: {path} size={total_size}")
                return {
                    "ok": True,
                    "useChunks": True,
                    "totalSize": total_size,
                    "mime": "image/gif",
                    "sourcePath": path,
                }
            except BaseException as e:
                _slog(f"gif size probe failed: {type(e).__name__}: {e}")
                return {"ok": False, "error": f"{type(e).__name__}: {e}"}

        _slog(f"open: {path}")
        with open(path, "rb") as f:
            data = f.read()
        _slog(f"read ok: size={len(data)}")

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

    except BaseException as e:
        _slog(f"top-level except: {type(e).__name__}: {e}")
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ---------------------------------------------------------------
# v1.9.7: 分割ファイル読み込み・GIF サムネイル一時ファイル生成
# Native Messaging の 1MB 送信上限を超える GIF を JS 側で組み立てるため
# ---------------------------------------------------------------

# 一時ファイルの保存先（プロセス寿命中のみ有効）
_CHUNK_TEMP_DIR = None


def _get_chunk_temp_dir():
    """BorgesTag 用一時ファイル置き場（%TEMP%\\borgestag_chunk_cache\\）を返す。"""
    global _CHUNK_TEMP_DIR
    if _CHUNK_TEMP_DIR and os.path.isdir(_CHUNK_TEMP_DIR):
        return _CHUNK_TEMP_DIR
    d = os.path.join(tempfile.gettempdir(), "borgestag_chunk_cache")
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        d = tempfile.gettempdir()
    _CHUNK_TEMP_DIR = d
    return d


def _write_gif_thumb_to_temp(gif_bytes):
    """
    v1.9.8: 保存系ハンドラ（SAVE_IMAGE / SAVE_IMAGE_BASE64 / GENERATE_THUMBS_BATCH）で
    GIF サムネイル Base64 を直接返していたが、Native Messaging の 1MB 応答上限を超える
    ケースが発生するため一時ファイル経由へ統一する。
    バイト列を %TEMP%\\borgestag_chunk_cache\\ に一意名で書き出し、(temp_path, size) を返す。
    失敗時は (None, None)。
    """
    try:
        temp_dir = _get_chunk_temp_dir()
        fd, temp_path = tempfile.mkstemp(suffix=".gif", prefix="savedgif_", dir=temp_dir)
        with os.fdopen(fd, "wb") as tf:
            tf.write(gif_bytes)
        return temp_path, len(gif_bytes)
    except Exception:
        return None, None


def _is_under_chunk_temp_dir(path):
    """path が一時ディレクトリ配下にあるかを確認する（DELETE_CHUNK_FILE の安全検証用）。"""
    try:
        base = os.path.realpath(_get_chunk_temp_dir())
        target = os.path.realpath(path)
        return target.startswith(base + os.sep) or target == base
    except Exception:
        return False


def handle_read_file_chunk(path, offset, max_bytes):
    """
    任意のローカルファイルをバイトオフセット指定で読み取り、Base64 で返す。
    Native Messaging の 1MB 送信上限より十分小さいサイズで返却するため
    max_bytes のデフォルトは 700KB。

    引数:
      path:      読み取り対象ファイル（絶対パス）
      offset:    読み取り開始バイト位置（0 以上）
      max_bytes: 1 回の応答で返すバイト上限

    戻り値:
      {ok: True, bytes: "<base64>", offset, length, totalSize, done: bool}
    """
    try:
        if not isinstance(path, str) or not path:
            return {"ok": False, "error": "path が指定されていません"}
        if not os.path.isfile(path):
            return {"ok": False, "error": f"ファイルが存在しません: {path}"}
        try:
            offset = int(offset or 0)
        except Exception:
            offset = 0
        try:
            max_bytes = int(max_bytes or 700 * 1024)
        except Exception:
            max_bytes = 700 * 1024
        if max_bytes <= 0:
            max_bytes = 700 * 1024
        # 保険: 800KB を超える単一応答は禁止（1MB 上限からの安全マージン）
        if max_bytes > 800 * 1024:
            max_bytes = 800 * 1024

        total = os.path.getsize(path)
        if offset >= total:
            return {
                "ok": True,
                "bytes": "",
                "offset": offset,
                "length": 0,
                "totalSize": total,
                "done": True,
            }

        with open(path, "rb") as f:
            f.seek(offset)
            chunk = f.read(max_bytes)

        return {
            "ok": True,
            "bytes": base64.b64encode(chunk).decode("ascii"),
            "offset": offset,
            "length": len(chunk),
            "totalSize": total,
            "done": (offset + len(chunk)) >= total,
        }
    except PermissionError:
        return {"ok": False, "error": f"アクセス権がありません: {path}"}
    except BaseException as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def handle_make_gif_thumb_file(path, max_size=600):
    """
    GIF ファイルから縮小アニメ GIF を生成し、一時ファイルへ書き出してそのパスを返す。
    JS 側が READ_FILE_CHUNK で分割読み取りする前提の v1.9.7 経路。

    戻り値:
      {ok, tempPath, totalSize, width, height, mime: "image/gif"}
    """
    try:
        if not os.path.isfile(path):
            return {"ok": False, "error": f"ファイルが存在しません: {path}"}
        try:
            max_size = int(max_size or 600)
        except Exception:
            max_size = 600
        if max_size <= 0:
            max_size = 600

        with open(path, "rb") as f:
            data = f.read()

        _errs = []
        gif_bytes, w, h = make_gif_thumbnail(data, max_size=max_size, _errors=_errs)
        if gif_bytes is None:
            err = _errs[0] if _errs else "unknown"
            return {"ok": False, "error": f"GIF サムネイル生成失敗: {err}"}

        temp_dir = _get_chunk_temp_dir()
        # 重複を避けるためパス+mtime で一意化
        try:
            mtime = int(os.path.getmtime(path))
        except Exception:
            mtime = 0
        key = hashlib.sha1(f"{os.path.abspath(path)}|{mtime}|{max_size}".encode("utf-8")).hexdigest()[:16]
        temp_path = os.path.join(temp_dir, f"thumb_{key}.gif")

        with open(temp_path, "wb") as tf:
            tf.write(gif_bytes)

        return {
            "ok": True,
            "tempPath": temp_path,
            "totalSize": len(gif_bytes),
            "width": w,
            "height": h,
            "mime": "image/gif",
        }
    except BaseException as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def handle_fetch_preview_gif(url):
    """
    GIF URL を取得し、元のアニメーションを保持したまま一時ファイルへ書き出して
    そのパスを返す。JS 側は READ_FILE_CHUNK で読み取る。
    通常画像のプレビューは従来の handle_fetch_preview を使用する。
    """
    import urllib.parse
    try:
        parsed = urllib.parse.urlparse(url)
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
        with urllib.request.urlopen(req, timeout=60) as response:
            data = response.read()

        temp_dir = _get_chunk_temp_dir()
        key = hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]
        temp_path = os.path.join(temp_dir, f"preview_{key}.gif")
        with open(temp_path, "wb") as tf:
            tf.write(data)

        # ベストエフォートで width/height
        width = None
        height = None
        try:
            from PIL import Image as _PI
            import io as _ioP
            _img = _PI.open(_ioP.BytesIO(data))
            width, height = _img.size
        except Exception:
            pass

        return {
            "ok": True,
            "tempPath": temp_path,
            "totalSize": len(data),
            "width": width,
            "height": height,
            "mime": "image/gif",
        }
    except BaseException as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


def handle_delete_chunk_file(path):
    """
    一時ディレクトリ配下のファイルを削除する（JS 側が読み取り完了後に呼ぶ）。
    安全のため、_CHUNK_TEMP_DIR 配下でなければ拒否する。
    """
    try:
        if not isinstance(path, str) or not path:
            return {"ok": False, "error": "path が指定されていません"}
        if not _is_under_chunk_temp_dir(path):
            return {"ok": False, "error": "一時ディレクトリ外のため削除できません"}
        if os.path.isfile(path):
            try:
                os.remove(path)
            except Exception as e:
                return {"ok": False, "error": str(e)}
        return {"ok": True}
    except BaseException as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ---------------------------------------------------------------
# 外部取り込み
# ---------------------------------------------------------------

def handle_scan_external_images(path, cutoff_date_str, excludes, extensions):
    """
    BorgesTag 使用前に手動保存した画像のメタデータをスキャンして返す。
    path: フォルダまたは単一ファイルのパス
    cutoff_date_str: ISO8601 文字列（これより古い mtime のファイルのみ対象）
    excludes: 除外トークン文字列のリスト（NFKC正規化・小文字化済み）
    extensions: 対象拡張子リスト（例: [".jpg", ".png"]）
    """

    def normalize(s):
        return unicodedata.normalize("NFKC", s).lower()

    # スキャンルートを事前に確定（relFolder 計算に使用）
    # ファイル指定時はその親ディレクトリをルートとする
    _scan_root = os.path.dirname(path) if os.path.isfile(path) else path

    def extract_tokens(file_path):
        """絶対パスのフォルダ成分を除外ワードでフィルタしてトークンとして返す。"""
        folder = os.path.dirname(file_path)
        parts  = re.split(r'[/\\]', folder)
        result    = []
        seen_norm = set()
        for p in parts:
            p = p.strip()
            if not p:
                continue
            norm = normalize(p)
            if norm in excludes_set:
                continue
            if norm not in seen_norm:
                seen_norm.add(norm)
                result.append(p)  # 元の大文字小文字を保持
        return result

    # 基準日時
    cutoff = None
    if cutoff_date_str:
        try:
            cutoff = datetime.fromisoformat(cutoff_date_str)
        except Exception:
            pass

    # 除外ワードセット（渡された文字列は NFKC小文字化済みを前提とする）
    excludes_set = set(excludes)

    # 対象拡張子セット
    exts_set = set(e.lower() for e in extensions) if extensions else None

    entries      = []
    scanned      = [0]  # ミュータブル参照のためリストで包む

    def process_file(file_path):
        _, ext = os.path.splitext(file_path)
        if exts_set and ext.lower() not in exts_set:
            return
        try:
            mtime_ts = os.path.getmtime(file_path)
            if cutoff and datetime.fromtimestamp(mtime_ts) >= cutoff:
                return
            saved_at = datetime.fromtimestamp(mtime_ts).strftime("%Y-%m-%dT%H:%M:%S")
        except Exception:
            saved_at = ""
        tokens = extract_tokens(file_path)
        # スキャンルートからの相対フォルダパス（"." = ルート直下）
        try:
            rel_folder = os.path.relpath(os.path.dirname(file_path), _scan_root)
        except ValueError:
            rel_folder = "."
        entries.append({
            "filePath":  file_path,
            "savedAt":   saved_at,
            "fileName":  os.path.basename(file_path),
            "savePath":  os.path.dirname(file_path),
            "tokens":    tokens,
            "relFolder": rel_folder,  # JS がフォルダ別タグ設定に使用
        })

    def scan_dir(dir_path, visited):
        try:
            real = os.path.realpath(dir_path)
        except Exception:
            return
        if real in visited:
            return  # シンボリックリンクループを検出しスキップ
        visited.add(real)
        try:
            with os.scandir(dir_path) as it:
                for entry in it:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            scan_dir(entry.path, visited)
                        elif entry.is_file(follow_symlinks=False):
                            scanned[0] += 1
                            process_file(entry.path)
                    except Exception:
                        continue
        except PermissionError:
            pass
        except Exception:
            pass

    try:
        if os.path.isfile(path):
            scanned[0] += 1
            process_file(path)
        elif os.path.isdir(path):
            scan_dir(path, set())
        else:
            return {"ok": False, "error": f"パスが存在しません: {path}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}

    # allTokens: 全エントリのトークンのユニーク集合（後方互換のため維持）
    seen_norm  = set()
    all_tokens = []
    for e in entries:
        for t in e["tokens"]:
            n = normalize(t)
            if n not in seen_norm:
                seen_norm.add(n)
                all_tokens.append(t)

    # allFolders: ユニークな relFolder 一覧（"." を先頭に、以降はソート済み）
    seen_folders = set()
    all_folders  = []
    for e in entries:
        rf = e["relFolder"]
        if rf not in seen_folders:
            seen_folders.add(rf)
            all_folders.append(rf)
    all_folders.sort(key=lambda x: ("" if x == "." else x))

    # folderTokens: フォルダ別トークン { relFolder: [token, ...] }
    # 同一フォルダ内のファイルは同じトークンを持つため先頭エントリを使用
    folder_tokens_map = {}
    for e in entries:
        rf = e["relFolder"]
        if rf not in folder_tokens_map:
            folder_tokens_map[rf] = e["tokens"]

    return {
        "ok":           True,
        "entries":      entries,
        "allTokens":    all_tokens,
        "allFolders":   all_folders,
        "folderTokens": folder_tokens_map,
        "scanned":      scanned[0],
        "matched":      len(entries),
    }


def handle_list_subfolders(path):
    """
    指定フォルダの直下サブフォルダ一覧を返す（再帰なし）。
    外部取り込み（1枚ずつ形式）の c1: 取り込み予定フォルダリスト用。
    """
    try:
        if not path or not os.path.isdir(path):
            return {"ok": False, "error": f"ディレクトリが存在しません: {path}"}

        entries = []
        with os.scandir(path) as it:
            for entry in it:
                try:
                    if entry.name.startswith("."):
                        continue
                    try:
                        attrs = ctypes.windll.kernel32.GetFileAttributesW(entry.path)
                        if attrs != -1 and (attrs & 0x2 or attrs & 0x4):
                            continue
                    except Exception:
                        pass
                    if not entry.is_dir(follow_symlinks=True):
                        continue
                    entries.append({
                        "name": entry.name,
                        "path": entry.path,
                        "createdAt": int(entry.stat().st_ctime),
                        "isDir": True,
                    })
                except PermissionError:
                    continue

        sorted_entries = sort_entries(entries)
        return {"ok": True, "path": path, "subfolders": sorted_entries}
    except PermissionError:
        return {"ok": False, "error": f"アクセス権がありません: {path}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def handle_read_local_image_base64(file_path, max_size=1200):
    """
    ローカル画像ファイルを読み込み、プレビュー表示用に Base64 で返す。
    b1（1枚ずつ形式）のプレビュー取得で使用。
    大きい画像は max_size（長辺）までリサイズして返却する。
    """
    import io as _io
    try:
        if not file_path or not os.path.isfile(file_path):
            return {"ok": False, "error": f"ファイルが存在しません: {file_path}"}

        with open(file_path, "rb") as f:
            data = f.read()

        try:
            from PIL import Image
        except ImportError:
            # Pillow 未インストール時はそのまま返す
            ext = os.path.splitext(file_path)[1].lower().lstrip(".")
            mime = {
                "jpg": "image/jpeg", "jpeg": "image/jpeg",
                "png": "image/png", "gif": "image/gif",
                "webp": "image/webp", "bmp": "image/bmp",
            }.get(ext, "application/octet-stream")
            b64 = base64.b64encode(data).decode("ascii")
            return {"ok": True, "dataUrl": f"data:{mime};base64,{b64}",
                    "width": None, "height": None, "resized": False}

        img = Image.open(_io.BytesIO(data))
        # プレビュー用は RGB で統一（JPEG 出力のため）
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGB")
        elif img.mode == "RGBA":
            img = img.convert("RGB")

        w, h = img.size
        try:
            max_size = int(max_size) if max_size else 1200
        except Exception:
            max_size = 1200

        scale = min(max_size / w, max_size / h, 1.0) if (w > 0 and h > 0) else 1.0
        resized = False
        if scale < 1.0:
            new_w = max(1, int(w * scale))
            new_h = max(1, int(h * scale))
            img = img.resize((new_w, new_h), Image.LANCZOS)
            w, h = img.size
            resized = True

        buf = _io.BytesIO()
        img.save(buf, format="JPEG", quality=90, optimize=True)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        return {"ok": True, "dataUrl": f"data:image/jpeg;base64,{b64}",
                "width": w, "height": h, "resized": resized}
    except PermissionError:
        return {"ok": False, "error": f"アクセス権がありません: {file_path}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def handle_generate_thumbs_batch(paths):
    """
    ローカルファイルパスのリストからサムネイルをバッチ生成して Base64 で返す。
    handle_save_image と同一のリサイズロジック（MAX=600, JPEG, quality=85）を使用。
    GIF はアニメーション情報を維持するため make_gif_thumbnail を使用する。
    JS 側から 1 件ずつ呼び出すことで Native Messaging 1MB 上限を回避する。
    """
    import io as _io
    thumbs = {}
    thumbMimes = {}  # パスごとの MIME type（デフォルト image/jpeg）
    # v1.9.8: GIF は Native Messaging 1MB 応答上限対策として一時ファイル経由へ統一
    # JS 側は thumbChunkPaths[p] が存在するとき READ_FILE_CHUNK で組み立てる
    thumbChunkPaths = {}
    errors = {}
    for p in paths:
        try:
            with open(p, "rb") as f:
                data = f.read()

            # GIF はアニメーション情報を維持するため専用ヘルパーで処理する
            if p.lower().endswith(".gif"):
                gif_bytes, _, _ = make_gif_thumbnail(data, max_size=600)
                if gif_bytes is not None:
                    tmp_path, tmp_size = _write_gif_thumb_to_temp(gif_bytes)
                    if tmp_path:
                        thumbChunkPaths[p] = {"tempPath": tmp_path, "totalSize": tmp_size}
                        thumbMimes[p] = "image/gif"
                    else:
                        errors[p] = "GIF thumbnail temp write failed"
                else:
                    errors[p] = "GIF thumbnail failed"
                continue

            from PIL import Image
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
            thumbs[p] = base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception as e:
            errors[p] = str(e)
    return {
        "ok": True,
        "thumbs": thumbs,
        "thumbMimes": thumbMimes,
        "thumbChunkPaths": thumbChunkPaths,
        "errors": errors,
    }


# ---------------------------------------------------------------
# ユーティリティ
# ---------------------------------------------------------------

def handle_copy_file(src_path, dst_path):
    """
    v1.23.0: GROUP-1-b 対応。ローカルファイルを src_path から dst_path へコピーする。
    - 保存先ディレクトリが存在しない場合はエラー（自動作成しない）
    - 既存ファイルがある場合は連番を付与してユニーク化（unique_path）
    - shutil.copy2 で mtime / 権限を維持する（外部取り込みの元ファイル日時を保つため）
    """
    import shutil

    try:
        if not src_path or not os.path.isfile(src_path):
            return {"ok": False, "error": f"コピー元ファイルが見つかりません: {src_path}"}

        dst_dir = os.path.dirname(dst_path)
        if not os.path.isdir(dst_dir):
            return {
                "ok": False,
                "error": f"保存先フォルダが存在しません: {dst_dir}",
                "errorCode": "DIR_NOT_FOUND",
            }

        final_path = unique_path(dst_path)
        shutil.copy2(src_path, final_path)
        return {"ok": True, "savedPath": final_path}

    except PermissionError:
        return {"ok": False, "error": f"書き込み権限がありません: {dst_path}"}
    except Exception as e:
        return {"ok": False, "error": str(e)}


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

        # v1.9.6: コマンド処理中の未捕捉例外でプロセスが死ぬと
        # ブラウザ側では Native 切断として観測され原因特定が困難になる。
        # BaseException まで捕捉してエラーレスポンスを返すことで継続動作させる。
        try:
            result = _dispatch_command(message)
        except BaseException as _top_e:
            try:
                sys.stderr.write(f"[main] uncaught in dispatch: {type(_top_e).__name__}: {_top_e}\n")
                sys.stderr.flush()
            except Exception:
                pass
            result = {"ok": False, "error": f"Native 内部エラー: {type(_top_e).__name__}: {_top_e}"}

        try:
            send_message(result)
        except BaseException as _send_e:
            try:
                sys.stderr.write(f"[main] send_message failed: {type(_send_e).__name__}: {_send_e}\n")
                sys.stderr.flush()
            except Exception:
                pass
            # 送信自体が失敗した場合は継続しても意味がないためループを抜ける
            break


def _dispatch_command(message):
    """
    v1.9.6: main() から切り出したコマンドディスパッチャ。
    例外はここでは捕捉せず、呼び出し側 main() の try/except でまとめて扱う。
    """
    cmd = message.get("cmd")

    if cmd == "LIST_DIR":
        return handle_list_dir(message.get("path"))

    elif cmd == "SAVE_IMAGE":
        return handle_save_image(
            message.get("url", ""),
            message.get("savePath", ""),
        )

    elif cmd == "MKDIR":
        return handle_mkdir(message.get("path", ""), message.get("allowedRoots"))

    elif cmd == "WRITE_FILE":
        return handle_write_file(
            message.get("path", ""),
            message.get("content", "")
        )

    elif cmd == "SAVE_IMAGE_BASE64":
        return handle_save_image_base64(
            message.get("dataUrl", ""),
            message.get("savePath", "")
        )

    elif cmd == "SCAN_EXTERNAL_IMAGES":
        return handle_scan_external_images(
            message.get("path", ""),
            message.get("cutoffDate", ""),
            message.get("excludes", []),
            message.get("extensions", [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]),
        )

    elif cmd == "GENERATE_THUMBS_BATCH":
        return handle_generate_thumbs_batch(message.get("paths", []))

    elif cmd == "LIST_SUBFOLDERS":
        return handle_list_subfolders(message.get("path", ""))

    elif cmd == "READ_LOCAL_IMAGE_BASE64":
        return handle_read_local_image_base64(
            message.get("path", ""),
            message.get("maxSize", 1200),
        )

    elif cmd == "OPEN_EXPLORER":
        return handle_open_explorer(message.get("path", ""))

    elif cmd == "OPEN_FILE":
        return handle_open_file(message.get("path", ""))

    elif cmd == "READ_FILE_BASE64":
        return handle_read_file_base64(message.get("path", ""))

    elif cmd == "FETCH_PREVIEW":
        return handle_fetch_preview(message.get("url", ""))

    # v1.9.7: 大容量 GIF の分割読み込み用コマンド群
    elif cmd == "READ_FILE_CHUNK":
        return handle_read_file_chunk(
            message.get("path", ""),
            message.get("offset", 0),
            message.get("maxBytes", 700 * 1024),
        )

    elif cmd == "MAKE_GIF_THUMB_FILE":
        return handle_make_gif_thumb_file(
            message.get("path", ""),
            message.get("maxSize", 600),
        )

    elif cmd == "FETCH_PREVIEW_GIF":
        return handle_fetch_preview_gif(message.get("url", ""))

    elif cmd == "DELETE_CHUNK_FILE":
        return handle_delete_chunk_file(message.get("path", ""))

    # v1.23.0: GROUP-1-b 外部取り込み時に指定保存先へローカルファイルをコピー
    elif cmd == "COPY_FILE":
        return handle_copy_file(
            message.get("srcPath", ""),
            message.get("dstPath", ""),
        )

    else:
        return {"ok": False, "error": f"不明なコマンド: {cmd}"}


if __name__ == "__main__":
    main()
