# Runbook: Gate B Ticket Type cutover（activation / rollback）

対象: dev / staging の在庫 writer mode 切替（`legacy` ⇄ `ticket_type`）。Issue #378 /
[ADR-0032](../adr/0032-single-transaction-writer-mode-switch-cli.md) /
[ADR-0033](../adr/0033-ticket-type-migration-irreversible-boundaries.md)。

本 runbook は「在庫正本の controlled cutover」を 1 つの failure domain として扱い、preflight /
activation / rollback / postflight の実行順序、合格条件（数値）、停止条件、禁止操作を定める。

## 1. owner と承認

- owner: Gate B cutover failure domain（Issue #378）。checker / activation CLI / workflow /
  本 runbook はこの failure domain の成果物である。
- Gate 判定・実行承認・証跡の所有は親 Issue #335。**AWS 上での実行（dev rehearsal / staging Gate B）は
  #335 Gate B の別承認を必要とする**。本 runbook が存在することは実行許可ではない。
- Search Projection（OpenSearch）の reconciliation / rebuild は
  [search-projection-reconciliation-rebuild.md](./search-projection-reconciliation-rebuild.md)（Issue #377）が正本。
  本 runbook はその呼び出し順序だけを定める。
- 本 runbook は Gate B（compatibility 期間）専用である。ADR-0033 決定 3 により、#384（fresh session
  final cleanup）実装後に ADR-0032 の CLI と cutover workflow は退役する。

## 2. 各段階の正本と read / write path

| 対象 | 正本 | 書き込める経路 | 備考 |
| --- | --- | --- | --- |
| 在庫数量 | Aurora PostgreSQL（`ticket_inventory` / `ticket_type_inventory`） | 購入 API（compatibility writer） | Gate B 中に人手で UPDATE しない |
| control state | Aurora `inventory_writer_control`（1 行） | switch CLI（ADR-0032）のみ | CLI は control row の 1 行 UPDATE 以外に何も書かない |
| Valkey counter / revision | Aurora（前段フィルタなので再構築可能） | seed / reconcile CLI（`run-cutover-task.sh` の counter operation: `seed-ticket-type` / `seed-legacy` / `reconcile-ticket-type` / `reconcile-legacy`）と稼働中 writer のみ | `redis-cli` 手打ち禁止（counter と revision の対が壊れる）。cutover workflow の choice には載せない |
| OpenSearch projection | Aurora（projection なので再構築可能） | rebuild / repair CLI のみ | 逆同期しない |

read path は writer mode に従う。`legacy` mode では Event 単位 counter（`inventory:<eventId>`）、
`ticket_type` mode では Type 単位 counter（`inventory:ticket-type:{<eventId>:<ticketTypeId>}:remaining`）を
購入 API が参照・更新する。**非 active 側の namespace は稼働中 writer が更新しない**（これが 5 章で
legacy 再 seed が必須になる理由）。

## 3. compatibility matrix

Gate B の rolling 期間に出現する「旧 API / 新 API × 旧 Worker / 新 Worker」の組合せについて、
互換性を担保する既存 artifact を対応させる。旧 binary プロセスを別途起動する integration harness は
作らない（#378 受け入れ条件）。

| 組合せ | DB schema | event payload | Valkey namespace | projection |
| --- | --- | --- | --- | --- |
| 旧 API × 旧 Worker | compatibility migration spec（`1785542400000-add-ticket-type-compatibility-writer.spec.ts`）: expand 済み schema 上で旧 write pattern が成立し、統合 requestId index の 23505 が HTTP 409 になる | 旧 payload（versioned field なし） | legacy namespace のみ（checker の `valkey_legacy_*` category） | version なし document。`unversioned_projection` として reconciliation が検出 |
| 新 API × 旧 Worker | 同 spec（compatibility writer は両 namespace を control state に従って更新） | 新 payload（追加 field を旧 Worker は無視する） | control state に従う（`legacy` mode 中は legacy namespace が正） | 旧 Worker が versioned field を全置換で消し得る。**mixed Worker 期間は新 projection を active 扱いしない**（projection runbook） |
| 旧 API × 新 Worker | 同 spec | 旧 payload | legacy namespace | 新 Worker の version guard が legacy を無視（`legacy_ignore`）。`src/search/projection.integration.spec.ts` |
| 新 API × 新 Worker | 同 spec + `src/purchases/purchases.ticket-type-inventory.integration.spec.ts`（実 PostgreSQL + 実 Valkey） | 新 payload | control state に従う（`ticket_type` mode で Type 単位） | versioned projection。`src/search/projection.integration.spec.ts` |

