#!/usr/bin/env bash
# GENZO を Cloud Run にデプロイする（ソースデプロイ）。
# 使い方:
#   PROJECT_ID=my-proj GCS_BUCKET=my-genzo-bucket ./deploy.sh
# 任意の環境変数: REGION(既定 asia-northeast1) SERVICE(既定 genzo) VERTEX_LOCATION(既定 global)
#                  VERTEX_MODEL VERTEX_IMAGE_MODEL APP_BASIC_AUTH("user:pass") ALLOW_UNAUTH(1 で公開)
set -euo pipefail

: "${PROJECT_ID:?PROJECT_ID を指定してください}"
: "${GCS_BUCKET:?GCS_BUCKET（プロジェクトJSONと画像の保存先バケット）を指定してください}"
REGION="${REGION:-asia-northeast1}"
SERVICE="${SERVICE:-genzo}"
VERTEX_LOCATION="${VERTEX_LOCATION:-global}"
VERTEX_MODEL="${VERTEX_MODEL:-gemini-2.5-pro}"
VERTEX_IMAGE_MODEL="${VERTEX_IMAGE_MODEL:-gemini-2.5-flash-image}"
VERTEX_IMAGE_LOCATION="${VERTEX_IMAGE_LOCATION:-us-central1}"
SA_NAME="${SA_NAME:-genzo-run}"
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "== API 有効化"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com aiplatform.googleapis.com storage.googleapis.com >/dev/null

echo "== バケット（存在しなければ作成）"
if ! gcloud storage buckets describe "gs://${GCS_BUCKET}" >/dev/null 2>&1; then
  gcloud storage buckets create "gs://${GCS_BUCKET}" --location="$REGION" --uniform-bucket-level-access
fi

echo "== サービスアカウント"
if ! gcloud iam service-accounts describe "$SA" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$SA_NAME" --display-name="GENZO Cloud Run"
fi
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${SA}" --role="roles/aiplatform.user" --condition=None >/dev/null
gcloud storage buckets add-iam-policy-binding "gs://${GCS_BUCKET}" --member="serviceAccount:${SA}" --role="roles/storage.objectAdmin" >/dev/null

ENV_VARS="STORAGE=gcs,GCS_BUCKET=${GCS_BUCKET},GCS_PREFIX=genzo/,LLM_PROVIDER=vertex,VERTEX_PROJECT=${PROJECT_ID},VERTEX_LOCATION=${VERTEX_LOCATION},VERTEX_MODEL=${VERTEX_MODEL},VERTEX_IMAGE_MODEL=${VERTEX_IMAGE_MODEL},VERTEX_IMAGE_LOCATION=${VERTEX_IMAGE_LOCATION}"
if [ -n "${APP_BASIC_AUTH:-}" ]; then ENV_VARS="${ENV_VARS},APP_BASIC_AUTH=${APP_BASIC_AUTH}"; fi

AUTH_FLAG="--no-allow-unauthenticated"
if [ "${ALLOW_UNAUTH:-0}" = "1" ]; then AUTH_FLAG="--allow-unauthenticated"; fi

echo "== デプロイ（生成は数分かかるため timeout=3600、状態整合のため max-instances=1）"
gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --service-account "$SA" \
  --timeout 3600 \
  --cpu 2 --memory 2Gi \
  --concurrency 40 \
  --min-instances 0 --max-instances 1 \
  --set-env-vars "$ENV_VARS" \
  $AUTH_FLAG

echo "== 完了"
gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)'
