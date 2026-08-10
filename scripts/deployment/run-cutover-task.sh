#!/usr/bin/env bash
# ECS run-task で Gate B cutover operation（preflight / activation / rollback / postflight）を
# 実行する（Issue #378 / ADR-0032 / ADR-0033）。
# API サービスのタスク定義（または指定タスク定義）を command override で流用し、
# private subnet 内から Aurora / Valkey / OpenSearch へ接続する。
#
# Usage:
#   run-cutover-task.sh <cluster> <api-service> <task-definition-arn|current> <operation>
#   operation:
#   - preflight-activation:  cutover:check --expect-mode legacy      --phase preflight
#   - activate:              cutover:switch --target-mode ticket_type
#   - postflight-activation: cutover:check --expect-mode ticket_type --phase postflight
#   - preflight-rollback:    cutover:check --expect-mode ticket_type --phase preflight
#   - rollback:              cutover:switch --target-mode legacy
#   - postflight-rollback:   cutover:check --expect-mode legacy      --phase postflight
#   引数はすべて必須（既定値を持たせない）。方向は operation 名に固定し、
#   --target-mode / --expect-mode の手打ち誤指定を構造的に排除する（ADR-0032 の緩和策）。
#
# run-db-migration.sh を流用しない理由（実読確認済み）:
# 1. mode が migration / ticket-type-readiness の 2 択固定である。
# 2. container exit code の非 0 を一律 `exit 1` へ潰す（run-db-migration.sh の判定）。
#    cutover CLI の exit code は 0 / 2 / 3 / 4 / 1 が別々の運用判断に対応するため
#    （switch-ticket-type-writer-mode.ts のファイル冒頭規約）、潰してはいけない。
#
# 本 script は container の exit code をそのまま自身の exit code にする。ただし
# **exit 0 でも evidence JSON を取得できなければ exit 1 で失敗させる**（false-green 禁止）。
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

CUTOVER_USAGE="usage: run-cutover-task.sh <cluster> <api-service> <task-definition-arn|current> <operation>
operation: preflight-activation | activate | postflight-activation | preflight-rollback | rollback | postflight-rollback"

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
	*)
		cutover_operation_command=()
		return 1
		;;
	esac
}

# cutover_operation_kind は operation の種別（switch = 状態を書き換える / check = 読み取り専用）を返す。
cutover_operation_kind() {
	case "$1" in
	activate | rollback)
		echo "switch"
		;;
	preflight-activation | postflight-activation | preflight-rollback | postflight-rollback)
		echo "check"
		;;
	*)
		return 1
		;;
	esac
}

# cutover_readiness_evidence_present は checker evidence（1 行 JSON）の構造検証。
# category 名・件数は checker 側の正本から出力されるため、ここでは固定しない
# （ticket-type-readiness-evidence.sh と同じ方針）。violation 件数は exit code が表すため
# ここでは検査しない（evidence の「取得できたこと」だけを判定する）。
cutover_readiness_evidence_present() {
	local task_log_messages_json=$1

	jq -e '
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
				and (.expectedWriterMode | type) == "string"
				and (.checkPhase | type) == "string"
				and (.results | type) == "array"
				and (.results | length) > 0
		)
	' <<<"$task_log_messages_json" >/dev/null 2>&1
}

# cutover_switch_result_present は switch CLI の結果行（1 行 JSON）の存在検証。
# 成功時（switched: true）も COMMIT 応答喪失時（commitOutcome: ambiguous）も
# action と switched を必ず持つ（switch-ticket-type-writer-mode.ts の出力）。
cutover_switch_result_present() {
	local task_log_messages_json=$1

	jq -e '
		[
			.[]
			| select(type == "string")
			| fromjson?
			| select(type == "object")
		]
		| any(
			.[];
			.action == "ticket-type-writer-mode-switch"
				and (.switched | type) == "boolean"
		)
	' <<<"$task_log_messages_json" >/dev/null 2>&1
}

# cutover_evidence_available は operation ごとに必要な evidence が揃っているかを判定する。
# switch operation は「preflight evidence」と「切替結果」の両方を必要とする。
cutover_evidence_available() {
	local task_log_messages_json=$1
	local operation=$2
	local kind

	kind=$(cutover_operation_kind "$operation") || return 1
	cutover_readiness_evidence_present "$task_log_messages_json" || return 1
	if [[ $kind == "switch" ]]; then
		cutover_switch_result_present "$task_log_messages_json" || return 1
	fi
	return 0
}

# cutover_gate_ok は workflow 最終 gate step の判定式（false-green 防止の中核）。
# 戻り値 0 = job を成功させてよい、1 = job を失敗させる。
#
# - switch operation（activate / rollback）: exit code が 0 / 3 のいずれかであり、かつ
#   同一 run 内の postflight step が success で完了していること。
#   exit code が空文字（switch step 自体が異常終了して output を書けなかった）や
#   postflight の skipped / failure / cancelled はすべて失敗にする。
# - check operation: exit code 0 のみ成功。
# - 未知の operation: 失敗（fail closed）。
cutover_gate_ok() {
	local operation=$1
	local exit_code=$2
	local postflight_outcome=$3
	local kind

	kind=$(cutover_operation_kind "$operation") || return 1

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
cutover_cluster=""
cutover_region=""
task_arn=""
task_stopped=false
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
	local log_available=false evidence_available=false log_attempt
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
			if cutover_evidence_available "$task_log_messages_json" "$operation"; then
				evidence_available=true
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
	write_cutover_evidence_file \
		"$operation" "$exit_code" "$task_arn" "$task_def" "$image" "$image_digest" \
		"$operation_started_at_utc" "$task_log_messages_json"

	# container 名一致で exitCode を取得できない（"none"）場合は結果不明。fail closed。
	if [[ ! $exit_code =~ ^[0-9]+$ ]]; then
		echo "could not determine container exit code (got '${exit_code}'); treating as execution error" >&2
		exit 1
	fi

	# false-green 禁止: 証跡なしの成功を成功として報告しない。
	if [[ $exit_code == "0" && $evidence_available != "true" ]]; then
		echo "cutover evidence JSON is unavailable for operation ${operation}; refusing to report success" >&2
		exit 1
	fi
	if [[ $evidence_available != "true" ]]; then
		# 非 0 の失敗理由を exit code から上書きしない（判断材料を潰さない）。
		echo "warning: cutover evidence JSON is unavailable for operation ${operation} (exit code ${exit_code})" >&2
	fi

	exit "$exit_code"
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
# （CUTOVER_EVIDENCE_FILE 未設定なら何もしない）。workflow はこのファイルを
# actions/upload-artifact で保存し、destroy 前の恒久化作業で使う。
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

	jq -c \
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
		' <<<"$task_log_messages_json" >>"$evidence_file" ||
		echo "warning: failed to write cutover evidence file ${evidence_file}" >&2
}

if [[ ${BASH_SOURCE[0]} == "${0}" ]]; then
	set -euo pipefail
	main "$@"
fi
