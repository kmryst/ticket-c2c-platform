#!/usr/bin/env bash
# ECS run-task で DB migration または allowlist 済み DB check を実行する
# （Issue #92 / #335 / #336）。
# API サービスのタスク定義（または指定タスク定義）を command override で流用し、
# private subnet 内から Aurora へ接続する。終了コードとログを検証する。
#
# Usage:
#   run-db-migration.sh <cluster> <api-service> [task-definition-arn] [mode]
#   task-definition-arn 省略時は API サービスの現行タスク定義を使う。
#   mode:
#   - migration（既定）: TypeORM versioned migrations を適用する。
#   - ticket-type-readiness: Ticket Type expand readiness を読み取り専用で検査する。
#   deploy-backend workflow は「新イメージのタスク定義を register した直後・サービス更新前」に
#   新タスク定義 ARN を渡して呼ぶ（migration 成功後にデプロイする運用）。

set -euo pipefail

usage="usage: run-db-migration.sh <cluster> <api-service> [task-definition-arn] [migration|ticket-type-readiness]"
if (( $# > 4 )); then
	echo "$usage" >&2
	exit 2
fi
cluster="${1:?$usage}"
service="${2:?$usage}"
task_def="${3:-}"
mode="${4:-migration}"
region="${AWS_REGION:-ap-northeast-1}"
task_arn=""
task_stopped=false
operation_started_at_utc=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

case "$mode" in
migration)
	command_path="dist/src/database/run-migrations.js"
	started_by="db-migrate"
	operation_label="DB migration"
	;;
ticket-type-readiness)
	command_path="dist/src/database/check-ticket-type-expand-readiness.js"
	started_by="ticket-type-readiness"
	operation_label="Ticket Type expand readiness"
	;;
*)
	echo "unsupported mode: $mode" >&2
	echo "$usage" >&2
	exit 2
	;;
esac

cleanup_task() {
	local exit_status=$?
	local operation_finished_at_utc
	trap - EXIT INT TERM

	if [[ -n $task_arn && $task_stopped != "true" ]]; then
		echo "operation interrupted before ECS task stopped; requesting best-effort stop: ${task_arn}" >&2
		aws ecs stop-task --region "$region" \
			--cluster "$cluster" \
			--task "$task_arn" \
			--reason "GitHub Actions ${mode} runner exited before task completion" \
			--query 'task.taskArn' --output text >/dev/null 2>&1 ||
			echo "warning: failed to stop ECS task ${task_arn}; check it manually" >&2
	fi

	operation_finished_at_utc=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
	echo "operationFinishedAtUtc=${operation_finished_at_utc} runnerExitCode=${exit_status}"
	exit "$exit_status"
}

trap cleanup_task EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "operationStartedAtUtc=${operation_started_at_utc} mode=${mode} region=${region} cluster=${cluster} service=${service}"

service_json=$(aws ecs describe-services --region "$region" \
	--cluster "$cluster" --services "$service" --query 'services[0]' --output json)

if [[ -z $task_def || $task_def == "current" ]]; then
	task_def=$(jq -r '.taskDefinition' <<<"$service_json")
fi

subnets=$(jq -r '.networkConfiguration.awsvpcConfiguration.subnets | join(",")' <<<"$service_json")
security_groups=$(jq -r '.networkConfiguration.awsvpcConfiguration.securityGroups | join(",")' <<<"$service_json")

td_json=$(aws ecs describe-task-definition --region "$region" \
	--task-definition "$task_def" --query 'taskDefinition' --output json)
container=$(jq -r '.containerDefinitions[0].name' <<<"$td_json")
image=$(jq -r '.containerDefinitions[0].image' <<<"$td_json")
log_group=$(jq -r '.containerDefinitions[0].logConfiguration.options["awslogs-group"]' <<<"$td_json")
log_prefix=$(jq -r '.containerDefinitions[0].logConfiguration.options["awslogs-stream-prefix"]' <<<"$td_json")
overrides=$(jq -cn \
	--arg container "$container" \
	--arg command_path "$command_path" \
	'{containerOverrides:[{name:$container,command:["node",$command_path]}]}')

echo "operation=${operation_label}"
echo "taskDefinition=${task_def}"
echo "image=${image}"
echo "container=${container}"
echo "command=node ${command_path}"

task_arn=$(aws ecs run-task --region "$region" \
	--cluster "$cluster" \
	--task-definition "$task_def" \
	--launch-type FARGATE \
	--started-by "$started_by" \
	--network-configuration "awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${security_groups}],assignPublicIp=DISABLED}" \
	--overrides "$overrides" \
	--query 'tasks[0].taskArn' --output text)

if [[ -z $task_arn || $task_arn == "None" ]]; then
	echo "failed to start ECS task for mode ${mode}" >&2
	task_arn=""
	exit 1
fi

echo "taskArn=${task_arn} startedBy=${started_by}"
if ! aws ecs wait tasks-stopped --region "$region" --cluster "$cluster" --tasks "$task_arn"; then
	echo "ECS waiter failed before task stopped: ${task_arn}" >&2
	exit 1
fi
task_stopped=true

task_json=$(aws ecs describe-tasks --region "$region" \
	--cluster "$cluster" --tasks "$task_arn" --query 'tasks[0]' --output json)
exit_code=$(jq -r '.containers[0].exitCode // "none"' <<<"$task_json")
stopped_reason=$(jq -r '.stoppedReason // "-"' <<<"$task_json")

# ECS task のログを表示する（awslogs stream: <prefix>/<container>/<task-id>）
task_id="${task_arn##*/}"
task_log=""
log_available=false
readiness_evidence_available=false
for log_attempt in {1..10}; do
	if task_log=$(aws logs get-log-events --region "$region" \
		--log-group-name "$log_group" \
		--log-stream-name "${log_prefix}/${container}/${task_id}" \
		--start-from-head \
		--query 'events[].message' --output text 2>/dev/null) &&
		[[ -n $task_log && $task_log != "None" ]]; then
		log_available=true
		if [[ $mode != "ticket-type-readiness" ||
			($task_log == *'"complete": true'* &&
				$task_log == *'"categoryCount": 16'* &&
				$task_log == *'"event_without_exactly_one_default"'* &&
				$task_log == *'"ticket_type_inventory_event_mismatch"'*) ]]; then
			break
		fi
	fi
	if ((log_attempt < 10)); then
		sleep 3
	fi
done

echo "--- ${mode} task log (${log_group}) ---"
if [[ $log_available == "true" ]]; then
	echo "$task_log"
else
	echo "(log stream not available after ${log_attempt} attempts)"
fi
echo "--- end of log ---"

if [[ $log_available == "true" &&
	$task_log == *'"complete": true'* &&
	$task_log == *'"categoryCount": 16'* &&
	$task_log == *'"event_without_exactly_one_default"'* &&
	$task_log == *'"ticket_type_inventory_event_mismatch"'* ]]; then
	readiness_evidence_available=true
fi

echo "exitCode=${exit_code} stoppedReason=${stopped_reason}"
if [[ $exit_code != "0" ]]; then
	echo "${operation_label} task failed" >&2
	exit 1
fi
if [[ $mode == "ticket-type-readiness" && $readiness_evidence_available != "true" ]]; then
	echo "Ticket Type expand readiness JSON evidence is unavailable" >&2
	exit 1
fi

echo "${operation_label} completed successfully"
