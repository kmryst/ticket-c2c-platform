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
migrate_cli="dist/src/search/search-index-migrate.cli.js"
rebuild_cli="dist/src/search/inventory-rebuild.cli.js"
reconcile_cli="dist/src/search/inventory-reconciliation.cli.js"

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
# projection operation（Codex High-2。runbook 手順からの手動実行専用）。
expect_command search-index-migrate "node ${migrate_cli}"
expect_command projection-rebuild "node ${rebuild_cli} --page-size 200 --bulk-size 200"
expect_command projection-reconcile "node ${reconcile_cli} --page-size 200"

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
expect_equal "operation kind: search-index-migrate" "projection" "$(cutover_operation_kind search-index-migrate)"
expect_equal "operation kind: projection-rebuild" "projection" "$(cutover_operation_kind projection-rebuild)"
expect_equal "operation kind: projection-reconcile" "projection" "$(cutover_operation_kind projection-reconcile)"

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
expect_workflow_operation search-index-migrate no
expect_workflow_operation projection-rebuild no
expect_workflow_operation projection-reconcile no

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
# counter expectation は「namespace / mode / seed 可能な control state」を返す
# （assertSeedNamespaceInactive: ticket-type は legacy mode のとき、legacy は ticket_type
# mode のときだけ seed できる。reconcile は "-" = 検査しない）。
expect_equal "counter expectation: seed-ticket-type" "ticket-type seed legacy" \
	"$(cutover_counter_expectation seed-ticket-type)"
expect_equal "counter expectation: seed-legacy" "legacy seed ticket_type" \
	"$(cutover_counter_expectation seed-legacy)"
expect_equal "counter expectation: reconcile-ticket-type" \
	"ticket-type reconcile -" "$(cutover_counter_expectation reconcile-ticket-type)"
expect_equal "projection expectation: search-index-migrate" "migrate" \
	"$(cutover_projection_expectation search-index-migrate)"
expect_equal "projection expectation: projection-rebuild" "rebuild" \
	"$(cutover_projection_expectation projection-rebuild)"
expect_equal "projection expectation: projection-reconcile" "reconcile" \
	"$(cutover_projection_expectation projection-reconcile)"

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
# projection operation も同じ規律（exit 0 + evidence_valid のみ green）。
expect_gate "search-index-migrate exit 0 + evidence" search-index-migrate 0 true skipped pass
expect_gate "search-index-migrate exit 1" search-index-migrate 1 true skipped fail
expect_gate "projection-rebuild exit 0 + evidence" projection-rebuild 0 true skipped pass
expect_gate "projection-rebuild exit 0 WITHOUT evidence" projection-rebuild 0 false skipped fail
expect_gate "projection-reconcile exit 0 + evidence" projection-reconcile 0 true skipped pass
# 差分あり（exit 2）は runbook の合格条件（差分 0）を満たさないので gate も失敗にする。
expect_gate "projection-reconcile exit 2 (diff found)" projection-reconcile 2 true skipped fail

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

# switch CLI の postSwitchDatabaseResults（checkCutoverDatabase の DATABASE_CATEGORIES 13 件）。
# ticket-type-cutover-readiness.ts の DATABASE_CATEGORIES と同じ並び。
cutover_db_categories=(
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
)
expect_equal "db category fixture matches script constant" \
	"${CUTOVER_SWITCH_DB_CATEGORIES[*]}" "${cutover_db_categories[*]}"

# post_switch_db_results <violating-category|"">
post_switch_db_results() {
	local violating_category=${1:-}
	printf '%s\n' "${cutover_db_categories[@]}" |
		jq -R --arg violating "$violating_category" \
			'{category: ., violationCount: (if . == $violating then 1 else 0 end)}' |
		jq -sc .
}

switch_success() {
	local source_mode=$1
	local target_mode=$2
	local db_results=${3:-"$(post_switch_db_results)"}
	jq -cn --arg source "$source_mode" --arg target "$target_mode" \
		--argjson dbResults "$db_results" '
		{
			action: "ticket-type-writer-mode-switch",
			switched: true,
			sourceMode: $source,
			targetMode: $target,
			schemaRevision: "1785542400000-add-ticket-type-compatibility-writer",
			postSwitchDatabaseResults: $dbResults
		}
	'
}

