# GENZO — コンセプトのビジュアル意思決定ワークスペース（Cloud Run 版）

Google Apps Script（`code.gs` + `index.html`）で動いていた GENZO v3 を、Cloud Run 上の Node.js アプリに移植したものです。
設計ロジック・シード知識（`SEED_REV`）・画面は GAS 版と同一で、GAS 固有の部分だけを次のように置き換えています。

| GAS 版 | Cloud Run 版 |
|---|---|
| `PropertiesService`（スクリプトプロパティ） | 環境変数（`server/config.js`、`.env.example` 参照） |
| `UrlFetchApp` → OpenAI 互換 API（Gemini 含む） | **Vertex AI**（`server/llm.js`）: Gemini でテキスト／画像入力／JSON 出力、Gemini 画像生成または Imagen で画像、Google 検索グラウンディングで web 接地。`LLM_PROVIDER=openai` で従来の OpenAI 互換 API も選択可 |
| `DriveApp`（`GENZO_FOLDER_ID`） | **Cloud Storage** バケット（`server/storage.js`）。ローカル開発は `STORAGE=local` でファイルシステム |
| `LockService` | プロセス内ミューテックス + 保存時の世代番号（GCS generation）照合 |
| `CacheService`（Drive サムネイル） | `sharp` で生成した縮小サムネを `thumbs/` に保存 + メモリキャッシュ |
| `HtmlService` / `google.script.run` | Express が `public/index.html` を配信し、`POST /api/<関数名>` で同じ関数を呼ぶ |

## 構成

```
server/index.js    起動点（本体は server/app.js: 静的配信・/api ディスパッチ・/files・/api/health・ログイン画面）
server/drive_import.js  GAS 版 Drive フォルダからの移行（/api/admin/importFromDrive）
server/genzo.js    アプリ本体（code.gs の移植。シード・パイプライン・判定ロジックはそのまま）
server/llm.js      Vertex AI / OpenAI 互換 の呼び出し層
server/storage.js  Cloud Storage / ローカル FS
server/lock.js     非同期ミューテックス
server/config.js   環境変数
public/index.html  画面（index.html の移植。RPC ラッパー gs() のみ fetch 化）
test/              LLM をモックしたバックエンドの通しテスト（npm test）
deploy.sh          gcloud での Cloud Run デプロイ一式
cloudbuild.yaml    Cloud Build を使う場合の定義
scripts/import-from-drive.sh  GAS 版の Drive フォルダをアプリ経由で保存先に移す
```

## ローカルで動かす

```bash
npm install
cp .env.example .env            # 必要なら編集
# Vertex AI を使う場合は ADC を用意
gcloud auth application-default login
export $(grep -v '^#' .env | xargs)   # または直接環境変数を設定
STORAGE=local VERTEX_PROJECT=<your-project> npm start
# → http://localhost:8080
```

外部サービスに接続しないテスト:

```bash
npm test
```

## Cloud Run へデプロイ

前提: `gcloud` にログイン済みで、対象プロジェクトの Owner か、Cloud Run / Cloud Build / IAM / Storage / Vertex AI の権限があること。

```bash
PROJECT_ID=<your-project> GCS_BUCKET=<bucket-name> ./deploy.sh
```

`deploy.sh` が行うこと:

1. 必要な API の有効化（Cloud Run, Cloud Build, Artifact Registry, Vertex AI, Storage）
2. 保存先バケットの作成（無ければ）
3. サービスアカウント `genzo-run` の作成と権限付与（`roles/aiplatform.user`、バケットへの `roles/storage.objectAdmin`）
4. ソースデプロイ（`--timeout 3600`、`--max-instances 1`、`--no-allow-unauthenticated`）

### 重要な設定値

