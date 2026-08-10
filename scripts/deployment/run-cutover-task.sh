#!/usr/bin/env bash
# ECS run-task で Gate B cutover operation（preflight / activation / rollback / postflight）を
# 実行する（Issue #378 / ADR-0032 / ADR-0033）。
# API サービスのタスク定義（または指定タスク定義）を command override で流用し、
# private subnet 内から Aurora / Valkey / OpenSearch へ接続する。
#
# Usage:
#   run-cutover-task.sh <cluster> <api-service> <task-definition-arn|current> <operation>
#   operation（workflow の choice から起動する。kind = check / switch）:
#   - preflight-activation:  cutover:check --expect-mode legacy      --phase preflight
#   - activate:              cutover:switch --target-mode ticket_type
#   - postflight-activation: cutover:check --expect-mode ticket_type --phase postflight
#   - preflight-rollback:    cutover:check --expect-mode ticket_type --phase preflight
#   - rollback:              cutover:switch --target-mode legacy
#   - postflight-rollback:   cutover:check --expect-mode legacy      --phase postflight
#   operation（**workflow からは起動できない**。runbook 手順から手動実行する。kind = counter）:
#   - seed-ticket-type:      cutover:valkey --namespace ticket-type --mode seed
#   - seed-legacy:           cutover:valkey --namespace legacy      --mode seed
#   - reconcile-ticket-type: cutover:valkey --namespace ticket-type --mode reconcile
#   - reconcile-legacy:      cutover:valkey --namespace legacy      --mode reconcile
#   operation（**workflow からは起動できない**。runbook 手順から手動実行する。kind = projection）:
#   - search-index-migrate:  search-index:migrate（OpenSearch events index の mapping migration）
#   - projection-rebuild:    projection:rebuild   --page-size 200 --bulk-size 200
#   - projection-reconcile:  projection:reconcile --page-size 200
#   引数はすべて必須（既定値を持たせない）。方向・対象は operation 名に固定し、
#   --target-mode / --expect-mode / --namespace の手打ち誤指定を構造的に排除する
#   （ADR-0032 の緩和策）。
#
# counter / projection operation を cutover workflow の choice に載せない理由:
# 「書き込み primitive の起動面を増やさない」は Issue #378 の確定済み設計判断である。
# seed は activation / rollback session 中に 1 回だけ、checker とセットで人が確認しながら
# 実行する手順であり、6 択に混ぜると（CLI が refuse するとはいえ）active namespace への
# 誤発火面が増える。一方で container 名一致の exit code 取得・evidence 検証・
# JSONL lineage・step summary は check / switch と共通化する価値があるため、
# **この script の operation allowlist にだけ** counter / projection operation を追加してある。
# 起動経路は docs/runbooks/gate-b-ticket-type-cutover.md および
# docs/runbooks/search-projection-reconciliation-rebuild.md の該当 step（手動実行）だけである。
#
# projection operation を足した理由（Codex High-2）:
# staging / dev の OpenSearch は VPC 内・SigV4 署名必須のため、operator 端末から
# `node dist/src/search/...` を直接実行できない。runbook が「委譲先にコンテナ内の node コマンド
# しか書いていない」状態では Gate B step の mapping migration / rebuild / reconciliation を
# 手順どおり完了できないため、counter operation と同じ RunTask helper 経路を用意する。
#
# run-db-migration.sh を流用しない理由（実読確認済み）:
# 1. mode が migration / ticket-type-readiness の 2 択固定である。
# 2. container exit code の非 0 を一律 `exit 1` へ潰す（run-db-migration.sh の判定）。
#    cutover CLI の exit code は 0 / 2 / 3 / 4 / 1 が別々の運用判断に対応するため
#    （switch-ticket-type-writer-mode.ts のファイル冒頭規約）、潰してはいけない。
#
# 本 script は container の exit code をそのまま自身の exit code にする。ただし
# **exit 0 でも evidence JSON が有効でなければ exit 1 で失敗させる**（false-green 禁止）。
#
# raw exit code と evidence 有効性は別々の output として報告する（GITHUB_OUTPUT）:
# - container_exit_code: container 名一致で取得した raw exit code（取得不能なら "none"）
# - evidence_valid: operation と exit code に対して期待どおりの evidence が揃ったか
# workflow は raw exit code を postflight step の起動条件に使い、最終 gate では
# 「raw exit code」「evidence_valid」「postflight outcome」の 3 つをすべて必須にする。
# raw を使わずに script 自身の exit code だけで gate すると、exit 3（COMMIT 応答喪失だが
# 切替は有効）で evidence を取り切れなかった run が「exit 3 + postflight success」で
# green になり得るため、両者を分離している。
#
# この script は Gate B（compatibility 期間）専用であり、ADR-0033 決定 3 により
# #384（fresh session final cleanup）実装後に ADR-0032 CLI ごと退役する。
#
# 純関数（operation 変換・evidence 判定・gate 判定）は spec から source して検証できるよう、
# main の実行は「直接実行されたときだけ」に限定する。

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/deployment/ecs-task-container-exit-code.sh
source "${script_dir}/ecs-task-container-exit-code.sh"

CUTOVER_CHECK_CLI="dist/src/cutover/check-ticket-type-cutover-readiness.js"
CUTOVER_SWITCH_CLI="dist/src/cutover/switch-ticket-type-writer-mode.js"
CUTOVER_COUNTER_CLI="dist/src/cutover/reconcile-inventory-counters.js"
CUTOVER_MIGRATE_CLI="dist/src/search/search-index-migrate.cli.js"
CUTOVER_REBUILD_CLI="dist/src/search/inventory-rebuild.cli.js"
CUTOVER_RECONCILE_CLI="dist/src/search/inventory-reconciliation.cli.js"

# projection CLI の bounded page / bulk size（search-projection-reconciliation-rebuild.md の
# 実行例と同じ値を operation に固定し、手打ちの取り違えを排除する）。
CUTOVER_PROJECTION_PAGE_SIZE=200
CUTOVER_PROJECTION_BULK_SIZE=200

