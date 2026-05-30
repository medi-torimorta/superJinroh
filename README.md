# superJinroh
  
## 概要  
アイテムを使用した特殊ルール付きの人狼ゲームです。  
本アプリケーションを実行しているホスト1名と、3~13名のクライアントが必要です。  

## 実行方法  
https://github.com/medi-torimorta/superJinroh/releases  
からOS毎に適切なアーカイブをダウンロードし、書き込み可能な任意のディレクトリに展開します。  
展開後は、Windows では `superjinroh.exe`、macOS / Linux では `superjinroh` を実行します。  
その後、ホストはlocalhost:11037から、クライアントは表示されるアドレスに接続します。  
このソフトはUPnPを使用してポートを開放するため、環境によっては手動でのポート開放が必要です。  

## 設定  
config.jsonで各種設定が可能です。  

### ファイルの場所  
- 実行ファイルと同じ階層に `config.json` があります。
- カスタム配役は `server/data/role-sets/custom/` に保存されます。

### 設定項目  
- `port`: サーバーの待受ポート  
- `allowMultipleParticipantsPerIp`: 同一IPから複数参加を許可するか  
- `enableUpnpPortMapping`: UPnP によるポート開放を有効にするか  
- `upnpPortMappingDescription`: UPnP に表示する説明  
- `upnpLeaseDurationSeconds`: UPnP ポート開放のリース秒数。`0` は無期限  
- `itemHandLimit`: アイテムの手札上限  
- `requireAdminPassword`: サーバー設定に管理者パスワードを要求するか  
- `adminPassword`: 管理者パスワード  

### GitHub Actions

Workflow: `.github/workflows/build-sea.yml`

- Trigger: `workflow_dispatch` および `v*` タグpush
- Matrix: `windows-latest`, `macos-latest`, `ubuntu-latest`
- `v*` タグ push 時は GitHub Releases に以下をアップロードします。
	- `superjinroh-win32-<arch>.zip` (Windows)
	- `superjinroh-darwin-<arch>.zip` (macOS)
	- `superjinroh-linux-<arch>.tar.gz` (Linux)

### VS Code Tasks

- `Build Release Archive (Windows)`: Windows 上で `superjinroh-win32-x64.zip` をビルドします。
- `Build Release Archive (macOS)`: macOS 上で `superjinroh-darwin-<arch>.zip` をビルドします。
- `Build Release Archive (Linux)`: Linux 上で `superjinroh-linux-<arch>.tar.gz` をビルドします。
- いずれの task も `npm run sea:build` を実行します。生成物は `dist/sea/` 配下に出力されます。