いずれの組合せでも、cutover 時点の整合は Gate B checker の 23 category（DB 未紐付け・在庫差分 10 /
control state 2 / compatibility object 1 / Valkey 9 / OpenSearch projection 1）で **実データに対して**
再確認する。テストは「その組合せが壊れないこと」、checker は「実環境が今壊れていないこと」を担保する。
両方が揃って初めて activation してよい。

activation の前提として、**全 RUNNING task が承認済み revision であること**（= 旧 task 0 件・rolling 完了）を
positive に確認する（4 章 step 2。件数一致で確認し、「0 件」を合格と読み替えない）。
これは #335 の不可逆境界 5 に対応する。

## 4. activation session の実行順序

各 step は「実行手段 / 合格条件 / 停止条件」を持つ。合格条件を満たさない限り次の step へ進まない。
`<env>` は `dev` / `staging`。cluster 名は `ticket-c2c-<env>`、service 名は
`ticket-c2c-<env>-api` / `ticket-c2c-<env>-worker`（`terraform/environments/<env>/main.tf` の
`aws_ecs_cluster.this`（`var.name`）と `module.api_service` / `module.worker_service` の
`name = "${var.name}-api"` / `"${var.name}-worker"`。container 名は service 名と同じ）。
以下の例は `ENV` / `CLUSTER` が設定済みであることを前提にする。

```bash
ENV=dev                     # または staging
CLUSTER="ticket-c2c-${ENV}"
API_SERVICE="ticket-c2c-${ENV}-api"
WORKER_SERVICE="ticket-c2c-${ENV}-worker"
```

0. **session 開始時の禁止 workflow 空確認**
   - 実行: 7 章の禁止 workflow に queued / in_progress / waiting / pending / requested の run が
     1 件も無いことを確認し、出力を証跡として残す。preflight と activation は別 run なので、
     既に queue 済みの deploy / migration が間に走ると、`current` が別 revision を指した状態で
     切り替わり得る。

     ```bash
     for wf in "terraform-apply-${ENV}.yml" "terraform-destroy-${ENV}.yml" \
       "db-migrate-${ENV}.yml" "deploy-backend-${ENV}.yml" "deploy-frontend-${ENV}.yml" \
       "${ENV}-smoke-test.yml" "ticket-type-expand-readiness-${ENV}.yml" \
       "ticket-type-cutover-${ENV}.yml"; do
       gh run list --workflow "$wf" --limit 30 \
         --json databaseId,status,displayTitle,createdAt \
         --jq "{workflow: \"$wf\", pending: ([.[] | select(.status | IN(\"queued\",\"in_progress\",\"waiting\",\"pending\",\"requested\"))] | length), runs: [.[] | select(.status | IN(\"queued\",\"in_progress\",\"waiting\",\"pending\",\"requested\"))]}"
     done
     ```

   - 合格条件: 全 workflow で `pending` が **0**。
   - 停止条件: 1 件でも非 0 なら、その run の完了（または cancel）を待ってから session を開始する。
1. **compatibility release の positive 確認**
   - 実行: API / Worker それぞれの ECS service が compatibility artifact（#376 / #389 / #377 を含む
     イメージ）の task definition で稼働していることを、**件数と一致で positive に**確認する。

     ```bash
     aws ecs describe-services --cluster "$CLUSTER" \
       --services "$API_SERVICE" "$WORKER_SERVICE" \
       --query 'services[].{service:serviceName,taskDefinition:taskDefinition,desired:desiredCount,running:runningCount,pending:pendingCount}' \
       --output json
     ```

   - 合格条件: API / Worker の両方で `desiredCount == runningCount` かつ **> 0**、`pendingCount == 0`、
     `taskDefinition` が承認済み revision の ARN と完全一致。
   - 停止条件: 片方でも旧 revision、`runningCount` が 0、`desiredCount != runningCount`、
     `pendingCount != 0` のいずれかなら activation しない。
   - **確認した API の task definition ARN をこの session の承認値として控える**
     （以降の全 dispatch で workflow 入力 `task_definition_arn` に明示する。step 6 / 7 / 9）。
