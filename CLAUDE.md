# GENZO 運用ルール（Claude Code セッション向け）

GAS 版 GENZO（ビジュアル意思決定ワークスペース）を Cloud Run + Vertex AI に移植したもの。構成は README.md。

## 鉄則（セッションをまたぐ既知の事実。推測で答える前にここと env を見る）

- **能力の有無は env と実測で確認してから言う**。「できない」「認証情報がない」と言う前に必ず
  `env | grep -iE "gcp|google|cloudsdk"` を見る。
  （`mt2pcs/dialogue` と同じ SessionStart フック `session_brief.sh` を置きたかったが、auto モードの分類器が
  フックスクリプトの作成を拒否した。手元で `dialogue/.claude/hooks/session_brief.sh` を写して置けば自動注入になる）
- **自分の知識が古い前提で動く**。手順・環境・過去の判断は、このファイル → 同じ環境の姉妹リポジトリ
  （`mt2pcs/dialogue` の CLAUDE.md と `tools/deploy_cloudrun.sh`）→ `list_sessions`（Claude Code Remote MCP）
  の順に**実物を読んで**確認する。ユーザーに「他セッションではどうしていますか」と聞くのは、これら全部を
  読んでからにする（2026-09-02 の事故: 読まずに3ターン質問を返し、会話が成立しなかった）
- **報告の作法**: 謝罪や自己弁護を書かない。「原因（事実）」「やったこと」「ユーザーの判断が要ること」だけを書く。
  問いに答えるときは答えだけ。判断を求めるときは判断できる材料（選択肢と根拠）を添える
- **事故や新しい環境知識が出たら、その場でこのファイルかスクリプトに焼き込む**（申し送りは文章でなく実行可能な形で）

## デプロイ（Cloud Run）— 既知の事実

- **push すれば自動でデプロイされる**（`.github/workflows/deploy.yml` が `bash deploy.sh` を実行）。セッションから直接
  デプロイする必要はない。前提は GitHub リポジトリの Secret `GCP_SA_KEY`（一度だけユーザーが設定）。結果は
  GitHub の Actions タブか `actions_list` / `actions_get`（GitHub MCP）で確認する。失敗していたらログを読んで直して push する
- **この Claude Code クラウド環境（env_01H8sS28LBDHFeKb8Wuo8AXt）には GCP 認証が設定済み**:
  環境変数 `GCP_SA_KEY` = サービスアカウントキー `love-coach-deployer@love-coach-sprint0`。
  外側の `{}` を欠いた形で格納されている（`deploy.sh` が両対応で吸収する）。
  **プロジェクト ID は love-coach-sprint0**。名前は別アプリ由来だが、思考の炉（shiko-no-ro）など
  このユーザーの Cloud Run アプリはすべてこのプロジェクトに同居している。別プロジェクトへ出すには別の鍵が要る
- 手動実行は `bash deploy.sh` の1コマンド（gcloud 導入・認証・バケット作成・権限・デプロイ・配信検証まで自己完結）。
  既定: service=genzo, region=asia-northeast1, bucket=love-coach-sprint0-genzo, ログイン genzo/genzo（画面は /login）
- `CLOUDSDK_AUTH_ACCESS_TOKEN` も環境にあるが失効・権限不足で使えないことがある。`deploy.sh` は unset して鍵を優先する
- **セッションから手動でデプロイする場合は default（手動承認）権限モードで実行する**。auto モードでは認証情報を扱う
  コマンドが承認制になり `bash deploy.sh` が通らない（2026-09-02 に確認）。auto モードのセッションにいる場合は
  `create_session`（Claude Code Remote MCP）で `permission_mode: "default"` の子セッションを起こして
  `bash deploy.sh` を指示し、ユーザーが Web UI で承認する（daward の「É MOOMENTS デプロイ最終実行」
  2026-08-25 がこの方式で成功）。同じことを繰り返し試して分類器を突破しようとしない
- 配信検証は `deploy.sh` の 3/4 が行う（/healthz と /api/getProject）。URL は完了時に表示される

## 開発

- `npm test`（LLM モックの通しテスト）と `npm run check`（構文）を push 前に通す
- 画面とサーバのバージョン整合は `public/index.html` の `UI_REV` と `server/genzo.js` の `SEED_REV`。
  シードを直したら両方を同じ数字に上げる
- Vertex AI のモデルは環境変数（`VERTEX_MODEL` / `VERTEX_IMAGE_MODEL`）で差し替える。コードに固定しない
