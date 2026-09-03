#!/usr/bin/env bash
# GAS 版 GENZO の Drive フォルダ（genzo_project.json と genzo_*.png）を、稼働中の Cloud Run アプリ経由で
# 保存先バケットへ取り込む。アプリの /api/admin/importFromDrive を remaining が 0 になるまで繰り返し呼ぶ。
# 前提: Drive フォルダが「リンクを知っている全員が閲覧可」か、Cloud Run の実行サービスアカウントに共有されていること。
#
#   scripts/import-from-drive.sh <DriveフォルダID> [アプリURL] [入室パスワード]
#   例: scripts/import-from-drive.sh 1ySC-deOheU-cP89RDwfq-ZrbitB7sPeu https://genzo-xxxx.asia-northeast1.run.app genzo
# 任意: FILES_JSON=一覧JSON（[{id,name,size}]。実行 SA から Drive の一覧が取れない場合に渡す）
#       LIMIT=1回あたりの件数(既定40)  OVERWRITE=1 で既存も上書き  DRY_RUN=1 で取り込まずに件数だけ
set -euo pipefail
FOLDER_ID="${1:?DriveフォルダIDを指定}"
URL="${2:-${APP_URL:-https://genzo-1066908065074.asia-northeast1.run.app}}"
PASS="${3:-${APP_PASSWORD:-genzo}}"
LIMIT="${LIMIT:-40}"
BODY_EXTRA=""
[ "${OVERWRITE:-0}" = "1" ] && BODY_EXTRA="$BODY_EXTRA,\"overwrite\":true"
[ "${DRY_RUN:-0}" = "1" ] && BODY_EXTRA="$BODY_EXTRA,\"dryRun\":true"

round=0
while :; do
  round=$((round+1))
  if [ -n "${FILES_JSON:-}" ]; then
    BODY="$(python3 -c 'import json,sys; print(json.dumps({"folderId":sys.argv[1],"limit":int(sys.argv[2]),"files":json.load(open(sys.argv[3]))}))' "$FOLDER_ID" "$LIMIT" "$FILES_JSON")"
    BODY="${BODY%\}}${BODY_EXTRA}}"
  else
    BODY="{\"folderId\":\"${FOLDER_ID}\",\"limit\":${LIMIT}${BODY_EXTRA}}"
  fi
  RES="$(curl -sS --max-time 1800 -u "genzo:${PASS}" -H 'Content-Type: application/json' -d "$BODY" "${URL}/api/admin/importFromDrive")"
  echo "$RES" | python3 -c '
import json,sys
j=json.load(sys.stdin)
if not j.get("ok"): print("エラー:", j.get("error")); sys.exit(2)
r=j["result"]
print("round %s: listed=%s images=%s present=%s imported=%s errors=%s remaining=%s %.0fs" % (sys.argv[1], r["listed"], r["images"], r["alreadyPresent"], len(r["imported"]), len(r["errors"]), r["remaining"], r["ms"]/1000))
for n in r.get("notes",[]): print("  ", n)
for e in r["errors"][:10]: print("   NG", e["name"], e["error"])
if r.get("wouldImport") is not None: print("   dryRun:", len(r["wouldImport"]), "件を取り込む予定"); sys.exit(3)
if r.get("project"): print("   project:", json.dumps(r["project"], ensure_ascii=False))
sys.exit(0 if (r["remaining"]==0 and not r["errors"]) else 1)
' "$round" && break
  rc=$?
  [ "$rc" = "2" ] && exit 1
  [ "$rc" = "3" ] && exit 0
  [ "$round" -ge 60 ] && { echo "60回で打ち切り"; exit 1; }
done
echo "完了"
