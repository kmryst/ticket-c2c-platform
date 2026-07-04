#!/usr/bin/env bash
# ECS run-task で DB migration（TypeORM versioned migrations）を実行する（Issue #92）。
# API サービスのタスク定義（または指定タスク定義）を command override で流用し、
# private subnet 内から Aurora へ migration を適用する。終了コードとログを検証する。
#
# Usage: run-db-migration.sh <cluster> <api-service> [task-definition-arn]
#   task-definition-arn 省略時は API サービスの現行タスク定義を使う。
#   deploy-app workflow は「新イメージのタスク定義を register した直後・サービス更新前」に
#   新タスク定義 ARN を渡して呼ぶ（migration 成功後にデプロイする運用）。

set -euo pipefail

cluster="${1:?usage: run-db-migration.sh <cluster> <api-service> [task-definition-arn]}"
service="${2:?usage: run-db-migration.sh <cluster> <api-service> [task-definition-arn]}"
task_def="${3:-}"
region="${AWS_REGION:-ap-northeast-1}"

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
log_group=$(jq -r '.containerDefinitions[0].logConfiguration.options["awslogs-group"]' <<<"$td_json")
log_prefix=$(jq -r '.containerDefinitions[0].logConfiguration.options["awslogs-stream-prefix"]' <<<"$td_json")

echo "running migration task: cluster=${cluster} taskDefinition=${task_def##*/} container=${container}"

task_arn=$(aws ecs run-task --region "$region" \
	--cluster "$cluster" \
	--task-definition "$task_def" \
	--launch-type FARGATE \
	--started-by db-migrate \
	--network-configuration "awsvpcConfiguration={subnets=[${subnets}],securityGroups=[${security_groups}],assignPublicIp=DISABLED}" \
	--overrides "{\"containerOverrides\":[{\"name\":\"${container}\",\"command\":[\"node\",\"dist/src/database/run-migrations.js\"]}]}" \
	--query 'tasks[0].taskArn' --output text)

echo "migration task started: ${task_arn}"
aws ecs wait tasks-stopped --region "$region" --cluster "$cluster" --tasks "$task_arn"

task_json=$(aws ecs describe-tasks --region "$region" \
	--cluster "$cluster" --tasks "$task_arn" --query 'tasks[0]' --output json)
exit_code=$(jq -r '.containers[0].exitCode // "none"' <<<"$task_json")
stopped_reason=$(jq -r '.stoppedReason // "-"' <<<"$task_json")

# migration タスクのログを表示する（awslogs stream: <prefix>/<container>/<task-id>）
task_id="${task_arn##*/}"
echo "--- migration task log (${log_group}) ---"
aws logs get-log-events --region "$region" \
	--log-group-name "$log_group" \
	--log-stream-name "${log_prefix}/${container}/${task_id}" \
	--start-from-head \
	--query 'events[].message' --output text 2>/dev/null || echo "(log stream not available)"
echo "--- end of log ---"

echo "exitCode=${exit_code} stoppedReason=${stopped_reason}"
if [[ $exit_code != "0" ]]; then
	echo "migration task failed" >&2
	exit 1
fi

echo "migration completed successfully"
