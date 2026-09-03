#!/usr/bin/env bash
# GENZO を Cloud Run にデプロイする（自己完結）。
#
#   - gcloud が無ければ自動で導入する（$HOME/google-cloud-sdk）
#   - 未認証なら環境変数 GCP_SA_KEY（Claude Code クラウド環境に設定済みのサービスアカウントキー）から認証する。
#     ローカルの gcloud 認証があればそれを使う
#   - プロジェクトIDは PROJECT_ID 未指定なら認証アカウント（xxx@PROJECT.iam.gserviceaccount.com）から導出する
#   → クラウドセッションでもローカルでも `bash deploy.sh` の1コマンドでよい
#
# 使い方:
#   bash deploy.sh
#   PROJECT_ID=xxx GCS_BUCKET=yyy REGION=asia-northeast1 SERVICE=genzo bash deploy.sh
# 任意: LLM_PROVIDER(openai | vertex。未指定なら OpenAI のキーが使えれば openai、無ければ vertex)
#       OPENAI_API_KEY OPENAI_MODEL(既定 gpt-5.5) OPENAI_IMAGE_MODEL(既定 gpt-image-2) OPENAI_BASE_URL — GAS 版と同じ設定
#       OPENAI_SECRET_NAME(既定 openai-api-key): OpenAI キーの置き場は GCP Secret Manager（プロジェクト横断で 1 回だけ設定）。
#         - OPENAI_API_KEY が環境にあれば Secret Manager に書き込む（無ければ作成、値が変わっていれば新版を追加）
#         - 無くても Secret Manager に既にあれば、それを Cloud Run に --set-secrets で渡す
#         → GitHub の Secret はリポジトリごとに要らない。どのアプリも同じ秘密を参照する
#       VERTEX_LOCATION(既定 global) VERTEX_MODEL VERTEX_IMAGE_MODEL VERTEX_IMAGE_LOCATION
#       APP_PASSWORD(入室パスワード、既定 genzo) ALLOW_UNAUTH(既定 1 = Cloud Run は公開・パスワードで保護)
#       RUNTIME_SA(実行サービスアカウント。未指定なら作成を試み、権限がなければ既定のコンピュート SA を使う)
set -euo pipefail
cd "$(dirname "$0")"

echo "== 0/4 gcloud の準備 =="
# 失効しがちなセッショントークンより、恒久のサービスアカウントキーを優先する
unset CLOUDSDK_AUTH_ACCESS_TOKEN || true
export CLOUDSDK_CORE_DISABLE_PROMPTS=1

if ! command -v gcloud >/dev/null 2>&1; then
  if [ ! -x "$HOME/google-cloud-sdk/bin/gcloud" ]; then
    echo "gcloud が無いので導入する..."
    curl -sSL https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-linux-x86_64.tar.gz \
      | tar -xz -C "$HOME"
  fi
  export PATH="$HOME/google-cloud-sdk/bin:$PATH"
fi

if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | grep -q .; then
  if [ -n "${GCP_SA_KEY:-}" ]; then
    echo "GCP_SA_KEY から認証する..."
    # 鍵の正規化: 環境変数や GitHub Secret に入る形はまちまち（外側の {} 欠落、前後の空白や引用符、
    # "GCP_SA_KEY=" 接頭辞、秘密鍵内の生改行）。JSON として読める形に直してから gcloud に渡す。
    # 出力するのは診断（キー名・project_id・client_email）だけで、秘密鍵は表示しない
    KEY_FILE="$(mktemp)"; chmod 600 "$KEY_FILE"
    GCP_SA_KEY="$GCP_SA_KEY" python3 - "$KEY_FILE" <<'PY'
import sys, os, json, re
s = os.environ.get('GCP_SA_KEY', '').strip()
s = re.sub(r'^(export\s+)?GCP_SA_KEY\s*=\s*', '', s).strip()
if s.startswith("'") or (s.startswith('"') and not s.startswith('"type')):
    s = s[1:].strip()
if not s.startswith('{'):
    s = '{' + s + '}'
d = None
for _ in range(6):  # 末尾に付いた引用符や別の環境変数行などの余分を、解析エラー位置で切り落として再試行
    try:
        d = json.loads(s, strict=False)  # strict=False: 秘密鍵内の生改行を許容
        break
    except json.JSONDecodeError as e:
        pos = e.pos
        if pos <= 1:
            break
        if e.msg.startswith('Extra data'):
            s = s[:pos].rstrip()
        elif e.msg.startswith('Expecting'):
            s = s[:pos].rstrip().rstrip(',').rstrip() + '}'
        else:
            break
