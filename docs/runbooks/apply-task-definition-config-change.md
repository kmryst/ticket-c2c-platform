# terraform で変えた task definition の設定を反映する・確認する・戻す

Issue #544 / [ADR-0042](../adr/0042-deploy-copies-terraform-registered-task-definition.md) で、ECS task definition の責務を次のように分けた。

- **設定**（環境変数・secrets・CPU / メモリ・role・sidecar 等）: terraform（`terraform/environments/<env>/`）
- **イメージ**: deploy workflow（`deploy-backend-<env>.yml` / `deploy-frontend-<env>.yml` → `deploy-service.yml`）

deploy は terraform の state から output `ecs_task_definition_arns`（service 名 → terraform が最後の apply で登録した revision の ARN）を読み、その revision のイメージだけを commit SHA タグに差し替えて register する。
register した revision を DB migration / search index migration の run-task と update-service に使う。
ECS service は `ignore_changes = [task_definition]` なので、apply だけではサービスは変わらない。

## 設定を変えて反映する

1. terraform のコードを変える PR をマージする。
2. `terraform-apply-<env>.yml` を実行する。plan で、対象の `aws_ecs_task_definition` が作り直され（`must be replaced`）、`aws_ecs_service` に差分が無いことを確認する。
3. **apply の run が success で完了したことを確認してから**、変えた service の deploy workflow を実行する。
   - api / worker: `deploy-backend-<env>.yml`。migration が新しい設定を必要とする場合は `run_migrations=true`。
   - frontend: `deploy-frontend-<env>.yml`。
4. 「確認する」の手順で、service と migration の task definition に設定が入ったことを確認する。

apply と deploy は同じ concurrency group（`mutation-<env>`、`queue: max`）なので同時には走らないが、**実行順は保証されない**。`queue: max` は待機中の run を cancel せずに保持するだけで、順序は待機を始めた時刻の FIFO で、[GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency) にも "ordering is not guaranteed" とある。concurrency は排他制御のためだけに使い、順序は次のとおり運用で守る（[ADR-0042](../adr/0042-deploy-copies-terraform-registered-task-definition.md)「残しているリスク」）。

- apply の完了を待たずに deploy を起動しない。両方が待機中になると deploy が先に実行され得る。そのとき deploy は前回の apply の設定で成功し、エラーにならない。
- apply が失敗したまま deploy しない。deploy は前回の apply の設定で成功してしまう。失敗した apply を re-run したときも、完了を確認してから deploy を起動する。
- ローカルでの apply（alb-http-only の手順など）は `mutation-<env>` の排他の外になる。CI の apply / deploy が動いていないことを確認してから行い、終わってから deploy を起動する。

この output を足す前の state しかない環境（Issue #544 のマージより前に apply し、その後 apply していない環境）では、deploy は `terraform output ecs_task_definition_arns is not in the state` で失敗する。先に `terraform-apply-<env>.yml` を 1 回実行する。

## rollback の意味

`image_tag` に過去の short SHA を指定する rollback は、**過去のイメージ ＋ 現在の terraform の設定**の組み合わせになる。設定は戻らない。

設定まで過去に戻す場合:

1. terraform の設定を戻す PR をマージする（`git revert` など）。
2. `terraform-apply-<env>.yml` を実行する。
3. `deploy-backend-<env>.yml` / `deploy-frontend-<env>.yml` を `image_tag=<戻したい short SHA>` で実行する。

新しいイメージが新しい設定（追加した環境変数など）を必須にしている場合、過去のイメージは問題なく動くが、新しいイメージを過去の設定で動かす組み合わせは作れない（deploy は常に terraform の現在の設定を使う）。設定を戻すのは、そのイメージも戻す時だけにする。

## AWS で確認する（既存の環境で設定を変えて再 apply → deploy）

コードを書き換えずに確認するため、`terraform-apply-<env>.yml` の入力 `task_config_check_value` を使う。
値を入れると、api / worker / frontend の task definition のアプリコンテナに環境変数 `TASK_CONFIG_CHECK_VALUE` が入る。アプリはこの変数を読まないので、動作は変わらない。空（既定値）なら環境変数を足さない。

以下は staging の例。`gh` は main ブランチの workflow を起動する。各 run は前の run が終わってから起動する。