2. **RUNNING task の positive 確認（旧 task 0 件）**
   - 実行: service ごとに RUNNING task を列挙し、**各 task の taskDefinition と imageDigest** を
     承認値と突き合わせる。`list-tasks` の出力を数えるだけでは、**target task が 0 件でも
     「旧 task 0 件」と読めてしまう**（空配列は「rolling 完了」ではなく「service が
     動いていない」かもしれない）。

     ```bash
     for service in "$API_SERVICE" "$WORKER_SERVICE"; do
       task_arns=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$service" \
         --desired-status RUNNING --query 'taskArns' --output text)
       echo "== ${service}: $(wc -w <<<"$task_arns") RUNNING task(s)"
       [ -n "$task_arns" ] || continue
       # shellcheck disable=SC2086
       aws ecs describe-tasks --cluster "$CLUSTER" --tasks $task_arns \
         --query "tasks[].{taskArn:taskArn,taskDefinition:taskDefinitionArn,lastStatus:lastStatus,digest:containers[?name=='${service}'].imageDigest|[0]}" \
         --output json
     done
     ```

   - 合格条件（すべて満たすこと）:
     - RUNNING task 件数が step 1 の `runningCount`（= `desiredCount`）と一致し、**1 件以上**である。
     - 全 RUNNING task の `taskDefinition` が step 1 で控えた承認値と一致する（一致件数 = 全件）。
     - 全 RUNNING task の `digest`（承認 image digest）が一致する。
     - 承認値以外の taskDefinition を持つ task、および `lastStatus != RUNNING` の task が **0 件**。
   - 停止条件: 上のいずれかを満たさない場合は rolling 完了まで待つ（統合 requestId index
     適用後の旧 binary 経路を混在させない）。「0 件」を合格と読み替えない。
3. **queue 状態の確認**
   - 実行: dashboard「Search Projection source queue」widget で backlog と oldest message age を見る。
   - 合格条件: backlog 0 / oldest age 0。
   - 停止条件: 非 0 のまま収束しない場合は projection runbook の検出信号切り分けへ。
4. **OpenSearch mapping migration / rebuild / reconciliation**
   - 実行: [projection runbook](./search-projection-reconciliation-rebuild.md) に委譲する
     （`search-index:migrate` → `projection:rebuild` → `projection:reconcile`）。
   - 合格条件: reconciliation の差分 0（`metadata_mismatch` を含む）。
   - 停止条件: `contract_corruption` / `malformed_projection` が出た場合は activation を止める。
5. **Valkey ticket-type namespace の seed**
   - 実行: seed / reconcile は cutover workflow の choice に載せていない（書き込み primitive の
     起動面を増やさないため）。**`run-cutover-task.sh` の counter operation として手動実行する**。
     この経路を使うと、container 名一致の exit code 取得・evidence 検証・JSONL lineage・
     step summary が workflow 経由の operation と同じ規律で得られる。

     ```bash
     # step 1 で控えた承認済み API task definition ARN（`current` で解決させない）
     TASK_DEFINITION_ARN=$(aws ecs describe-services --cluster "$CLUSTER" \
       --services "$API_SERVICE" --query 'services[0].taskDefinition' --output text)
     echo "$TASK_DEFINITION_ARN"   # step 1 の承認値と一致することを目視で確認する

     AWS_REGION=ap-northeast-1 \
     CUTOVER_EVIDENCE_FILE="$(pwd)/cutover-evidence-${ENV}-seed-ticket-type.jsonl" \
       ./scripts/deployment/run-cutover-task.sh \
         "$CLUSTER" "$API_SERVICE" "$TASK_DEFINITION_ARN" seed-ticket-type
     echo "exit=$?"
     ```

     script が `--namespace ticket-type --mode seed` への変換、task 停止待ち、
     app container の exit code 取得、evidence 抽出までを行う。CLI を素で叩かない
     （task definition / network / container 名 / 停止待ち / exit code 取得 / task 固有ログの
     組み立てを毎回即興でやらない）。
   - 合格条件: exit 0。evidence JSON（`action: "inventory-counter-reconcile"`）の
     `initialized` 件数が DB の `ticket_type_inventory` 行数と一致し、
     `processed == initialized`、`synced == 0`、`skipped == 0`、`writerMode == "legacy"`。
   - 停止条件: exit 2（guard による refuse。`writer_mode` が `legacy` でないと ticket-type
     namespace は seed できない。evidence は `refused: true`）または exit 1。
