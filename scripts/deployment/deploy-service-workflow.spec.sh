#!/usr/bin/env bash
# deploy-service.yml の step 順序と条件のテスト（Issue #543 / ADR-0040、Issue #544 / ADR-0042）。
# workflow の jobs.deploy.steps を yq で読み、run step を GitHub Actions と同じ順序・条件
# （if 式、前の step が失敗したら以降を実行しない）で実行する。aws / docker は PATH 上のスタブ、
# run-db-migration.sh / wait-ecs-rollout.sh は呼び出しを記録するスタブに置き換える。terraform も PATH 上の
# スタブで、output ecs_task_definition_arns はケースごとの JSON を返す。AWS へは接続しない。
#
# 確認すること:
# - latest と pending-deploy（terraform の初期タスク定義が参照するタグ）を push しない
# - image_tag 入力に latest / pending-deploy を指定したら push も update-service もしない
# - DB migration または search index migration が失敗したら update-service を呼ばない
# - 正常時は SHA タグの task definition で update-service を呼び、その前に migration と index 作成が終わる
# - workflow の PENDING_DEPLOY_IMAGE_TAG と terraform の image_tag 既定値が一致する
# - register のコピー元は terraform の output ecs_task_definition_arns が指す revision で、service が今使っている
#   revision や family の最新 revision ではない（既存環境で terraform の設定を変えた後の deploy。Issue #544）
# - output が無い・service のキーが無い・terraform が登録した revision でない（image が pending-deploy でない、
#   revision 番号が無い）なら、push・register・migration・update-service の前に失敗する
#
# 必要なコマンド: bash, jq, yq（mikefarah v4）, python3（GitHub-hosted ubuntu runner に同梱）

set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "${script_dir}/../.." && pwd)
workflow="${repo_root}/.github/workflows/deploy-service.yml"

work_dir=$(mktemp -d)
trap '[[ -n ${KEEP_WORK_DIR:-} ]] || rm -rf "$work_dir"' EXIT

stub_dir="${work_dir}/bin"
mkdir -p "$stub_dir"

# aws スタブ。呼び出しを calls.log に記録する。task definition はケースごとの fixture（td/<family>:<revision>.json）。
# - describe-services: status は STUB_SERVICE_STATUS（既定 ACTIVE）、taskDefinition は service-revision-<service>
#   （既定 1）の revision。deploy はこれをコピー元に使ってはいけない
# - describe-task-definition: revision 番号付きの ARN だけを受け付け、fixture を返す（無ければ ClientException）
# - register-task-definition: 渡された JSON を保存し、リビジョン STUB_REGISTER_REVISION（既定 2）の ARN を返す
# - ecr describe-images: STUB_EXISTING_TAGS（空白区切り）にあるタグだけ存在する
cat >"${stub_dir}/aws" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo "aws $*" >>"${STUB_WORK_DIR}/calls.log"
args="$*"
case "$1 $2" in
"ecs describe-services")
	svc=""
	prev=""
	for arg in "$@"; do
		[[ $prev == "--services" ]] && svc=$arg
		prev=$arg
	done
	if [[ $args == *"services[0].status"* ]]; then
		echo "${STUB_SERVICE_STATUS:-ACTIVE}"
	else
		rev=1
		[[ -f "${STUB_WORK_DIR}/service-revision-${svc}" ]] && rev=$(<"${STUB_WORK_DIR}/service-revision-${svc}")
		echo "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/${svc}:${rev}"
	fi
	;;
"ecs describe-task-definition")
	td=""
	prev=""
	for arg in "$@"; do
		[[ $prev == "--task-definition" ]] && td=$arg
		prev=$arg
	done
	name=${td##*/}
	if [[ $name != *:* ]]; then
		echo "stub: describe-task-definition without a revision (family only) is not allowed: ${td}" >&2
		exit 98
	fi
	fixture="${STUB_WORK_DIR}/td/${name}.json"
	if [[ ! -f $fixture ]]; then
		echo "An error occurred (ClientException) when calling the DescribeTaskDefinition operation: Unable to describe task definition." >&2
		exit 254
	fi
	cat "$fixture"
	;;
"ecs register-task-definition")
	file=""
	prev=""
	for arg in "$@"; do
		[[ $prev == "--cli-input-json" ]] && file=${arg#file://}
		prev=$arg
	done
	family=$(jq -r '.family' "$file")
	cp "$file" "${STUB_WORK_DIR}/registered-${family}.json"
	echo "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/${family}:${STUB_REGISTER_REVISION:-2}"
	;;
"ecs update-service")
	prev=""
	for arg in "$@"; do
		[[ $prev == "--service" ]] && echo "$arg"
		prev=$arg
	done
	;;
