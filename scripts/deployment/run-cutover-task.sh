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
#   引数はすべて必須（既定値を持たせない）。方向・対象は operation 名に固定し、
#   --target-mode / --expect-mode / --namespace の手打ち誤指定を構造的に排除する
#   （ADR-0032 の緩和策）。
#
# counter operation（seed / reconcile）を cutover workflow の choice に載せない理由:
# 「書き込み primitive の起動面を増やさない」は Issue #378 の確定済み設計判断である。
# seed は activation / rollback session 中に 1 回だけ、checker とセットで人が確認しながら
# 実行する手順であり、6 択に混ぜると（CLI が refuse するとはいえ）active namespace への
# 誤発火面が増える。一方で container 名一致の exit code 取得・evidence 検証・
# JSONL lineage・step summary は check / switch と共通化する価値があるため、
# **この script の operation allowlist にだけ** counter operation を追加してある。
# 起動経路は docs/runbooks/gate-b-ticket-type-cutover.md の該当 step（手動実行）だけである。
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

# checker evidence の category 数（ticket-type-cutover-readiness.ts の
# TICKET_TYPE_CUTOVER_READINESS_CATEGORIES と 1 対 1。件数が変わったら evidence 契約の
# 変更なので、ここも spec も同時に更新する）。
CUTOVER_EVIDENCE_CATEGORY_COUNT=23

CUTOVER_USAGE="usage: run-cutover-task.sh <cluster> <api-service> <task-definition-arn|current> <operation>
operation (workflow): preflight-activation | activate | postflight-activation | preflight-rollback | rollback | postflight-rollback
operation (runbook manual only): seed-ticket-type | seed-legacy | reconcile-ticket-type | reconcile-legacy"

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
	*)
		return 1
		;;
	esac
}

# cutover_workflow_operation は cutover workflow の choice から起動してよい operation かを返す
# （counter operation は runbook 手順からの手動実行専用）。
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

# cutover_counter_expectation は counter operation の namespace / mode を返す（"<namespace> <mode>"）。
cutover_counter_expectation() {
	case "$1" in
	seed-ticket-type) echo "ticket-type seed" ;;
	seed-legacy) echo "legacy seed" ;;
	reconcile-ticket-type) echo "ticket-type reconcile" ;;
	reconcile-legacy) echo "legacy reconcile" ;;
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
# - require_zero_violations = true（exit 0 = 全 category 0）のときは全 violationCount が 0
# - require_zero_violations = false かつ exit 2 のときは violation が 1 件以上
#   （checker / switch の exit 2 は hasTicketTypeCutoverViolations と 1 対 1）
cutover_readiness_evidence_valid() {
	local task_log_messages_json=$1
	local expected_mode=$2
	local expected_phase=$3
	local violation_expectation=$4 # zero | some | any

	jq -e \
		--arg expectedMode "$expected_mode" \
		--arg expectedPhase "$expected_phase" \
		--arg violations "$violation_expectation" \
		--argjson categoryCount "$CUTOVER_EVIDENCE_CATEGORY_COUNT" '
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
cutover_switch_result_valid() {
	local task_log_messages_json=$1
	local source_mode=$2
	local target_mode=$3
	local exit_code=$4

	jq -e \
		--arg sourceMode "$source_mode" \
		--arg targetMode "$target_mode" \
		--arg exitCode "$exit_code" '
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
							and (.postSwitchDatabaseResults | type) == "array"
					elif $exitCode == "3" then
						.commitOutcome == "ambiguous"
							and .verifiedMode == $targetMode
							and .switched == true
							and .sourceMode == $sourceMode
							and .targetMode == $targetMode
							and (.postSwitchDatabaseResults | type) == "array"
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
# - exit 0 かつ seed: refused なし / initialized == processed / synced == 0 / skipped == 0
# - exit 0 かつ reconcile: refused なし / initialized == 0 / processed == synced + skipped
# - exit 2: refused == true（guard 違反。Valkey への書き込みなし）
cutover_counter_result_valid() {
	local task_log_messages_json=$1
	local namespace=$2
	local counter_mode=$3
	local exit_code=$4

	jq -e \
		--arg namespace "$namespace" \
		--arg counterMode "$counter_mode" \
		--arg exitCode "$exit_code" '
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
						.refused == true and (.reason | type) == "string"
					else
						false
					end
				)
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
		local namespace counter_mode
		read -r namespace counter_mode <<<"$expectation"
		cutover_counter_result_valid \
			"$task_log_messages_json" "$namespace" "$counter_mode" "$exit_code"
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
# - counter operation: workflow からは起動しないが、判定は check と同じ規律にする。
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

	task_arn=$(aws ecs run-task --region "$region" \
		--cluster "$cluster" \
		--task-definition "$task_def" \
		--launch-type FARGATE \
		--started-by "cutover-${operation}" \
		--network-configuration "awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${security_groups}],assignPublicIp=DISABLED}" \
		--overrides "$overrides" \
		--query 'tasks[0].taskArn' --output text)

	if [[ -z $task_arn || $task_arn == "None" ]]; then
		echo "failed to start ECS task for operation ${operation}" >&2
		task_arn=""
		exit 1
	fi

	echo "taskArn=${task_arn} startedBy=cutover-${operation}"
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

	{
		echo "### cutover ${operation} (exit ${exit_code})"
		echo
		echo "- operationStartedAtUtc: \`${started_at_utc}\`"
		echo "- taskArn: \`${task_arn}\`"
		echo "- taskDefinition: \`${task_def}\`"
		echo "- image: \`${image}\`"
		echo "- imageDigest: \`${image_digest}\`"
		echo "- runUrl: \`${GITHUB_SERVER_URL:--}/${GITHUB_REPOSITORY:--}/actions/runs/${GITHUB_RUN_ID:--}\`"
		echo
		echo "evidence:"
		echo
		echo '```json'
		jq -r '
			[
				.[]
				| select(type == "string")
				| fromjson?
				| select(type == "object")
				| select(.evidenceType == "ticket-type-cutover-readiness" or .action != null)
			]
			| if length == 0 then "(no evidence JSON found in task log)" else .[] | tojson end
		' <<<"$task_log_messages_json" 2>/dev/null ||
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

	if ! jq -c \
		--arg operation "$operation" \
		--arg exitCode "$exit_code" \
		--arg taskArn "$task_arn" \
		--arg taskDefinition "$task_def" \
		--arg image "$image" \
		--arg imageDigest "$image_digest" \
		--arg startedAtUtc "$started_at_utc" \
		--arg runUrl "${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_ID:-}" '
			{
				lineage: {
					operation: $operation,
					exitCode: $exitCode,
					taskArn: $taskArn,
					taskDefinition: $taskDefinition,
					image: $image,
					imageDigest: $imageDigest,
					operationStartedAtUtc: $startedAtUtc,
					runUrl: $runUrl
				},
				evidence: [
					.[]
					| select(type == "string")
					| fromjson?
					| select(type == "object")
					| select(.evidenceType == "ticket-type-cutover-readiness" or .action != null)
				]
			}
		' <<<"$task_log_messages_json" >>"$evidence_file"; then
		echo "failed to write cutover evidence file ${evidence_file}" >&2
		return 1
	fi
	return 0
}

if [[ ${BASH_SOURCE[0]} == "${0}" ]]; then
	set -euo pipefail
	main "$@"
fi