if d is None:
    try:
        json.loads(s, strict=False)
    except Exception as e:
        sys.stderr.write('GCP_SA_KEY を JSON として読めません: %s（先頭12文字: %r、長さ %d）\n' % (e, s[:12], len(s)))
    sys.exit(1)
missing = [k for k in ('type', 'project_id', 'private_key', 'client_email', 'token_uri') if k not in d]
if missing:
    sys.stderr.write('GCP_SA_KEY に必要なフィールドがありません: %s（あるキー: %s）\n' % (missing, sorted(d.keys())))
    sys.exit(1)
with open(sys.argv[1], 'w') as f:
    json.dump(d, f)
print('   鍵: project_id=%s client_email=%s' % (d.get('project_id'), d.get('client_email')))
PY
    gcloud auth activate-service-account --key-file="$KEY_FILE"
    rm -f "$KEY_FILE"
  else
    echo "エラー: gcloud が未認証で GCP_SA_KEY も無い。gcloud auth login を先に実行すること" >&2
    exit 1
  fi
fi

ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"
if [ -z "${PROJECT_ID:-}" ]; then
  case "$ACCOUNT" in
    *@*.iam.gserviceaccount.com) PROJECT_ID="${ACCOUNT#*@}"; PROJECT_ID="${PROJECT_ID%%.*}" ;;
    *) PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)" ;;
  esac
fi
: "${PROJECT_ID:?PROJECT_ID を特定できません。PROJECT_ID=... を指定してください}"
gcloud config set project "$PROJECT_ID" -q >/dev/null

REGION="${REGION:-asia-northeast1}"
SERVICE="${SERVICE:-genzo}"
GCS_BUCKET="${GCS_BUCKET:-${PROJECT_ID}-genzo}"
VERTEX_LOCATION="${VERTEX_LOCATION:-global}"
VERTEX_MODEL="${VERTEX_MODEL:-gemini-2.5-pro}"
VERTEX_IMAGE_MODEL="${VERTEX_IMAGE_MODEL:-gemini-2.5-flash-image}"
VERTEX_IMAGE_LOCATION="${VERTEX_IMAGE_LOCATION:-us-central1}"
APP_PASSWORD="${APP_PASSWORD:-genzo}"
ALLOW_UNAUTH="${ALLOW_UNAUTH:-1}"
OPENAI_MODEL="${OPENAI_MODEL:-gpt-5.5}"
OPENAI_IMAGE_MODEL="${OPENAI_IMAGE_MODEL:-gpt-image-2}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}"
OPENAI_SECRET_NAME="${OPENAI_SECRET_NAME:-openai-api-key}"
echo "   account=${ACCOUNT} project=${PROJECT_ID} region=${REGION} service=${SERVICE} bucket=gs://${GCS_BUCKET}"

echo "== 1/4 API・バケット・実行サービスアカウント（権限が無い項目は警告して続行） =="
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com aiplatform.googleapis.com storage.googleapis.com drive.googleapis.com secretmanager.googleapis.com >/dev/null 2>&1 \
  || echo "   警告: API の有効化に失敗（既に有効か、serviceusage の権限なし）。続行する"

if ! gcloud storage buckets describe "gs://${GCS_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${GCS_BUCKET}" --location="$REGION" --uniform-bucket-level-access \
    || { echo "エラー: バケット gs://${GCS_BUCKET} を作成できません（別名を GCS_BUCKET= で指定するか、権限を確認）" >&2; exit 1; }
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>/dev/null || true)"
SA_FLAG=()
RUNTIME_SA_EMAIL=""
if [ -n "${RUNTIME_SA:-}" ]; then
  SA_FLAG=(--service-account "$RUNTIME_SA"); RUNTIME_SA_EMAIL="$RUNTIME_SA"