# checker evidence の category 集合（ticket-type-cutover-readiness.ts の
# TICKET_TYPE_CUTOVER_READINESS_CATEGORIES と 1 対 1。件数だけでなく **集合そのもの** を
# 固定する（Codex Medium-1: 件数一致だけだと 23 件の重複 category を受理してしまう）。
# 契約が変わったら、ここも spec も同時に更新する）。
CUTOVER_EVIDENCE_CATEGORIES=(
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
CUTOVER_EVIDENCE_CATEGORY_COUNT=${#CUTOVER_EVIDENCE_CATEGORIES[@]}

# switch CLI の postSwitchDatabaseResults が持つ category 集合
# （ticket-type-cutover-readiness.ts の DATABASE_CATEGORIES と 1 対 1。checkCutoverDatabase が
# 返すのは DB 10 + control state 2 + compatibility object 1 の 13 件で、Valkey / OpenSearch は
# 含まない）。空配列を受理すると「切替 transaction 内の parity 検査を通った」証跡が無いまま
# green になるため、集合一致（重複があれば別 category が欠けるので不一致になる）と
# 全件 violationCount 0 を必須にする（Codex Medium-1）。
CUTOVER_SWITCH_DB_CATEGORIES=(
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

# reconciliation report の counts が持つ category 集合
# （inventory-reconciliation.service.ts の RECONCILIATION_CATEGORIES と 1 対 1）。
CUTOVER_RECONCILIATION_CATEGORIES=(
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

# CUTOVER_EVIDENCE_SELECT_FILTER は task log の各行から「evidence として保存する JSON」を選ぶ
# jq filter（step summary と evidence file で同じ定義を使う）。projection CLI の出力は
# evidenceType / action を持たないため、CLI ごとに一意な必須 field で識別する
# （migrate: status="ensured" / rebuild: processedEvents / reconcile: hasDiff）。
CUTOVER_EVIDENCE_SELECT_FILTER='
	.[]
	| select(type == "string")
	| fromjson?
	| select(type == "object")
	| select(
		.evidenceType == "ticket-type-cutover-readiness"
			or .action != null
			or (.index != null and (.status == "ensured" or has("processedEvents") or has("hasDiff")))
	)
'

CUTOVER_USAGE="usage: run-cutover-task.sh <cluster> <api-service> <task-definition-arn|current> <operation>
operation (workflow): preflight-activation | activate | postflight-activation | preflight-rollback | rollback | postflight-rollback
operation (runbook manual only): seed-ticket-type | seed-legacy | reconcile-ticket-type | reconcile-legacy
operation (runbook manual only): search-index-migrate | projection-rebuild | projection-reconcile"

# set_cutover_operation_command は operation を ECS command override の argv へ機械変換する。
# 変換結果は配列 cutover_operation_command に格納する（未知の operation は fail closed）。
cutover_operation_command=()
set_cutover_operation_command() {
	case "$1" in
	preflight-activation)
		cutover_operation_command=(node "$CUTOVER_CHECK_CLI" --expect-mode legacy --phase preflight)
		;;
	activate)
		cutover_operation_command=(node "$CUTOVER_SWITCH_CLI" --target-mode ticket_type)
		;;
	postflight-activation)
		cutover_operation_command=(node "$CUTOVER_CHECK_CLI" --expect-mode ticket_type --phase postflight)
		;;
	preflight-rollback)
		cutover_operation_command=(node "$CUTOVER_CHECK_CLI" --expect-mode ticket_type --phase preflight)
		;;
	rollback)
		cutover_operation_command=(node "$CUTOVER_SWITCH_CLI" --target-mode legacy)
		;;
	postflight-rollback)
		cutover_operation_command=(node "$CUTOVER_CHECK_CLI" --expect-mode legacy --phase postflight)
		;;
	seed-ticket-type)
		cutover_operation_command=(node "$CUTOVER_COUNTER_CLI" --namespace ticket-type --mode seed)
		;;
	seed-legacy)
		cutover_operation_command=(node "$CUTOVER_COUNTER_CLI" --namespace legacy --mode seed)
		;;
	reconcile-ticket-type)
		cutover_operation_command=(node "$CUTOVER_COUNTER_CLI" --namespace ticket-type --mode reconcile)
		;;
	reconcile-legacy)
		cutover_operation_command=(node "$CUTOVER_COUNTER_CLI" --namespace legacy --mode reconcile)
		;;
	search-index-migrate)
		cutover_operation_command=(node "$CUTOVER_MIGRATE_CLI")
		;;
	projection-rebuild)
		cutover_operation_command=(
			node "$CUTOVER_REBUILD_CLI"
			--page-size "$CUTOVER_PROJECTION_PAGE_SIZE"
			--bulk-size "$CUTOVER_PROJECTION_BULK_SIZE"
		)
		;;
	projection-reconcile)
		cutover_operation_command=(
			node "$CUTOVER_RECONCILE_CLI"
			--page-size "$CUTOVER_PROJECTION_PAGE_SIZE"
		)
		;;
	*)
		cutover_operation_command=()
		return 1
		;;
	esac
}

# cutover_operation_kind は operation の種別を返す。
# - switch:  control state を書き換える（ADR-0032 の切替 CLI）
# - check:   読み取り専用の readiness checker
# - counter: Valkey counter を seed / reconcile する（workflow からは起動しない）
# - projection: OpenSearch mapping migration / rebuild / reconciliation（workflow からは起動しない）
cutover_operation_kind() {
	case "$1" in
	activate | rollback)
		echo "switch"
		;;
	preflight-activation | postflight-activation | preflight-rollback | postflight-rollback)
		echo "check"
		;;
	seed-ticket-type | seed-legacy | reconcile-ticket-type | reconcile-legacy)
		echo "counter"
		;;
	search-index-migrate | projection-rebuild | projection-reconcile)
		echo "projection"
		;;
	*)
		return 1
		;;
	esac
}

# cutover_workflow_operation は cutover workflow の choice から起動してよい operation かを返す
# （counter / projection operation は runbook 手順からの手動実行専用）。
cutover_workflow_operation() {
	local kind
	kind=$(cutover_operation_kind "$1") || return 1
	[[ $kind == "switch" || $kind == "check" ]]
}

# cutover_check_expectation は check operation が出すべき evidence の
# expectedWriterMode / checkPhase を返す（"<mode> <phase>"）。
cutover_check_expectation() {
	case "$1" in
	preflight-activation) echo "legacy preflight" ;;
	postflight-activation) echo "ticket_type postflight" ;;
	preflight-rollback) echo "ticket_type preflight" ;;
	postflight-rollback) echo "legacy postflight" ;;
	*) return 1 ;;
	esac
}

# cutover_switch_modes は switch operation の source / target mode を返す（"<source> <target>"）。
# switch CLI は preflight evidence を expectedWriterMode = source mode で出力する
# （ticket-type-writer-mode-switch.ts: expectedWriterMode: sourceMode / checkPhase: 'preflight'）。
cutover_switch_modes() {
	case "$1" in
	activate) echo "legacy ticket_type" ;;
	rollback) echo "ticket_type legacy" ;;
	*) return 1 ;;
	esac
}

# cutover_counter_expectation は counter operation の namespace / mode / 必須 writerMode を返す
# （"<namespace> <mode> <required-writer-mode>"）。
#
# 第 3 要素は seed operation が成功してよい control state である
# （reconcile-inventory-counters.ts の assertSeedNamespaceInactive: seed 対象 namespace は
# 非 active でなければならない。ticket-type namespace は writer_mode=legacy のときだけ、
# legacy namespace は writer_mode=ticket_type のときだけ seed できる）。
# これを evidence 側でも固定しないと、**seed 対象と逆の writerMode を持つ evidence** を
# 受理してしまう（Codex Medium-1。CLI は refuse するが、artifact 取り違えでは検出できない）。
# reconcile は active / 非 active の双方に対して実行し得るため "-"（検査しない）。
cutover_counter_expectation() {
	case "$1" in
	seed-ticket-type) echo "ticket-type seed legacy" ;;
	seed-legacy) echo "legacy seed ticket_type" ;;
	reconcile-ticket-type) echo "ticket-type reconcile -" ;;
	reconcile-legacy) echo "legacy reconcile -" ;;
	*) return 1 ;;
	esac
}

