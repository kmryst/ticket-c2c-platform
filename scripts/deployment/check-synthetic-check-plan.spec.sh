#!/usr/bin/env bash
# check-synthetic-check-plan.sh の fixture テスト（Issue #546 / ADR-0043）。
# fixture は terraform show -json <planfile> の resource_changes の形に合わせる
# （Terraform 1.14.8 の terraform_data で、moved あり / なし・replace の計画を出して形を確認した）。
# AWS へは接続しない。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
check_script="${script_dir}/check-synthetic-check-plan.sh"
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT

passed=0

# plan JSON の fixture を書き、検査の終了コードが期待どおりかを確かめる。
expect_exit() {
	local label=$1
	local expected=$2
	local plan_json=$3
	local plan_file="${work_dir}/plan.json"
	printf '%s\n' "$plan_json" >"$plan_file"

	local actual=0
	bash "$check_script" "$plan_file" >"${work_dir}/stdout" 2>"${work_dir}/stderr" || actual=$?
	if [[ $actual != "$expected" ]]; then
		echo "expected exit ${expected} but got ${actual}: ${label}" >&2
		cat "${work_dir}/stdout" "${work_dir}/stderr" >&2
		exit 1
	fi
	passed=$((passed + 1))
}

change() {
	# address, actions（JSON 配列）, previous_address（省略可）
	local address=$1
	local actions=$2
	local previous_address=${3:-}
	jq -cn --arg address "$address" --argjson actions "$actions" --arg previous "$previous_address" '
		{address: $address, change: {actions: $actions}}
		+ (if $previous == "" then {} else {previous_address: $previous} end)
	'
}

plan() {
	jq -cn --argjson changes "[$(
		IFS=,
		echo "$*"
	)]" '{format_version: "1.2", resource_changes: $changes}'
}

canary="module.synthetic_check[0].aws_synthetics_canary.this"
bucket="module.synthetic_check[0].aws_s3_bucket.artifacts"
alarm="module.synthetic_check[0].aws_cloudwatch_metric_alarm.synthetic_check_failure"
other="module.api_service.aws_ecs_service.this"

# 1. 作成済みの環境を false で apply する計画（canary・アラームの delete）→ 失敗する。
expect_exit "delete under module.synthetic_check[0]" 1 "$(plan \
	"$(change "$canary" '["delete"]')" \
	"$(change "$alarm" '["delete"]')")"

# 2. canary の replace（delete → create）→ 入力が true でも失敗する。
expect_exit "replace delete-before-create" 1 "$(plan \
	"$(change "$canary" '["delete","create"]')")"

# 3. create_before_destroy の replace（create → delete）→ 失敗する。
expect_exit "replace create-before-destroy" 1 "$(plan \
	"$(change "$bucket" '["create","delete"]')")"

# 4. moved の書き忘れ（count を付けたのに moved が無い）: 旧アドレスの delete と [0] の create → 失敗する。
expect_exit "address change without moved" 1 "$(plan \
	"$(change "module.synthetic_check.aws_synthetics_canary.this" '["delete"]')" \
	"$(change "$canary" '["create"]')")"

# 5. moved で移ったリソース（previous_address 付きの no-op / update）→ 成功する。
expect_exit "moved resources are no-op or update" 0 "$(plan \
	"$(change "$canary" '["no-op"]' "module.synthetic_check.aws_synthetics_canary.this")" \
	"$(change "$bucket" '["update"]' "module.synthetic_check.aws_s3_bucket.artifacts")")"

# 6. 2 回目の apply で外形監視を作る（create のみ）→ 成功する。
expect_exit "create only" 0 "$(plan \
	"$(change "$canary" '["create"]')" \
	"$(change "$alarm" '["create"]')")"

# 7. 外形監視以外のリソースの delete（task definition の replace など）→ 止めない。
expect_exit "delete outside module.synthetic_check" 0 "$(plan \
	"$(change "$other" '["delete","create"]')")"

# 8. 名前が module.synthetic_check で始まる別のモジュール（境界の確認）→ 止めない。
expect_exit "similar module name is not matched" 0 "$(plan \
	"$(change "module.synthetic_check_v2.aws_synthetics_canary.this" '["delete"]')")"

# 9. 空の state からの最初の apply（既定値 false。resource_changes が無い）→ 成功する。
expect_exit "no resource_changes" 0 '{"format_version":"1.2"}'

# 10. plan JSON として読めない入力 → 失敗する（fail closed）。
expect_exit "invalid json" 1 'not json'
expect_exit "json without plan keys" 1 '{"foo":1}'

# 11. 引数が無い → 失敗する。
actual=0
bash "$check_script" >/dev/null 2>&1 || actual=$?
if [[ $actual != 1 ]]; then
	echo "expected exit 1 without arguments but got ${actual}" >&2
	exit 1
fi
passed=$((passed + 1))

echo "check-synthetic-check-plan fixtures passed (${passed} cases)"
