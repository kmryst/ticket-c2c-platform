#!/usr/bin/env bash
# run-cutover-task.sh の shell test（Issue #378）。AWS へは接続せず、PATH 先頭へ置いた
# `aws` スタブで ECS / CloudWatch Logs 応答を差し替えて検証する。
#
# 検証する不変条件:
# 1. operation -> command override 変換が全 operation で正しい（workflow から起動する
#    6 択の activation / rollback が対称で、--expect-mode / --phase / --target-mode の
#    組み合わせが逆転していない。runbook 手動専用の counter 4 択も namespace / mode が
#    operation 名どおりである）。
# 2. container の exit code 0 / 2 / 3 / 4 / 1 を潰さずそのまま伝搬する。
# 3. evidence 判定が operation と exit code に結び付いている（構造の存在だけで受理しない）。
# 4. gate 判定式（cutover_gate_ok）が workflow の false-green 経路を塞ぐ。
#    raw exit code / evidence_valid / postflight outcome の 3 条件をすべて必須にする。
# 5. evidence が有効でない、または evidence file を書けない run を green にしない。

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
# 1. operation -> command override 変換
# ---------------------------------------------------------------------------

check_cli="dist/src/cutover/check-ticket-type-cutover-readiness.js"
switch_cli="dist/src/cutover/switch-ticket-type-writer-mode.js"
counter_cli="dist/src/cutover/reconcile-inventory-counters.js"

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
# counter operation（runbook 手順からの手動実行専用。workflow の choice には無い）。
expect_command seed-ticket-type "node ${counter_cli} --namespace ticket-type --mode seed"
expect_command seed-legacy "node ${counter_cli} --namespace legacy --mode seed"
expect_command reconcile-ticket-type "node ${counter_cli} --namespace ticket-type --mode reconcile"
expect_command reconcile-legacy "node ${counter_cli} --namespace legacy --mode reconcile"

if set_cutover_operation_command "switch-to-ticket-type" 2>/dev/null; then
	echo "FAIL: unknown operation must be rejected" >&2
	failures=$((failures + 1))
fi

expect_equal "operation kind: activate" "switch" "$(cutover_operation_kind activate)"
expect_equal "operation kind: rollback" "switch" "$(cutover_operation_kind rollback)"
expect_equal "operation kind: preflight-activation" "check" "$(cutover_operation_kind preflight-activation)"
expect_equal "operation kind: postflight-rollback" "check" "$(cutover_operation_kind postflight-rollback)"
expect_equal "operation kind: seed-ticket-type" "counter" "$(cutover_operation_kind seed-ticket-type)"
expect_equal "operation kind: reconcile-legacy" "counter" "$(cutover_operation_kind reconcile-legacy)"

# workflow の choice に載せてよいのは check / switch だけである（counter は runbook 手動専用）。
expect_workflow_operation() {
	local operation=$1
	local expected=$2
	local actual="no"
	if cutover_workflow_operation "$operation"; then
		actual="yes"
	fi
	expect_equal "workflow operation: ${operation}" "$expected" "$actual"
}
expect_workflow_operation preflight-activation yes
expect_workflow_operation activate yes
expect_workflow_operation rollback yes
expect_workflow_operation postflight-rollback yes
expect_workflow_operation seed-ticket-type no
expect_workflow_operation seed-legacy no
expect_workflow_operation reconcile-ticket-type no
expect_workflow_operation reconcile-legacy no

# 期待値表（evidence 判定の正本）。
expect_equal "check expectation: preflight-activation" \
	"legacy preflight" "$(cutover_check_expectation preflight-activation)"
expect_equal "check expectation: postflight-activation" \
	"ticket_type postflight" "$(cutover_check_expectation postflight-activation)"
expect_equal "check expectation: preflight-rollback" \
	"ticket_type preflight" "$(cutover_check_expectation preflight-rollback)"
expect_equal "check expectation: postflight-rollback" \
	"legacy postflight" "$(cutover_check_expectation postflight-rollback)"
expect_equal "switch modes: activate" "legacy ticket_type" "$(cutover_switch_modes activate)"
expect_equal "switch modes: rollback" "ticket_type legacy" "$(cutover_switch_modes rollback)"
expect_equal "counter expectation: seed-legacy" "legacy seed" "$(cutover_counter_expectation seed-legacy)"
expect_equal "counter expectation: reconcile-ticket-type" \
	"ticket-type reconcile" "$(cutover_counter_expectation reconcile-ticket-type)"

