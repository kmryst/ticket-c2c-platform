#!/usr/bin/env bash
# search-index-migrate CLI（deploy-service.yml の search index migration step が ECS run-task で
# 実行するもの）を実 OpenSearch に対して実行し、冪等性と失敗検出を確認する（Issue #538）。
#
# Usage:
#   search-index-migrate.integration.sh <opensearch-url>
#   例: search-index-migrate.integration.sh http://127.0.0.1:9200
#   事前に `npm run build` で dist を作っておく。
#
# 確認すること:
# 1. index が無い状態で実行 → exit 0、`{"index":"events","status":"ensured"}`、index が作成され
#    ticket_types が nested になっている。
# 2. index がある状態でもう一度実行 → exit 0（冪等）。mapping は変わらず、投入済み document も残る。
# 3. ticket_types が object になった index（dynamic mapping で壊れた状態）に実行 → exit 1。
#
# OpenSearch の `events` index を作成・削除する。共有の OpenSearch には使わない
# （CI の service container や、この検証専用に起動した local container に対して使う）。

set -euo pipefail

usage="usage: search-index-migrate.integration.sh <opensearch-url>"
url="${1:?$usage}"
url="${url%/}"
index="events"
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cli="${repo_root}/dist/src/search/search-index-migrate.cli.js"

if [[ ! -f $cli ]]; then
	echo "${cli} not found; run npm run build first" >&2
	exit 2
fi

fail() {
	echo "FAIL: $*" >&2
	exit 1
}

index_status() {
	curl -s -o /dev/null -w '%{http_code}' "${url}/${index}"
}

ticket_types_type() {
	curl -sf "${url}/${index}/_mapping" |
		jq -r --arg index "$index" '.[$index].mappings.properties.ticket_types.type // "object"'
}

# AWS_REGION を外し、local / CI の無署名 HTTP 経路で実行する（src/opensearch.ts）。
run_cli() {
	env -u AWS_REGION -u AWS_DEFAULT_REGION OPENSEARCH_ENDPOINT="$url" node "$cli"
}

curl -sf -X DELETE "${url}/${index}?ignore_unavailable=true" >/dev/null || true
[[ $(index_status) == "404" ]] || fail "index ${index} still exists before the test"
echo "precondition: index ${index} does not exist (HTTP 404)"

# 1. index が無い状態で実行する。
out=$(run_cli) || fail "first run exited non-zero"
echo "run 1 (index missing): exit 0 output=${out}"
[[ $(jq -c . <<<"$out") == '{"index":"events","status":"ensured"}' ]] || fail "unexpected output: ${out}"
[[ $(index_status) == "200" ]] || fail "index was not created"
[[ $(ticket_types_type) == "nested" ]] || fail "ticket_types is not nested after create"
mapping_after_first=$(curl -sf "${url}/${index}/_mapping" | jq -S -c .)

curl -sf -X PUT "${url}/${index}/_doc/idempotency-check?refresh=true" \
	-H 'Content-Type: application/json' -d '{"title":"idempotency-check"}' >/dev/null

# 2. index がある状態でもう一度実行する（冪等であること）。
out=$(run_cli) || fail "second run exited non-zero"
echo "run 2 (index exists): exit 0 output=${out}"
[[ $(jq -c . <<<"$out") == '{"index":"events","status":"ensured"}' ]] || fail "unexpected output: ${out}"
mapping_after_second=$(curl -sf "${url}/${index}/_mapping" | jq -S -c .)
[[ $mapping_after_first == "$mapping_after_second" ]] || fail "mapping changed on the second run"
[[ $(curl -sf "${url}/${index}/_count" | jq -r .count) == "1" ]] || fail "document was lost on the second run"
echo "mapping unchanged and document kept after run 2"

# 3. ticket_types が object になった index では exit 1 になること（deploy を止める）。
curl -sf -X DELETE "${url}/${index}" >/dev/null
curl -sf -X PUT "${url}/${index}" -H 'Content-Type: application/json' \
	-d '{"mappings":{"properties":{"ticket_types":{"type":"object"}}}}' >/dev/null
rc=0
err=$(run_cli 2>&1 >/dev/null) || rc=$?
echo "run 3 (ticket_types is object): exit ${rc} stderr=${err}"
[[ $rc == "1" ]] || fail "expected exit 1 for a broken mapping but got ${rc}"

curl -sf -X DELETE "${url}/${index}" >/dev/null
echo "search-index-migrate integration passed"
