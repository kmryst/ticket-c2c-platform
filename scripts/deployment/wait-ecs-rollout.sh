#!/usr/bin/env bash
# ECS サービスの rollout 完了を確認する（Issue #538 / ADR-0039）。
# deploy-service.yml の成功判定として、`aws ecs wait services-stable` の代わりに使う。
#
# Usage:
#   wait-ecs-rollout.sh <cluster> <service-task-definition-map-file>
#   map file は 1 行 1 サービスで「<service> <task-definition-arn>」（deploy-service.yml の td-map.txt）。
#   task-definition-arn は今回の deploy で register し、update-service に渡した ARN。
#
# 環境変数（テスト用。既定値は deploy 用）:
#   ECS_ROLLOUT_POLL_INTERVAL_SECONDS   poll 間隔（既定 15）
#   ECS_ROLLOUT_MAX_POLLS               poll 回数の上限（既定 80 = 約 20 分）
#   ECS_ROLLOUT_REQUIRED_STABLE_POLLS   成功条件が連続で成り立つ必要がある poll 回数（既定 3）
#   ECS_ROLLOUT_MAX_UNOBSERVED_POLLS    今回の ARN の deployment を一度も観測できないまま許容する
#                                       poll 回数（既定 8 = 約 2 分。Issue #540）
#
# exit code:
#   0   = すべてのサービスで rollout が完了した
#   1   = rollout が失敗した（circuit breaker の FAILED、rollback、サービス不在など）
#   2   = 引数の誤り
#   124 = 上限まで待っても完了しなかった（タイムアウト）
#
# services-stable を使わない理由:
# services-stable は「deployments が 1 件」かつ「runningCount == desiredCount」をその時点の
# 1 回の観測だけで判定し、rolloutState も circuit breaker の結果も見ない。起動直後に異常終了する
# task（events index が無い worker など）は一瞬 RUNNING になり、その瞬間を観測すると success になる。
# staging（run 37575172137）では 05:17 台に success となり、worker の deployment が FAILED に
# なったのはその後の 05:19:43Z だった。
#
# 成功条件（サービスごと。すべてのサービスで成り立つ状態が ECS_ROLLOUT_REQUIRED_STABLE_POLLS 回
# 連続したら成功）:
# - サービスが ACTIVE
# - deployments が 1 件だけで、その PRIMARY deployment の taskDefinition が今回の ARN
# - PRIMARY deployment の rolloutState が COMPLETED
# - PRIMARY deployment の failedTasks が 0
# - サービスと PRIMARY deployment の runningCount が desiredCount と一致
#
# 即時失敗（その時点で exit 1）:
# - 今回の ARN の deployment の rolloutState が FAILED（circuit breaker が失敗と判定した）
# - 今回の ARN の deployment があるのに PRIMARY が別の taskDefinition（circuit breaker の rollback 中、
#   または別の deploy による上書き）
# - 今回の ARN の deployment を一度観測した後に、その deployment が消えた（rollback の完了など）
# - サービスが存在しない、または ACTIVE でない
#
# 今回の ARN の deployment をまだ一度も観測していない場合（Issue #540）:
# ECS の API は結果整合なので、update-service 直後の describe-services が更新前の deployment だけを
# 返すことがある。1 回の応答では「古い読み取り」と「rollback の完了」を区別できないため、この状態は
# 即失敗にせず待つ。ECS_ROLLOUT_MAX_UNOBSERVED_POLLS 回を超えても観測できなければ exit 1 にする。
#
# 純関数（ecs_rollout_evaluate_service）は spec から source して検証できるよう、
# main の実行は「直接実行されたときだけ」に限定する。