"ecr describe-images")
	for tag in ${STUB_EXISTING_TAGS:-}; do
		if [[ $args == *"imageTag=${tag} "* || $args == *"imageTag=${tag}" ]]; then
			echo "2026-10-01T00:00:00+09:00"
			exit 0
		fi
	done
	echo "An error occurred (ImageNotFoundException)" >&2
	exit 254
	;;
*)
	echo "unexpected aws call: $*" >&2
	exit 99
	;;
esac
STUB

cat >"${stub_dir}/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo "docker $*" >>"${STUB_WORK_DIR}/calls.log"
STUB
# terraform スタブ。init は何もしない。output -json ecs_task_definition_arns はケースの tf-output.json を返す
# （無ければ、その output が state に無い時と同じく失敗する）。
cat >"${stub_dir}/terraform" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo "terraform $*" >>"${STUB_WORK_DIR}/calls.log"
args=" $* "
if [[ $args == *" init "* ]]; then
	exit 0
fi
if [[ $args == *" output -json ecs_task_definition_arns "* ]]; then
	if [[ -f "${STUB_WORK_DIR}/tf-output.json" ]]; then
		cat "${STUB_WORK_DIR}/tf-output.json"
		exit 0
	fi
	echo "Error: Output \"ecs_task_definition_arns\" not found" >&2
	exit 1
fi
echo "unexpected terraform call: $*" >&2
exit 99
STUB
chmod +x "${stub_dir}/aws" "${stub_dir}/docker" "${stub_dir}/terraform"

# workflow が相対パスで呼ぶ script のスタブ（実体は run-db-migration.spec.sh / wait-ecs-rollout.spec.sh で検証済み）。
fake_root="${work_dir}/checkout"
mkdir -p "${fake_root}/scripts/deployment"
cat >"${fake_root}/scripts/deployment/run-db-migration.sh" <<'STUB'
#!/usr/bin/env bash
mode=${4:-migration}
echo "run-db-migration ${mode} $3" >>"${STUB_WORK_DIR}/calls.log"
case "$mode" in
migration) exit "${STUB_MIGRATION_EXIT:-0}" ;;
search-index-migration) exit "${STUB_INDEX_EXIT:-0}" ;;
esac
exit 2
STUB
cat >"${fake_root}/scripts/deployment/wait-ecs-rollout.sh" <<'STUB'
#!/usr/bin/env bash
echo "wait-ecs-rollout $1 $(tr '\n' ' ' <"$2")" >>"${STUB_WORK_DIR}/calls.log"
exit 0
STUB
chmod +x "${fake_root}/scripts/deployment/"*.sh

yq -o=json '.' "$workflow" >"${work_dir}/workflow.json"

# workflow の step を実行する（GitHub Actions の if 式のうち、この workflow で使う形だけを評価する）。
cat >"${work_dir}/simulate.py" <<'PY'
import json
import os
import re
import subprocess
import sys

workflow_path, inputs_json, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
with open(workflow_path) as f:
    wf = json.load(f)
declared = wf["on"]["workflow_call"]["inputs"]
inputs = {k: v.get("default", "") for k, v in declared.items()}
given = json.loads(inputs_json)
unknown = set(given) - set(declared)
if unknown:
    sys.exit(f"unknown inputs: {sorted(unknown)}")
inputs.update(given)
ctx = {
    "inputs": inputs,
    "vars": {"AWS_APPLY_ROLE_ARN": "arn:aws:iam::111122223333:role/stub", "AWS_REGION": "ap-northeast-1"},
    "github": {"sha": os.environ["STUB_GITHUB_SHA"]},
    "steps": {},
}


def lookup(path):
    cur = ctx
    for part in path.split("."):
        if not isinstance(cur, dict):
            return ""
        cur = cur.get(part, "")
    return cur


def evaluate(expr):
    expr = expr.strip()
    if expr.startswith("${{") and expr.endswith("}}"):
        expr = expr[3:-2].strip()
    if re.search(r"\b(always|failure|cancelled|success|contains|startsWith|format|fromJSON)\s*\(", expr):
        sys.exit(f"unsupported expression function: {expr}")
    # 文字列リテラル（'...'）の外側だけを Python の式に変換する。
    parts = re.split(r"('[^']*')", expr)
    for j in range(0, len(parts), 2):
        code = parts[j]
        code = re.sub(r"\b((?:inputs|vars|github|steps)(?:\.[A-Za-z0-9_-]+)+)",
                      lambda m: f"lookup({m.group(1)!r})", code)
        code = code.replace("&&", " and ").replace("||", " or ")
        code = re.sub(r"!(?!=)", " not ", code)
        code = re.sub(r"\btrue\b", "True", re.sub(r"\bfalse\b", "False", code))
        parts[j] = code
    return eval("".join(parts), {"__builtins__": {}}, {"lookup": lookup})


