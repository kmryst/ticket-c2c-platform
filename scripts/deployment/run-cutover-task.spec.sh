#!/usr/bin/env bash
# run-cutover-task.sh の shell test（Issue #378）。AWS へは接続せず、PATH 先頭へ置いた
# `aws` スタブで ECS / CloudWatch Logs 応答を差し替えて検証する。
#
# 検証する不変条件:
# 1. operation -> command override 変換が 6 択すべてで正しい（activation / rollback が対称で、
#    --expect-mode / --phase / --target-mode の組み合わせが逆転していない）。
# 2. container の exit code 0 / 2 / 3 / 4 / 1 を潰さずそのまま伝搬する。
# 3. evidence JSON を取得できない場合は exit code 0 でも失敗する（false-green 禁止）。
# 4. gate 判定式（cutover_gate_ok）が workflow の false-green 経路を塞ぐ。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/deployment/run-cutover-task.sh
source "${script_dir}/run-cutover-task.sh"

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

failures=0

expect_equal() {
	local label=$1
	local expected=$2
	local actual=$3
	if [[ $actual != "$expected" ]]; then
		echo "FAIL: ${label}: expected '${expected}' but got '${actual}'" >&2
		failures=$((failures + 1))
	fi
}

# ---------------------------------------------------------------------------
# 1. operation -> command override 変換（6 択すべて）
# ---------------------------------------------------------------------------

check_cli="dist/src/cutover/check-ticket-type-cutover-readiness.js"
switch_cli="dist/src/cutover/switch-ticket-type-writer-mode.js"

expect_command() {
	local operation=$1
	local expected=$2
	if ! set_cutover_operation_command "$operation"; then
		echo "FAIL: operation ${operation} was rejected by set_cutover_operation_command" >&2
		failures=$((failures + 1))
		return
	fi
	expect_equal "operation ${operation} command" \
		"$expected" "${cutover_operation_command[*]}"
}

expect_command preflight-activation "node ${check_cli} --expect-mode legacy --phase preflight"
expect_command activate "node ${switch_cli} --target-mode ticket_type"
expect_command postflight-activation "node ${check_cli} --expect-mode ticket_type --phase postflight"
expect_command preflight-rollback "node ${check_cli} --expect-mode ticket_type --phase preflight"
expect_command rollback "node ${switch_cli} --target-mode legacy"
expect_command postflight-rollback "node ${check_cli} --expect-mode legacy --phase postflight"

if set_cutover_operation_command "switch-to-ticket-type" 2>/dev/null; then
	echo "FAIL: unknown operation must be rejected" >&2
	failures=$((failures + 1))
fi

expect_equal "operation kind: activate" "switch" "$(cutover_operation_kind activate)"
expect_equal "operation kind: rollback" "switch" "$(cutover_operation_kind rollback)"
expect_equal "operation kind: preflight-activation" "check" "$(cutover_operation_kind preflight-activation)"
expect_equal "operation kind: postflight-rollback" "check" "$(cutover_operation_kind postflight-rollback)"

# ---------------------------------------------------------------------------
# 2. gate 判定式（workflow の false-green 経路）
# ---------------------------------------------------------------------------

expect_gate() {
	local label=$1
	local operation=$2
	local exit_code=$3
	local postflight_outcome=$4
	local expected=$5
	local actual="fail"
	if cutover_gate_ok "$operation" "$exit_code" "$postflight_outcome"; then
		actual="pass"
	fi
	expect_equal "gate: ${label}" "$expected" "$actual"
}

