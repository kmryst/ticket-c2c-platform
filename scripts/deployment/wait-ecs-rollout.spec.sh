#!/usr/bin/env bash
# wait-ecs-rollout.sh のテスト（Issue #538）。
# `aws ecs describe-services` を PATH 上のスタブに置き換え、poll ごとに用意した出力を順に返す。
# AWS へは接続しない。各ケースで exit code と出力を確認する。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
script="${script_dir}/wait-ecs-rollout.sh"

work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

stub_dir="${work_dir}/bin"
mkdir -p "$stub_dir"

# aws スタブ: STUB_RESPONSES_DIR/<n>.json を poll 順に返す（足りなければ最後のものを返し続ける）。
# <n>.fail があればその回は exit 255 で失敗する（describe-services 自体の失敗）。
cat >"${stub_dir}/aws" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1 $2" != "ecs describe-services" ]]; then
	echo "unexpected aws call: $*" >&2
	exit 99
fi
count_file="${STUB_RESPONSES_DIR}/count"
n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$count_file"
echo "$*" >>"${STUB_RESPONSES_DIR}/calls.log"
if [[ -f "${STUB_RESPONSES_DIR}/${n}.fail" ]]; then
	echo "An error occurred (ThrottlingException)" >&2
	exit 255
fi
last=$(find "$STUB_RESPONSES_DIR" -name '[0-9]*.json' | sed 's#.*/##; s#\.json##' | sort -n | tail -1)
if (( n > last )); then
	n=$last
fi
cat "${STUB_RESPONSES_DIR}/${n}.json"
STUB
chmod +x "${stub_dir}/aws"

cat >"${stub_dir}/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "${stub_dir}/sleep"

API_TD_NEW="arn:aws:ecs:ap-northeast-1:111122223333:task-definition/ticket-c2c-staging-api:12"
WORKER_TD_NEW="arn:aws:ecs:ap-northeast-1:111122223333:task-definition/ticket-c2c-staging-worker:9"
WORKER_TD_OLD="arn:aws:ecs:ap-northeast-1:111122223333:task-definition/ticket-c2c-staging-worker:8"

printf '%s %s\n%s %s\n' \
	ticket-c2c-staging-api "$API_TD_NEW" \
	ticket-c2c-staging-worker "$WORKER_TD_NEW" >"${work_dir}/td-map.txt"

# service <name> <running> <desired> <deployments JSON array>
service() {
	jq -cn --arg name "$1" --argjson running "$2" --argjson desired "$3" --argjson deployments "$4" '{
		serviceName: $name, status: "ACTIVE",
		runningCount: $running, desiredCount: $desired, pendingCount: ($desired - $running),
		deployments: $deployments,
		events: [{createdAt: "2026-10-07T05:19:43Z", message: "(service \($name)) stub event"}]
	}'
}

# deployment <status> <taskDefinition> <rolloutState> <running> <desired> [failedTasks]
deployment() {
	jq -cn --arg status "$1" --arg td "$2" --arg rollout "$3" \
		--argjson running "$4" --argjson desired "$5" --argjson failed "${6:-0}" '{
		status: $status, taskDefinition: $td, rolloutState: $rollout,
		rolloutStateReason: "stub reason", runningCount: $running, desiredCount: $desired,
		failedTasks: $failed
	}'
}

api_completed=$(service ticket-c2c-staging-api 1 1 \
	"[$(deployment PRIMARY "$API_TD_NEW" COMPLETED 1 1)]")
worker_completed=$(service ticket-c2c-staging-worker 1 1 \
	"[$(deployment PRIMARY "$WORKER_TD_NEW" COMPLETED 1 1)]")

# 今回の事象（services-stable が success になった瞬間）の再現:
# worker task が一瞬 RUNNING で running == desired、deployments も 1 件だが、rollout は IN_PROGRESS。
worker_flapping=$(service ticket-c2c-staging-worker 1 1 \
	"[$(deployment PRIMARY "$WORKER_TD_NEW" IN_PROGRESS 1 1 2)]")
worker_failed=$(service ticket-c2c-staging-worker 0 1 \
	"[$(deployment PRIMARY "$WORKER_TD_NEW" FAILED 0 1 3)]")
