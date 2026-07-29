#!/usr/bin/env bash
# Ticket Type readiness証跡の動的検証を、AWSへ接続せずfixtureで確認する。

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/deployment/ticket-type-readiness-evidence.sh
source "${script_dir}/ticket-type-readiness-evidence.sh"

build_evidence() {
	local results_json=$1
	jq -cn --argjson results "$results_json" '{
		evidenceType: "ticket-type-expand-readiness",
		evidenceVersion: 1,
		results: $results,
		categoryCount: ($results | length),
		complete: true
	}'
}

wrap_log_messages() {
	local evidence=$1
	jq -cn --arg evidence "$evidence" '["npm banner", $evidence]'
}

expect_accepted() {
	local label=$1
	local messages_json=$2
	if ! ticket_type_readiness_evidence_available "$messages_json"; then
		echo "expected readiness evidence to be accepted: ${label}" >&2
		exit 1
	fi
}

expect_rejected() {
	local label=$1
	local messages_json=$2
	if ticket_type_readiness_evidence_available "$messages_json"; then
		echo "expected readiness evidence to be rejected: ${label}" >&2
		exit 1
	fi
}

two_results='[
	{"category":"first_check","violationCount":0},
	{"category":"last_check","violationCount":0}
]'
three_results='[
	{"category":"renamed_check","violationCount":0},
	{"category":"added_check","violationCount":0},
	{"category":"last_check","violationCount":0}
]'

valid_evidence=$(build_evidence "$two_results")
changed_categories_evidence=$(build_evidence "$three_results")
expect_accepted "valid evidence" "$(wrap_log_messages "$valid_evidence")"
expect_accepted \
	"category addition and rename" \
	"$(wrap_log_messages "$changed_categories_evidence")"

count_mismatch_evidence=$(jq -c '.categoryCount += 1' <<<"$valid_evidence")
duplicate_category_evidence=$(jq -c \
	'.results[1].category = .results[0].category' <<<"$valid_evidence")
violation_evidence=$(jq -c \
	'.results[0].violationCount = 1' <<<"$valid_evidence")
incomplete_evidence=$(jq -c '.complete = false' <<<"$valid_evidence")
wrong_version_evidence=$(jq -c '.evidenceVersion = 2' <<<"$valid_evidence")

expect_rejected \
	"category count mismatch" \
	"$(wrap_log_messages "$count_mismatch_evidence")"
expect_rejected \
	"duplicate category" \
	"$(wrap_log_messages "$duplicate_category_evidence")"
if ! ticket_type_readiness_evidence_complete \
	"$(wrap_log_messages "$violation_evidence")"; then
	echo "expected non-zero violation evidence to be structurally complete" >&2
	exit 1
fi
expect_rejected \
	"non-zero violation" \
	"$(wrap_log_messages "$violation_evidence")"
expect_rejected \
	"incomplete result" \
	"$(wrap_log_messages "$incomplete_evidence")"
expect_rejected \
	"unsupported evidence version" \
	"$(wrap_log_messages "$wrong_version_evidence")"
expect_rejected "malformed and unrelated logs" '["npm banner","{"]'

echo "Ticket Type readiness evidence fixtures passed"
