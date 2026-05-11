# native/ 更新時のチェックリスト（実装者向け）

## image_saver.py を変更した場合

- [ ] ファイル先頭の `version: x.x.x` を上げる（例: 1.6.3 → 1.6.4）
- [ ] 拡張機能側の manifest.json / settings.js のバージョンも上げる
- [ ] install.bat の再実行が必要である旨をリリースノートに記載する

## バージョンの対応表（参考）
- 拡張機能バージョン: manifest.json の "version"
- native バージョン: image_saver.py 先頭の "version: x.x.x"
- native は独立してバージョン管理（例: 拡張 1.5.46 / native 1.6.4）

## install.bat が行う処理
- pip install Pillow
- Windows レジストリへの Native Messaging ホスト登録
- → フォルダパスをレジストリに書き込むため、フォルダ移動後も再実行が必要