# switch operation: exit 0 / 3 かつ postflight success のときだけ job を green にする。
expect_gate "activate exit 0 + postflight success" activate 0 success pass
expect_gate "activate exit 3 + postflight success" activate 3 success pass
expect_gate "activate exit 3 + postflight failure" activate 3 failure fail
expect_gate "activate exit 2 (postflight skipped)" activate 2 skipped fail
expect_gate "activate exit 4 (postflight skipped)" activate 4 skipped fail
expect_gate "activate exit 1 (postflight skipped)" activate 1 skipped fail
expect_gate "activate exit code missing (step crashed)" activate "" "" fail
# exit code 条件を postflight 条件と独立に検査する（両条件のどちらか一方でも
# 緩めれば job が green になってしまう組合せを固定する）。
expect_gate "activate exit 2 even if postflight somehow succeeded" activate 2 success fail
expect_gate "activate exit 4 even if postflight somehow succeeded" activate 4 success fail
expect_gate "activate exit 1 even if postflight somehow succeeded" activate 1 success fail
expect_gate "activate exit code missing but postflight success" activate "" success fail
expect_gate "activate exit 0 + postflight skipped" activate 0 skipped fail
expect_gate "activate exit 0 + postflight cancelled" activate 0 cancelled fail
expect_gate "rollback exit 0 + postflight success" rollback 0 success pass
expect_gate "rollback exit 3 + postflight failure" rollback 3 failure fail

# check operation: exit 0 のみ green（postflight step は存在しない = skipped）。
expect_gate "preflight-activation exit 0" preflight-activation 0 skipped pass
expect_gate "preflight-activation exit 2" preflight-activation 2 skipped fail
expect_gate "preflight-activation exit 1" preflight-activation 1 skipped fail
expect_gate "postflight-activation exit 2" postflight-activation 2 skipped fail
expect_gate "postflight-rollback exit 0" postflight-rollback 0 skipped pass
expect_gate "check exit code missing" preflight-rollback "" skipped fail
expect_gate "unknown operation" activate-now 0 success fail

# ---------------------------------------------------------------------------
# 3. evidence 判定
# ---------------------------------------------------------------------------

readiness_evidence='{"evidenceType":"ticket-type-cutover-readiness","evidenceVersion":1,"expectedWriterMode":"legacy","checkPhase":"preflight","results":[{"category":"writer_control_state","violationCount":0}]}'
switch_result='{"action":"ticket-type-writer-mode-switch","switched":true,"sourceMode":"legacy","targetMode":"ticket_type"}'

log_messages() {
	local messages_json='[]'
	local message
	for message in "$@"; do
		messages_json=$(jq -c --arg message "$message" '. + [$message]' <<<"$messages_json")
	done
	echo "$messages_json"
}

expect_evidence() {
	local label=$1
	local operation=$2
	local messages_json=$3
	local expected=$4
	local actual="absent"
	if cutover_evidence_available "$messages_json" "$operation"; then
		actual="present"
	fi
	expect_equal "evidence: ${label}" "$expected" "$actual"
}

check_log=$(log_messages "npm banner" "$readiness_evidence")
switch_log=$(log_messages "npm banner" "$readiness_evidence" "$switch_result")
no_evidence_log=$(log_messages "npm banner" "started" "{")
wrong_version_log=$(log_messages "$(jq -c '.evidenceVersion = 2' <<<"$readiness_evidence")")

expect_evidence "check operation with readiness evidence" preflight-activation "$check_log" present
expect_evidence "check operation without evidence" preflight-activation "$no_evidence_log" absent
expect_evidence "check operation with unsupported evidence version" \
	preflight-activation "$wrong_version_log" absent
expect_evidence "switch operation with readiness + switch result" activate "$switch_log" present
# switch operation は preflight evidence だけでは足りない（切替結果まで揃って初めて証跡）。
expect_evidence "switch operation without switch result" activate "$check_log" absent

# ---------------------------------------------------------------------------
# 4. end-to-end（AWS CLI スタブ）: exit code 伝搬と command override
# ---------------------------------------------------------------------------

stub_dir="${work_dir}/bin"
mkdir -p "$stub_dir"

cat >"${stub_dir}/aws" <<'STUB'
#!/usr/bin/env bash
# run-cutover-task.spec.sh 用の AWS CLI スタブ（AWS へは接続しない）。
set -euo pipefail

service=$1
shift
action=$1
shift

case "${service} ${action}" in
"ecs describe-services")
	jq -cn '{
		taskDefinition: "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/stub-api:7",
		networkConfiguration: {awsvpcConfiguration: {subnets: ["subnet-a","subnet-b"], securityGroups: ["sg-1"]}}
	}'
	;;