def render(text):
    def one(m):
        v = evaluate(m.group(1))
        if isinstance(v, bool):
            return "true" if v else "false"
        return str(v)
    return re.sub(r"\$\{\{(.*?)\}\}", one, text)


base_env = dict(os.environ)
for k, v in wf.get("env", {}).items():
    base_env[k] = render(str(v))
base_env["GITHUB_SHA"] = ctx["github"]["sha"]
summary = os.path.join(os.environ["STUB_WORK_DIR"], "summary.md")
base_env["GITHUB_STEP_SUMMARY"] = summary

results = []
failed = False
for i, step in enumerate(wf["jobs"]["deploy"]["steps"]):
    name = step.get("name", step.get("uses", f"step-{i}"))
    cond = step.get("if")
    # if に status 関数が無い step は、前の step がすべて成功した時だけ実行される（success() && <if>）。
    run_it = not failed and (cond is None or bool(evaluate(str(cond))))
    if not run_it:
        results.append({"name": name, "result": "skipped"})
        continue
    outputs = {}
    if "uses" in step:
        if step["uses"].startswith("aws-actions/amazon-ecr-login@"):
            outputs["registry"] = os.environ["STUB_REGISTRY"]
        results.append({"name": name, "result": "success"})
    else:
        script = render(step["run"])
        script_path = os.path.join(os.environ["STUB_WORK_DIR"], f"step-{i}.sh")
        with open(script_path, "w") as f:
            f.write(script)
        output_path = os.path.join(os.environ["STUB_WORK_DIR"], f"step-{i}.output")
        open(output_path, "w").close()
        env = dict(base_env)
        for k, v in step.get("env", {}).items():
            env[k] = render(str(v))
        env["GITHUB_OUTPUT"] = output_path
        # shell 未指定は bash -e {0}、shell: bash は bash --noprofile --norc -eo pipefail {0}。
        if step.get("shell") == "bash":
            cmd = ["bash", "--noprofile", "--norc", "-eo", "pipefail", script_path]
        elif "shell" not in step:
            cmd = ["bash", "-e", script_path]
        else:
            sys.exit(f"unsupported shell: {step['shell']}")
        proc = subprocess.run(cmd, env=env, cwd=os.environ["STUB_CHECKOUT"],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        with open(output_path) as f:
            for line in f:
                if "=" in line:
                    k, v = line.rstrip("\n").split("=", 1)
                    outputs[k] = v
        result = "success" if proc.returncode == 0 else "failure"
        results.append({"name": name, "result": result, "exit": proc.returncode, "log": proc.stdout})
        if result == "failure":
            failed = True
    if "id" in step:
        ctx["steps"][step["id"]] = {"outputs": outputs}

with open(out_path, "w") as f:
    json.dump({"failed": failed, "steps": results}, f, indent=1)
PY

REGISTRY="111122223333.dkr.ecr.ap-northeast-1.amazonaws.com"
SHA="0a1b2c3d4e5f60718293a4b5c6d7e8f901234567"
SHORT_SHA=${SHA::7}

backend_inputs() {
	local extra=${1:-'{}'}
	jq -cn --argjson extra "$extra" '{
		environment: "staging", ecr_repository: "ticket-c2c-staging", ecs_cluster: "ticket-c2c-staging",
		ecs_services: "ticket-c2c-staging-api ticket-c2c-staging-worker", docker_context: ".",
		terraform_dir: "terraform/environments/staging",
		api_service: "ticket-c2c-staging-api", run_migrations: true, run_search_index_migration: true
	} + $extra'
}

TD_ARN_PREFIX="arn:aws:ecs:ap-northeast-1:111122223333:task-definition"
OTEL_IMAGE="public.ecr.aws/aws-observability/aws-otel-collector:v0.40.0"