# circuit breaker の rollback: PRIMARY が旧 task definition、今回の deployment は ACTIVE 側に残る。
worker_rolled_back=$(service ticket-c2c-staging-worker 0 1 \
	"[$(deployment PRIMARY "$WORKER_TD_OLD" IN_PROGRESS 0 1),$(deployment ACTIVE "$WORKER_TD_NEW" IN_PROGRESS 0 1 3)]")
# rollback 完了後: 今回の deployment は消え、旧 task definition の deployment だけが COMPLETED。
worker_rollback_completed=$(service ticket-c2c-staging-worker 1 1 \
	"[$(deployment PRIMARY "$WORKER_TD_OLD" COMPLETED 1 1)]")
worker_running_short=$(service ticket-c2c-staging-worker 0 1 \
	"[$(deployment PRIMARY "$WORKER_TD_NEW" COMPLETED 0 1)]")
worker_in_progress=$(service ticket-c2c-staging-worker 0 1 \
	"[$(deployment PRIMARY "$WORKER_TD_NEW" IN_PROGRESS 0 1),$(deployment ACTIVE "$WORKER_TD_OLD" COMPLETED 0 0)]")

response() {
	jq -cn --argjson a "$1" --argjson b "$2" '{services: [$a, $b], failures: []}'
}

# run_case <label> <expected exit> <response JSON>...（poll 順）
run_case() {
	local label=$1
	local expected=$2
	shift 2
	local responses_dir="${work_dir}/responses-${label}"
	mkdir -p "$responses_dir"
	local i=0
	local r
	for r in "$@"; do
		i=$((i + 1))
		if [[ $r == "FAIL" ]]; then
			touch "${responses_dir}/${i}.fail"
			echo '{}' >"${responses_dir}/${i}.json"
		else
			echo "$r" >"${responses_dir}/${i}.json"
		fi
	done

	local actual=0
	env PATH="${stub_dir}:${PATH}" \
		STUB_RESPONSES_DIR="$responses_dir" \
		ECS_ROLLOUT_POLL_INTERVAL_SECONDS=0 \
		ECS_ROLLOUT_MAX_POLLS="${MAX_POLLS:-6}" \
		ECS_ROLLOUT_REQUIRED_STABLE_POLLS="${STABLE_POLLS:-3}" \
		ECS_ROLLOUT_MAX_UNOBSERVED_POLLS="${UNOBSERVED_POLLS:-3}" \
		bash "$script" ticket-c2c-staging "${work_dir}/td-map.txt" \
		>"${work_dir}/${label}.stdout" 2>"${work_dir}/${label}.stderr" || actual=$?
	if [[ $actual != "$expected" ]]; then
		echo "FAIL ${label}: expected exit ${expected} but got ${actual}" >&2
		cat "${work_dir}/${label}.stdout" "${work_dir}/${label}.stderr" >&2
		exit 1
	fi
	polls=$(cat "${responses_dir}/count")
	echo "ok   ${label}: exit ${actual} (polls=${polls})"
}

expect_polls() {
	local label=$1
	local expected=$2
	if [[ $polls != "$expected" ]]; then
		echo "FAIL ${label}: expected ${expected} polls but got ${polls}" >&2
		exit 1
	fi
}

expect_output() {
	local label=$1
	local pattern=$2
	if ! grep -q -- "$pattern" "${work_dir}/${label}.stdout" "${work_dir}/${label}.stderr"; then
		echo "FAIL ${label}: output does not contain '${pattern}'" >&2
		exit 1
	fi
}

# 1. COMPLETED: 両サービスとも COMPLETED が 3 poll 連続 → 0。
run_case completed 0 "$(response "$api_completed" "$worker_completed")"
expect_polls completed 3
expect_output completed "ECS rollout completed for all services"

# 2. circuit breaker FAILED: worker の deployment が FAILED → 即 1（api は COMPLETED でも）。
run_case circuit-breaker-failed 1 \
	"$(response "$api_completed" "$worker_flapping")" \
	"$(response "$api_completed" "$worker_failed")"
expect_polls circuit-breaker-failed 2
expect_output circuit-breaker-failed "circuit breaker marked it FAILED"
expect_output circuit-breaker-failed "stub event"

# 3. running < desired: rolloutState が COMPLETED でも running が足りなければ成功にしない → 124。
run_case running-below-desired 124 "$(response "$api_completed" "$worker_running_short")"
expect_polls running-below-desired 6
expect_output running-below-desired "did not complete within 6 polls"