# ---------------------------------------------------------------------------
# 2. gate 判定式（workflow の false-green 経路）
# ---------------------------------------------------------------------------

expect_gate() {
	local label=$1
	local operation=$2
	local exit_code=$3
	local evidence_valid=$4
	local postflight_outcome=$5
	local expected=$6
	local actual="fail"
	if cutover_gate_ok "$operation" "$exit_code" "$evidence_valid" "$postflight_outcome"; then
		actual="pass"
	fi
	expect_equal "gate: ${label}" "$expected" "$actual"
}

# switch operation: raw exit 0 / 3 かつ evidence_valid かつ postflight success のときだけ green。
expect_gate "activate exit 0 + evidence + postflight success" activate 0 true success pass
expect_gate "activate exit 3 + evidence + postflight success" activate 3 true success pass
expect_gate "activate exit 3 + evidence + postflight failure" activate 3 true failure fail
expect_gate "activate exit 2 (postflight skipped)" activate 2 true skipped fail
expect_gate "activate exit 4 (postflight skipped)" activate 4 true skipped fail
expect_gate "activate exit 1 (postflight skipped)" activate 1 true skipped fail
expect_gate "activate exit code missing (step crashed)" activate "" "" "" fail
# 3 条件を独立に検査する（どれか 1 つでも緩めれば green になってしまう組合せを固定する）。
expect_gate "activate exit 2 even if evidence + postflight succeeded" activate 2 true success fail
expect_gate "activate exit 4 even if evidence + postflight succeeded" activate 4 true success fail
expect_gate "activate exit 1 even if evidence + postflight succeeded" activate 1 true success fail
expect_gate "activate exit code missing but evidence + postflight success" activate "" true success fail
expect_gate "activate exit 0 + evidence + postflight skipped" activate 0 true skipped fail
expect_gate "activate exit 0 + evidence + postflight cancelled" activate 0 true cancelled fail
# **Codex High-1 の中核**: exit 3 で switch evidence を取り切れず、postflight が success でも fail。
expect_gate "activate exit 3 WITHOUT evidence + postflight success" activate 3 false success fail
expect_gate "activate exit 3 with empty evidence_valid + postflight success" activate 3 "" success fail
expect_gate "activate exit 0 WITHOUT evidence + postflight success" activate 0 false success fail
expect_gate "rollback exit 3 WITHOUT evidence + postflight success" rollback 3 false success fail
expect_gate "rollback exit 0 + evidence + postflight success" rollback 0 true success pass
expect_gate "rollback exit 3 + evidence + postflight failure" rollback 3 true failure fail

# check operation: raw exit 0 かつ evidence_valid のみ green（postflight step は存在しない = skipped）。
expect_gate "preflight-activation exit 0 + evidence" preflight-activation 0 true skipped pass
expect_gate "preflight-activation exit 0 WITHOUT evidence" preflight-activation 0 false skipped fail
expect_gate "preflight-activation exit 0 with empty evidence_valid" preflight-activation 0 "" skipped fail
expect_gate "preflight-activation exit 2" preflight-activation 2 true skipped fail
expect_gate "preflight-activation exit 1" preflight-activation 1 true skipped fail
expect_gate "postflight-activation exit 2" postflight-activation 2 true skipped fail
expect_gate "postflight-rollback exit 0 + evidence" postflight-rollback 0 true skipped pass
expect_gate "check exit code missing" preflight-rollback "" true skipped fail
expect_gate "unknown operation" activate-now 0 true success fail
# counter operation は workflow から起動しないが、判定は check と同じ規律にする。
expect_gate "seed-ticket-type exit 0 + evidence" seed-ticket-type 0 true skipped pass
expect_gate "seed-ticket-type exit 2 (guard refuse)" seed-ticket-type 2 true skipped fail
expect_gate "seed-legacy exit 0 WITHOUT evidence" seed-legacy 0 false skipped fail

# ---------------------------------------------------------------------------
# 3. evidence 判定（operation 別 fixture）
# ---------------------------------------------------------------------------