6. **preflight**
   - 実行: workflow `ticket-type-cutover-<env>.yml` を `operation=preflight-activation`、
     `task_definition_arn` に step 1 の承認値を明示して dispatch する（`current` に解決させない）。
   - 合格条件: 全 category の `violationCount` が 0（exit 0）で、gate step が pass すること。
   - 停止条件: exit 2（violation ≥ 1）。violation を解消してから preflight をやり直す。
7. **禁止 workflow 空確認（switch 直前）**
   - 実行: step 0 と同じコマンドを再実行し、出力を証跡として残す。step 0 から step 6 までの
     間に queue された run が switch と交錯しないことを、切替直前にもう一度固定する。
   - 合格条件: 全 workflow で `pending` が **0**。加えて step 1 / 2 の positive 確認を再実行し、
     承認済み task definition ARN と image digest が変わっていないこと。
   - 停止条件: 1 件でも非 0、または task definition / digest が step 1 と異なる場合は
     activation しない（新しい preflight からやり直す）。
8. **activation**
   - 実行: 同 workflow を `operation=activate`、`task_definition_arn` に step 1 の承認値を
     明示して dispatch する。
   - 合格条件: 次の **3 条件すべて**（workflow の gate step が機械的に強制する）。
     1. switch の raw exit code が 0（切替成功）または 3（COMMIT 応答喪失だが再確認で
        `ticket_type` を確認 = 切替は有効）。
     2. `evidence_valid` が `true`（preflight evidence と切替結果が operation どおりに揃った。
        exit 3 で `commitOutcome` / `verifiedMode` を取り切れていない run はここで落ちる）。
     3. **同一 run 内の postflight step が success** で終わること。
   - 停止条件: exit 2 / 4 / 1、`evidence_valid` が `true` でない、run の cancel、
     postflight の skip / 失敗（6 章）。
9. **smoke**
   - 実行: `staging-smoke-test.yml` / `dev-smoke-test.yml` を dispatch。
   - 合格条件: smoke の全ケース成功（失敗 0）。
   - 停止条件: 1 件でも失敗したら rollback session（5 章）の判断へ入る。
   - 注意: smoke workflow は独立 concurrency group のため機械排他されない。**この step 以外で
     session 中に smoke を dispatch しない**。
10. **postflight の再実行**
    - 実行: 同 workflow を `operation=postflight-activation`、`task_definition_arn` に step 1 の
      承認値を明示して dispatch（smoke 後の状態を再検査する）。
    - 合格条件: 全 category violation 0（exit 0）で gate step が pass すること。
    - 停止条件: exit 2 の場合は「postflight 差分の収束手順」（下記）へ。
11. **証跡の永続化**
    - 実行: 各 run の evidence JSON（artifact `cutover-evidence-<env>-*` と step summary）、run URL、
      taskArn / taskDefinition / image digest、9 章の数値を #335 へ comment する。
    - **hash / provenance の確認**: artifact をダウンロードし、JSON Lines の各行が
      lineage（`operation` / `exitCode` / `taskArn` / `taskDefinition` / `image` / `imageDigest` /
      `operationStartedAtUtc` / `runUrl`）を持つことと、行数が実行した operation 数と一致することを
      確認したうえで、**SHA-256 を計算して #335 の comment に併記する**（後から差し替えられて
      いないことを示すため）。

      ```bash
      gh run download <run-id> --name "cutover-evidence-${ENV}-<operation>-<run-id>-<attempt>" --dir ./evidence
      jq -c '.lineage' ./evidence/cutover-evidence.jsonl
      wc -l ./evidence/cutover-evidence.jsonl
      sha256sum ./evidence/cutover-evidence.jsonl
      ```

    - 合格条件: **destroy 前に** remote（GitHub）へ永続化されていること。lineage 欠落行が 0、
      SHA-256 を記録済み。
    - 停止条件: 証跡を残せない、lineage が欠けている、行数が実行した operation 数と合わない
      場合、環境を destroy しない。

### postflight 差分の収束手順

postflight（`operation=postflight-activation` / `postflight-rollback`）が exit 2 になった場合、
workflow は自動で reconcile しない（ADR-0032 は reconcile の実行順序を runbook 所有と定めている）。

