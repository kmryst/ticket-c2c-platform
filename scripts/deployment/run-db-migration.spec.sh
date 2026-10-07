#!/usr/bin/env bash
# run-db-migration.sh のテスト（Issue #538）。
# AWS CLI をスタブに置き換え、mode ごとの command override と、container の exit code が
# script の exit code に反映されること（非 0 なら exit 1 で deploy を止める）を確認する。
# AWS へは接続しない。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
script="${script_dir}/run-db-migration.sh"

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

stub_dir="${work_dir}/bin"
mkdir -p "$stub_dir"

cat >"${stub_dir}/aws" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >>"${STUB_WORK_DIR}/calls.log"
case "$1 $2" in
"ecs describe-services")
	jq -cn '{
		taskDefinition: "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/stub-api:7",
		networkConfiguration: {awsvpcConfiguration: {subnets: ["subnet-a", "subnet-b"], securityGroups: ["sg-api"]}}
	}'
	;;
"ecs describe-task-definition")
	jq -cn '{
		containerDefinitions: [{
			name: "stub-api",
			image: "111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/stub:abcdef0",
			logConfiguration: {options: {"awslogs-group": "/ecs/stub-api", "awslogs-stream-prefix": "ecs"}}
		}]
	}'
	;;
"ecs run-task")
	prev=""
	for arg in "$@"; do
		if [[ $prev == "--overrides" ]]; then
			echo "$arg" >"${STUB_WORK_DIR}/overrides.json"
		fi
		if [[ $prev == "--task-definition" ]]; then
			echo "$arg" >"${STUB_WORK_DIR}/task-definition.txt"
		fi
		if [[ $prev == "--started-by" ]]; then
			echo "$arg" >"${STUB_WORK_DIR}/started-by.txt"
		fi
		prev=$arg
	done
	echo "arn:aws:ecs:ap-northeast-1:111122223333:task/stub-cluster/0123456789abcdef"
	;;
"ecs wait")
	exit 0
	;;
"ecs describe-tasks")
	jq -cn --argjson code "$STUB_EXIT_CODE" '{
		stoppedReason: "Essential container in task exited",
		containers: [{name: "otel-collector", exitCode: 0}, {name: "stub-api", exitCode: $code}]
	}'
	;;
"logs get-log-events")
	jq -cn --arg line "$STUB_LOG_LINE" '[$line]'
	;;
"ecs stop-task")
	echo "unexpected stop-task" >&2
	exit 1
	;;
*)
	echo "unexpected aws call: $*" >&2
	exit 99
	;;
esac
STUB
chmod +x "${stub_dir}/aws"

cat >"${stub_dir}/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "${stub_dir}/sleep"

NEW_TD="arn:aws:ecs:ap-northeast-1:111122223333:task-definition/stub-api:8"

# run_case <label> <mode> <container exit code> <log line> <expected exit>
run_case() {
	local label=$1 mode=$2 code=$3 log_line=$4 expected=$5
	rm -f "${work_dir}"/{calls.log,overrides.json,task-definition.txt,started-by.txt}
	local actual=0
	env PATH="${stub_dir}:${PATH}" \
		STUB_WORK_DIR="$work_dir" \
		STUB_EXIT_CODE="$code" \
		STUB_LOG_LINE="$log_line" \
		bash "$script" stub-cluster stub-api "$NEW_TD" "$mode" \
		>"${work_dir}/${label}.stdout" 2>"${work_dir}/${label}.stderr" || actual=$?
	if [[ $actual != "$expected" ]]; then
		echo "FAIL ${label}: expected exit ${expected} but got ${actual}" >&2
		cat "${work_dir}/${label}.stdout" "${work_dir}/${label}.stderr" >&2
		exit 1
	fi
	echo "ok   ${label}: exit ${actual}"
}

expect_equal() {
	local label=$1 expected=$2 actual=$3
	if [[ $actual != "$expected" ]]; then
		echo "FAIL ${label}: expected '${expected}' but got '${actual}'" >&2
		exit 1
	fi
}

# 1. search-index-migration 成功: search-index-migrate CLI を新 task definition で実行し exit 0。
run_case search-index-ok search-index-migration 0 '{"index":"events","status":"ensured"}' 0
expect_equal "search-index command" '["node","dist/src/search/search-index-migrate.cli.js"]' \
	"$(jq -c '.containerOverrides[0].command' "${work_dir}/overrides.json")"
expect_equal "search-index container" "stub-api" \
	"$(jq -r '.containerOverrides[0].name' "${work_dir}/overrides.json")"
expect_equal "search-index task definition" "$NEW_TD" "$(cat "${work_dir}/task-definition.txt")"
expect_equal "search-index startedBy" "search-index-migrate" "$(cat "${work_dir}/started-by.txt")"
grep -q "Search index migration completed successfully" "${work_dir}/search-index-ok.stdout" ||
	{ echo "FAIL search-index-ok: success message missing" >&2; exit 1; }
grep -q '"status":"ensured"' "${work_dir}/search-index-ok.stdout" ||
	{ echo "FAIL search-index-ok: task log missing" >&2; exit 1; }

# 2. search-index-migration 失敗: container exit 1（OpenSearch エラー）→ script exit 1（deploy を止める）。
run_case search-index-failed search-index-migration 1 \
	'{"error":"mapper [ticket_types] cannot be changed from type [object] to [nested]"}' 1
grep -q "Search index migration task failed" "${work_dir}/search-index-failed.stderr" ||
	{ echo "FAIL search-index-failed: failure message missing" >&2; exit 1; }

# 3. 既存 mode（migration）の command override が変わっていないこと（回帰）。
run_case migration-ok migration 0 'migrations applied' 0
expect_equal "migration command" '["node","dist/src/database/run-migrations.js"]' \
	"$(jq -c '.containerOverrides[0].command' "${work_dir}/overrides.json")"
expect_equal "migration startedBy" "db-migrate" "$(cat "${work_dir}/started-by.txt")"

# 4. migration 失敗 → exit 1（回帰）。
run_case migration-failed migration 1 'migration error' 1

# 5. 未知の mode → exit 2（run-task を呼ばない）。
run_case unknown-mode search-index-migrate 0 '' 2
if grep -q "run-task" "${work_dir}/calls.log" 2>/dev/null; then
	echo "FAIL unknown-mode: run-task was called" >&2
	exit 1
fi

echo "run-db-migration fixtures passed"