# cutover_projection_expectation は projection operation が出すべき CLI 出力の種別を返す
# （migrate / rebuild / reconcile）。exit code 規約も CLI ごとに違う:
# - search-index-migrate（search-index-migrate.cli.ts）: 0 = 成功 / 1 = 実行エラー
# - projection-rebuild（inventory-rebuild.cli.ts）:      0 = 成功 / 1 = 実行エラー
# - projection-reconcile（inventory-reconciliation.cli.ts）: 0 = 差分 0 / 2 = 差分あり / 1 = 実行エラー
cutover_projection_expectation() {
	case "$1" in
	search-index-migrate) echo "migrate" ;;
	projection-rebuild) echo "rebuild" ;;
	projection-reconcile) echo "reconcile" ;;
	*) return 1 ;;
	esac
}

# cutover_readiness_evidence_valid は checker evidence（1 行 JSON）を
# **operation の期待値に対して**検証する。
#
# 構造の存在だけを見ると、task definition の取り違え（逆方向 operation の CLI が動いた）や
# 出力契約の退行（complete: false / results: [{}] / 逆方向の expectedWriterMode・checkPhase）
# を検出できない。そこで期待値を固定する:
# - expectedWriterMode / checkPhase が operation と一致すること
# - complete が true であること（serializeTicketTypeCutoverEvidence が必ず立てる）
# - results / categoryCount が 23 category ちょうどであること
#   （assertTicketTypeCutoverReadinessComplete が欠落・重複を禁じている）
# - **results の category 集合が正本と完全一致すること**（Codex Medium-1）。
#   件数一致だけでは「同じ category が 23 個並んだ evidence」を受理してしまい、
#   全 category を検査した証跡にならない。sort 済み集合の完全一致は重複も同時に排除する
#   （重複があれば別の category が欠けるので一致しない）。
# - require_zero_violations = true（exit 0 = 全 category 0）のときは全 violationCount が 0
# - require_zero_violations = false かつ exit 2 のときは violation が 1 件以上
#   （checker / switch の exit 2 は hasTicketTypeCutoverViolations と 1 対 1）
cutover_readiness_evidence_valid() {
	local task_log_messages_json=$1
	local expected_mode=$2
	local expected_phase=$3
	local violation_expectation=$4 # zero | some | any
	local expected_categories_json
	expected_categories_json=$(printf '%s\n' "${CUTOVER_EVIDENCE_CATEGORIES[@]}" | jq -R . | jq -sc 'sort')

	jq -e \
		--arg expectedMode "$expected_mode" \
		--arg expectedPhase "$expected_phase" \
		--arg violations "$violation_expectation" \
		--argjson categoryCount "$CUTOVER_EVIDENCE_CATEGORY_COUNT" \
		--argjson expectedCategories "$expected_categories_json" '
		[
			.[]
			| select(type == "string")
			| fromjson?
			| select(type == "object")
		]
		| any(
			.[];
			.evidenceType == "ticket-type-cutover-readiness"
				and .evidenceVersion == 1
				and .complete == true
				and .expectedWriterMode == $expectedMode
				and .checkPhase == $expectedPhase
				and (.writerMode | type) == "string"
				and (.schemaRevision | type) == "string"
				and (.results | type) == "array"
				and (.results | length) == $categoryCount
				and .categoryCount == $categoryCount
				and (
					.results
					| all(
						.[];
						(.category | type) == "string"
							and (.violationCount | type) == "number"
					)
				)
				and ([.results[].category] | sort) == $expectedCategories
				and (
					if $violations == "zero" then
						(.results | all(.[]; .violationCount == 0))
					elif $violations == "some" then
						(.results | any(.[]; .violationCount > 0))
					else
						true
					end
				)
		)
	' <<<"$task_log_messages_json" >/dev/null 2>&1
}

# cutover_switch_result_valid は switch CLI の結果行（1 行 JSON）を exit code の
# 期待値に対して検証する（switch-ticket-type-writer-mode.ts の出力と 1 対 1）:
# - exit 0: switched = true / commitOutcome なし / sourceMode・targetMode が operation と一致
# - exit 3: commitOutcome = ambiguous / verifiedMode = target / switched = true /
#           sourceMode・targetMode が一致（pendingResult を伴う）
# - exit 4: commitOutcome = ambiguous / verifiedMode = source / switched = false
#           （result は null なので sourceMode / targetMode は出力されない）
#
# exit 0 / 3 では postSwitchDatabaseResults を **13 category の集合一致・全件 0** で
# 要求する（Codex Medium-1）。ticket-type-writer-mode-switch.ts は checkCutoverDatabase
# （DATABASE_CATEGORIES 13 件）の結果をそのまま載せ、violation があれば ROLLBACK して
# ここへ到達しないため、空配列や欠落は「切替 transaction 内の parity 検査を通った証跡が無い」
# ことを意味する。
cutover_switch_result_valid() {
	local task_log_messages_json=$1
	local source_mode=$2
	local target_mode=$3
	local exit_code=$4
	local expected_db_categories_json
	expected_db_categories_json=$(printf '%s\n' "${CUTOVER_SWITCH_DB_CATEGORIES[@]}" | jq -R . | jq -sc 'sort')

	jq -e \
		--arg sourceMode "$source_mode" \
		--arg targetMode "$target_mode" \
		--arg exitCode "$exit_code" \
		--argjson expectedDbCategories "$expected_db_categories_json" '
		def post_switch_db_ok:
			(.postSwitchDatabaseResults | type) == "array"
			and (
				.postSwitchDatabaseResults
				| all(
					.[];
					(.category | type) == "string"
						and (.violationCount | type) == "number"
						and .violationCount == 0
				)
			)
			and ([.postSwitchDatabaseResults[].category] | sort) == $expectedDbCategories;
		[
			.[]
			| select(type == "string")
			| fromjson?
			| select(type == "object")
		]
		| any(
			.[];
			.action == "ticket-type-writer-mode-switch"
				and (
					if $exitCode == "0" then
						.switched == true
							and (.commitOutcome == null)
							and .sourceMode == $sourceMode
							and .targetMode == $targetMode
							and (.schemaRevision | type) == "string"
							and post_switch_db_ok
					elif $exitCode == "3" then
						.commitOutcome == "ambiguous"
							and .verifiedMode == $targetMode
							and .switched == true
							and .sourceMode == $sourceMode
							and .targetMode == $targetMode
							and post_switch_db_ok
					elif $exitCode == "4" then
						.commitOutcome == "ambiguous"
							and .verifiedMode == $sourceMode
							and .switched == false
					else
						false
					end
				)
		)
	' <<<"$task_log_messages_json" >/dev/null 2>&1
}