# checker evidence の 23 category（ticket-type-cutover-readiness.ts の
# TICKET_TYPE_CUTOVER_READINESS_CATEGORIES と同じ並び）。
cutover_categories=(
	event_without_exactly_one_default
	event_without_legacy_inventory
	legacy_inventory_without_default_ticket_type_inventory
	ticket_type_inventory_without_ticket_type
	ticket_type_without_ticket_type_inventory
	purchase_without_ticket_type
	purchase_ticket_type_event_mismatch
	legacy_aggregate_total_mismatch
	legacy_aggregate_remaining_mismatch
	non_default_ticket_type_inventory_in_legacy_mode
	writer_control_state_missing_or_invalid
	writer_control_mode_mismatch
	compatibility_object_missing_or_invalid
	valkey_counter_missing
	valkey_counter_without_inventory_row
	valkey_counter_value_invalid
	valkey_counter_remaining_mismatch
	valkey_revision_missing_or_invalid
	valkey_legacy_counter_missing
	valkey_legacy_counter_value_invalid
	valkey_legacy_counter_remaining_mismatch
	valkey_legacy_version_value_invalid
	opensearch_projection_diff
)
expect_equal "category fixture count matches script constant" \
	"$CUTOVER_EVIDENCE_CATEGORY_COUNT" "${#cutover_categories[@]}"

# readiness_evidence <expect-mode> <phase> <violating-category|"">
readiness_evidence() {
	local expect_mode=$1
	local phase=$2
	local violating_category=${3:-}
	local results
	results=$(printf '%s\n' "${cutover_categories[@]}" |
		jq -R --arg violating "$violating_category" \
			'{category: ., violationCount: (if . == $violating then 1 else 0 end)}' |
		jq -sc .)
	jq -cn \
		--arg expectMode "$expect_mode" \
		--arg phase "$phase" \
		--argjson results "$results" '
		{
			evidenceType: "ticket-type-cutover-readiness",
			evidenceVersion: 1,
			expectedWriterMode: $expectMode,
			checkPhase: $phase,
			writerMode: $expectMode,
			schemaRevision: "1785542400000-add-ticket-type-compatibility-writer",
			opensearchIndex: "events",
			results: $results,
			categoryCount: ($results | length),
			opensearchReport: {index: "events", totalDiffs: 0, counts: {}, findings: []},
			complete: true
		}
	'
}

switch_success() {
	local source_mode=$1
	local target_mode=$2
	jq -cn --arg source "$source_mode" --arg target "$target_mode" '
		{
			action: "ticket-type-writer-mode-switch",
			switched: true,
			sourceMode: $source,
			targetMode: $target,
			schemaRevision: "1785542400000-add-ticket-type-compatibility-writer",
			postSwitchDatabaseResults: []
		}
	'
}

switch_ambiguous_applied() {
	local source_mode=$1
	local target_mode=$2
	jq -cn --arg source "$source_mode" --arg target "$target_mode" '
		{
			action: "ticket-type-writer-mode-switch",
			commitOutcome: "ambiguous",
			verifiedMode: $target,
			switched: true,
			sourceMode: $source,
			targetMode: $target,
			schemaRevision: "1785542400000-add-ticket-type-compatibility-writer",
			postSwitchDatabaseResults: []
		}
	'
}

switch_ambiguous_not_applied() {
	local source_mode=$1
	# result: null の経路なので sourceMode / targetMode は出力されない
	# （ticket-type-writer-mode-switch.ts: verifiedMode === sourceMode -> result: null）。
	jq -cn --arg source "$source_mode" '
		{
			action: "ticket-type-writer-mode-switch",
			commitOutcome: "ambiguous",
			verifiedMode: $source,
			switched: false
		}
	'
}

counter_evidence() {
	local namespace=$1
	local counter_mode=$2
	local writer_mode=$3
	local processed=$4
	local initialized=$5
	local synced=$6
	local skipped=$7
	jq -cn \
		--arg namespace "$namespace" --arg mode "$counter_mode" --arg writerMode "$writer_mode" \
		--argjson processed "$processed" --argjson initialized "$initialized" \
		--argjson synced "$synced" --argjson skipped "$skipped" '
		{
			action: "inventory-counter-reconcile",
			namespace: $namespace,
			mode: $mode,
			writerMode: $writerMode,
			processed: $processed,
			initialized: $initialized,
			synced: $synced,
			skipped: $skipped
		}
	'
}

counter_refused() {
	local namespace=$1
	local counter_mode=$2
	local writer_mode=$3
	jq -cn --arg namespace "$namespace" --arg mode "$counter_mode" --arg writerMode "$writer_mode" '
		{
			action: "inventory-counter-reconcile",
			namespace: $namespace,
			mode: $mode,
			writerMode: $writerMode,
			refused: true,
			reason: ("refusing to seed namespace " + $namespace)
		}
	'
}

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
	local exit_code=$3
	local messages_json=$4
	local expected=$5
	local actual="invalid"
	if cutover_evidence_valid "$messages_json" "$operation" "$exit_code"; then
		actual="valid"
	fi
	expect_equal "evidence: ${label}" "$expected" "$actual"
}