# 4. rollout IN_PROGRESS のままタイムアウト → 124。
run_case in-progress-timeout 124 "$(response "$api_completed" "$worker_in_progress")"
expect_polls in-progress-timeout 6

# 5. 今回の事象: services-stable の success 条件（deployments 1 件・running == desired）を満たすが
#    rollout は IN_PROGRESS。その後 FAILED → 1。success を返さないこと。
run_case services-stable-false-success 1 \
	"$(response "$api_completed" "$worker_flapping")" \
	"$(response "$api_completed" "$worker_flapping")" \
	"$(response "$api_completed" "$worker_flapping")" \
	"$(response "$api_completed" "$worker_failed")"
expect_polls services-stable-false-success 4

# 6. circuit breaker の rollback: PRIMARY が旧 task definition → 即 1。
run_case rolled-back 1 "$(response "$api_completed" "$worker_rolled_back")"
expect_output rolled-back "rolled back or replaced"

# 7. rollback 完了後（今回の deployment を観測した後に消え、旧 task definition が COMPLETED）も
#    成功にしない → 即 1。
run_case rollback-completed 1 \
	"$(response "$api_completed" "$worker_in_progress")" \
	"$(response "$api_completed" "$worker_rollback_completed")"
expect_polls rollback-completed 2
expect_output rollback-completed "disappeared after it was observed"

# 7-a. update-service 直後の古い読み取り（Issue #540）: 最初の poll は更新前の PRIMARY（旧 task
#      definition）だけが返り、その後に今回の deployment が見えて COMPLETED → 0。
run_case stale-first-poll 0 \
	"$(response "$api_completed" "$worker_rollback_completed")" \
	"$(response "$api_completed" "$worker_rollback_completed")" \
	"$(response "$api_completed" "$worker_in_progress")" \
	"$(response "$api_completed" "$worker_completed")"
expect_polls stale-first-poll 6
expect_output stale-first-poll "not observed yet (1/3); the response may be stale"

# 7-b. 今回の deployment を上限（3 poll）まで一度も観測できない → 4 poll 目で 1。
MAX_POLLS=12 run_case never-observed 1 "$(response "$api_completed" "$worker_rollback_completed")"
expect_polls never-observed 4
expect_output never-observed "was not observed in 3 polls"

# 8. 成功条件が途中で崩れたら連続回数を数え直す: COMPLETED 2 回 → IN_PROGRESS → COMPLETED 3 回 → 0（6 poll）。
run_case stable-window-reset 0 \
	"$(response "$api_completed" "$worker_completed")" \
	"$(response "$api_completed" "$worker_completed")" \
	"$(response "$api_completed" "$worker_in_progress")" \
	"$(response "$api_completed" "$worker_completed")" \
	"$(response "$api_completed" "$worker_completed")" \
	"$(response "$api_completed" "$worker_completed")"
expect_polls stable-window-reset 6

# 9. describe-services 自体の失敗は判定せずに retry し、その後 COMPLETED → 0。
run_case describe-error-retry 0 \
	FAIL \
	"$(response "$api_completed" "$worker_completed")"
expect_polls describe-error-retry 4

# 10. サービス不在（describe-services の failures のみ）→ 即 1。
run_case service-missing 1 \
	"$(jq -cn --argjson a "$api_completed" '{services: [$a], failures: [{arn: "x", reason: "MISSING"}]}')"
expect_output service-missing "missing or not ACTIVE"

# 11. 引数の誤り → 2。
actual=0
bash "$script" ticket-c2c-staging >/dev/null 2>&1 || actual=$?
[[ $actual == 2 ]] || { echo "FAIL usage: expected exit 2 but got ${actual}" >&2; exit 1; }
actual=0
bash "$script" ticket-c2c-staging "${work_dir}/no-such-file" >/dev/null 2>&1 || actual=$?
[[ $actual == 2 ]] || { echo "FAIL missing map: expected exit 2 but got ${actual}" >&2; exit 1; }
echo "ok   usage errors: exit 2"

# describe-services に map の全サービスを 1 回で渡していること。
grep -q -- "--services ticket-c2c-staging-api ticket-c2c-staging-worker" \
	"${work_dir}/responses-completed/calls.log" ||
	{ echo "FAIL describe-services was not called with all services" >&2; exit 1; }

echo "wait-ecs-rollout fixtures passed"