else
  SA_NAME="genzo-run"
  SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
  if gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 \
     || gcloud iam service-accounts create "$SA_NAME" --display-name="GENZO Cloud Run" >/dev/null 2>&1; then
    if gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA}" --role="roles/aiplatform.user" --condition=None >/dev/null 2>&1 \
       && gcloud storage buckets add-iam-policy-binding "gs://${GCS_BUCKET}" --member="serviceAccount:${SA}" --role="roles/storage.objectAdmin" >/dev/null 2>&1; then
      SA_FLAG=(--service-account "$SA"); RUNTIME_SA_EMAIL="$SA"
      echo "   実行SA: ${SA}（Vertex AI User + バケットの Object Admin）"
    else
      echo "   警告: ${SA} への権限付与ができないため、既定のコンピュート SA で実行する"
    fi
  else
    echo "   警告: 実行用サービスアカウントを作成できないため、既定のコンピュート SA で実行する"
  fi
  if [ ${#SA_FLAG[@]} -eq 0 ] && [ -n "$PROJECT_NUMBER" ]; then
    DEFAULT_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"; RUNTIME_SA_EMAIL="$DEFAULT_SA"
    gcloud storage buckets add-iam-policy-binding "gs://${GCS_BUCKET}" --member="serviceAccount:${DEFAULT_SA}" --role="roles/storage.objectAdmin" >/dev/null 2>&1 \
      || echo "   警告: 既定SA(${DEFAULT_SA})へバケット権限を付与できない（Editor 権限があれば不要）"
    gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${DEFAULT_SA}" --role="roles/aiplatform.user" --condition=None >/dev/null 2>&1 \
      || echo "   警告: 既定SA(${DEFAULT_SA})へ Vertex AI User を付与できない（Editor 権限があれば不要）"
  fi
fi

# OpenAI キー: Secret Manager を正とする（プロジェクト内の全アプリで共有。GitHub の Secret はリポジトリごとに要らない）
OPENAI_SECRET_OK=0
if [ -n "${OPENAI_API_KEY:-}" ]; then
  if ! gcloud secrets describe "$OPENAI_SECRET_NAME" >/dev/null 2>&1; then
    gcloud secrets create "$OPENAI_SECRET_NAME" --replication-policy=automatic >/dev/null 2>&1 \
      && echo "   Secret Manager: ${OPENAI_SECRET_NAME} を作成" \
      || echo "   警告: Secret Manager に ${OPENAI_SECRET_NAME} を作成できない（権限）。今回は環境変数で渡す"
  fi
  if gcloud secrets describe "$OPENAI_SECRET_NAME" >/dev/null 2>&1; then
    CUR="$(gcloud secrets versions access latest --secret="$OPENAI_SECRET_NAME" 2>/dev/null || true)"
    if [ "$CUR" != "$OPENAI_API_KEY" ]; then
      printf %s "$OPENAI_API_KEY" | gcloud secrets versions add "$OPENAI_SECRET_NAME" --data-file=- >/dev/null 2>&1 \
        && echo "   Secret Manager: ${OPENAI_SECRET_NAME} に新しい版を追加" \
        || echo "   警告: ${OPENAI_SECRET_NAME} に版を追加できない（権限）"
    fi
    [ "$(gcloud secrets versions access latest --secret="$OPENAI_SECRET_NAME" 2>/dev/null || true)" = "$OPENAI_API_KEY" ] && OPENAI_SECRET_OK=1
  fi
elif gcloud secrets versions access latest --secret="$OPENAI_SECRET_NAME" >/dev/null 2>&1; then
  OPENAI_SECRET_OK=1
  echo "   Secret Manager: ${OPENAI_SECRET_NAME} を使う（環境に OPENAI_API_KEY は無いが既に登録済み）"
fi
if [ "$OPENAI_SECRET_OK" = 1 ] && [ -n "$RUNTIME_SA_EMAIL" ]; then
  gcloud secrets add-iam-policy-binding "$OPENAI_SECRET_NAME" --member="serviceAccount:${RUNTIME_SA_EMAIL}" --role="roles/secretmanager.secretAccessor" >/dev/null 2>&1 || true
  if ! gcloud secrets get-iam-policy "$OPENAI_SECRET_NAME" --format=json 2>/dev/null | grep -q "serviceAccount:${RUNTIME_SA_EMAIL}"; then
    if [ -n "${OPENAI_API_KEY:-}" ]; then
      echo "   警告: ${RUNTIME_SA_EMAIL} に ${OPENAI_SECRET_NAME} の読み取り権限を付与できない。今回は環境変数で渡す"; OPENAI_SECRET_OK=0
    else
      echo "   警告: ${RUNTIME_SA_EMAIL} に ${OPENAI_SECRET_NAME} の読み取り権限が無い。GCP コンソールで Secret Manager → ${OPENAI_SECRET_NAME} → 権限 に Secret Accessor を付与すること"
    fi
  fi
fi

if [ -z "${LLM_PROVIDER:-}" ]; then
  if [ "$OPENAI_SECRET_OK" = 1 ] || [ -n "${OPENAI_API_KEY:-}" ]; then LLM_PROVIDER=openai; else LLM_PROVIDER=vertex; fi
fi
if [ "$LLM_PROVIDER" = "openai" ] && [ "$OPENAI_SECRET_OK" != 1 ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "エラー: LLM_PROVIDER=openai だが OpenAI のキーが無い（Secret Manager の ${OPENAI_SECRET_NAME} か環境変数 OPENAI_API_KEY）" >&2; exit 1
fi
echo "   llm=${LLM_PROVIDER} $([ "$LLM_PROVIDER" = openai ] && echo "${OPENAI_MODEL} / ${OPENAI_IMAGE_MODEL} (キー: $([ "$OPENAI_SECRET_OK" = 1 ] && echo "Secret Manager/${OPENAI_SECRET_NAME}" || echo 環境変数))" || echo "${VERTEX_MODEL} / ${VERTEX_IMAGE_MODEL}")"

echo "== 2/4 Cloud Run デプロイ (project=${PROJECT_ID}, service=${SERVICE}, region=${REGION}) =="
# 区切り文字を ^|^ にして、値にカンマや URL が含まれても壊れないようにする
ENV_VARS="^|^STORAGE=gcs|GCS_BUCKET=${GCS_BUCKET}|GCS_PREFIX=genzo/|LLM_PROVIDER=${LLM_PROVIDER}|VERTEX_PROJECT=${PROJECT_ID}|VERTEX_LOCATION=${VERTEX_LOCATION}|VERTEX_MODEL=${VERTEX_MODEL}|VERTEX_IMAGE_MODEL=${VERTEX_IMAGE_MODEL}|VERTEX_IMAGE_LOCATION=${VERTEX_IMAGE_LOCATION}"
ENV_VARS="${ENV_VARS}|OPENAI_MODEL=${OPENAI_MODEL}|OPENAI_IMAGE_MODEL=${OPENAI_IMAGE_MODEL}|OPENAI_BASE_URL=${OPENAI_BASE_URL}"
SECRET_FLAG=(--clear-secrets)
if [ "$OPENAI_SECRET_OK" = 1 ]; then SECRET_FLAG=(--set-secrets "OPENAI_API_KEY=${OPENAI_SECRET_NAME}:latest")
elif [ -n "${OPENAI_API_KEY:-}" ]; then ENV_VARS="${ENV_VARS}|OPENAI_API_KEY=${OPENAI_API_KEY}"; fi
if [ -n "$APP_PASSWORD" ]; then ENV_VARS="${ENV_VARS}|APP_PASSWORD=${APP_PASSWORD}"; fi
AUTH_FLAG="--no-allow-unauthenticated"
if [ "$ALLOW_UNAUTH" = "1" ]; then AUTH_FLAG="--allow-unauthenticated"; fi

# 生成は数分かかるため timeout=3600、単一 JSON を読み書きするため max-instances=1
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  "${SA_FLAG[@]}" \
  --timeout 3600 \
  --cpu 2 --memory 2Gi \
  --concurrency 40 \
  --min-instances 0 --max-instances 1 \
  --set-env-vars "$ENV_VARS" \
  "${SECRET_FLAG[@]}" \
  $AUTH_FLAG

echo "== 3/4 配信検証 =="
LIVE_URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format 'value(status.url)')"
AUTH_OPT=()
if [ -n "$APP_PASSWORD" ]; then AUTH_OPT=(-u "genzo:${APP_PASSWORD}"); fi
HEALTH="$(curl -sf "${AUTH_OPT[@]}" "${LIVE_URL}/api/health" || true)"
echo "   /api/health: ${HEALTH:-(応答なし)}"
case "$HEALTH" in
  *'"ok":true'*) ;;
  *) echo "配信検証: 不合格 — /api/health が ok を返さない" >&2; exit 1 ;;
esac
PROJ_OK="$(curl -sf "${AUTH_OPT[@]}" -X POST -H 'Content-Type: application/json' -d '{"args":[]}' "${LIVE_URL}/api/getProject" | head -c 200 || true)"
case "$PROJ_OK" in
  *'"ok":true'*) echo "   /api/getProject: ok（プロジェクトJSONを gs://${GCS_BUCKET} に初期化済み）" ;;
  *) echo "配信検証: 不合格 — /api/getProject が失敗: ${PROJ_OK}" >&2; exit 1 ;;
esac
case "$HEALTH" in
  *'"llm":"'"$LLM_PROVIDER"*) echo "   llm: ${LLM_PROVIDER} で稼働" ;;
  *) echo "配信検証: 不合格 — /api/health の llm が ${LLM_PROVIDER} でない" >&2; exit 1 ;;
esac
echo "== 4/4 完了。${LIVE_URL} を開く（入室パスワードは APP_PASSWORD） =="