# --- check operation ---
check_preflight_activation_log=$(log_messages "npm banner" "$(readiness_evidence legacy preflight)")
check_postflight_activation_log=$(log_messages "$(readiness_evidence ticket_type postflight)")
check_preflight_rollback_log=$(log_messages "$(readiness_evidence ticket_type preflight)")
check_postflight_rollback_log=$(log_messages "$(readiness_evidence legacy postflight)")
check_violation_log=$(log_messages "$(readiness_evidence legacy preflight valkey_counter_missing)")
no_evidence_log=$(log_messages "npm banner" "started" "{")
wrong_version_log=$(log_messages \
	"$(readiness_evidence legacy preflight | jq -c '.evidenceVersion = 2')")
incomplete_log=$(log_messages "$(readiness_evidence legacy preflight | jq -c '.complete = false')")
empty_results_log=$(log_messages \
	"$(readiness_evidence legacy preflight | jq -c '.results = [{}] | .categoryCount = 1')")
missing_category_log=$(log_messages \
	"$(readiness_evidence legacy preflight | jq -c '.results |= .[0:22] | .categoryCount = 22')")

expect_evidence "preflight-activation exit 0" preflight-activation 0 "$check_preflight_activation_log" valid
expect_evidence "postflight-activation exit 0" postflight-activation 0 "$check_postflight_activation_log" valid
expect_evidence "preflight-rollback exit 0" preflight-rollback 0 "$check_preflight_rollback_log" valid
expect_evidence "postflight-rollback exit 0" postflight-rollback 0 "$check_postflight_rollback_log" valid
expect_evidence "check operation without evidence" preflight-activation 0 "$no_evidence_log" invalid
expect_evidence "unsupported evidence version" preflight-activation 0 "$wrong_version_log" invalid
# 構造だけでは受理しない（Codex Medium-1）。
expect_evidence "complete: false is rejected" preflight-activation 0 "$incomplete_log" invalid
expect_evidence "results: [{}] is rejected" preflight-activation 0 "$empty_results_log" invalid
expect_evidence "category count 22 is rejected" preflight-activation 0 "$missing_category_log" invalid
# 逆方向の operation の evidence を受理しない（task definition の取り違え検出）。
expect_evidence "preflight-activation must not accept rollback preflight evidence" \
	preflight-activation 0 "$check_preflight_rollback_log" invalid
expect_evidence "preflight-rollback must not accept activation preflight evidence" \
	preflight-rollback 0 "$check_preflight_activation_log" invalid
expect_evidence "postflight-activation must not accept preflight phase evidence" \
	postflight-activation 0 "$check_preflight_rollback_log" invalid
expect_evidence "postflight-rollback must not accept postflight-activation evidence" \
	postflight-rollback 0 "$check_postflight_activation_log" invalid
# exit code と violation 件数の整合。
expect_evidence "check exit 0 with violation is rejected" \
	preflight-activation 0 "$check_violation_log" invalid
expect_evidence "check exit 2 with violation is accepted" \
	preflight-activation 2 "$check_violation_log" valid
expect_evidence "check exit 2 without violation is rejected" \
	preflight-activation 2 "$check_preflight_activation_log" invalid
expect_evidence "check exit 1 is never evidence-backed" \
	preflight-activation 1 "$check_preflight_activation_log" invalid

# --- switch operation ---
activate_success_log=$(log_messages \
	"$(readiness_evidence legacy preflight)" "$(switch_success legacy ticket_type)")
activate_ambiguous_applied_log=$(log_messages \
	"$(readiness_evidence legacy preflight)" "$(switch_ambiguous_applied legacy ticket_type)")
activate_ambiguous_not_applied_log=$(log_messages \
	"$(readiness_evidence legacy preflight)" "$(switch_ambiguous_not_applied legacy)")
activate_violation_log=$(log_messages "$(readiness_evidence legacy preflight valkey_counter_missing)")
rollback_success_log=$(log_messages \
	"$(readiness_evidence ticket_type preflight)" "$(switch_success ticket_type legacy)")
switched_false_log=$(log_messages \
	"$(readiness_evidence legacy preflight)" \
	"$(switch_success legacy ticket_type | jq -c '.switched = false')")