# cutover_counter_result_valid は seed / reconcile CLI の evidence を検証する
# （reconcile-inventory-counters.ts の serializeCounterReconcileEvidence / refuse 出力と 1 対 1）:
# - exit 0 かつ seed: refused なし / initialized == processed / synced == 0 / skipped == 0 /
#                     writerMode が seed 対象 namespace の非 active 条件と一致
# - exit 0 かつ reconcile: refused なし / initialized == 0 / processed == synced + skipped
# - exit 2: refused == true（guard 違反。Valkey への書き込みなし）。seed の場合は
#           writerMode が **必須 mode 以外** であること（refuse の根拠と一致すること）。
#
# required_writer_mode は seed 対象 namespace が非 active である control state（"-" = 検査しない）。
# これを見ないと「seed 対象と逆の writerMode を持つ成功 evidence」を受理してしまう
# （Codex Medium-1。CLI は refuse するので実出力には現れないが、artifact 取り違えや
# 出力契約の退行では false-green になる）。
cutover_counter_result_valid() {
	local task_log_messages_json=$1
	local namespace=$2
	local counter_mode=$3
	local exit_code=$4
	local required_writer_mode=${5:--}

	jq -e \
		--arg namespace "$namespace" \
		--arg counterMode "$counter_mode" \
		--arg exitCode "$exit_code" \
		--arg requiredWriterMode "$required_writer_mode" '
		[
			.[]
			| select(type == "string")
			| fromjson?
			| select(type == "object")
		]
		| any(
			.[];
			.action == "inventory-counter-reconcile"
				and .namespace == $namespace
				and .mode == $counterMode
				and (.writerMode | type) == "string"
				and (
					if $exitCode == "0" then
						(.refused == null or .refused == false)
							and (.processed | type) == "number"
							and (.initialized | type) == "number"
							and (.synced | type) == "number"
							and (.skipped | type) == "number"
							and ($requiredWriterMode == "-" or .writerMode == $requiredWriterMode)
							and (
								if $counterMode == "seed" then
									.initialized == .processed
										and .synced == 0
										and .skipped == 0
								else
									.initialized == 0
										and .processed == (.synced + .skipped)
								end
							)
					elif $exitCode == "2" then
						.refused == true
							and (.reason | type) == "string"
							and ($requiredWriterMode == "-" or .writerMode != $requiredWriterMode)
					else
						false
					end
				)
		)
	' <<<"$task_log_messages_json" >/dev/null 2>&1
}

# cutover_projection_result_valid は projection CLI の出力を exit code の期待値に対して検証する。
# projection CLI は evidenceType / action を持たないため、CLI ごとに一意な必須 field で識別する。
# - migrate（search-index-migrate.cli.ts）: exit 0 のみ valid。`{index, status: "ensured"}`
# - rebuild（inventory-rebuild.cli.ts）: exit 0 のみ valid。RebuildReport の 3 counter が数値
# - reconcile（inventory-reconciliation.cli.ts）: exit 0 = hasDiff false / totalDiffs 0 / 全 counts 0、
#   exit 2 = hasDiff true / totalDiffs > 0。いずれも counts が 14 category ちょうど（重複なし・
#   欠落なし。RECONCILIATION_CATEGORIES と集合一致）で、totalDiffs が counts の総和と一致すること。
cutover_projection_result_valid() {
	local task_log_messages_json=$1
	local projection_mode=$2
	local exit_code=$3
	local expected_categories_json
	expected_categories_json=$(printf '%s\n' "${CUTOVER_RECONCILIATION_CATEGORIES[@]}" | jq -R . | jq -sc 'sort')

	jq -e \
		--arg projectionMode "$projection_mode" \
		--arg exitCode "$exit_code" \
		--argjson expectedCategories "$expected_categories_json" '
		[
			.[]
			| select(type == "string")
			| fromjson?
			| select(type == "object")
		]
		| any(
			.[];
			if $projectionMode == "migrate" then
				$exitCode == "0"
					and (.index | type) == "string"
					and .status == "ensured"
			elif $projectionMode == "rebuild" then
				$exitCode == "0"
					and (.index | type) == "string"
					and (.processedEvents | type) == "number"
					and (.processedTicketTypes | type) == "number"
					and (.bulkRequests | type) == "number"
			elif $projectionMode == "reconcile" then
				(.index | type) == "string"
					and (.counts | type) == "object"
					and (.totalDiffs | type) == "number"
					and (.findings | type) == "array"
					and (.checkedEvents | type) == "number"
					and (.checkedDocuments | type) == "number"
					and (.counts | keys | sort) == $expectedCategories
					and (.counts | to_entries | all(.[]; (.value | type) == "number"))
					and .totalDiffs == (.counts | to_entries | map(.value) | add)
					and (
						if $exitCode == "0" then
							.hasDiff == false
								and .totalDiffs == 0
						elif $exitCode == "2" then
							.hasDiff == true
								and .totalDiffs > 0
						else
							false
						end
					)
			else
				false
			end
		)
	' <<<"$task_log_messages_json" >/dev/null 2>&1
}

# cutover_evidence_valid は「operation と exit code の組に対して期待どおりの evidence が
# 揃っているか」を判定する（構造の存在だけでは判定しない。Codex Medium-1）。
#
# exit code ごとの扱い:
# - check:   exit 0 = 全 category violation 0 / exit 2 = violation 1 件以上。
#            それ以外（1 等）は「evidence を根拠にできない」ので invalid。
# - switch:  exit 0 / 3 / 4 は preflight evidence（source mode / preflight）＋切替結果。
#            exit 2 は preflight evidence のみ（violation 1 件以上。切替結果は出ない）。
#            exit 1 は invalid（実行エラー。手動確認へ倒す）。
# - counter: exit 0 / 2 のみ valid。
cutover_evidence_valid() {
	local task_log_messages_json=$1
	local operation=$2
	local exit_code=$3
	local kind expectation

	kind=$(cutover_operation_kind "$operation") || return 1

	case "$kind" in
	check)
		expectation=$(cutover_check_expectation "$operation") || return 1
		local expected_mode expected_phase
		read -r expected_mode expected_phase <<<"$expectation"
		case "$exit_code" in
		0) cutover_readiness_evidence_valid "$task_log_messages_json" "$expected_mode" "$expected_phase" zero ;;
		2) cutover_readiness_evidence_valid "$task_log_messages_json" "$expected_mode" "$expected_phase" some ;;
		*) return 1 ;;
		esac
		;;
	switch)
		expectation=$(cutover_switch_modes "$operation") || return 1
		local source_mode target_mode
		read -r source_mode target_mode <<<"$expectation"
		case "$exit_code" in
		0 | 3 | 4)
			cutover_readiness_evidence_valid \
				"$task_log_messages_json" "$source_mode" preflight zero || return 1
			cutover_switch_result_valid \
				"$task_log_messages_json" "$source_mode" "$target_mode" "$exit_code"
			;;
		2)
			cutover_readiness_evidence_valid \
				"$task_log_messages_json" "$source_mode" preflight some
			;;
		*) return 1 ;;
		esac
		;;
	counter)
		expectation=$(cutover_counter_expectation "$operation") || return 1
		local namespace counter_mode required_writer_mode
		read -r namespace counter_mode required_writer_mode <<<"$expectation"
		cutover_counter_result_valid \
			"$task_log_messages_json" "$namespace" "$counter_mode" "$exit_code" \
			"$required_writer_mode"
		;;
	projection)
		expectation=$(cutover_projection_expectation "$operation") || return 1
		cutover_projection_result_valid \
			"$task_log_messages_json" "$expectation" "$exit_code"
		;;
	*)
		return 1
		;;
	esac
}

