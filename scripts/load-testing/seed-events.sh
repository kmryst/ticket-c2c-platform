#!/usr/bin/env bash
# ファイル概要:
# purchase-spike.js 用のイベントと在庫を対象環境（dev / staging）の API 経由で作成する seed スクリプトです。
# 人気イベント（hot）1 件と分散負荷用イベント（background）N 件を作成し、
# k6 実行に必要な環境変数（HOT_EVENT_ID / BG_EVENT_IDS）を標準出力へ export 形式で出します。
#
# 使い方:
#   ./scripts/load-testing/seed-events.sh https://ticket-app-dev.ticket-c2c.click/api
#   （出力された export 行を eval するか、コピーして環境変数に設定する）

set -euo pipefail

BASE_URL="${1:?usage: seed-events.sh <BASE_URL> [HOT_INVENTORY] [BG_COUNT] [BG_INVENTORY]}"
# HOT_INVENTORY: 人気イベントの在庫数。HOT_RATE × 継続時間の途中で売り切れる値にすると、
# 「在庫あり期間のロック競合」と「売り切れ後の前段拒否」の両方を 1 回の試験で観測できる。
HOT_INVENTORY="${2:-6000}"
BG_COUNT="${3:-4}"
BG_INVENTORY="${4:-100000}"

RUN_ID="$(date +%Y%m%d-%H%M%S)"

create_event() {
	local title="$1"
	local quantity="$2"

	curl -sS -f -X POST "${BASE_URL}/events" \
		-H 'Content-Type: application/json' \
		-d "{\"title\":\"${title}\",\"eventType\":\"load-test\",\"startsAt\":\"2026-08-01T10:00:00Z\",\"totalQuantity\":${quantity}}" |
		sed -n 's/.*"eventId":"\([^"]*\)".*/\1/p'
}

hot_id="$(create_event "spike-${RUN_ID}-hot" "${HOT_INVENTORY}")"
[[ -n $hot_id ]] || {
	echo "Error: failed to create hot event" >&2
	exit 1
}

bg_ids=()
for i in $(seq 1 "${BG_COUNT}"); do
	id="$(create_event "spike-${RUN_ID}-bg-${i}" "${BG_INVENTORY}")"
	[[ -n $id ]] || {
		echo "Error: failed to create background event ${i}" >&2
		exit 1
	}
	bg_ids+=("$id")
done

bg_joined="$(
	IFS=,
	echo "${bg_ids[*]}"
)"

echo "export BASE_URL=${BASE_URL}"
echo "export HOT_EVENT_ID=${hot_id}"
echo "export BG_EVENT_IDS=${bg_joined}"