"ecs describe-task-definition")
	jq -cn --arg container "${STUB_CONTAINER_NAME}" '{
		containerDefinitions: [{
			name: $container,
			image: "111122223333.dkr.ecr.ap-northeast-1.amazonaws.com/stub-api:abcdef",
			logConfiguration: {options: {"awslogs-group": "/ecs/stub-api", "awslogs-stream-prefix": "ecs"}}
		}]
	}'
	;;
"ecs run-task")
	while (($# > 0)); do
		if [[ $1 == "--overrides" ]]; then
			printf '%s' "$2" >"${STUB_DIR}/overrides.json"
		fi
		if [[ $1 == "--started-by" ]]; then
			printf '%s' "$2" >"${STUB_DIR}/started-by.txt"
		fi
		shift
	done
	echo "arn:aws:ecs:ap-northeast-1:111122223333:task/stub-cluster/0123456789abcdef"
	;;
"ecs wait")
	exit 0
	;;
"ecs describe-tasks")
	jq -cn \
		--arg container "${STUB_TASK_CONTAINER_NAME:-${STUB_CONTAINER_NAME}}" \
		--argjson exit_code "${STUB_EXIT_CODE}" '{
			containers: [
				{name: "otel-collector", exitCode: 0},
				{name: $container, exitCode: $exit_code, imageDigest: "sha256:deadbeef"}
			],
			stoppedReason: "Essential container in task exited"
		}'
	;;
"ecs stop-task")
	echo "stopped"
	;;
"logs get-log-events")
	printf '%s' "${STUB_LOG_JSON}"
	;;
*)
	echo "unexpected aws invocation: ${service} ${action}" >&2
	exit 1
	;;
esac
STUB
chmod +x "${stub_dir}/aws"

# 失敗経路の log 再試行で実時間を消費しないよう sleep も差し替える。
cat >"${stub_dir}/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "${stub_dir}/sleep"

run_stubbed_cutover() {
	local operation=$1
	local exit_code=$2
	local log_json=$3
	local task_container_name=${4:-}

	rm -f "${work_dir}/overrides.json" "${work_dir}/started-by.txt"
	set +e
	env PATH="${stub_dir}:${PATH}" \
		STUB_DIR="$work_dir" \
		STUB_CONTAINER_NAME="stub-api" \
		STUB_TASK_CONTAINER_NAME="${task_container_name:-stub-api}" \
		STUB_EXIT_CODE="$exit_code" \
		STUB_LOG_JSON="$log_json" \
		GITHUB_STEP_SUMMARY="${work_dir}/summary.md" \
		CUTOVER_EVIDENCE_FILE="${work_dir}/evidence.jsonl" \
		AWS_REGION="ap-northeast-1" \
		bash "${script_dir}/run-cutover-task.sh" \
		stub-cluster stub-api current "$operation" >"${work_dir}/stdout.log" 2>"${work_dir}/stderr.log"
	local status=$?
	set -e
	echo "$status"
}

expect_run_exit_code() {
	local label=$1
	local expected=$2
	shift 2
	local actual
	actual=$(run_stubbed_cutover "$@")
	expect_equal "run: ${label}" "$expected" "$actual"
}

# 4-1. container exit code 0 / 2 / 3 / 4 / 1 をそのまま伝搬する。
expect_run_exit_code "check operation exit 0" 0 preflight-activation 0 "$check_log"
expect_run_exit_code "check operation exit 2 (violation)" 2 preflight-activation 2 "$check_log"
expect_run_exit_code "check operation exit 1 (execution error)" 1 postflight-rollback 1 "$check_log"
expect_run_exit_code "switch operation exit 0" 0 activate 0 "$switch_log"
expect_run_exit_code "switch operation exit 3 (commit ambiguous, switched)" 3 activate 3 "$switch_log"
expect_run_exit_code "switch operation exit 4 (commit ambiguous, not applied)" 4 rollback 4 "$switch_log"
expect_run_exit_code "switch operation exit 2 (preflight violation)" 2 activate 2 "$check_log"