# write_td <family> <revision> <image> <CONFIG_MARKER の値> <cpu>
# case_dir に task definition の fixture（describe-task-definition の taskDefinition）を書く。
# 設定の違いは環境変数 CONFIG_MARKER と cpu で表す。containerDefinitions[1] は ADOT collector sidecar。
write_td() {
	local family=$1 revision=$2 image=$3 marker=$4 cpu=$5
	mkdir -p "${case_dir}/td"
	jq -n --arg arn "${TD_ARN_PREFIX}/${family}:${revision}" --arg family "$family" \
		--argjson revision "$revision" --arg image "$image" --arg marker "$marker" --arg cpu "$cpu" \
		--arg otel "$OTEL_IMAGE" '{
		taskDefinitionArn: $arn, family: $family, revision: $revision, status: "ACTIVE",
		registeredAt: "2026-10-07T00:00:00Z", registeredBy: "arn:aws:sts::111122223333:assumed-role/stub",
		compatibilities: ["EC2", "FARGATE"], requiresAttributes: [{name: "com.amazonaws.ecs.capability.logging-driver.awslogs"}],
		requiresCompatibilities: ["FARGATE"], networkMode: "awsvpc", cpu: $cpu, memory: "1024",
		executionRoleArn: "arn:aws:iam::111122223333:role/ticket-c2c-staging-execution",
		taskRoleArn: ("arn:aws:iam::111122223333:role/" + $family + "-task"),
		containerDefinitions: [
			{name: $family, image: $image, essential: true,
			 environment: [{name: "CONFIG_MARKER", value: $marker}]},
			{name: "otel-collector", image: $otel, essential: false}
		]
	}' >"${case_dir}/td/${family}:${revision}.json"
}

# prepare_case <label>: case_dir を作る。fixture を書くケースは run_case の前に呼ぶ。
prepare_case() {
	label=$1
	case_dir="${work_dir}/case-${label}"
	mkdir -p "$case_dir"
}

# run_case <label> <inputs JSON> [VAR=value ...]
# fixture（td/）が無いケースは「新しい環境の最初の deploy」にする: service と terraform の output が同じ
# revision :1（image pending-deploy）を指す。
run_case() {
	local label=$1 inputs=$2
	shift 2
	case_dir="${work_dir}/case-${label}"
	mkdir -p "$case_dir"
	local repository svc
	repository=$(jq -r '.ecr_repository' <<<"$inputs")
	if [[ ! -d "${case_dir}/td" ]]; then
		echo '{}' >"${case_dir}/tf-output.json"
		for svc in $(jq -r '.ecs_services' <<<"$inputs"); do
			write_td "$svc" 1 "${REGISTRY}/${repository}:pending-deploy" initial 256
			jq --arg svc "$svc" --arg arn "${TD_ARN_PREFIX}/${svc}:1" '. + {($svc): $arn}' \
				"${case_dir}/tf-output.json" >"${case_dir}/tf-output.json.tmp"
			mv "${case_dir}/tf-output.json.tmp" "${case_dir}/tf-output.json"
		done
	fi
	env PATH="${stub_dir}:${PATH}" \
		STUB_WORK_DIR="$case_dir" STUB_CHECKOUT="$fake_root" \
		STUB_REGISTRY="$REGISTRY" STUB_REPOSITORY="$repository" STUB_GITHUB_SHA="$SHA" \
		"$@" \
		python3 "${work_dir}/simulate.py" "${work_dir}/workflow.json" "$inputs" "${case_dir}/result.json"
	touch "${case_dir}/calls.log"
}

fail() {
	echo "FAIL ${label}: $*" >&2
	jq -r '.steps[] | "  \(.result)\t\(.name)"' "${case_dir}/result.json" >&2 || true
	sed 's/^/  call: /' "${case_dir}/calls.log" >&2 || true
	jq -r '.steps[] | select(.result == "failure") | .log' "${case_dir}/result.json" >&2 || true
	exit 1
}

step_result() {
	jq -r --arg name "$1" '.steps[] | select(.name == $name) | .result' "${case_dir}/result.json"
}

expect_step() {
	local name=$1 expected=$2 actual
	actual=$(step_result "$name")
	[[ $actual == "$expected" ]] || fail "step '${name}' expected ${expected} but was ${actual:-absent}"
}

expect_no_call() {
	if grep -qE -- "$1" "${case_dir}/calls.log"; then
		fail "unexpected call matching '$1'"
	fi
}

expect_call() {
	grep -qE -- "$1" "${case_dir}/calls.log" || fail "expected call matching '$1'"
}

# 呼び出し順: <pattern a> が <pattern b> より前にある（どちらも存在する）。
expect_order() {
	local a b
	a=$(grep -nE -- "$1" "${case_dir}/calls.log" | tail -1 | cut -d: -f1)
	b=$(grep -nE -- "$2" "${case_dir}/calls.log" | head -1 | cut -d: -f1)
	[[ -n $a && -n $b ]] || fail "order check needs both '$1' and '$2'"
	((a < b)) || fail "'$1' (line ${a}) must come before '$2' (line ${b})"
}

expect_no_forbidden_push() {
	expect_no_call "^docker push .*:latest$"
	expect_no_call "^docker push .*:pending-deploy$"
	expect_no_call "^docker build .*-t [^ ]*:latest( |$)"
	expect_no_call "^docker build .*-t [^ ]*:pending-deploy( |$)"
}