expect_evidence "activate exit 0" activate 0 "$activate_success_log" valid
expect_evidence "activate exit 3 (ambiguous, applied)" activate 3 "$activate_ambiguous_applied_log" valid
expect_evidence "activate exit 4 (ambiguous, not applied)" activate 4 "$activate_ambiguous_not_applied_log" valid
expect_evidence "activate exit 2 (preflight violation)" activate 2 "$activate_violation_log" valid
expect_evidence "rollback exit 0" rollback 0 "$rollback_success_log" valid
# **Codex High-1 の中核**: exit 3 で切替結果が取れていない log は evidence 無効。
expect_evidence "activate exit 3 without switch result" activate 3 "$check_preflight_activation_log" invalid
expect_evidence "activate exit 0 without switch result" activate 0 "$check_preflight_activation_log" invalid
expect_evidence "activate exit 3 with only success-shaped result" \
	activate 3 "$activate_success_log" invalid
expect_evidence "activate exit 0 with ambiguous result" \
	activate 0 "$activate_ambiguous_applied_log" invalid
expect_evidence "activate exit 4 with applied ambiguous result" \
	activate 4 "$activate_ambiguous_applied_log" invalid
expect_evidence "switched: false is rejected for exit 0" activate 0 "$switched_false_log" invalid
# 切替結果の方向だけが逆転している場合（preflight evidence は operation どおり）も拒否する。
reversed_switch_result_log=$(log_messages \
	"$(readiness_evidence legacy preflight)" "$(switch_success ticket_type legacy)")
expect_evidence "activate exit 0 with reversed switch result direction" \
	activate 0 "$reversed_switch_result_log" invalid
reversed_ambiguous_log=$(log_messages \
	"$(readiness_evidence legacy preflight)" "$(switch_ambiguous_applied ticket_type legacy)")
expect_evidence "activate exit 3 with reversed switch result direction" \
	activate 3 "$reversed_ambiguous_log" invalid
# 方向の取り違え（rollback の evidence を activate として受理しない・逆も）。
expect_evidence "activate must not accept rollback evidence" activate 0 "$rollback_success_log" invalid
expect_evidence "rollback must not accept activate evidence" rollback 0 "$activate_success_log" invalid
expect_evidence "activate exit 2 must not accept clean preflight" activate 2 "$activate_success_log" invalid
expect_evidence "switch exit 1 is never evidence-backed" activate 1 "$activate_success_log" invalid

# --- counter operation ---
seed_ticket_type_log=$(log_messages "$(counter_evidence ticket-type seed legacy 12 12 0 0)")
seed_legacy_log=$(log_messages "$(counter_evidence legacy seed ticket_type 5 5 0 0)")
reconcile_ticket_type_log=$(log_messages "$(counter_evidence ticket-type reconcile ticket_type 12 0 9 3)")
seed_refused_log=$(log_messages "$(counter_refused ticket-type seed ticket_type)")

expect_evidence "seed-ticket-type exit 0" seed-ticket-type 0 "$seed_ticket_type_log" valid
expect_evidence "seed-legacy exit 0" seed-legacy 0 "$seed_legacy_log" valid
expect_evidence "reconcile-ticket-type exit 0" reconcile-ticket-type 0 "$reconcile_ticket_type_log" valid
expect_evidence "seed-ticket-type exit 2 (guard refuse)" seed-ticket-type 2 "$seed_refused_log" valid
expect_evidence "seed-ticket-type must not accept legacy namespace evidence" \
	seed-ticket-type 0 "$seed_legacy_log" invalid
expect_evidence "seed-ticket-type must not accept reconcile evidence" \
	seed-ticket-type 0 "$reconcile_ticket_type_log" invalid
expect_evidence "reconcile must not accept seed evidence" \
	reconcile-ticket-type 0 "$seed_ticket_type_log" invalid
expect_evidence "seed exit 0 with initialized != processed is rejected" \
	seed-ticket-type 0 "$(log_messages "$(counter_evidence ticket-type seed legacy 12 11 0 0)")" invalid
expect_evidence "reconcile exit 0 with processed != synced + skipped is rejected" \
	reconcile-ticket-type 0 "$(log_messages "$(counter_evidence ticket-type reconcile ticket_type 12 0 9 1)")" invalid
expect_evidence "seed exit 0 with refused: true is rejected" \
	seed-ticket-type 0 "$seed_refused_log" invalid