1. evidence の category 別 `violationCount` を確認し、差分が Valkey か OpenSearch かを切り分ける。
2. Valkey 差分: active 側 namespace に対して counter operation を実行する
   （`reconcile` は counter 不在を作らず、revision 不一致は skip する CAS 補正）。

   ```bash
   # active が ticket_type なら reconcile-ticket-type、legacy なら reconcile-legacy
   AWS_REGION=ap-northeast-1 \
   CUTOVER_EVIDENCE_FILE="$(pwd)/cutover-evidence-${ENV}-reconcile.jsonl" \
     ./scripts/deployment/run-cutover-task.sh \
       "$CLUSTER" "$API_SERVICE" "$TASK_DEFINITION_ARN" reconcile-ticket-type
   ```

   合格条件: exit 0 かつ evidence の `initialized == 0`、`processed == synced + skipped`。
3. OpenSearch 差分: projection runbook の rebuild / repair に従う
   （`search-index:migrate` / `projection:rebuild` / `projection:reconcile` は projection runbook が
   正本であり、本 runbook の counter operation には含めない）。
4. DB 差分（在庫・未紐付け）: **CLI では収束させない**。#376 の failure domain として調査する。
5. checker を再実行し、差分 0 を確認する。差分が残るなら次の操作へ進まない。

## 5. rollback session の実行順序

運用 rollback は「compatibility artifact のまま全体を `ticket_type -> legacy` へ戻す」ことである。
Valkey や OpenSearch だけを独立に戻さない（switch CLI は control row 1 行 UPDATE 以外に書けない
構造でこれを強制している）。schema down は本 runbook のスコープ外であり、安全条件は #376 の down
migration の `ASSERT_SAFE_DOWN` が正本。forward-fix 3 分割（#335 不可逆境界 1）と
`legacyRollbackEligible` / `schemaDownEligible` guard を混同しない。

### legacy namespace の再 seed が必須である根拠

rollback の preflight（`--expect-mode ticket_type --phase preflight`）は legacy Event counter を
**厳密に検査する**（不在も、DB との乖離（stale）も violation にする）。一方 `ticket_type` mode の
稼働中、購入 API は legacy Event counter を更新しない。したがって activation からの経過時間に比例して
legacy namespace は不在・stale になり、**再 seed なしでは rollback preflight を通過できない**。
seed CLI の guard（active 側 namespace への seed を exit 2 で refuse する）は、この
「`writer_mode = ticket_type` のときだけ legacy を seed してよい」という規則と一致している。

### 手順

0. **禁止 workflow 空確認 + compatibility runtime の positive 確認**
   - 実行: 4 章 step 0 / 1 / 2 と同じ確認を行い、承認済み task definition ARN を控える。
   - 合格条件・停止条件は 4 章 step 0 / 1 / 2 と同じ。
1. **legacy namespace の再 seed**
   - 実行: counter operation として手動実行する（4 章 step 5 と同じ経路）。

     ```bash
     AWS_REGION=ap-northeast-1 \
     CUTOVER_EVIDENCE_FILE="$(pwd)/cutover-evidence-${ENV}-seed-legacy.jsonl" \
       ./scripts/deployment/run-cutover-task.sh \
         "$CLUSTER" "$API_SERVICE" "$TASK_DEFINITION_ARN" seed-legacy
     ```

   - 合格条件: exit 0。evidence の `initialized` 件数が `ticket_inventory` 行数と一致し、
     `processed == initialized`、`synced == 0`、`skipped == 0`、`writerMode == "ticket_type"`。
   - 停止条件: exit 2（`writer_mode` が `ticket_type` でない = 前提が崩れている）または exit 1。
2. **preflight**
   - 実行: workflow を `operation=preflight-rollback`、`task_definition_arn` に承認値を明示して dispatch。
   - 合格条件: 全 category violation 0（exit 0）で gate step が pass すること。
   - 停止条件: exit 2 の場合、legacy counter の差分なら step 1 を再実行してから preflight をやり直す。
3. **禁止 workflow 空確認（switch 直前）**
   - 4 章 step 7 と同じ（`pending` 0 と、task definition / digest が step 0 から変わっていないこと）。
4. **rollback**
   - 実行: workflow を `operation=rollback`、`task_definition_arn` に承認値を明示して dispatch。
   - 合格条件: raw exit code 0 / 3 かつ `evidence_valid` が true かつ同一 run 内の
     postflight step が success（4 章 step 8 と同じ 3 条件）。
   - 停止条件: exit 2 / 4 / 1、`evidence_valid` が true でない、run の cancel、
     postflight の skip / 失敗。