# 0. workflow の PENDING_DEPLOY_IMAGE_TAG と terraform の image_tag 既定値・validation が一致する。
label=pending-deploy-tag-consistency
case_dir="${work_dir}/case-${label}"
mkdir -p "$case_dir"
echo '{"steps":[]}' >"${case_dir}/result.json"
touch "${case_dir}/calls.log"
workflow_tag=$(yq '.env.PENDING_DEPLOY_IMAGE_TAG' "$workflow")
[[ $workflow_tag == "pending-deploy" ]] || fail "workflow PENDING_DEPLOY_IMAGE_TAG is '${workflow_tag}'"
for env_name in dev staging; do
	variables="${repo_root}/terraform/environments/${env_name}/variables.tf"
	block=$(awk '/^variable "image_tag" \{/,/^\}/' "$variables")
	grep -qE "^  default += \"${workflow_tag}\"$" <<<"$block" ||
		fail "${env_name} image_tag default is not ${workflow_tag}"
	grep -qE "condition += var\.image_tag == \"${workflow_tag}\"$" <<<"$block" ||
		fail "${env_name} image_tag validation does not pin ${workflow_tag}"
done
echo "ok   ${label}"

# 1. backend 正常系（run_migrations=true）: SHA タグだけを build / push し、SHA の task definition を
#    register → DB migration → search index migration → update-service → rollout 確認の順。
label=backend-success
run_case "$label" "$(backend_inputs)"
[[ $(jq -r '.failed' "${case_dir}/result.json") == "false" ]] || fail "workflow failed"
expect_no_forbidden_push
expect_call "^docker build -t ${REGISTRY}/ticket-c2c-staging:${SHORT_SHA} \\.$"
[[ $(grep -c '^docker push ' "${case_dir}/calls.log") == 1 ]] || fail "expected exactly one docker push"
expect_call "^docker push ${REGISTRY}/ticket-c2c-staging:${SHORT_SHA}$"
for svc in ticket-c2c-staging-api ticket-c2c-staging-worker; do
	image=$(jq -r '.containerDefinitions[0].image' "${case_dir}/registered-${svc}.json")
	[[ $image == "${REGISTRY}/ticket-c2c-staging:${SHORT_SHA}" ]] || fail "${svc} registered image is ${image}"
	sidecar=$(jq -r '.containerDefinitions[1].image' "${case_dir}/registered-${svc}.json")
	[[ $sidecar == *aws-otel-collector* ]] || fail "${svc} sidecar image changed: ${sidecar}"
	expect_call "^aws ecs update-service --cluster ticket-c2c-staging --service ${svc} --task-definition arn:aws:ecs:ap-northeast-1:111122223333:task-definition/${svc}:2 "
done
expect_order "^run-db-migration migration arn:.*/ticket-c2c-staging-api:2$" "^run-db-migration search-index-migration "
expect_order "^run-db-migration search-index-migration arn:.*/ticket-c2c-staging-api:2$" "^aws ecs update-service "
expect_order "^docker push " "^run-db-migration migration "
expect_order "^aws ecs update-service " "^wait-ecs-rollout "
expect_call "^wait-ecs-rollout ticket-c2c-staging ticket-c2c-staging-api arn:.*:2 ticket-c2c-staging-worker arn:.*:2 $"
# 新しい環境の最初の deploy: コピー元は terraform の output が指す revision :1（service の revision と同じ）。
expect_call "^terraform -chdir=terraform/environments/staging output -json ecs_task_definition_arns$"
expect_call "^aws ecs describe-task-definition --task-definition ${TD_ARN_PREFIX}/ticket-c2c-staging-api:1 "
expect_order "^terraform .* output " "^docker build "
echo "ok   ${label}"

# 2. DB migration が失敗 → search index migration・update-service・rollout 確認を実行しない。
label=migration-failed
run_case "$label" "$(backend_inputs)" STUB_MIGRATION_EXIT=1
expect_step "Run DB migration (before service update)" failure
expect_step "Run search index migration (before service update)" skipped
expect_step "Update services" skipped
expect_step "Wait for ECS rollout completed" skipped
expect_no_call "^aws ecs update-service "
expect_no_call "^run-db-migration search-index-migration "
expect_no_forbidden_push
echo "ok   ${label}"

# 3. search index migration が失敗 → update-service・rollout 確認を実行しない。
label=index-failed
run_case "$label" "$(backend_inputs)" STUB_INDEX_EXIT=1
expect_step "Run DB migration (before service update)" success
expect_step "Run search index migration (before service update)" failure
expect_step "Update services" skipped
expect_no_call "^aws ecs update-service "
expect_no_call "^wait-ecs-rollout "
expect_no_forbidden_push
echo "ok   ${label}"

