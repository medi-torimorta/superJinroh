# superJinroh

## サーバーセットアップ
### batファイルでのセットアップ
```bat
start-server.bat
```

- 初回実行時は `start-server.bat` が Node.js 22.15.0 の導入、npm 依存関係のインストール、shared ビルド、Prisma クライアント生成、SQLite スキーマ適用、server ビルドまでを自動実行します。
- 2 回目以降も同じ `start-server.bat` を実行すると、必要な再ビルドと DB 同期を行ったうえでサーバーを起動します。
- Node.js の新規導入時は管理者権限が必要です。未導入の場合、バッチは昇格して再実行します。
- `server/data/config.json` の `enableUpnpPortMapping` が `true` の場合、サーバー起動時に TCP （config値） の UPnP ポート開放を試行し、終了時に解除します。
- UPnP の動作内容は `server/data/config.json` の `upnpPortMappingDescription` と `upnpLeaseDurationSeconds` でも調整できます。

- サーバーは `server/data/app.db` に情報を保持します。

## ビルド方法 (exe / dmg / AppImage)

### 手元ビルド

```bash
npm ci
npm run build
npm --workspace server run prisma:generate
npm run sea:build
```

- 出力先: `dist/sea/<platform>-<arch>/`
- Windows: `superjinroh.exe`, 
- macOS: `superjinroh.dmg`
- Linux: `superjinroh-x86_64.AppImage`

`server/dist/index.js` が `app/product/` に出力します。

### GitHub Actions

Workflow: `.github/workflows/build-sea.yml`

- Trigger: `workflow_dispatch` および `v*` タグpush
- Matrix: `windows-latest`, `macos-latest`, `ubuntu-latest`
- `v*` タグ push 時は GitHub Releases に以下をアップロードします。
	- `superjinroh.dmg` (macOS)
	- `superjinroh-x86_64.AppImage` (Linux)
	- `superjinroh.exe` (Windows)