| 環境変数 | 既定 | 説明 |
|---|---|---|
| `GCS_BUCKET` | (必須) | プロジェクト JSON と画像の保存先 |
| `GCS_PREFIX` | `genzo/` | バケット内のプレフィックス |
| `LLM_PROVIDER` | `openai`（`OPENAI_API_KEY` があるとき。無ければ `vertex`） | `openai`（GAS 版と同じ OpenAI 互換 API）または `vertex` |
| `OPENAI_API_KEY` / `OPENAI_MODEL` / `OPENAI_IMAGE_MODEL` / `OPENAI_BASE_URL` | — / `gpt-5.5` / `gpt-image-2` / `https://api.openai.com/v1` | GAS 版のスクリプトプロパティと同じ。キーの正本は GCP Secret Manager の `openai-api-key`（`deploy.sh` が `--set-secrets` で渡す。環境変数にあれば Secret Manager へ登録する） |
| `VERTEX_PROJECT` | ADC から取得 | Vertex AI のプロジェクト |
| `VERTEX_LOCATION` | `global` | Gemini のロケーション |
| `VERTEX_MODEL` | `gemini-2.5-pro` | テキスト・画像理解・JSON 生成・グラウンディングに使うモデル |
| `VERTEX_IMAGE_MODEL` | `gemini-2.5-flash-image` | 画像生成。`imagen-*` を指定すると `:predict` API（参照画像なし）になる |
| `VERTEX_IMAGE_LOCATION` | `us-central1` | Imagen を使う場合のリージョン |
| `APP_PASSWORD` | 空 | 設定すると入室画面でこのパスワード1つを要求（ユーザー名なし） |

- **タイムアウト**: 新方向の設計は 2〜6 分、派生は 1〜3 分かかります。Cloud Run の `--timeout` は 3600 にしてください（`deploy.sh` 済み）。
- **インスタンス数**: プロジェクトは 1 つの JSON を読み書きします。`--max-instances 1` を推奨します（複数インスタンスでも保存時の世代番号照合で競合は検知・再試行されますが、サムネキャッシュ等は共有されません）。
- **認証**: 既定では未認証アクセスを許可しません。チーム利用は IAP（Identity-Aware Proxy）か `gcloud run services add-iam-policy-binding ... --role roles/run.invoker` で Google アカウントを許可してください。手軽に済ませる場合は `ALLOW_UNAUTH=1 APP_PASSWORD=xxxx ./deploy.sh`（`deploy.sh` の既定はこちら）。
- **モデルの変更**: `VERTEX_MODEL` / `VERTEX_IMAGE_MODEL` を差し替えるだけで済みます（`reasoning_effort` は Gemini 2.5 系では thinkingBudget、3 系では thinkingLevel に写像されます）。

## GAS 版からデータを移す

GAS 版の Drive フォルダ（`GENZO_FOLDER_ID`。`genzo_project.json` と `genzo_*.png`）を、稼働中のアプリ経由で保存先へ取り込みます。

1. Drive フォルダを「リンクを知っている全員が閲覧可」にするか、Cloud Run の実行サービスアカウントに閲覧共有する
2. `scripts/import-from-drive.sh <フォルダID> <アプリURL> <入室パスワード>`
   （`POST /api/admin/importFromDrive` を残数 0 まで繰り返す。画像は保存先に無いものだけ取り込み、全部揃ったら
   `genzo_project.json` を差し替える。差し替え前のものは `backups/` に退避）
3. アプリを開くと `_migrate` が現在の `SEED_REV` へ更新します（版・メモ・画像・参照・依頼は保持）

画像は GAS 版と同様にファイル名で参照するため、Drive のファイル ID は不要です。
実行サービスアカウントから Drive の一覧が取れない場合は `FILES_JSON=一覧.json`（`[{id,name,size}]`）を渡します。

## API の形

`google.script.run.<fn>(...args)` は `POST /api/<fn>` に置き換わっています。

```
POST /api/directInput
Content-Type: application/json
{"args":[{"directionId":"...","versionId":"...","input":{"type":"text","text":"..."}}]}

→ {"ok":true,"result":{...}}  /  {"ok":false,"error":"メッセージ"}
```

画面側は `public/index.html` の `gs()` だけがこの変換を担い、それ以外の画面コードは GAS 版と同じです。
画面とサーバのバージョン整合は従来どおり `UI_REV` と `SEED_REV` の一致で検査され、不一致は画面上部の黒帯で通知されます。