# 4. run_migrations=false でも search index migration は実行し、その後に update-service。
label=backend-without-db-migration
run_case "$label" "$(backend_inputs '{"run_migrations": false}')"
expect_step "Run DB migration (before service update)" skipped
expect_no_call "^run-db-migration migration "
expect_order "^run-db-migration search-index-migration " "^aws ecs update-service "
expect_no_forbidden_push
echo "ok   ${label}"

# 5. ロールバック（image_tag に過去の short SHA）: build / push せず、そのタグで register → update-service。
label=rollback-existing-tag
run_case "$label" "$(backend_inputs '{"image_tag": "abc1234"}')" STUB_EXISTING_TAGS="abc1234 latest pending-deploy"
[[ $(jq -r '.failed' "${case_dir}/result.json") == "false" ]] || fail "workflow failed"
expect_step "Build and push image" skipped
expect_no_call "^docker "
image=$(jq -r '.containerDefinitions[0].image' "${case_dir}/registered-ticket-c2c-staging-api.json")
[[ $image == "${REGISTRY}/ticket-c2c-staging:abc1234" ]] || fail "registered image is ${image}"
expect_call "^aws ecs update-service "
echo "ok   ${label}"

# 6. image_tag に pending-deploy / latest を指定 → Resolve image tag で失敗し、ECR も ECS も更新しない
#    （ECR にタグが残っていても拒否する）。
for tag in pending-deploy latest; do
	label="reject-image-tag-${tag}"
	run_case "$label" "$(backend_inputs "{\"image_tag\": \"${tag}\"}")" STUB_EXISTING_TAGS="abc1234 latest pending-deploy"
	expect_step "Resolve image tag" failure
	expect_step "Register SHA-pinned task definitions" skipped
	expect_step "Update services" skipped
	expect_no_call "^docker "
	expect_no_call "^aws ecs register-task-definition "
	expect_no_call "^aws ecs update-service "
	expect_no_call "^aws ecr describe-images "
	echo "ok   ${label}"
done

# 7. frontend（api_service なし、migration なし）: SHA タグだけを push し、frontend を update-service。
label=frontend-success
run_case "$label" "$(jq -cn '{
	environment: "staging", ecr_repository: "ticket-c2c-staging-frontend", ecs_cluster: "ticket-c2c-staging",
	ecs_services: "ticket-c2c-staging-frontend", docker_context: "frontend", skip_if_services_missing: true,
	terraform_dir: "terraform/environments/staging"
}')"
[[ $(jq -r '.failed' "${case_dir}/result.json") == "false" ]] || fail "workflow failed"
expect_no_forbidden_push
expect_call "^docker push ${REGISTRY}/ticket-c2c-staging-frontend:${SHORT_SHA}$"
expect_no_call "^run-db-migration "
expect_call "^aws ecs update-service --cluster ticket-c2c-staging --service ticket-c2c-staging-frontend "
echo "ok   ${label}"

# 8. workflow 自体に latest を push / tag する記述が無いこと（将来の step 追加の回帰）。
label=no-latest-in-workflow
# shellcheck disable=SC2016 # $TAG は展開せず、workflow 内の文字列として照合する
rejection_check='[ "$TAG" = "latest" ]'
if yq '.jobs.deploy.steps[].run // ""' "$workflow" | grep -nE ':latest|"latest"' |
	grep -vF "$rejection_check"; then
	fail "deploy-service.yml still references the latest tag outside the rejection checks"
fi
echo "ok   ${label}"

# 9. 既存の環境（Issue #544）: service は deploy が前に register した revision :42（旧設定 + 旧イメージ）を使い、
#    terraform は設定を変えた revision :43（新設定 + pending-deploy）を登録済み。さらに失敗した deploy が
#    register した revision :44（旧設定 + 別のイメージ）が family の最新 ACTIVE revision として残っている。
#    deploy は :43 の設定 + 今回の SHA の revision（:45）を register し、migration・index 作成・update-service に使う。
#    修正前の workflow（service の revision をコピーする）では :42 の旧設定が register されるため、このケースが失敗する。
label=existing-environment-terraform-config-change
prepare_case "$label"
OLD_IMAGE="${REGISTRY}/ticket-c2c-staging:1111111"
FAILED_IMAGE="${REGISTRY}/ticket-c2c-staging:2222222"
PENDING_IMAGE="${REGISTRY}/ticket-c2c-staging:pending-deploy"
echo '{}' >"${case_dir}/tf-output.json"
for svc in ticket-c2c-staging-api ticket-c2c-staging-worker; do
	write_td "$svc" 42 "$OLD_IMAGE" old-config 256
	write_td "$svc" 43 "$PENDING_IMAGE" new-config 512
	write_td "$svc" 44 "$FAILED_IMAGE" old-config 256
	echo 42 >"${case_dir}/service-revision-${svc}"
	jq --arg svc "$svc" --arg arn "${TD_ARN_PREFIX}/${svc}:43" '. + {($svc): $arn}' \
		"${case_dir}/tf-output.json" >"${case_dir}/tf-output.json.tmp"
	mv "${case_dir}/tf-output.json.tmp" "${case_dir}/tf-output.json"
