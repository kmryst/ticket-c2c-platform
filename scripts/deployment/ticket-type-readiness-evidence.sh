#!/usr/bin/env bash
# Ticket Type expand readinessのCloudWatch Logs証跡を構造検証する共通関数。
# カテゴリ数・カテゴリ名はchecker側の正本から出力されるため、ここでは固定しない。

ticket_type_readiness_evidence_matches() {
	local task_log_messages_json=$1
	local require_zero_violations=$2

	jq -e --argjson require_zero_violations "$require_zero_violations" '
		[
			.[]
			| select(type == "string")
			| fromjson?
			| select(type == "object")
		]
		| any(
			.[];
			. as $evidence
			| $evidence.evidenceType == "ticket-type-expand-readiness"
				and $evidence.evidenceVersion == 1
				and $evidence.complete == true
				and (
					if (
						($evidence.results | type) == "array"
						and ($evidence.categoryCount | type) == "number"
					) then
						($evidence.results | length) > 0
						and $evidence.categoryCount == ($evidence.results | length)
						and $evidence.categoryCount == ($evidence.categoryCount | floor)
						and (
							[$evidence.results[].category] | unique | length
						) == $evidence.categoryCount
						and all(
							$evidence.results[];
							type == "object"
							and (.category | type) == "string"
							and (.violationCount | type) == "number"
							and .violationCount == (.violationCount | floor)
							and .violationCount >= 0
							and (
								($require_zero_violations | not)
								or .violationCount == 0
							)
						)
					else
						false
					end
				)
		)
	' <<<"$task_log_messages_json" >/dev/null 2>&1
}

ticket_type_readiness_evidence_complete() {
	ticket_type_readiness_evidence_matches "$1" false
}

ticket_type_readiness_evidence_available() {
	ticket_type_readiness_evidence_matches "$1" true
}