```bash
ENV=staging
CLUSTER="ticket-c2c-${ENV}"
CHECK_VALUE="issue-544-check-$(date -u +%Y%m%d%H%M)"

# task definition の環境変数 TASK_CONFIG_CHECK_VALUE と image を表示する
show_td() {
  aws ecs describe-task-definition --task-definition "$1" \
    --query "taskDefinition.{revision: revision, image: containerDefinitions[0].image, check: containerDefinitions[0].environment[?name=='TASK_CONFIG_CHECK_VALUE'].value | [0]}" \
    --output json
}
# service が使っている task definition の ARN
service_td() {
  aws ecs describe-services --cluster "$CLUSTER" --services "$1" --query 'services[0].taskDefinition' --output text
}
```

### 1. 環境を作り、通常どおり deploy する（既存の環境の状態にする）

```bash
gh workflow run terraform-apply-staging.yml -f capacity_profile=normal -f public_endpoint_mode=https-dns
gh workflow run deploy-backend-staging.yml -f run_migrations=true
gh workflow run deploy-frontend-staging.yml
gh workflow run staging-smoke-test.yml
```

deploy-backend の step summary に `terraform task definition for ticket-c2c-staging-api: ticket-c2c-staging-api:<N>` と `registered ticket-c2c-staging-api -> ticket-c2c-staging-api:<M> (from ticket-c2c-staging-api:<N>, ...)` が出る。

```bash
for SVC in ticket-c2c-${ENV}-api ticket-c2c-${ENV}-worker ticket-c2c-${ENV}-frontend; do
  echo "$SVC"; show_td "$(service_td "$SVC")"
done
```

合格条件: 3 service とも `image` が commit SHA タグ、`check` が `null`。この時点の revision 番号（`<M>`）を記録する。

### 2. 設定だけを変えて再 apply する

```bash
gh workflow run terraform-apply-staging.yml -f capacity_profile=normal -f public_endpoint_mode=https-dns \
  -f task_config_check_value="$CHECK_VALUE"
```

合格条件:

- run log の plan で、変わるのは `module.api_service` / `module.worker_service` / `module.frontend_service[0]` の `aws_ecs_task_definition.this` の作り直し（environment に `TASK_CONFIG_CHECK_VALUE` が増える）だけで、`aws_ecs_service` を含むその他のリソースに差分が無い。
- step summary の `terraform output` で、`ecs_task_definition_arns` の 3 つの ARN の revision 番号が手順 1 から変わっている。
- service はまだ変わっていない（apply だけでは反映されない）:

```bash
for SVC in ticket-c2c-${ENV}-api ticket-c2c-${ENV}-worker ticket-c2c-${ENV}-frontend; do
  echo "$SVC"; show_td "$(service_td "$SVC")"
done
```

`check` が `null` のままで、revision が手順 1 の `<M>` のまま。

### 3. deploy して、service と migration に反映されることを確認する

```bash
gh workflow run deploy-backend-staging.yml -f run_migrations=true
gh workflow run deploy-frontend-staging.yml
```

合格条件:

- deploy-backend の step summary で、`terraform task definition for ticket-c2c-staging-api` / `-worker` の revision が手順 2 の output の revision と一致し、`registered ... (from <その revision>, <commit SHA のイメージ>)` になっている。
- 同じ step summary の DB migration と search index migration の出力で、`taskDefinition=` が `registered ticket-c2c-staging-api -> ...` の revision（今回 register した api の revision）と一致する。
- service と migration が使った task definition に変更が入っている:

```bash
for SVC in ticket-c2c-${ENV}-api ticket-c2c-${ENV}-worker ticket-c2c-${ENV}-frontend; do
  echo "$SVC"; show_td "$(service_td "$SVC")"
done
# migration の task definition（step summary の taskDefinition= の値）
show_td "<migration の taskDefinition= の ARN>"
```

3 service と migration の task definition で `check` が `$CHECK_VALUE`、`image` が今回の commit SHA タグ。`wait-ecs-rollout` の step が成功している。

migration の task が残っていれば、実際に起動した task の task definition も確認できる（停止した task は約 1 時間で describe できなくなる）:

```bash
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "<step summary の taskArn= の値>" \
  --query 'tasks[0].taskDefinitionArn' --output text
```

### 4. rollback の組み合わせを確認する（任意）

```bash
gh workflow run deploy-backend-staging.yml -f image_tag=<手順 1 の commit の short SHA>
```

合格条件: api / worker の task definition の `image` が指定した short SHA、`check` が `$CHECK_VALUE`（過去のイメージ ＋ 現在の terraform の設定）。

### 5. 後片付け

staging は destroy する（`terraform-destroy-staging.yml`）。destroy しない環境では、`task_config_check_value` を空にして `terraform-apply-<env>.yml` を実行し、続けて deploy workflow を実行すると `TASK_CONFIG_CHECK_VALUE` が消える。