# ecs_rollout_evaluate_service は describe-services の services[] 1 件と期待する task definition ARN
# から、状態を 1 語で返す: completed / in_progress / failed / rolled_back / not_observed / missing。
# not_observed は今回の ARN の deployment が deployments に無いこと（古い読み取りか rollback 完了か
# はこの関数では判断しない。呼び出し側が「以前に観測したか」で判断する）。
# 2 行目以降に判定に使った値を出力する（ログ用）。
ecs_rollout_evaluate_service() {
	local service_json=$1
	local expected_task_definition=$2

	jq -r --arg td "$expected_task_definition" '
		if . == null or (.status // "") != "ACTIVE" then
			"missing\nstatus=\(.status // "MISSING")"
		else
			(.deployments // []) as $deployments
			| ([$deployments[] | select(.status == "PRIMARY")][0]) as $primary
			| ([$deployments[] | select(.taskDefinition == $td)][0]) as $target
			| (
				if $target == null then "not_observed"
				elif $target.rolloutState == "FAILED" then "failed"
				elif $primary == null then "in_progress"
				elif $primary.taskDefinition != $td then "rolled_back"
				elif $primary.rolloutState == "FAILED" then "failed"
				elif ($deployments | length) == 1
					and $primary.rolloutState == "COMPLETED"
					and ($primary.failedTasks // 0) == 0
					and $primary.runningCount == $primary.desiredCount
					and .runningCount == .desiredCount
					then "completed"
				else "in_progress"
				end
			) as $state
			| "\($state)\ndeployments=\($deployments | length) primaryTaskDefinition=\($primary.taskDefinition // "-" | split("/") | last) rolloutState=\($primary.rolloutState // "-") rolloutStateReason=\($primary.rolloutStateReason // "-") failedTasks=\($primary.failedTasks // 0) running=\(.runningCount) desired=\(.desiredCount) pending=\(.pendingCount)"
		end
	' <<<"$service_json"
}

ecs_rollout_print_events() {
	local service_json=$1
	jq -r '"recent service events:", ((.events // [])[:5][] | "  \(.createdAt) \(.message)")' \
		<<<"$service_json" >&2 || true
}

ecs_rollout_main() {
	local usage="usage: wait-ecs-rollout.sh <cluster> <service-task-definition-map-file>"
	if (($# != 2)); then
		echo "$usage" >&2
		return 2
	fi
	local cluster=$1
	local map_file=$2
	if [[ ! -s $map_file ]]; then
		echo "map file is missing or empty: ${map_file}" >&2
		echo "$usage" >&2
		return 2
	fi

	local interval="${ECS_ROLLOUT_POLL_INTERVAL_SECONDS:-15}"
	local max_polls="${ECS_ROLLOUT_MAX_POLLS:-80}"
	local required_stable="${ECS_ROLLOUT_REQUIRED_STABLE_POLLS:-3}"
	local max_unobserved="${ECS_ROLLOUT_MAX_UNOBSERVED_POLLS:-8}"
	local region="${AWS_REGION:-ap-northeast-1}"

	local -a services=()
	local -A expected=()
	local -A observed=()
	local -A unobserved_polls=()
	local svc td
	while read -r svc td; do
		[[ -z ${svc:-} ]] && continue
		if [[ -z ${td:-} ]]; then
			echo "task definition ARN is missing for service ${svc} in ${map_file}" >&2
			return 2
		fi
		services+=("$svc")
		expected[$svc]=$td
		observed[$svc]=false
		unobserved_polls[$svc]=0
	done <"$map_file"
	if ((${#services[@]} == 0)); then
		echo "no service in ${map_file}" >&2
		return 2
	fi

	echo "waiting for ECS rollout: cluster=${cluster} services=${services[*]} interval=${interval}s maxPolls=${max_polls} requiredStablePolls=${required_stable} maxUnobservedPolls=${max_unobserved}"

	local poll stable=0 described service_json result state detail all_completed
	for ((poll = 1; poll <= max_polls; poll++)); do
		all_completed=true
		# describe-services 自体の失敗（throttling など）は判定せずに次の poll へ進む。
		if ! described=$(aws ecs describe-services --region "$region" \
			--cluster "$cluster" --services "${services[@]}" --output json); then
			echo "poll ${poll}: describe-services failed; retrying" >&2
			stable=0
			if ((poll < max_polls)); then
				sleep "$interval"
			fi
			continue
		fi
		for svc in "${services[@]}"; do
			service_json=$(jq -c --arg name "$svc" \
				'[.services[]? | select(.serviceName == $name)][0]' <<<"$described")
			result=$(ecs_rollout_evaluate_service "$service_json" "${expected[$svc]}")
			state=$(head -n 1 <<<"$result")
			detail=$(tail -n +2 <<<"$result")
			echo "poll ${poll}: ${svc} state=${state} ${detail}"
			if [[ $state != "not_observed" && $state != "missing" ]]; then
				observed[$svc]=true
			fi
			case "$state" in
			completed) ;;
			in_progress) all_completed=false ;;
			failed)
				echo "::error::ECS rollout failed for ${svc} (deployment circuit breaker marked it FAILED)" >&2
				ecs_rollout_print_events "$service_json"
				return 1
				;;
			not_observed)
				if [[ ${observed[$svc]} == "true" ]]; then
					echo "::error::ECS deployment for ${svc} on ${expected[$svc]##*/} disappeared after it was observed (rolled back or replaced)" >&2
					ecs_rollout_print_events "$service_json"
					return 1
				fi
				unobserved_polls[$svc]=$((${unobserved_polls[$svc]} + 1))
				if ((${unobserved_polls[$svc]} > max_unobserved)); then
					echo "::error::ECS deployment for ${svc} on ${expected[$svc]##*/} was not observed in ${max_unobserved} polls (update-service not applied, or already rolled back)" >&2
					ecs_rollout_print_events "$service_json"
					return 1
				fi
				echo "poll ${poll}: ${svc} deployment on ${expected[$svc]##*/} not observed yet (${unobserved_polls[$svc]}/${max_unobserved}); the response may be stale"
				all_completed=false
				;;
			rolled_back)
				echo "::error::ECS rollout for ${svc} is no longer on ${expected[$svc]##*/} (rolled back or replaced)" >&2
				ecs_rollout_print_events "$service_json"
				return 1
				;;
			*)
				echo "::error::ECS service ${svc} is missing or not ACTIVE" >&2
				return 1
				;;
			esac
		done

		if [[ $all_completed == "true" ]]; then
			stable=$((stable + 1))
			if ((stable >= required_stable)); then
				echo "ECS rollout completed for all services (${services[*]}) after ${poll} polls"
				return 0
			fi
		else
			stable=0
		fi
		if ((poll < max_polls)); then
			sleep "$interval"
		fi
	done

	echo "::error::ECS rollout did not complete within ${max_polls} polls (${interval}s interval)" >&2
	return 124
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
	set -euo pipefail
	ecs_rollout_main "$@"
fi
