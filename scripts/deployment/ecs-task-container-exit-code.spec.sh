#!/usr/bin/env bash
# ecs_task_container_exit_code のfixtureテスト（Issue #363）。
# describe-tasksのcontainers[]配列順序に依存せず、container名一致で
# app containerのexitCodeを取得できることを確認する。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/deployment/ecs-task-container-exit-code.sh
source "${script_dir}/ecs-task-container-exit-code.sh"

expect_equal() {
	local label=$1
	local expected=$2
	local actual=$3
	if [[ $actual != "$expected" ]]; then
		echo "expected '${expected}' but got '${actual}': ${label}" >&2
		exit 1
	fi
}

# 1. sidecarが配列先頭、appが2番目（Issue #363の再現taskと同じ並び）。
#    appのexitCode=0が、sidecarのexitCode=2に引きずられず取得できること。
sidecar_first_task=$(jq -cn '{
	containers: [
		{name: "otel-collector", exitCode: 2},
		{name: "ticket-c2c-staging-api", exitCode: 0}
	]
}')
exit_code=$(ecs_task_container_exit_code "$sidecar_first_task" "ticket-c2c-staging-api")
expect_equal "sidecar-first array: app exitCode" "0" "$exit_code"

# 2. appが配列先頭、sidecarが2番目（旧dev成功run相当の並び）でも同じ結果になること。
app_first_task=$(jq -cn '{
	containers: [
		{name: "ticket-c2c-dev-api", exitCode: 0},
		{name: "otel-collector", exitCode: 2}
	]
}')
exit_code=$(ecs_task_container_exit_code "$app_first_task" "ticket-c2c-dev-api")
expect_equal "app-first array: app exitCode" "0" "$exit_code"

# 3. fail-closed回帰: app自体が異常終了（exitCode=1）した場合、
#    sidecarの終了コード（配列順序に関わらず）に関わらずappの非0コードを検知できること。
app_failure_sidecar_first_task=$(jq -cn '{
	containers: [
		{name: "otel-collector", exitCode: 0},
		{name: "ticket-c2c-staging-api", exitCode: 1}
	]
}')
exit_code=$(ecs_task_container_exit_code "$app_failure_sidecar_first_task" "ticket-c2c-staging-api")
expect_equal "app failure detected regardless of array order" "1" "$exit_code"

# 4. 該当containerが見つからない場合は "none" を返すこと（既存の `// "none"` fallback踏襲）。
no_match_task=$(jq -cn '{
	containers: [
		{name: "otel-collector", exitCode: 0}
	]
}')
exit_code=$(ecs_task_container_exit_code "$no_match_task" "ticket-c2c-staging-api")
expect_equal "no matching container" "none" "$exit_code"

echo "ecs_task_container_exit_code fixtures passed"
