#!/usr/bin/env bash
# deploy-service.yml の step 順序と条件のテスト（Issue #543 / ADR-0040）。
# workflow の jobs.deploy.steps を yq で読み、run step を GitHub Actions と同じ順序・条件
# （if 式、前の step が失敗したら以降を実行しない）で実行する。aws / docker は PATH 上のスタブ、
# run-db-migration.sh / wait-ecs-rollout.sh は呼び出しを記録するスタブに置き換える。AWS へは接続しない。
#
# 確認すること:
# - latest と pending-deploy（terraform の初期タスク定義が参照するタグ）を push しない
# - image_tag 入力に latest / pending-deploy を指定したら push も update-service もしない
# - DB migration または search index migration が失敗したら update-service を呼ばない
# - 正常時は SHA タグの task definition で update-service を呼び、その前に migration と index 作成が終わる
# - workflow の PENDING_DEPLOY_IMAGE_TAG と terraform の image_tag 既定値が一致する
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

# aws スタブ。呼び出しを calls.log に記録する。
# - describe-services: status は ACTIVE、taskDefinition は terraform の初期リビジョン（:1）
# - describe-task-definition: image は pending-deploy（terraform apply 直後の状態）
# - register-task-definition: 渡された JSON を保存し、リビジョン :2 の ARN を返す
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
		echo "ACTIVE"
	else
		echo "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/${svc}:1"
	fi
	;;
"ecs describe-task-definition")
	td=""
	prev=""
	for arg in "$@"; do
		[[ $prev == "--task-definition" ]] && td=$arg
		prev=$arg
	done
	family=${td##*/}
	family=${family%%:*}
	jq -n --arg td "$td" --arg family "$family" --arg image "${STUB_REGISTRY}/${STUB_REPOSITORY}:pending-deploy" '{
		taskDefinitionArn: $td, family: $family, revision: 1, status: "ACTIVE",
		registeredAt: "2026-10-07T00:00:00Z", registeredBy: "terraform",
		compatibilities: ["EC2", "FARGATE"], requiresAttributes: [],
		containerDefinitions: [
			{name: $family, image: $image, essential: true},
			{name: "otel-collector", image: "public.ecr.aws/aws-observability/aws-otel-collector:v0.40.0", essential: false}
		]
	}'
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
	echo "arn:aws:ecs:ap-northeast-1:111122223333:task-definition/${family}:2"
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
chmod +x "${stub_dir}/aws" "${stub_dir}/docker"

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
		api_service: "ticket-c2c-staging-api", run_migrations: true, run_search_index_migration: true
	} + $extra'
}

# run_case <label> <inputs JSON> [VAR=value ...]
run_case() {
	local label=$1 inputs=$2
	shift 2
	case_dir="${work_dir}/case-${label}"
	mkdir -p "$case_dir"
	local repository
	repository=$(jq -r '.ecr_repository' <<<"$inputs")
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
	ecs_services: "ticket-c2c-staging-frontend", docker_context: "frontend", skip_if_services_missing: true
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

echo "deploy-service workflow fixtures passed"
