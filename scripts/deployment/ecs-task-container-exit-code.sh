#!/usr/bin/env bash
# ECS RunTask結果JSONから、container名を指定してexitCodeを取得する共通関数（Issue #363）。
#
# `aws ecs describe-tasks` が返す実行時 `.containers[]` 配列の並び順は、
# task definitionの `containerDefinitions[]` の並び順（app→sidecar）と一致する保証がない。
# readiness/migration taskではapp（essential）が正常終了すると `EssentialContainerExited` で
# task全体が停止し、まだ稼働中だったADOT sidecar（essential=false）も巻き込まれて終了する。
# このとき `.containers[0]` が指すコンテナはrunごとに変わり得るため、
# 配列indexではなくcontainer name一致で対象（呼び出し元が明示的に指定するapp container）を
# 特定する。

ecs_task_container_exit_code() {
	local task_json=$1
	local container_name=$2

	jq -r --arg container "$container_name" '
		([.containers[]? | select(.name == $container) | (.exitCode // "none")][0])
			// "none"
	' <<<"$task_json"
}