expect_evidence "seed exit 2 without refused is rejected" \
	seed-ticket-type 2 "$seed_ticket_type_log" invalid

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
	local evidence_file=${5:-"${work_dir}/evidence.jsonl"}

	rm -f "${work_dir}/overrides.json" "${work_dir}/started-by.txt" "${work_dir}/step-output.txt"
	: >"${work_dir}/step-output.txt"
	set +e
	env PATH="${stub_dir}:${PATH}" \
		STUB_DIR="$work_dir" \
		STUB_CONTAINER_NAME="stub-api" \
		STUB_TASK_CONTAINER_NAME="${task_container_name:-stub-api}" \
		STUB_EXIT_CODE="$exit_code" \
		STUB_LOG_JSON="$log_json" \
		GITHUB_STEP_SUMMARY="${work_dir}/summary.md" \
		GITHUB_OUTPUT="${work_dir}/step-output.txt" \
		CUTOVER_EVIDENCE_FILE="$evidence_file" \
		AWS_REGION="ap-northeast-1" \
		bash "${script_dir}/run-cutover-task.sh" \
		stub-cluster stub-api current "$operation" >"${work_dir}/stdout.log" 2>"${work_dir}/stderr.log"
	local status=$?
	set -e
	echo "$status"
}

step_output() {
	local key=$1
	local value=""
	if [[ -f "${work_dir}/step-output.txt" ]]; then
		value=$(grep -E "^${key}=" "${work_dir}/step-output.txt" | tail -n 1 | cut -d= -f2-)
	fi
	echo "$value"
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
expect_run_exit_code "check operation exit 0" 0 preflight-activation 0 "$check_preflight_activation_log"
expect_run_exit_code "check operation exit 2 (violation)" 2 preflight-activation 2 "$check_violation_log"
expect_run_exit_code "check operation exit 1 (execution error)" 1 postflight-rollback 1 "$check_postflight_rollback_log"
expect_run_exit_code "switch operation exit 0" 0 activate 0 "$activate_success_log"
expect_run_exit_code "switch operation exit 3 (commit ambiguous, switched)" 3 activate 3 "$activate_ambiguous_applied_log"
expect_run_exit_code "switch operation exit 4 (commit ambiguous, not applied)" 4 rollback 4 \
	"$(log_messages "$(readiness_evidence ticket_type preflight)" "$(switch_ambiguous_not_applied ticket_type)")"
expect_run_exit_code "switch operation exit 2 (preflight violation)" 2 activate 2 "$activate_violation_log"
expect_run_exit_code "counter operation exit 0 (seed)" 0 seed-ticket-type 0 "$seed_ticket_type_log"
expect_run_exit_code "counter operation exit 2 (seed guard refuse)" 2 seed-ticket-type 2 "$seed_refused_log"
expect_run_exit_code "counter operation exit 0 (reconcile)" 0 reconcile-ticket-type 0 "$reconcile_ticket_type_log"

# 4-2. raw exit code と evidence_valid を別々の GITHUB_OUTPUT として報告する。
run_stubbed_cutover activate 3 "$activate_ambiguous_applied_log" >/dev/null
expect_equal "output container_exit_code (exit 3)" "3" "$(step_output container_exit_code)"
expect_equal "output evidence_valid (exit 3 with evidence)" "true" "$(step_output evidence_valid)"

# **Codex High-1**: exit 3 かつ switch evidence 欠落。raw exit code は 3 のまま保たれ、
# evidence_valid が false になる。workflow の gate はこの組合せで job を失敗させる
# （postflight が success でも green にしない）。
expect_run_exit_code "exit 3 with missing switch evidence keeps raw exit code" \
	3 activate 3 "$check_preflight_activation_log"
expect_equal "output container_exit_code (exit 3, evidence missing)" "3" "$(step_output container_exit_code)"
expect_equal "output evidence_valid (exit 3, evidence missing)" "false" "$(step_output evidence_valid)"
expect_gate "activate exit 3 + missing evidence + postflight success (end-to-end outputs)" \
	activate "$(step_output container_exit_code)" "$(step_output evidence_valid)" success fail

# 4-3. false-green 禁止: exit 0 でも evidence が有効でなければ script 自体が失敗する。
expect_run_exit_code "exit 0 without evidence must fail" 1 preflight-activation 0 "$no_evidence_log"
expect_equal "output container_exit_code (exit 0, evidence missing)" "0" "$(step_output container_exit_code)"
expect_equal "output evidence_valid (exit 0, evidence missing)" "false" "$(step_output evidence_valid)"
expect_run_exit_code "switch exit 0 without switch result must fail" 1 activate 0 "$check_preflight_activation_log"
if ! grep -q "refusing to report success" "${work_dir}/stderr.log"; then
	echo "FAIL: missing evidence must be reported on stderr" >&2
	failures=$((failures + 1))
fi
expect_run_exit_code "check exit 0 with reverse-direction evidence must fail" \
	1 preflight-activation 0 "$check_preflight_rollback_log"
expect_run_exit_code "seed exit 0 with reverse-namespace evidence must fail" \
	1 seed-ticket-type 0 "$seed_legacy_log"

# 4-4. container 名一致で exit code を取得できない場合は結果不明として失敗する（Issue #363）。
expect_run_exit_code "app container missing from describe-tasks" \
	1 preflight-activation 0 "$check_preflight_activation_log" "otel-collector-only"
expect_equal "output container_exit_code (container missing)" "none" "$(step_output container_exit_code)"
expect_gate "gate rejects container_exit_code=none" \
	preflight-activation "$(step_output container_exit_code)" "$(step_output evidence_valid)" skipped fail

# 4-5. command override が operation ごとに正しく組み立てられている（実行経路での確認）。
expect_override() {
	local operation=$1
	local expected=$2
	local log_json=$3
	run_stubbed_cutover "$operation" 0 "$log_json" >/dev/null
	local actual
	actual=$(jq -r '.containerOverrides[0].command | join(" ")' "${work_dir}/overrides.json")
	expect_equal "override: ${operation}" "$expected" "$actual"
	expect_equal "override container: ${operation}" \
		"stub-api" "$(jq -r '.containerOverrides[0].name' "${work_dir}/overrides.json")"
	expect_equal "startedBy: ${operation}" \
		"cutover-${operation}" "$(cat "${work_dir}/started-by.txt")"
}

expect_override preflight-activation "node ${check_cli} --expect-mode legacy --phase preflight" \
	"$check_preflight_activation_log"
expect_override activate "node ${switch_cli} --target-mode ticket_type" "$activate_success_log"
expect_override postflight-activation "node ${check_cli} --expect-mode ticket_type --phase postflight" \
	"$check_postflight_activation_log"
expect_override preflight-rollback "node ${check_cli} --expect-mode ticket_type --phase preflight" \
	"$check_preflight_rollback_log"
expect_override rollback "node ${switch_cli} --target-mode legacy" "$rollback_success_log"
expect_override postflight-rollback "node ${check_cli} --expect-mode legacy --phase postflight" \
	"$check_postflight_rollback_log"
expect_override seed-ticket-type "node ${counter_cli} --namespace ticket-type --mode seed" \
	"$seed_ticket_type_log"
expect_override seed-legacy "node ${counter_cli} --namespace legacy --mode seed" "$seed_legacy_log"
expect_override reconcile-ticket-type "node ${counter_cli} --namespace ticket-type --mode reconcile" \
	"$reconcile_ticket_type_log"
expect_override reconcile-legacy "node ${counter_cli} --namespace legacy --mode reconcile" \
	"$(log_messages "$(counter_evidence legacy reconcile legacy 4 0 4 0)")"

# 4-6. evidence が GITHUB_STEP_SUMMARY へ転記される。
rm -f "${work_dir}/summary.md"
run_stubbed_cutover activate 0 "$activate_success_log" >/dev/null
if ! grep -q "ticket-type-writer-mode-switch" "${work_dir}/summary.md" ||
	! grep -q "ticket-type-cutover-readiness" "${work_dir}/summary.md"; then
	echo "FAIL: evidence JSON must be transcribed into GITHUB_STEP_SUMMARY" >&2
	failures=$((failures + 1))
fi

# 4-7. evidence file（artifact 用 JSON Lines）に lineage と evidence が追記される。
rm -f "${work_dir}/evidence.jsonl"
run_stubbed_cutover activate 3 "$activate_ambiguous_applied_log" >/dev/null
expect_equal "evidence file line count" "1" "$(wc -l <"${work_dir}/evidence.jsonl")"
expect_equal "evidence file operation" "activate" \
	"$(jq -r '.lineage.operation' "${work_dir}/evidence.jsonl")"
expect_equal "evidence file exit code" "3" \
	"$(jq -r '.lineage.exitCode' "${work_dir}/evidence.jsonl")"
expect_equal "evidence file evidence count" "2" \
	"$(jq -r '.evidence | length' "${work_dir}/evidence.jsonl")"
# 同一 run の後続 step（postflight）は追記される。
run_stubbed_cutover postflight-activation 0 "$check_postflight_activation_log" >/dev/null
expect_equal "evidence file is appended, not truncated" "2" \
	"$(wc -l <"${work_dir}/evidence.jsonl")"

# 4-8. **Codex Medium-2**: CUTOVER_EVIDENCE_FILE を書けない場合は green にしない。
# 書き込み不能なパス（存在しないディレクトリ配下）を渡すと、exit 0 の run でも
# script は exit 1 になり、evidence_valid も false へ倒れる。
expect_run_exit_code "unwritable evidence file must fail the run" \
	1 preflight-activation 0 "$check_preflight_activation_log" "" \
	"${work_dir}/missing-directory/evidence.jsonl"
expect_equal "output evidence_valid (evidence file write failed)" "false" "$(step_output evidence_valid)"
expect_gate "gate rejects a run whose evidence file could not be written" \
	preflight-activation "$(step_output container_exit_code)" "$(step_output evidence_valid)" skipped fail
if ! grep -q "failed to write cutover evidence file" "${work_dir}/stderr.log"; then
	echo "FAIL: evidence file write failure must be reported on stderr" >&2
	failures=$((failures + 1))
fi

# 4-9. 引数不足・未知 operation は使用エラー（exit 2）で停止し、ECS を呼ばない。
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

# ---------------------------------------------------------------------------
# 5. workflow YAML と script の結線（gate が 3 条件を受け取っていること）
# ---------------------------------------------------------------------------

repo_root=$(cd -- "${script_dir}/../.." && pwd)
for workflow in \
	"${repo_root}/.github/workflows/ticket-type-cutover-dev.yml" \
	"${repo_root}/.github/workflows/ticket-type-cutover-staging.yml"; do
	workflow_name=$(basename "$workflow")
	# postflight step の起動条件と gate step の入力の両方が raw exit code を使うこと
	# （どちらか一方でも固定値へ差し替わると false-green 経路が復活する）。
	# shellcheck disable=SC2016 # workflow の literal（GitHub の式）をそのまま照合する
	if ! grep -q "steps.cutover.outputs.container_exit_code == '0'" "$workflow"; then
		echo "FAIL: ${workflow_name} must start the postflight step from the raw container_exit_code" >&2
		failures=$((failures + 1))
	fi
	# shellcheck disable=SC2016 # workflow の literal（GitHub の式）をそのまま照合する
	if ! grep -q 'CUTOVER_EXIT_CODE: ${{ steps.cutover.outputs.container_exit_code }}' "$workflow"; then
		echo "FAIL: ${workflow_name} must pass the raw container_exit_code into the gate step" >&2
		failures=$((failures + 1))
	fi
	# shellcheck disable=SC2016 # workflow の literal（GitHub の式）をそのまま照合する
	if ! grep -q 'CUTOVER_EVIDENCE_VALID: ${{ steps.cutover.outputs.evidence_valid }}' "$workflow"; then
		echo "FAIL: ${workflow_name} must pass evidence_valid into the gate step" >&2
		failures=$((failures + 1))
	fi
	# shellcheck disable=SC2016 # workflow の literal（gate step の run 本文）をそのまま照合する
	if ! grep -q 'cutover_gate_ok "$OPERATION" "$CUTOVER_EXIT_CODE" "$CUTOVER_EVIDENCE_VALID" "$POSTFLIGHT_OUTCOME"' "$workflow"; then
		echo "FAIL: ${workflow_name} must call cutover_gate_ok with all three conditions" >&2
		failures=$((failures + 1))
	fi
	if ! grep -q 'if-no-files-found: error' "$workflow"; then
		echo "FAIL: ${workflow_name} must fail the run when no evidence artifact is produced" >&2
		failures=$((failures + 1))
	fi
	# counter operation は workflow の choice に載せない（書き込み primitive の起動面を増やさない）。
	for counter_operation in seed-ticket-type seed-legacy reconcile-ticket-type reconcile-legacy; do
		if grep -qE "^ +- ${counter_operation}\$" "$workflow"; then
			echo "FAIL: ${workflow_name} must not expose ${counter_operation} as a dispatch choice" >&2
			failures=$((failures + 1))
		fi
	done
done

if ((failures > 0)); then
	echo "run-cutover-task fixtures failed: ${failures} assertion(s)" >&2
	exit 1
fi

echo "run-cutover-task fixtures passed"