# cutover_gate_ok は workflow 最終 gate step の判定式（false-green 防止の中核）。
# 引数は raw exit code / evidence 有効性 / postflight outcome の 3 つを独立に取り、
# **すべてを必須条件にする**。戻り値 0 = job を成功させてよい、1 = job を失敗させる。
#
# - switch operation（activate / rollback）: 次の 3 条件をすべて満たすこと。
#   1. raw exit code が 0 または 3
#   2. evidence_valid が true（切替結果 + preflight evidence が operation どおりに揃った）
#   3. 同一 run 内の postflight step が success
#   exit 3（COMMIT 応答喪失だが切替は有効）で CloudWatch Logs の取得が間に合わず
#   evidence を取れなかった run は、postflight が success でも 2 で落ちる。
#   raw exit code が空文字（step 自体が異常終了して output を書けなかった）、
#   evidence_valid が空文字、postflight の skipped / failure / cancelled もすべて失敗。
# - check operation: raw exit code 0 かつ evidence_valid true（gate 側でも独立に固定する。
#   script 側の fail-closed と二重化して、片方の退行だけでは green にならないようにする）。
# - counter / projection operation: workflow からは起動しないが、判定は check と同じ規律にする。
#   projection-reconcile の exit 2（差分あり）も gate としては失敗にする（差分 0 を合格条件と
#   する runbook の停止条件と一致させる）。
# - 未知の operation: 失敗（fail closed）。
cutover_gate_ok() {
	local operation=$1
	local exit_code=$2
	local evidence_valid=$3
	local postflight_outcome=$4
	local kind

	kind=$(cutover_operation_kind "$operation") || return 1

	[[ $evidence_valid == "true" ]] || return 1

	if [[ $kind == "switch" ]]; then
		[[ $exit_code == "0" || $exit_code == "3" ]] || return 1
		[[ $postflight_outcome == "success" ]] || return 1
		return 0
	fi

	[[ $exit_code == "0" ]] || return 1
	return 0
}

# cutover_exit_code_advice は exit code ごとの再実行可否の規約文言を返す
# （switch-ticket-type-writer-mode.ts の exit code 規約と 1 対 1）。
cutover_exit_code_advice() {
	local exit_code=$1

	case "$exit_code" in
	0)
		echo "exit 0: 操作は成功した。runbook の次の step へ進む。"
		;;
	2)
		echo "exit 2: violation あり（switch operation では切替未開始）。violation を解消してから preflight をやり直す。"
		;;
	3)
		echo "exit 3: COMMIT 応答は不明だったが再確認で target mode を確認した（切替は有効）。commitOutcome=ambiguous。同一 run 内の postflight 結果を必ず確認する。"
		;;
	4)
		echo "exit 4: COMMIT 応答は不明で再確認では source mode のままだった（切替は未適用）。新しい preflight から再実行できる。"
		;;
	1)
		echo "exit 1: 実行エラー（結果不明を含む）。inventory_writer_control を手動確認するまで次の操作へ進まない。"
		;;
	"")
		echo "exit code 未取得: step が異常終了して exit code を記録できなかった。exit 1 と同じ扱いで、inventory_writer_control を手動確認するまで次の操作へ進まない。"
		;;
	*)
		echo "未知の exit code (${exit_code}): exit 1 と同じ扱いで、inventory_writer_control を手動確認するまで次の操作へ進まない。"
		;;
	esac
}

# cleanup_task は EXIT trap（exit code を保存したまま best-effort で task を止める）。
# EXIT trap は main の関数スコープが残っている保証がないため、参照する変数はすべて
# global に置く（cutover_cluster / cutover_region / task_arn / task_stopped）。
#
# stop-task 要求だけでは足りない: ECS は SIGTERM 後に既定 30 秒の停止猶予を持つため、
# 要求直後の task はまだ動いており、その間に切替 transaction の COMMIT が確定し得る。
# そのため best-effort stop の**後に** tasks-stopped を待つ。ただし runner は既に
# 終了処理中なので無期限には待たず、CUTOVER_STOP_WAIT_SECONDS（既定 60 秒 = 猶予 30 秒 +
# 余裕）で bounded にし、待ちきれなかったことは警告として明示する
# （runbook 側は「taskArn を特定して aws ecs wait tasks-stopped を確認するまで
# 全操作停止」を停止条件に持つ）。
cutover_cluster=""
cutover_region=""
task_arn=""
task_stopped=false
cutover_client_token=""
cutover_started_by=""

# cutover_generate_client_token は RunTask の idempotency token を生成する。
# ECS RunTask の clientToken は「64 ASCII 文字以内・文字コード 33-126」で、同一 cluster 内で
# 一意である必要がある（ECS API Reference: RunTask / Ensuring idempotency。TTL 24 時間）。
# 同じ token・同じ引数での再試行は元の結果を返すため、**RunTask 応答喪失時の回収に使う**。
# CUTOVER_CLIENT_TOKEN で外から固定できる（spec / 手動再取得用）。
cutover_generate_client_token() {
	if [[ -n ${CUTOVER_CLIENT_TOKEN:-} ]]; then
		printf '%s' "${CUTOVER_CLIENT_TOKEN}"
		return 0
	fi
	local uuid=""
	if command -v uuidgen >/dev/null 2>&1; then
		uuid=$(uuidgen)
	elif [[ -r /proc/sys/kernel/random/uuid ]]; then
		uuid=$(cat /proc/sys/kernel/random/uuid)
	elif command -v openssl >/dev/null 2>&1; then
		uuid=$(openssl rand -hex 16)
	else
		uuid="$(date -u +%Y%m%d%H%M%S)-$$-${RANDOM}${RANDOM}"
	fi
	printf 'cutover-%s' "${uuid,,}"
}

# cutover_startedby_for は session 固有の startedBy を組み立てる。
# 従来の `cutover-<operation>` 固定値では、同じ operation を複数回実行した run を
# ListTasks で区別できず、cancel 後の回収で「どの run の task か」を特定できない
# （Codex High-4）。ECS の startedBy は 128 文字以内・英数字 / - / _ / / のみ。
cutover_startedby_for() {
	local operation=$1
	local token=$2
	local suffix="${token//[^A-Za-z0-9_-]/}"
	printf 'cutover-%s-%s' "$operation" "${suffix:0:64}"
}

# cutover_wait_task_stopped_bounded は stop-task 要求後に tasks-stopped を bounded に待つ。
# `aws ecs wait tasks-stopped` は既定で最大 10 分ポーリングするため、そのまま呼ぶと
# runner の終了処理を長時間ブロックし得る。timeout(1) で上限を切る。
cutover_wait_task_stopped_bounded() {
	local wait_seconds="${CUTOVER_STOP_WAIT_SECONDS:-60}"

	if [[ ! $wait_seconds =~ ^[0-9]+$ ]] || ((wait_seconds == 0)); then
		echo "warning: skipped tasks-stopped wait for ${task_arn} (CUTOVER_STOP_WAIT_SECONDS=${wait_seconds})" >&2
		return 0
	fi
	if ! command -v timeout >/dev/null 2>&1; then
		echo "warning: timeout(1) is unavailable; skipped bounded tasks-stopped wait for ${task_arn}" >&2
		return 0
	fi

	if timeout "$wait_seconds" aws ecs wait tasks-stopped --region "$cutover_region" \
		--cluster "$cutover_cluster" --tasks "$task_arn" >/dev/null 2>&1; then
		task_stopped=true
		echo "ECS task reached STOPPED after best-effort stop: ${task_arn}" >&2
	else
		echo "warning: ECS task ${task_arn} did not reach STOPPED within ${wait_seconds}s; it may still be committing. Confirm with 'aws ecs wait tasks-stopped' before any further cutover operation (runbook stop condition)." >&2
	fi
}

