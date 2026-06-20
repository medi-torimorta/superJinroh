# superJinroh
  
## 概要  
アイテムを使用した特殊ルール付きの人狼ゲームです。  
本アプリケーションを実行しているホスト1名と、3~13名のクライアントが必要です。  

## 実行方法  
https://github.com/medi-torimorta/superJinroh/releases/latest 
からOS毎に適切なファイルをダウンロードし、書き込み可能な任意のディレクトリに展開します。  
macOS は CPU に応じて Intel Mac では `superjinroh-darwin-x64.zip`、Apple Silicon Mac では `superjinroh-darwin-arm64.zip` を選択してください。  
展開後は、Windows では `superjinroh.exe`、macOS / Linux では `superjinroh` を実行します。  
その後、ホストはlocalhost:11037に、クライアントは表示されるアドレスに接続してプレイします。  
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