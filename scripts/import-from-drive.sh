#!/usr/bin/env bash
# GAS 版の Drive フォルダ（genzo_project.json と genzo_*.png）を Cloud Storage へ移す。
# 手順:
#   1. Drive の GENZO_FOLDER_ID のフォルダを丸ごとダウンロード（Drive の Web UI で「ダウンロード」→ zip を展開）
#   2. ./scripts/import-from-drive.sh <展開したフォルダ> <バケット名> [prefix(既定 genzo/)]
# 画像は「ファイル名」で参照されるため、Drive のファイルIDは不要（JSON 内の fileId は無視される）。
set -euo pipefail
SRC="${1:?展開したフォルダのパスを指定してください}"
BUCKET="${2:?バケット名を指定してください}"
PREFIX="${3:-genzo/}"

if [ ! -f "${SRC}/genzo_project.json" ]; then
  echo "警告: ${SRC}/genzo_project.json が見つかりません（画像だけを移す場合はそのまま続行します）" >&2
fi
echo "== gs://${BUCKET}/${PREFIX} へアップロード"
gcloud storage cp "${SRC}"/genzo_project.json "gs://${BUCKET}/${PREFIX}" 2>/dev/null || true
gcloud storage cp "${SRC}"/genzo_*.png "gs://${BUCKET}/${PREFIX}" 2>/dev/null || true
gcloud storage cp "${SRC}"/genzo_*.jpg "gs://${BUCKET}/${PREFIX}" 2>/dev/null || true
echo "== 完了。サムネイルは初回表示時にサーバが生成します（thumbs/ 配下）"