switch_ambiguous_applied() {
	local source_mode=$1
	local target_mode=$2
	local db_results=${3:-"$(post_switch_db_results)"}
	jq -cn --arg source "$source_mode" --arg target "$target_mode" \
		--argjson dbResults "$db_results" '
		{
			action: "ticket-type-writer-mode-switch",
			commitOutcome: "ambiguous",
			verifiedMode: $target,
			switched: true,
			sourceMode: $source,
			targetMode: $target,
			schemaRevision: "1785542400000-add-ticket-type-compatibility-writer",
			postSwitchDatabaseResults: $dbResults
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
# **Codex Medium-1**: 件数だけ 23 で category が重複している evidence（全 category を検査した
# 証跡になっていない）。最初の 1 件を 23 回並べる。
duplicated_category_log=$(log_messages \
	"$(readiness_evidence legacy preflight |
		jq -c '.results = [range(0; 23) | {category: "event_without_exactly_one_default", violationCount: 0}]')")
# 件数 23 のまま 1 件だけ正本に無い category へ差し替えた evidence（集合一致で落とす）。
unknown_category_log=$(log_messages \
	"$(readiness_evidence legacy preflight |
		jq -c '.results[0].category = "totally_unknown_category"')")

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
# **Codex Medium-1**: 23 件だが重複している / 正本に無い category が混じっている evidence。
expect_evidence "23 duplicated categories are rejected" \
	preflight-activation 0 "$duplicated_category_log" invalid
expect_evidence "unknown category is rejected" \
	preflight-activation 0 "$unknown_category_log" invalid
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

# **Codex Medium-1**: postSwitchDatabaseResults の検証。
# 空配列は「切替 transaction 内の parity 検査を通った証跡」にならないので受理しない。
empty_post_switch_log=$(log_messages \
	"$(readiness_evidence legacy preflight)" \
	"$(switch_success legacy ticket_type '[]')")
expect_evidence "activate exit 0 with empty postSwitchDatabaseResults" \
	activate 0 "$empty_post_switch_log" invalid
empty_post_switch_ambiguous_log=$(log_messages \
	"$(readiness_evidence legacy preflight)" \
	"$(switch_ambiguous_applied legacy ticket_type '[]')")
expect_evidence "activate exit 3 with empty postSwitchDatabaseResults" \
	activate 3 "$empty_post_switch_ambiguous_log" invalid
# 13 件だが重複している（全 DB category を検査した証跡になっていない）。
duplicated_post_switch_log=$(log_messages \
	"$(readiness_evidence legacy preflight)" \
	"$(switch_success legacy ticket_type \
		"$(jq -cn '[range(0; 13) | {category: "event_without_legacy_inventory", violationCount: 0}]')")")
expect_evidence "activate exit 0 with duplicated postSwitchDatabaseResults categories" \
	activate 0 "$duplicated_post_switch_log" invalid
# 件数不足（12 件）。
short_post_switch_log=$(log_messages \
	"$(readiness_evidence legacy preflight)" \
	"$(switch_success legacy ticket_type "$(post_switch_db_results | jq -c '.[0:12]')")")
expect_evidence "activate exit 0 with 12 postSwitchDatabaseResults categories" \
	activate 0 "$short_post_switch_log" invalid
# violation が残っている（switch CLI は ROLLBACK するのでこの出力は退行を意味する）。
violating_post_switch_log=$(log_messages \
	"$(readiness_evidence legacy preflight)" \
	"$(switch_success legacy ticket_type "$(post_switch_db_results writer_control_mode_mismatch)")")
expect_evidence "activate exit 0 with a violating postSwitchDatabaseResults category" \
	activate 0 "$violating_post_switch_log" invalid

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

# **Codex Medium-1**: seed 対象と逆の writerMode を持つ「成功」evidence を受理しない。
# ticket-type namespace は writer_mode=legacy のときだけ seed できる（逆は refuse される）。
expect_evidence "seed-ticket-type exit 0 with writerMode=ticket_type is rejected" \
	seed-ticket-type 0 "$(log_messages "$(counter_evidence ticket-type seed ticket_type 12 12 0 0)")" invalid
expect_evidence "seed-legacy exit 0 with writerMode=legacy is rejected" \
	seed-legacy 0 "$(log_messages "$(counter_evidence legacy seed legacy 5 5 0 0)")" invalid
# refuse（exit 2）側は「必須 mode 以外だったから refuse された」evidence でなければならない。
expect_evidence "seed-ticket-type exit 2 with writerMode=legacy is rejected" \
	seed-ticket-type 2 "$(log_messages "$(counter_refused ticket-type seed legacy)")" invalid
# reconcile は active / 非 active の双方に対して実行し得るため writerMode を固定しない。
expect_evidence "reconcile-legacy exit 0 with writerMode=legacy is accepted" \
	reconcile-legacy 0 "$(log_messages "$(counter_evidence legacy reconcile legacy 4 0 4 0)")" valid
expect_evidence "reconcile-legacy exit 0 with writerMode=ticket_type is accepted" \
	reconcile-legacy 0 "$(log_messages "$(counter_evidence legacy reconcile ticket_type 4 0 4 0)")" valid

# --- projection operation（Codex High-2）---
# 実出力の形は CLI の実装から取る:
# - search-index-migrate.cli.ts: {index, status: "ensured"}
# - inventory-rebuild.cli.ts:    RebuildReport {index, processedEvents, processedTicketTypes, bulkRequests}
# - inventory-reconciliation.cli.ts: ReconciliationReport
#   {index, checkedEvents, checkedDocuments, counts, totalDiffs, findings, hasDiff}
reconciliation_categories=(
	missing_event_document
	unexpected_event_document
	missing_ticket_type
	unexpected_ticket_type
	ticket_type_total_mismatch
	ticket_type_remaining_mismatch
	ticket_type_version_mismatch
	event_total_mismatch
	event_remaining_mismatch
	event_version_mismatch
	metadata_mismatch
	contract_corruption
	unversioned_projection
	malformed_projection
)
expect_equal "reconciliation category fixture matches script constant" \
	"${CUTOVER_RECONCILIATION_CATEGORIES[*]}" "${reconciliation_categories[*]}"

migrate_evidence() {
	jq -cn '{index: "events", status: "ensured"}'
}

rebuild_evidence() {
	jq -cn '{index: "events", processedEvents: 12, processedTicketTypes: 30, bulkRequests: 1}'
}

# reconcile_evidence <diff-category|"">
reconcile_evidence() {
	local diff_category=${1:-}
	local counts
	counts=$(printf '%s\n' "${reconciliation_categories[@]}" |
		jq -R --arg diff "$diff_category" '{key: ., value: (if . == $diff then 1 else 0 end)}' |
		jq -sc 'from_entries')
	jq -cn --argjson counts "$counts" '
		{
			index: "events",
			checkedEvents: 12,
			checkedDocuments: 12,
			counts: $counts,
			totalDiffs: ($counts | to_entries | map(.value) | add),
			findings: [],
			hasDiff: (($counts | to_entries | map(.value) | add) > 0)
		}
	'
}

migrate_log=$(log_messages "npm banner" "$(migrate_evidence)")
rebuild_log=$(log_messages "$(rebuild_evidence)")
reconcile_clean_log=$(log_messages "$(reconcile_evidence)")
reconcile_diff_log=$(log_messages "$(reconcile_evidence metadata_mismatch)")

expect_evidence "search-index-migrate exit 0" search-index-migrate 0 "$migrate_log" valid
expect_evidence "search-index-migrate exit 1 is never evidence-backed" \
	search-index-migrate 1 "$migrate_log" invalid
expect_evidence "projection-rebuild exit 0" projection-rebuild 0 "$rebuild_log" valid
expect_evidence "projection-rebuild exit 1 is never evidence-backed" \
	projection-rebuild 1 "$rebuild_log" invalid
expect_evidence "projection-reconcile exit 0 (no diff)" projection-reconcile 0 "$reconcile_clean_log" valid
expect_evidence "projection-reconcile exit 2 (diff)" projection-reconcile 2 "$reconcile_diff_log" valid
# exit code と hasDiff の整合。
expect_evidence "projection-reconcile exit 0 with hasDiff true is rejected" \
	projection-reconcile 0 "$reconcile_diff_log" invalid
expect_evidence "projection-reconcile exit 2 without diff is rejected" \
	projection-reconcile 2 "$reconcile_clean_log" invalid
# CLI の取り違え（別 projection CLI の出力を受理しない）。
expect_evidence "search-index-migrate must not accept rebuild output" \
	search-index-migrate 0 "$rebuild_log" invalid
expect_evidence "projection-rebuild must not accept migrate output" \
	projection-rebuild 0 "$migrate_log" invalid
expect_evidence "projection-reconcile must not accept rebuild output" \
	projection-reconcile 0 "$rebuild_log" invalid
expect_evidence "projection-rebuild must not accept reconcile output" \
	projection-rebuild 0 "$reconcile_clean_log" invalid
# cutover evidence を projection operation として受理しない（逆も）。
expect_evidence "projection-reconcile must not accept checker evidence" \
	projection-reconcile 0 "$check_preflight_activation_log" invalid
expect_evidence "preflight-activation must not accept reconcile output" \
	preflight-activation 0 "$reconcile_clean_log" invalid
# counts の完全性（category 欠落 / totalDiffs 不一致 / 値の型）。
expect_evidence "projection-reconcile with a missing counts category is rejected" \
	projection-reconcile 0 \
	"$(log_messages "$(reconcile_evidence | jq -c 'del(.counts.malformed_projection)')")" invalid
expect_evidence "projection-reconcile with an unknown counts category is rejected" \
	projection-reconcile 0 \
	"$(log_messages "$(reconcile_evidence | jq -c '.counts.totally_unknown = 0')")" invalid
expect_evidence "projection-reconcile with totalDiffs inconsistent with counts is rejected" \
	projection-reconcile 2 \
	"$(log_messages "$(reconcile_evidence metadata_mismatch | jq -c '.totalDiffs = 5')")" invalid
expect_evidence "projection-rebuild with a non-numeric counter is rejected" \
	projection-rebuild 0 \
	"$(log_messages "$(rebuild_evidence | jq -c '.bulkRequests = "1"')")" invalid
expect_evidence "search-index-migrate with status != ensured is rejected" \
	search-index-migrate 0 \
	"$(log_messages "$(migrate_evidence | jq -c '.status = "skipped"')")" invalid

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
		if [[ $1 == "--client-token" ]]; then
			printf '%s' "$2" >"${STUB_DIR}/client-token.txt"
		fi
		shift
	done
	# RunTask 呼び出し回数を記録する（同一 clientToken での再試行を数える）。
	run_task_calls=0
	if [[ -f "${STUB_DIR}/run-task-calls.txt" ]]; then
		run_task_calls=$(cat "${STUB_DIR}/run-task-calls.txt")
	fi
	run_task_calls=$((run_task_calls + 1))
	printf '%s' "$run_task_calls" >"${STUB_DIR}/run-task-calls.txt"
	# STUB_RUNTASK_LOST_RESPONSES 回だけ「AWS は受理したが応答が失われた」を模す。
	if ((run_task_calls <= ${STUB_RUNTASK_LOST_RESPONSES:-0})); then
		echo "None"
		exit 0
	fi
	echo "arn:aws:ecs:ap-northeast-1:111122223333:task/stub-cluster/0123456789abcdef"
	;;
"ecs list-tasks")
	# startedBy は単独 filter でなければならない（ECS ListTasks の API 仕様）。
	# スタブでも他の filter との併用を検出したら失敗させ、仕様違反の呼び出しを固定する。
	has_started_by=false
	has_other_filter=false
	while (($# > 0)); do
		case "$1" in
		--started-by)
			has_started_by=true
			printf '%s' "$2" >"${STUB_DIR}/list-tasks-started-by.txt"
			;;
		--desired-status | --service-name | --family | --container-instance | --launch-type)
			has_other_filter=true
			;;
		esac
		shift
	done
	if [[ $has_started_by == "true" && $has_other_filter == "true" ]]; then
		echo "InvalidParameterException: startedBy must be the only filter" >&2
		exit 254
	fi
	printf '%s' "${STUB_LIST_TASKS_ARNS:-}"
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

	rm -f "${work_dir}/overrides.json" "${work_dir}/started-by.txt" "${work_dir}/step-output.txt" \
		"${work_dir}/client-token.txt" "${work_dir}/run-task-calls.txt" \
		"${work_dir}/list-tasks-started-by.txt"
	: >"${work_dir}/step-output.txt"
	set +e
	env PATH="${stub_dir}:${PATH}" \
		STUB_DIR="$work_dir" \
		STUB_CONTAINER_NAME="stub-api" \
		STUB_TASK_CONTAINER_NAME="${task_container_name:-stub-api}" \
		STUB_EXIT_CODE="$exit_code" \
		STUB_LOG_JSON="$log_json" \
		STUB_RUNTASK_LOST_RESPONSES="${STUB_RUNTASK_LOST_RESPONSES:-0}" \
		STUB_LIST_TASKS_ARNS="${STUB_LIST_TASKS_ARNS:-}" \
		GITHUB_STEP_SUMMARY="${work_dir}/summary.md" \
		GITHUB_OUTPUT="${work_dir}/step-output.txt" \
		GITHUB_SERVER_URL="${SPEC_GITHUB_SERVER_URL-https://github.com}" \
		GITHUB_REPOSITORY="${SPEC_GITHUB_REPOSITORY-kmryst/ticket-c2c-platform}" \
		GITHUB_RUN_ID="${SPEC_GITHUB_RUN_ID-42}" \
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
# projection operation（Codex High-2）。reconcile の exit 2（差分あり）も潰さず伝搬する。
expect_run_exit_code "projection operation exit 0 (search-index-migrate)" 0 search-index-migrate 0 "$migrate_log"
expect_run_exit_code "projection operation exit 0 (projection-rebuild)" 0 projection-rebuild 0 "$rebuild_log"
expect_run_exit_code "projection operation exit 0 (projection-reconcile, no diff)" \
	0 projection-reconcile 0 "$reconcile_clean_log"
expect_run_exit_code "projection operation exit 2 (projection-reconcile, diff)" \
	2 projection-reconcile 2 "$reconcile_diff_log"
expect_run_exit_code "projection operation exit 1 (rebuild bulk item error)" \
	1 projection-rebuild 1 "$rebuild_log"
# false-green 禁止: 別 CLI の出力しか無い run を成功として報告しない。
expect_run_exit_code "search-index-migrate exit 0 with rebuild output must fail" \
	1 search-index-migrate 0 "$rebuild_log"

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
	# startedBy は operation 名だけでなく **session 固有 token** を含む（Codex High-4）。
	# 固定値 `cutover-<operation>` のままだと、同じ operation の別 run を ListTasks で
	# 区別できず、cancel 後に回収すべき task を一意に特定できない。
	local actual_started_by actual_client_token
	actual_started_by=$(cat "${work_dir}/started-by.txt")
	actual_client_token=$(cat "${work_dir}/client-token.txt")
	expect_equal "startedBy: ${operation}" \
		"cutover-${operation}-${actual_client_token}" "$actual_started_by"
	if [[ $actual_started_by == "cutover-${operation}" ]]; then
		echo "FAIL: startedBy must not be the run-independent literal cutover-${operation}" >&2
		failures=$((failures + 1))
	fi
	if ((${#actual_client_token} == 0 || ${#actual_client_token} > 64)); then
		echo "FAIL: clientToken length must be 1..64 (ECS RunTask limit) but was ${#actual_client_token}" >&2
		failures=$((failures + 1))
	fi
	if [[ ! $actual_started_by =~ ^[A-Za-z0-9_/-]{1,128}$ ]]; then
		echo "FAIL: startedBy must match the ECS charset/length limit: ${actual_started_by}" >&2
		failures=$((failures + 1))
	fi
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
expect_override search-index-migrate "node ${migrate_cli}" "$migrate_log"
expect_override projection-rebuild "node ${rebuild_cli} --page-size 200 --bulk-size 200" "$rebuild_log"
expect_override projection-reconcile "node ${reconcile_cli} --page-size 200" "$reconcile_clean_log"

# ---------------------------------------------------------------------------
# 4-5b. **Codex High-4**: RunTask 応答喪失時に実行中 task を回収する
# ---------------------------------------------------------------------------

# (a) 応答が失われても、同じ clientToken での再試行で task ARN を回収する。
#     ECS は成功済みリクエストを同じ token・同じ引数で再試行すると元の結果を返す
#     （ECS API Reference: Ensuring idempotency）。
STUB_RUNTASK_LOST_RESPONSES=2 \
	expect_run_exit_code "RunTask response loss is recovered by retrying with the same clientToken" \
	0 preflight-activation 0 "$check_preflight_activation_log"
expect_equal "RunTask was retried until the ARN was recovered" "3" \
	"$(cat "${work_dir}/run-task-calls.txt")"
if ! grep -q "recovered ECS task ARN by retrying RunTask with the same clientToken" \
	"${work_dir}/stderr.log"; then
	echo "FAIL: RunTask recovery must be reported on stderr" >&2
	failures=$((failures + 1))
fi

# (b) 再試行でも取れない場合は startedBy 単独の ListTasks で回収する。
#     スタブは startedBy と他 filter の併用を検出したら失敗するため、
#     この case は「単独 filter で呼んでいること」も同時に固定する。
STUB_RUNTASK_LOST_RESPONSES=99 \
	STUB_LIST_TASKS_ARNS="arn:aws:ecs:ap-northeast-1:111122223333:task/stub-cluster/recovered0001" \
	expect_run_exit_code "RunTask response loss is recovered via ListTasks --started-by" \
	0 preflight-activation 0 "$check_preflight_activation_log"
if ! grep -q "recovered ECS task ARN via ListTasks --started-by" "${work_dir}/stderr.log"; then
	echo "FAIL: ListTasks recovery must be reported on stderr" >&2
	failures=$((failures + 1))
fi
expect_equal "ListTasks recovery used the session-specific startedBy" \
	"$(cat "${work_dir}/started-by.txt")" "$(cat "${work_dir}/list-tasks-started-by.txt")"
expect_equal "recovered taskArn is recorded in the evidence lineage" \
	"arn:aws:ecs:ap-northeast-1:111122223333:task/stub-cluster/recovered0001" \
	"$(tail -n 1 "${work_dir}/evidence.jsonl" | jq -r '.lineage.taskArn')"

# (c) どの経路でも回収できない場合は fail closed。次の操作を止める指示を stderr へ出す。
STUB_RUNTASK_LOST_RESPONSES=99 STUB_LIST_TASKS_ARNS="" \
	expect_run_exit_code "unrecoverable RunTask response loss fails closed" \
	1 preflight-activation 0 "$check_preflight_activation_log"
if ! grep -q "Do NOT run any further cutover operation" "${work_dir}/stderr.log"; then
	echo "FAIL: unrecoverable RunTask response loss must forbid the next operation" >&2
	failures=$((failures + 1))
fi
if ! grep -q "startedBy must be the only ListTasks filter" "${work_dir}/stderr.log"; then
	echo "FAIL: the recovery hint must state the ListTasks single-filter constraint" >&2
	failures=$((failures + 1))
fi
# 複数件ヒットした場合は「この session の task を一意に特定できない」ので回収しない。
STUB_RUNTASK_LOST_RESPONSES=99 \
	STUB_LIST_TASKS_ARNS="arn:aws:ecs:ap-northeast-1:111122223333:task/stub-cluster/a1 arn:aws:ecs:ap-northeast-1:111122223333:task/stub-cluster/a2" \
	expect_run_exit_code "ambiguous ListTasks recovery fails closed" \
	1 preflight-activation 0 "$check_preflight_activation_log"

# (d) clientToken / startedBy は RunTask の **前に** stdout へ出す
#     （応答喪失時に run log から復元して再取得できるようにするため）。
run_stubbed_cutover preflight-activation 0 "$check_preflight_activation_log" >/dev/null
recorded_client_token=$(cat "${work_dir}/client-token.txt")
if ! grep -q "clientToken=${recorded_client_token} startedBy=cutover-preflight-activation-${recorded_client_token}" \
	"${work_dir}/stdout.log"; then
	echo "FAIL: clientToken / startedBy must be printed before RunTask" >&2
	failures=$((failures + 1))
fi
client_token_line=$(grep -n "^clientToken=" "${work_dir}/stdout.log" | head -n 1 | cut -d: -f1)
task_arn_line=$(grep -n "^taskArn=" "${work_dir}/stdout.log" | head -n 1 | cut -d: -f1)
if [[ -z $client_token_line || -z $task_arn_line ]] || ((client_token_line >= task_arn_line)); then
	echo "FAIL: clientToken must be logged before the taskArn line" >&2
	failures=$((failures + 1))
fi
# 実行ごとに token が変わる（session 固有であること）。
first_token=$(cat "${work_dir}/client-token.txt")
run_stubbed_cutover preflight-activation 0 "$check_preflight_activation_log" >/dev/null
if [[ $first_token == "$(cat "${work_dir}/client-token.txt")" ]]; then
	echo "FAIL: clientToken must be unique per run" >&2
	failures=$((failures + 1))
fi
# CUTOVER_CLIENT_TOKEN で固定できる（手動再取得の経路）。
CUTOVER_CLIENT_TOKEN="cutover-fixed-token-0001" \
	run_stubbed_cutover preflight-activation 0 "$check_preflight_activation_log" >/dev/null
expect_equal "CUTOVER_CLIENT_TOKEN pins the RunTask idempotency token" \
	"cutover-fixed-token-0001" "$(cat "${work_dir}/client-token.txt")"

# ---------------------------------------------------------------------------
# 4-5c. **Codex Medium-2**: lineage provenance（GitHub Actions / ローカル実行）
# ---------------------------------------------------------------------------

rm -f "${work_dir}/evidence.jsonl"
run_stubbed_cutover preflight-activation 0 "$check_preflight_activation_log" >/dev/null
lineage=$(tail -n 1 "${work_dir}/evidence.jsonl" | jq -c '.lineage')
expect_equal "lineage executionContext (GitHub Actions)" "github-actions" \
	"$(jq -r '.executionContext' <<<"$lineage")"
expect_equal "lineage runUrl (GitHub Actions)" \
	"https://github.com/kmryst/ticket-c2c-platform/actions/runs/42" \
	"$(jq -r '.runUrl' <<<"$lineage")"
expect_equal "lineage clientToken is recorded" "$(cat "${work_dir}/client-token.txt")" \
	"$(jq -r '.clientToken' <<<"$lineage")"
expect_equal "lineage startedBy is recorded" "$(cat "${work_dir}/started-by.txt")" \
	"$(jq -r '.startedBy' <<<"$lineage")"
expect_equal "lineage has no operator field on GitHub Actions" "null" \
	"$(jq -r '.operator // "null"' <<<"$lineage")"

# ローカル実行（GitHub run context 無し）: 壊れた `//actions/runs/` を出さず、
# 実行者・ホストで provenance を成立させる。
rm -f "${work_dir}/evidence.jsonl" "${work_dir}/summary.md"
SPEC_GITHUB_SERVER_URL="" SPEC_GITHUB_REPOSITORY="" SPEC_GITHUB_RUN_ID="" \
	CUTOVER_OPERATOR="gatsby" CUTOVER_OPERATOR_HOST="workstation-1" \
	run_stubbed_cutover projection-reconcile 0 "$reconcile_clean_log" >/dev/null
local_lineage=$(tail -n 1 "${work_dir}/evidence.jsonl" | jq -c '.lineage')
expect_equal "lineage executionContext (local)" "local" \
	"$(jq -r '.executionContext' <<<"$local_lineage")"
expect_equal "lineage has no runUrl on local runs" "null" \
	"$(jq -r '.runUrl // "null"' <<<"$local_lineage")"
expect_equal "lineage operator (local)" "gatsby" "$(jq -r '.operator' <<<"$local_lineage")"
expect_equal "lineage operatorHost (local)" "workstation-1" \
	"$(jq -r '.operatorHost' <<<"$local_lineage")"
expect_equal "lineage operation (local projection run)" "projection-reconcile" \
	"$(jq -r '.operation' <<<"$local_lineage")"
expect_equal "local projection evidence is captured in the JSONL" "1" \
	"$(tail -n 1 "${work_dir}/evidence.jsonl" | jq -r '.evidence | length')"
if grep -q "//actions/runs/" "${work_dir}/evidence.jsonl"; then
	echo "FAIL: local runs must not emit a broken runUrl" >&2
	failures=$((failures + 1))
fi
if grep -q "runUrl" "${work_dir}/summary.md"; then
	echo "FAIL: local step summary must not print a runUrl" >&2
	failures=$((failures + 1))
fi
for provenance_field in "clientToken" "startedBy" "executionContext" "operator" "operatorHost"; do
	if ! grep -q "${provenance_field}" "${work_dir}/summary.md"; then
		echo "FAIL: local step summary must include ${provenance_field}" >&2
		failures=$((failures + 1))
	fi
done

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
	# counter / projection operation は workflow の choice に載せない
	# （書き込み primitive の起動面を増やさない。operation choice は 6 択のまま）。
	for manual_operation in seed-ticket-type seed-legacy reconcile-ticket-type reconcile-legacy \
		search-index-migrate projection-rebuild projection-reconcile; do
		if grep -qE "^ +- ${manual_operation}\$" "$workflow"; then
			echo "FAIL: ${workflow_name} must not expose ${manual_operation} as a dispatch choice" >&2
			failures=$((failures + 1))
		fi
	done
	# operation choice はちょうど 6 択であること（承認済みの設計判断）。
	choice_count=$(awk '/^      operation:/,/^      task_definition_arn:/' "$workflow" |
		grep -cE "^          - [a-z-]+$")
	expect_equal "${workflow_name} operation choice count" "6" "$choice_count"

	# **Codex High-3**: 承認済み task definition の固定を機械強制する。
	# 1. input が required: true であること。
	if ! awk '/^      task_definition_arn:/,/^permissions:/' "$workflow" |
		grep -q "^        required: true$"; then
		echo "FAIL: ${workflow_name} must declare task_definition_arn as required: true" >&2
		failures=$((failures + 1))
	fi
	if ! awk '/^      task_definition_arn:/,/^permissions:/' "$workflow" |
		grep -q "^        type: string$"; then
		echo "FAIL: ${workflow_name} must declare task_definition_arn as type: string" >&2
		failures=$((failures + 1))
	fi
	# 2. `current` への fallback（`${TASK_DEFINITION_ARN:-current}`）が残っていないこと。
	# shellcheck disable=SC2016 # workflow の literal（shell 展開）をそのまま照合する
	if grep -q 'TASK_DEFINITION_ARN:-current' "$workflow"; then
		echo "FAIL: ${workflow_name} must not fall back to the 'current' task definition" >&2
		failures=$((failures + 1))
	fi
	# 3. 実行 step が空文字と `current` を明示的に拒否すること（cutover / postflight の 2 箇所）。
	# shellcheck disable=SC2016 # workflow の literal（shell 展開）をそのまま照合する
	reject_count=$(grep -cF '[ "$task_definition" = "current" ]' "$workflow")
	expect_equal "${workflow_name} rejects the 'current' sentinel in both run steps" "2" "$reject_count"
	# shellcheck disable=SC2016 # workflow の literal（shell 展開）をそのまま照合する
	empty_reject_count=$(grep -cF '[ -z "${task_definition// /}" ]' "$workflow")
	expect_equal "${workflow_name} rejects empty/whitespace task_definition_arn in both run steps" \
		"2" "$empty_reject_count"
done

# High-3 の拒否ロジックそのものを workflow から抜き出して真理値表で固定する
# （YAML の grep だけでは「書いてあるが効かない」条件を検出できない）。
extract_task_definition_guard() {
	local workflow=$1
	awk '
		/# 承認済み task definition の固定を機械強制する/ {capture = 1}
		capture {
			line = $0
			sub(/^          /, "", line)
			print line
		}
		capture && /^          fi$/ {exit}
	' "$workflow"
}

for workflow in \
	"${repo_root}/.github/workflows/ticket-type-cutover-dev.yml" \
	"${repo_root}/.github/workflows/ticket-type-cutover-staging.yml"; do
	workflow_name=$(basename "$workflow")
	guard_body=$(extract_task_definition_guard "$workflow")
	if [[ -z $guard_body ]]; then
		echo "FAIL: ${workflow_name} task definition guard could not be extracted" >&2
		failures=$((failures + 1))
		continue
	fi
	expect_task_definition_guard() {
		local label=$1
		local value=$2
		local expected=$3
		local actual="accept"
		if ! TASK_DEFINITION_ARN="$value" bash -c "set -uo pipefail; ${guard_body}" >/dev/null 2>&1; then
			actual="reject"
		fi
		expect_equal "${workflow_name} task definition guard: ${label}" "$expected" "$actual"
	}
	expect_task_definition_guard "approved ARN" \
		"arn:aws:ecs:ap-northeast-1:111122223333:task-definition/ticket-c2c-dev-api:7" accept
	expect_task_definition_guard "empty string" "" reject
	expect_task_definition_guard "whitespace only" "   " reject
	expect_task_definition_guard "current sentinel" "current" reject
done

if ((failures > 0)); then
	echo "run-cutover-task fixtures failed: ${failures} assertion(s)" >&2
	exit 1
fi

echo "run-cutover-task fixtures passed"