# cutover_run_task は RunTask を「応答喪失に耐える形」で実行し、global の task_arn を設定する
# （Codex High-4）。
#
# 問題: AWS が task を受理した **後に** 応答が失われると、従来の実装は task_arn が空のまま
# exit 1 し、EXIT trap は停止も待機もできない。呼び出し側（runbook / workflow）から見ると
# 「起動していない」ように見えるため、切替 CLI が走っている最中に次の操作へ進み得る。
#
# 対策（ECS API Reference: Ensuring idempotency で確認済み）:
# 1. RunTask に clientToken を明示する。
# 2. 応答が取れなかったら、**同じ clientToken・同じ引数で再試行する**。ECS は成功済みの
#    リクエストの再試行に対して元の結果を返す（引数が違えば ConflictException になるため、
#    引数は 1 文字も変えない）。
# 3. それでも取れなければ、session 固有の startedBy で ListTasks から回収する。
#    **ListTasks では startedBy を使うときそれが唯一の filter でなければならない**
#    （ECS API Reference: ListTasks "When you specify startedBy as the filter, it must be
#    the only filter that you use."）。desiredStatus 等での絞り込みは describe-tasks 側で行う。
cutover_run_task() {
	local region=$1
	local cluster=$2
	local task_def=$3
	local subnets=$4
	local security_groups=$5
	local overrides=$6
	local attempt max_attempts="${CUTOVER_RUN_TASK_ATTEMPTS:-3}"

	for ((attempt = 1; attempt <= max_attempts; attempt++)); do
		# 引数は毎回完全に同一にする（clientToken による idempotency の前提）。
		task_arn=$(aws ecs run-task --region "$region" \
			--cluster "$cluster" \
			--task-definition "$task_def" \
			--launch-type FARGATE \
			--client-token "$cutover_client_token" \
			--started-by "$cutover_started_by" \
			--network-configuration "awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${security_groups}],assignPublicIp=DISABLED}" \
			--overrides "$overrides" \
			--query 'tasks[0].taskArn' --output text 2>/dev/null) || task_arn=""

		if [[ -n $task_arn && $task_arn != "None" ]]; then
			if ((attempt > 1)); then
				echo "recovered ECS task ARN by retrying RunTask with the same clientToken (attempt ${attempt}): ${task_arn}" >&2
			fi
			return 0
		fi

		echo "warning: RunTask returned no task ARN (attempt ${attempt}/${max_attempts}); retrying with the same clientToken ${cutover_client_token}" >&2
		sleep 3
	done

	# 最後の回収経路: startedBy 単独の ListTasks（他の filter と併用しない）。
	local recovered_arns
	recovered_arns=$(aws ecs list-tasks --region "$region" \
		--cluster "$cluster" \
		--started-by "$cutover_started_by" \
		--query 'taskArns' --output text 2>/dev/null) || recovered_arns=""

	# session 固有 startedBy なので、回収できるのは 1 件でなければならない。
	# 複数件は「この session の task を一意に特定できない」状態なので回収しない（fail closed）。
	if [[ -n $recovered_arns && $recovered_arns != "None" ]] && (($(wc -w <<<"$recovered_arns") == 1)); then
		task_arn=$(tr -d '[:space:]' <<<"$recovered_arns")
		echo "recovered ECS task ARN via ListTasks --started-by ${cutover_started_by}: ${task_arn}" >&2
		return 0
	fi

	task_arn=""
	return 1
}

cleanup_task() {
	local exit_status=$?
	local operation_finished_at_utc
	trap - EXIT INT TERM

	if [[ -n $task_arn && $task_stopped != "true" ]]; then
		echo "cutover operation interrupted before ECS task stopped; requesting best-effort stop: ${task_arn}" >&2
		aws ecs stop-task --region "$cutover_region" \
			--cluster "$cutover_cluster" \
			--task "$task_arn" \
			--reason "GitHub Actions cutover runner exited before task completion" \
			--query 'task.taskArn' --output text >/dev/null 2>&1 ||
			echo "warning: failed to stop ECS task ${task_arn}; check it manually" >&2
		cutover_wait_task_stopped_bounded
	fi

	operation_finished_at_utc=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	echo "operationFinishedAtUtc=${operation_finished_at_utc} runnerExitCode=${exit_status}"
	exit "$exit_status"
}