done
run_case "$label" "$(backend_inputs)" STUB_REGISTER_REVISION=45
[[ $(jq -r '.failed' "${case_dir}/result.json") == "false" ]] || fail "workflow failed"
for svc in ticket-c2c-staging-api ticket-c2c-staging-worker; do
	registered="${case_dir}/registered-${svc}.json"
	# register した内容 = terraform の revision :43 から ECS が付ける属性を除き、アプリのイメージだけを差し替えたもの。
	expected=$(jq -S --arg image "${REGISTRY}/ticket-c2c-staging:${SHORT_SHA}" '
		del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
			.registeredAt, .registeredBy, .deregisteredAt)
		| .containerDefinitions[0].image = $image' "${case_dir}/td/${svc}:43.json")
	[[ $(jq -S . "$registered") == "$expected" ]] || fail "${svc} registered task definition is not terraform :43 + new image: $(jq -c . "$registered")"
	[[ $(jq -r '.containerDefinitions[0].environment[] | select(.name == "CONFIG_MARKER") | .value' "$registered") == "new-config" ]] ||
		fail "${svc} registered the old configuration"
	[[ $(jq -r '.cpu' "$registered") == "512" ]] || fail "${svc} registered the old cpu"
	expect_call "^aws ecs describe-task-definition --task-definition ${TD_ARN_PREFIX}/${svc}:43 "
	expect_no_call "^aws ecs describe-task-definition --task-definition ${TD_ARN_PREFIX}/${svc}:42 "
	expect_no_call "^aws ecs describe-task-definition --task-definition ${TD_ARN_PREFIX}/${svc}:44 "
	expect_no_call "^aws ecs describe-task-definition --task-definition (${TD_ARN_PREFIX}/)?${svc} "
	expect_call "^aws ecs update-service --cluster ticket-c2c-staging --service ${svc} --task-definition ${TD_ARN_PREFIX}/${svc}:45 "
done
expect_no_call "^aws ecs list-task-definitions"
expect_call "^run-db-migration migration ${TD_ARN_PREFIX}/ticket-c2c-staging-api:45$"
expect_call "^run-db-migration search-index-migration ${TD_ARN_PREFIX}/ticket-c2c-staging-api:45$"
expect_order "^run-db-migration search-index-migration " "^aws ecs update-service "
expect_call "^wait-ecs-rollout ticket-c2c-staging ticket-c2c-staging-api ${TD_ARN_PREFIX}/ticket-c2c-staging-api:45 ticket-c2c-staging-worker ${TD_ARN_PREFIX}/ticket-c2c-staging-worker:45 $"
echo "ok   ${label}"

# 10. 既存の環境で rollback（image_tag に過去の short SHA）: 設定は terraform の現在の revision :43、イメージは過去のタグ。
label=existing-environment-rollback
prepare_case "$label"
cp -r "${work_dir}/case-existing-environment-terraform-config-change/td" "${case_dir}/td"
cp "${work_dir}/case-existing-environment-terraform-config-change/tf-output.json" "${case_dir}/"
cp "${work_dir}/case-existing-environment-terraform-config-change/"service-revision-* "${case_dir}/"
run_case "$label" "$(backend_inputs '{"image_tag": "1111111", "run_migrations": false}')" STUB_EXISTING_TAGS="1111111" STUB_REGISTER_REVISION=45
[[ $(jq -r '.failed' "${case_dir}/result.json") == "false" ]] || fail "workflow failed"
expect_no_call "^docker "
registered="${case_dir}/registered-ticket-c2c-staging-api.json"
[[ $(jq -r '.containerDefinitions[0].image' "$registered") == "$OLD_IMAGE" ]] || fail "rollback image is not the past tag"
[[ $(jq -r '.containerDefinitions[0].environment[0].value' "$registered") == "new-config" ]] ||
	fail "rollback must keep the current terraform configuration"
echo "ok   ${label}"