5. **smoke**
   - 実行: `staging-smoke-test.yml` / `dev-smoke-test.yml`。合格条件は失敗 0。
6. **postflight の再実行**
   - 実行: workflow を `operation=postflight-rollback` で dispatch。合格条件は差分 0。
7. **証跡の永続化**
   - activation session の step 11 と同じ（hash / provenance の確認を含む）。
     rollback を実施した事実・理由・数値を #335 へ残す。

## 6. 停止条件

次のいずれかに該当したら、**その時点で全操作を止める**。次の操作へ進まない。

- preflight / postflight の violation が 1 件以上（checker exit 2）。
- 旧 revision の RUNNING task が 1 件以上。
- source queue の backlog または oldest message age が 0 でない。
- switch の exit 2（切替未開始。violation 解消後に preflight から再実行）。
- switch の exit 4（切替は未適用。新しい preflight から再実行できる）。
- switch の exit 1（実行エラー・結果不明を含む）。**`inventory_writer_control` を手動確認するまで
  次の操作へ進まない**。
- **cutover workflow run を手動 cancel した場合**。cancel 後は後続 step が実行されず「切替済み・
  postflight 証跡なし」の状態が残り得るため、exit 1 と同じ扱いにする（workflow の構造では
  cancel を防げない）。**cancel 後の control state は「1 回読んで終わり」にしない**（下記）。
- gate step が job を失敗させた場合（raw exit code が 0 / 3 以外、raw exit code が空、
  `evidence_valid` が true でない、postflight が success 以外）。
- reconciliation が `contract_corruption` または `malformed_projection` を示した場合
  （projection runbook を参照）。
- smoke が 1 件でも失敗した場合。

exit 3（COMMIT 応答喪失だが切替は有効）は停止条件ではないが、**同一 run 内の postflight 結果を
必ず確認する**。evidence の `commitOutcome=ambiguous` と `verifiedMode` を証跡に明記する。
gate step は `evidence_valid` も必須条件にしているため、`commitOutcome` / `verifiedMode` を
取り切れていない exit 3 の run は postflight が success でも job 失敗になる。

### run を cancel した場合の手順（control state を読む前に task の停止を確定させる）

cancel 直後に `inventory_writer_control` を 1 回読むだけでは足りない。ECS の停止処理は SIGTERM 後に
**既定 30 秒の猶予**を持つため、その間に元 task の COMMIT が確定し得る。読んだ値が最終状態である
保証がないまま次の操作へ進むと、切替済みの環境に対して再度切替 CLI を叩くことになる。

`run-cutover-task.sh` の EXIT trap も、`stop-task` 要求の後に bounded な
`aws ecs wait tasks-stopped`（既定 60 秒 / `CUTOVER_STOP_WAIT_SECONDS`）までしか行わない。
runner が既に落ちている状況で無期限に待たないための意図的な上限であり、**待ちきれなかった場合は
警告を出して終了する**。したがって cancel 後は必ず人が次を実施する。

1. **exact taskArn を特定する**（cancel した run のログに `taskArn=...` が出ている。
   出ていない場合は `--started-by` で引く）。

   ```bash
   aws ecs list-tasks --cluster "$CLUSTER" --started-by "cutover-<operation>" \
     --desired-status STOPPED --query 'taskArns' --output text
   aws ecs list-tasks --cluster "$CLUSTER" --started-by "cutover-<operation>" \
     --desired-status RUNNING --query 'taskArns' --output text
   ```

2. **task の停止を確定させるまで、他の一切の操作を行わない**（checker も switch も dispatch しない）。

   ```bash
   aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"
   aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" \
     --query "tasks[].{lastStatus:lastStatus,stoppedReason:stoppedReason,container:containers[?name=='${API_SERVICE}']|[0]}" \
     --output json
   ```

   `lastStatus` が `STOPPED` であること、**named application container（`ticket-c2c-<env>-api`）が
   停止していること**（`lastStatus: STOPPED` と `exitCode` の有無）を確認する。
   sidecar だけ停止して app container が残っている状態を「停止」と読まない。