main() {
	if (($# != 4)); then
		echo "$CUTOVER_USAGE" >&2
		exit 2
	fi

	cutover_cluster=$1
	cutover_region="${AWS_REGION:-ap-northeast-1}"
	local cluster=$1
	local service=$2
	local task_def=$3
	local operation=$4
	local region="$cutover_region"
	local operation_kind

	if ! operation_kind=$(cutover_operation_kind "$operation") ||
		! set_cutover_operation_command "$operation"; then
		echo "unsupported operation: ${operation}" >&2
		echo "$CUTOVER_USAGE" >&2
		exit 2
	fi

	task_arn=""
	task_stopped=false
	local operation_started_at_utc
	operation_started_at_utc=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

	trap cleanup_task EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM

	echo "operationStartedAtUtc=${operation_started_at_utc} operation=${operation} operationKind=${operation_kind} region=${region} cluster=${cluster} service=${service}"

	local service_json
	service_json=$(aws ecs describe-services --region "$region" \
		--cluster "$cluster" --services "$service" --query 'services[0]' --output json)

	if [[ -z $task_def || $task_def == "current" ]]; then
		task_def=$(jq -r '.taskDefinition' <<<"$service_json")
	fi

	local subnets security_groups
	subnets=$(jq -r '.networkConfiguration.awsvpcConfiguration.subnets | join(",")' <<<"$service_json")
	security_groups=$(jq -r '.networkConfiguration.awsvpcConfiguration.securityGroups | join(",")' <<<"$service_json")

	local td_json container image image_digest log_group log_prefix command_json overrides
	td_json=$(aws ecs describe-task-definition --region "$region" \
		--task-definition "$task_def" --query 'taskDefinition' --output json)
	container=$(jq -r '.containerDefinitions[0].name' <<<"$td_json")
	image=$(jq -r '.containerDefinitions[0].image' <<<"$td_json")
	log_group=$(jq -r '.containerDefinitions[0].logConfiguration.options["awslogs-group"]' <<<"$td_json")
	log_prefix=$(jq -r '.containerDefinitions[0].logConfiguration.options["awslogs-stream-prefix"]' <<<"$td_json")
	# command override は operation から機械変換した argv をそのまま JSON 配列にする
	# （jq の --args は `--expect-mode` を自身の option として解釈するため使わない）。
	command_json=$(printf '%s\n' "${cutover_operation_command[@]}" | jq -R . | jq -sc .)
	overrides=$(jq -cn \
		--arg container "$container" \
		--argjson command "$command_json" \
		'{containerOverrides:[{name:$container,command:$command}]}')

	echo "taskDefinition=${task_def}"
	echo "image=${image}"
	echo "container=${container}"
	echo "command=${cutover_operation_command[*]}"

	# --- RunTask（応答喪失に耐える経路。Codex High-4） ---------------------------------
	# RunTask を投げる **前に** clientToken と session 固有 startedBy を確定し、先に出力する。
	# こうしておくと、応答が失われて task ARN が取れなかった run でも、run log から
	# token / startedBy を復元して同じ token で再取得（または ListTasks で回収）できる。
	cutover_client_token=$(cutover_generate_client_token)
	cutover_started_by=$(cutover_startedby_for "$operation" "$cutover_client_token")
	echo "clientToken=${cutover_client_token} startedBy=${cutover_started_by}"

	# 回収失敗（非 0）でも set -e で即死させない。下の fail-closed 分岐で
	# 「次の操作を止めろ」という運用指示を必ず出す。
	cutover_run_task "$region" "$cluster" "$task_def" "$subnets" "$security_groups" "$overrides" ||
		true

	if [[ -z $task_arn || $task_arn == "None" ]]; then
		task_arn=""
		echo "failed to obtain the ECS task ARN for operation ${operation} after retrying RunTask with the same clientToken and recovering via ListTasks." >&2
		echo "AWS may have accepted the task even though the response was lost. Do NOT run any further cutover operation (including reading inventory_writer_control) until the task is identified and confirmed STOPPED." >&2
		echo "recover with: aws ecs list-tasks --region ${region} --cluster ${cluster} --started-by ${cutover_started_by}" >&2
		echo "(startedBy must be the only ListTasks filter; narrow the result with describe-tasks)" >&2
		exit 1
	fi

	echo "taskArn=${task_arn} startedBy=${cutover_started_by}"
	if ! aws ecs wait tasks-stopped --region "$region" --cluster "$cluster" --tasks "$task_arn"; then
		echo "ECS waiter failed before task stopped: ${task_arn}" >&2
		exit 1
	fi
	task_stopped=true

	local task_json exit_code stopped_reason
	task_json=$(aws ecs describe-tasks --region "$region" \
		--cluster "$cluster" --tasks "$task_arn" --query 'tasks[0]' --output json)
	# 配列 index ではなく container 名一致で app container の exitCode を取得する（Issue #363）。
	exit_code=$(ecs_task_container_exit_code "$task_json" "$container")
	stopped_reason=$(jq -r '.stoppedReason // "-"' <<<"$task_json")
	image_digest=$(jq -r --arg container "$container" \
		'([.containers[]? | select(.name == $container) | (.imageDigest // "-")][0]) // "-"' \
		<<<"$task_json")

	# ECS task のログを取得する（awslogs stream: <prefix>/<container>/<task-id>）。
	# evidence が揃うまで待つ（CloudWatch Logs への配送遅延を吸収する）。
	# switch operation の exit 2（preflight violation で切替せず停止）では結果行が
	# 出ないため、この loop は上限まで再試行してから抜ける（失敗経路のみの待ち時間）。
	local task_id="${task_arn##*/}"
	local task_log="" task_log_messages_json="[]" fetched_task_log_messages_json=""
	local log_available=false evidence_valid=false log_attempt
	for log_attempt in {1..10}; do
		if fetched_task_log_messages_json=$(aws logs get-log-events --region "$region" \
			--log-group-name "$log_group" \
			--log-stream-name "${log_prefix}/${container}/${task_id}" \
			--start-from-head \
			--query 'events[].message' --output json 2>/dev/null) &&
			jq -e 'type == "array" and length > 0' \
				<<<"$fetched_task_log_messages_json" >/dev/null 2>&1; then
			task_log_messages_json=$fetched_task_log_messages_json
			task_log=$(jq -r '.[]' <<<"$task_log_messages_json")
			log_available=true
			if cutover_evidence_valid "$task_log_messages_json" "$operation" "$exit_code"; then
				evidence_valid=true
				break
			fi
		fi
		if ((log_attempt < 10)); then
			sleep 3
		fi
	done

	echo "--- cutover task log (${log_group}) ---"
	if [[ $log_available == "true" ]]; then
		echo "$task_log"
	else
		echo "(log stream not available after ${log_attempt} attempts)"
	fi
	echo "--- end of log ---"

	echo "exitCode=${exit_code} stoppedReason=${stopped_reason}"

	write_cutover_step_summary \
		"$operation" "$exit_code" "$task_arn" "$task_def" "$image" "$image_digest" \
		"$operation_started_at_utc" "$task_log_messages_json"

	# evidence file（artifact の元）の書き込み失敗は green にしない。
	# 失敗したら evidence_valid を false へ倒したうえで実行エラーにする
	# （evidence_valid を倒さないと、gate 側が「exit 0 + evidence あり」で green になる）。
	local evidence_file_written=true
	if ! write_cutover_evidence_file \
		"$operation" "$exit_code" "$task_arn" "$task_def" "$image" "$image_digest" \
		"$operation_started_at_utc" "$task_log_messages_json"; then
		evidence_file_written=false
		evidence_valid=false
	fi

	# raw exit code と evidence 有効性を別々の output として報告する。
	# ここで必ず書くことで、後続の fail-closed（exit 1）経路でも gate が判断材料を持てる。
	write_cutover_step_output "$exit_code" "$evidence_valid"

	if [[ $evidence_file_written != "true" ]]; then
		echo "refusing to report success: cutover evidence file could not be written" >&2
		exit 1
	fi

	# container 名一致で exitCode を取得できない（"none"）場合は結果不明。fail closed。
	if [[ ! $exit_code =~ ^[0-9]+$ ]]; then
		echo "could not determine container exit code (got '${exit_code}'); treating as execution error" >&2
		exit 1
	fi

	# false-green 禁止: 期待どおりの証跡がない成功を成功として報告しない。
	if [[ $exit_code == "0" && $evidence_valid != "true" ]]; then
		echo "cutover evidence JSON is unavailable or does not match operation ${operation}; refusing to report success" >&2
		exit 1
	fi
	if [[ $evidence_valid != "true" ]]; then
		# 非 0 の失敗理由を exit code から上書きしない（判断材料を潰さない）。
		echo "warning: cutover evidence JSON is unavailable or does not match operation ${operation} (exit code ${exit_code})" >&2
	fi

	exit "$exit_code"
}

# write_cutover_step_output は raw exit code と evidence 有効性を GITHUB_OUTPUT へ書く
# （未設定のローカル実行では何もしない）。workflow の postflight 起動条件は raw exit code、
# 最終 gate は raw exit code + evidence_valid + postflight outcome の 3 条件を使う。
write_cutover_step_output() {
	local exit_code=$1
	local evidence_valid=$2
	local output_file="${GITHUB_OUTPUT:-}"

	if [[ -z $output_file ]]; then
		return 0
	fi

	{
		echo "container_exit_code=${exit_code}"
		echo "evidence_valid=${evidence_valid}"
	} >>"$output_file"
}

# cutover_execution_context は実行経路を返す（"github-actions" / "local"）。
# GitHub Actions の run context（GITHUB_RUN_ID）が無いローカル実行では、
# `//actions/runs/` のような壊れた runUrl を作らない（Codex Medium-2）。
cutover_execution_context() {
	if [[ -n ${GITHUB_RUN_ID:-} && -n ${GITHUB_REPOSITORY:-} && -n ${GITHUB_SERVER_URL:-} ]]; then
		echo "github-actions"
	else
		echo "local"
	fi
}

# cutover_run_url は GitHub Actions run の URL を返す（ローカル実行では空文字）。
cutover_run_url() {
	if [[ $(cutover_execution_context) == "github-actions" ]]; then
		echo "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
	else
		echo ""
	fi
}

# cutover_operator は実行者の識別子を返す（ローカル実行 lineage 用。CUTOVER_OPERATOR で上書き可）。
cutover_operator() {
	local operator="${CUTOVER_OPERATOR:-}"
	if [[ -z $operator ]]; then
		operator=$(id -un 2>/dev/null || echo "unknown")
	fi
	echo "$operator"
}

# cutover_operator_host は実行ホスト名を返す（ローカル実行 lineage 用）。
cutover_operator_host() {
	local host="${CUTOVER_OPERATOR_HOST:-}"
	if [[ -z $host ]]; then
		host=$(hostname 2>/dev/null || echo "unknown")
	fi
	echo "$host"
}

# write_cutover_step_summary は evidence JSON と lineage を GITHUB_STEP_SUMMARY へ転記する
# （ADR-0033 決定 5 / #335 の証跡要件。run log にも残るが、summary は destroy 前の
# 恒久化作業で参照する）。GITHUB_STEP_SUMMARY 未設定のローカル実行では何もしない。
write_cutover_step_summary() {
	local operation=$1
	local exit_code=$2
	local task_arn=$3
	local task_def=$4
	local image=$5
	local image_digest=$6
	local started_at_utc=$7
	local task_log_messages_json=$8
	local summary_file="${GITHUB_STEP_SUMMARY:-}"

	if [[ -z $summary_file ]]; then
		return 0
	fi

	local execution_context run_url
	execution_context=$(cutover_execution_context)
	run_url=$(cutover_run_url)

	{
		echo "### cutover ${operation} (exit ${exit_code})"
		echo
		echo "- operationStartedAtUtc: \`${started_at_utc}\`"
		echo "- taskArn: \`${task_arn}\`"
		echo "- taskDefinition: \`${task_def}\`"
		echo "- image: \`${image}\`"
		echo "- imageDigest: \`${image_digest}\`"
		echo "- clientToken: \`${cutover_client_token:--}\`"
		echo "- startedBy: \`${cutover_started_by:--}\`"
		echo "- executionContext: \`${execution_context}\`"
		# 壊れた runUrl を出さない（Codex Medium-2）。ローカル実行では実行者・ホストを載せる。
		if [[ -n $run_url ]]; then
			echo "- runUrl: \`${run_url}\`"
		else
			echo "- operator: \`$(cutover_operator)\`"
			echo "- operatorHost: \`$(cutover_operator_host)\`"
		fi
		echo
		echo "evidence:"
		echo
		echo '```json'
		jq -r "
			[${CUTOVER_EVIDENCE_SELECT_FILTER}]
			| if length == 0 then \"(no evidence JSON found in task log)\" else .[] | tojson end
		" <<<"$task_log_messages_json" 2>/dev/null ||
			echo "(failed to parse task log for evidence)"
		echo '```'
		echo
	} >>"$summary_file"
}

# write_cutover_evidence_file は evidence JSON と lineage を JSON Lines で追記する
# （CUTOVER_EVIDENCE_FILE 未設定なら何もしない = 従来どおり）。workflow はこのファイルを
# actions/upload-artifact で保存し、destroy 前の恒久化作業で使う。
#
# **CUTOVER_EVIDENCE_FILE が設定されているのに書けなかった場合は非 0 を返す**。
# 呼び出し側はこれを実行エラーへ倒す。警告だけにすると、artifact が空のまま
# （upload の if-no-files-found: error と合わせても、追記失敗で 0 行のファイルが
# 残る経路など）run が green になり得る。
write_cutover_evidence_file() {
	local operation=$1
	local exit_code=$2
	local task_arn=$3
	local task_def=$4
	local image=$5
	local image_digest=$6
	local started_at_utc=$7
	local task_log_messages_json=$8
	local evidence_file="${CUTOVER_EVIDENCE_FILE:-}"

	if [[ -z $evidence_file ]]; then
		return 0
	fi

	local execution_context run_url
	execution_context=$(cutover_execution_context)
	run_url=$(cutover_run_url)

	# lineage schema（provenance）:
	# - 共通: operation / exitCode / taskArn / taskDefinition / image / imageDigest /
	#   operationStartedAtUtc / clientToken / startedBy / executionContext
	# - executionContext == "github-actions": runUrl（run へのリンク）
	# - executionContext == "local": operator / operatorHost（runUrl は出さない）
	# ローカル実行では GitHub Actions の artifact / step summary が作られないため、
	# 壊れた `//actions/runs/` を書く代わりに実行者・ホストで provenance を成立させる
	# （Codex Medium-2。JSONL の保存先は runbook が定める）。
	if ! jq -c \
		--arg operation "$operation" \
		--arg exitCode "$exit_code" \
		--arg taskArn "$task_arn" \
		--arg taskDefinition "$task_def" \
		--arg image "$image" \
		--arg imageDigest "$image_digest" \
		--arg startedAtUtc "$started_at_utc" \
		--arg clientToken "$cutover_client_token" \
		--arg startedBy "$cutover_started_by" \
		--arg executionContext "$execution_context" \
		--arg runUrl "$run_url" \
		--arg operator "$(cutover_operator)" \
		--arg operatorHost "$(cutover_operator_host)" "
			{
				lineage: (
					{
						operation: \$operation,
						exitCode: \$exitCode,
						taskArn: \$taskArn,
						taskDefinition: \$taskDefinition,
						image: \$image,
						imageDigest: \$imageDigest,
						operationStartedAtUtc: \$startedAtUtc,
						clientToken: \$clientToken,
						startedBy: \$startedBy,
						executionContext: \$executionContext
					}
					+ (
						if \$executionContext == \"github-actions\" then
							{runUrl: \$runUrl}
						else
							{operator: \$operator, operatorHost: \$operatorHost}
						end
					)
				),
				evidence: [${CUTOVER_EVIDENCE_SELECT_FILTER}]
			}
		" <<<"$task_log_messages_json" >>"$evidence_file"; then
		echo "failed to write cutover evidence file ${evidence_file}" >&2
		return 1
	fi
	return 0
}

if [[ ${BASH_SOURCE[0]} == "${0}" ]]; then
	set -euo pipefail
	main "$@"
fi