# 11. terraform の output が state に無い（その環境に一度も apply していない、この output を足す前の state）:
#     push・register・migration・update-service の前に失敗する。
label=terraform-output-missing
prepare_case "$label"
write_td ticket-c2c-staging-api 1 "${REGISTRY}/ticket-c2c-staging:pending-deploy" initial 256
run_case "$label" "$(backend_inputs)"
expect_step "Resolve terraform task definitions" failure
expect_step "Build and push image" skipped
expect_step "Register SHA-pinned task definitions" skipped
expect_step "Run DB migration (before service update)" skipped
expect_step "Update services" skipped
expect_no_call "^docker "
expect_no_call "^aws ecs register-task-definition "
expect_no_call "^run-db-migration "
expect_no_call "^aws ecs update-service "
echo "ok   ${label}"

# 12. output に service のキーが無い / revision 番号の無い ARN / terraform が登録した revision でない
#     （image が pending-deploy でない）/ describe できない ARN: どれも同じく register の前に失敗する。
for variant in missing-key family-only not-terraform-revision unknown-revision; do
	label="terraform-arn-${variant}"
	prepare_case "$label"
	for svc in ticket-c2c-staging-api ticket-c2c-staging-worker; do
		write_td "$svc" 43 "$PENDING_IMAGE" new-config 512
		write_td "$svc" 44 "$FAILED_IMAGE" old-config 256
	done
	api_arn="${TD_ARN_PREFIX}/ticket-c2c-staging-api:43"
	case "$variant" in
	missing-key) jq -n --arg w "${TD_ARN_PREFIX}/ticket-c2c-staging-worker:43" '{"ticket-c2c-staging-worker": $w}' >"${case_dir}/tf-output.json" ;;
	family-only) api_arn="${TD_ARN_PREFIX}/ticket-c2c-staging-api" ;;
	not-terraform-revision) api_arn="${TD_ARN_PREFIX}/ticket-c2c-staging-api:44" ;;
	unknown-revision) api_arn="${TD_ARN_PREFIX}/ticket-c2c-staging-api:99" ;;
	esac
	if [[ $variant != missing-key ]]; then
		jq -n --arg a "$api_arn" --arg w "${TD_ARN_PREFIX}/ticket-c2c-staging-worker:43" \
			'{"ticket-c2c-staging-api": $a, "ticket-c2c-staging-worker": $w}' >"${case_dir}/tf-output.json"
	fi
	run_case "$label" "$(backend_inputs)"
	expect_step "Resolve terraform task definitions" failure
	expect_step "Register SHA-pinned task definitions" skipped
	expect_step "Update services" skipped
	expect_no_call "^docker "
	expect_no_call "^aws ecs register-task-definition "
	expect_no_call "^run-db-migration "
	expect_no_call "^aws ecs update-service "
	echo "ok   ${label}"
done

# 13. frontend service が無い環境（staging alb-http-only、skip_if_services_missing）: terraform の output を読まない
#     （frontend のキーが無くても失敗しない）。イメージの build / push だけ行う。
label=frontend-service-missing
prepare_case "$label"
mkdir -p "${case_dir}/td"
run_case "$label" "$(jq -cn '{
	environment: "staging", ecr_repository: "ticket-c2c-staging-frontend", ecs_cluster: "ticket-c2c-staging",
	ecs_services: "ticket-c2c-staging-frontend", docker_context: "frontend", skip_if_services_missing: true,
	terraform_dir: "terraform/environments/staging"
}')" STUB_SERVICE_STATUS=MISSING
[[ $(jq -r '.failed' "${case_dir}/result.json") == "false" ]] || fail "workflow failed"
expect_step "Resolve terraform task definitions" skipped
expect_no_call "^terraform "
expect_no_call "^aws ecs update-service "
expect_call "^docker push ${REGISTRY}/ticket-c2c-staging-frontend:${SHORT_SHA}$"
echo "ok   ${label}"

# 14. 呼び出し側の 4 workflow が、自分の環境の terraform root を terraform_dir に渡している。
label=callers-pass-terraform-dir
case_dir="${work_dir}/case-${label}"
mkdir -p "$case_dir"
echo '{"steps":[]}' >"${case_dir}/result.json"
touch "${case_dir}/calls.log"
for env_name in dev staging; do
	for kind in backend frontend; do
		caller="${repo_root}/.github/workflows/deploy-${kind}-${env_name}.yml"
		dir=$(yq '.jobs.deploy.with.terraform_dir' "$caller")
		[[ $dir == "terraform/environments/${env_name}" ]] || fail "deploy-${kind}-${env_name}.yml terraform_dir is '${dir}'"
	done
done
echo "ok   ${label}"

echo "deploy-service workflow fixtures passed"
