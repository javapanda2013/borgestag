"""
Firefox 拡張機能 ZIP 作成スクリプト
PowerShell の Compress-Archive はバックスラッシュを使うため、
フォワードスラッシュが必要な Firefox アドオン登録用 ZIP はこのスクリプトで作成する。

使用方法:
  python make_zip.py v1.9.5
"""
import zipfile
import os
import sys

src_dir  = os.path.dirname(os.path.abspath(__file__))
version  = sys.argv[1] if len(sys.argv) > 1 else "x.x.x"
out_dir  = os.path.dirname(src_dir)  # リポジトリの1つ上（ZIP 出力先）
out_file = os.path.join(out_dir, f"image_saver_with_tags_{version}.zip")

EXCLUDE_DIRS  = {".git", "__pycache__", ".idea", "node_modules"}
EXCLUDE_FILES = {".DS_Store", "Thumbs.db"}

with zipfile.ZipFile(out_file, "w", zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(src_dir):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS and not d.startswith(".")]
        for file in files:
            if file in EXCLUDE_FILES or file.startswith("."):
                continue
            fp      = os.path.join(root, file)
            arcname = os.path.relpath(fp, src_dir).replace("\\", "/")
            zf.write(fp, arcname)

print(f"Created: {out_file}")
