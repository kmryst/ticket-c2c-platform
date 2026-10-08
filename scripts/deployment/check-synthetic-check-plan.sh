#!/usr/bin/env bash
# terraform plan の JSON（terraform show -json <planfile>）を読み、外形監視（CloudWatch Synthetics canary）の
# module.synthetic_check 配下のリソースを削除する計画なら失敗する（Issue #546 / ADR-0043）。
#
# 外形監視は enable_synthetic_check（既定 false）で作成を切り替える。作成済みの環境で入力を false のまま
# apply すると canary が削除されるため、terraform-apply-<env>.yml が apply の前にこの検査を実行する。
# 入力の値に関係なく、delete を含む計画（replace の ["delete","create"] / ["create","delete"] も含む）は止める。
# replace でも canary は一度消え、S3 バケット（force_destroy = true）のアーティファクトも失われる。
# また、moved の書き忘れなど state のアドレスが変わる変更は、モジュール配下の全リソースの delete として現れる。
# moved で移ったリソースは previous_address 付きの no-op / update になり、delete を含まないので止めない。
#
# 外形監視を意図して外す・作り直す手段は terraform-destroy-<env>.yml で環境ごと消して作り直すことだけとする。
#
# 使い方: check-synthetic-check-plan.sh <plan.json>
# 終了コード: 0 = 削除なし / 1 = 削除あり、または plan JSON を読めない

set -euo pipefail

synthetic_check_plan_deletions() {
	local plan_json_file=$1

	jq -r '
		[.resource_changes[]?
			| select(.address | test("^module\\.synthetic_check([.\\[]|$)"))
			| select(.change.actions | index("delete"))
			| "\(.address) \(.change.actions | join(","))"]
		| .[]
	' "$plan_json_file"
}

main() {
	if [[ $# -ne 1 ]]; then
		echo "usage: $0 <plan.json>" >&2
		return 1
	fi

	local plan_json_file=$1
	if [[ ! -f $plan_json_file ]]; then
		echo "plan JSON が見つからない: ${plan_json_file}" >&2
		return 1
	fi

	if ! jq -e 'has("resource_changes") or has("format_version")' "$plan_json_file" >/dev/null; then
		echo "plan JSON として読めない: ${plan_json_file}" >&2
		return 1
	fi

	local deletions
	deletions=$(synthetic_check_plan_deletions "$plan_json_file")

	if [[ -n $deletions ]]; then
		{
			echo "外形監視（module.synthetic_check）のリソースを削除する計画のため、apply を中止する（Issue #546 / ADR-0043）。"
			echo "削除・再作成されるリソース（address actions）:"
			while IFS= read -r deletion; do
				echo "  ${deletion}"
			done <<<"$deletions"
			echo "作成済みの環境では入力 enable_synthetic_check=true で apply する。"
			echo "外形監視を外す場合は terraform-destroy-<env>.yml で環境ごと削除する。"
		} >&2
		return 1
	fi

	echo "外形監視（module.synthetic_check）を削除する計画は無い"
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
	main "$@"
fi