3. 停止確定後に control state と、対応する postflight checker を実行して判定する。
   - `writer_mode` が **target**（activation なら `ticket_type`、rollback なら `legacy`）:
     切替済みとして扱い、`operation=postflight-<activation|rollback>` を dispatch して証跡を取る。
   - `writer_mode` が **source** のまま: 切替は未適用。**新しい preflight から**やり直す。
   - **task を一意に特定できない、または mode を一意に確認できない場合は session を FAIL とする**
     （推測で先へ進まない。#335 へ FAIL として記録し、次の判断を仰ぐ）。

## 7. Gate B session 中の禁止操作チェックリスト

session 開始前に確認し、session 中は次を実行しない。

- [ ] 同一環境の `terraform-apply-<env>` / `terraform-destroy-<env>` を起動しない。
      **これらは別の concurrency group（`terraform-<env>`）のため機械排他されない**
      （恒久解の受け皿は #419）。
- [ ] `db-migrate-<env>` を起動しない。
- [ ] `deploy-backend-<env>`（`run_migrations=true` を含む）を起動しない。同一 concurrency group
      （`backend-database-operation-<env>`）による直列化は「同時実行の防止」であって
      「順序の保証」ではない。
- [ ] smoke workflow を 4 章 step 9 / 5 章 step 5 以外で dispatch しない（smoke は独立 group）。
- [ ] PoC script 等、共有 writer barrier を取得しない直接 SQL writer を実行しない。
- [ ] seed（`seed-ticket-type` / `seed-legacy`）を active 側 namespace に対して実行しない
      （CLI が exit 2 で refuse するが、手順としても禁止する）。
- [ ] seed / reconcile CLI を `run-cutover-task.sh` を通さずに直接叩かない（exit code の取り違え・
      evidence 未取得・lineage 欠落を招く）。cutover workflow の choice にも載せない。
- [ ] cutover workflow を `task_definition_arn` 空欄（`current` 解決）で dispatch しない。
      session 開始時に確認した承認済み ARN を毎回明示する。
- [ ] `redis-cli` で counter / revision を直接編集しない。
- [ ] OpenSearch から PostgreSQL への逆同期を行わない。

## 8. rollback / forward-fix の境界

- **mode rollback**（本 runbook 5 章）: compatibility artifact を維持したまま control state を
  `legacy` へ戻す。可逆。
- **forward-fix**: compatibility 期間中に見つかった不整合は、原則 rollback ではなく forward-fix で
  収束させる（#335 不可逆境界 1 の 3 分割）。Valkey / OpenSearch の差分は再構築可能なので
  reconcile / rebuild で収束させ、mode を戻す判断とは分ける。
- **schema down**: 本 runbook のスコープ外。`ASSERT_SAFE_DOWN` が DDL 前に条件を検査して停止する。
  down 前の全列 parity を回復・再検査する version parity reconcile 経路は #378 のスコープ外であり、
  最終状態への到達は #384（fresh session final cleanup）が所有する（ADR-0033 決定 3 / 6）。

## 9. 必要な数値証跡

各 session で次を数値として残す（evidence JSON と run URL を添える）。

- checker の category 別 `violationCount`（activation / rollback それぞれの preflight と postflight。
  全 0 であること）と `writerMode` / `schemaRevision`、`categoryCount`（23）。
- switch の raw exit code、workflow の `evidence_valid`、`postSwitchDatabaseResults`
  （切替 transaction 内の parity 検査結果）、exit 3 の場合は `commitOutcome` と `verifiedMode`。
- 禁止 workflow の queued / in_progress / waiting 件数（session 開始時と switch 直前の 2 回。
  いずれも 0）。
- API / Worker の `desiredCount` / `runningCount` / `pendingCount`（`desired == running > 0`、
  `pending == 0`）と、承認済み task definition ARN / image digest に一致する RUNNING task 件数
  （= `runningCount`）、承認値以外の RUNNING task 件数（0）。
- source queue の backlog と oldest message age（いずれも 0）。
- seed の `processed` / `initialized` 件数（namespace 別）と、対応する DB 行数。
- reconcile を実行した場合は `synced` / `skipped` 件数。
- smoke の成功数 / 失敗数。
- 在庫超過が 0 であること。

## 10. 手動実行契機と有効期限

- 契機: compatibility release の rolling 完了後（activation）、および activation 後に停止条件へ
  該当した場合（rollback）。定期実行はしない。
- **一度の Gate B PASS を将来の整合性保証として扱わない**。環境を destroy / 再作成した場合、
  compatibility artifact を入れ替えた場合、schema revision が変わった場合は、preflight から
  やり直す。