# 4-2. false-green 禁止: exit 0 でも evidence が無ければ失敗する。
expect_run_exit_code "exit 0 without evidence must fail" 1 preflight-activation 0 "$no_evidence_log"
expect_run_exit_code "switch exit 0 without switch result must fail" 1 activate 0 "$check_log"
if ! grep -q "refusing to report success" "${work_dir}/stderr.log"; then
	echo "FAIL: missing evidence must be reported on stderr" >&2
	failures=$((failures + 1))
fi

# 4-3. container 名一致で exit code を取得できない場合は結果不明として失敗する（Issue #363）。
expect_run_exit_code "app container missing from describe-tasks" \
	1 preflight-activation 0 "$check_log" "otel-collector-only"

# 4-4. command override が operation ごとに正しく組み立てられている（実行経路での確認）。
expect_override() {
	local operation=$1
	local expected=$2
	run_stubbed_cutover "$operation" 0 "$switch_log" >/dev/null
	local actual
	actual=$(jq -r '.containerOverrides[0].command | join(" ")' "${work_dir}/overrides.json")
	expect_equal "override: ${operation}" "$expected" "$actual"
	expect_equal "override container: ${operation}" \
		"stub-api" "$(jq -r '.containerOverrides[0].name' "${work_dir}/overrides.json")"
	expect_equal "startedBy: ${operation}" \
		"cutover-${operation}" "$(cat "${work_dir}/started-by.txt")"
}

expect_override preflight-activation "node ${check_cli} --expect-mode legacy --phase preflight"
expect_override activate "node ${switch_cli} --target-mode ticket_type"
expect_override postflight-activation "node ${check_cli} --expect-mode ticket_type --phase postflight"
expect_override preflight-rollback "node ${check_cli} --expect-mode ticket_type --phase preflight"
expect_override rollback "node ${switch_cli} --target-mode legacy"
expect_override postflight-rollback "node ${check_cli} --expect-mode legacy --phase postflight"

# 4-5. evidence が GITHUB_STEP_SUMMARY へ転記される。
rm -f "${work_dir}/summary.md"
run_stubbed_cutover activate 0 "$switch_log" >/dev/null
if ! grep -q "ticket-type-writer-mode-switch" "${work_dir}/summary.md" ||
	! grep -q "ticket-type-cutover-readiness" "${work_dir}/summary.md"; then
	echo "FAIL: evidence JSON must be transcribed into GITHUB_STEP_SUMMARY" >&2
	failures=$((failures + 1))
fi

# 4-6. evidence file（artifact 用 JSON Lines）に lineage と evidence が追記される。
rm -f "${work_dir}/evidence.jsonl"
run_stubbed_cutover activate 3 "$switch_log" >/dev/null
expect_equal "evidence file line count" "1" "$(wc -l <"${work_dir}/evidence.jsonl")"
expect_equal "evidence file operation" "activate" \
	"$(jq -r '.lineage.operation' "${work_dir}/evidence.jsonl")"
expect_equal "evidence file exit code" "3" \
	"$(jq -r '.lineage.exitCode' "${work_dir}/evidence.jsonl")"
expect_equal "evidence file evidence count" "2" \
	"$(jq -r '.evidence | length' "${work_dir}/evidence.jsonl")"
# 同一 run の後続 step（postflight）は追記される。
run_stubbed_cutover postflight-activation 0 "$check_log" >/dev/null
expect_equal "evidence file is appended, not truncated" "2" \
	"$(wc -l <"${work_dir}/evidence.jsonl")"

# 4-7. 引数不足・未知 operation は使用エラー（exit 2）で停止し、ECS を呼ばない。
set +e
env PATH="${stub_dir}:${PATH}" bash "${script_dir}/run-cutover-task.sh" stub-cluster stub-api current \
	>/dev/null 2>&1
usage_status=$?
env PATH="${stub_dir}:${PATH}" bash "${script_dir}/run-cutover-task.sh" stub-cluster stub-api current seed \
	>/dev/null 2>&1
unknown_status=$?
set -e
expect_equal "missing operation argument" "2" "$usage_status"
expect_equal "unsupported operation argument" "2" "$unknown_status"

if ((failures > 0)); then
	echo "run-cutover-task fixtures failed: ${failures} assertion(s)" >&2
	exit 1
fi

echo "run-cutover-task fixtures passed"
