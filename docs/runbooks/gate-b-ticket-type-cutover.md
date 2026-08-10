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
| Valkey counter / revision | Aurora（前段フィルタなので再構築可能） | seed / reconcile CLI（`cutover:valkey`）と稼働中 writer のみ | `redis-cli` 手打ち禁止（counter と revision の対が壊れる） |
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

activation の前提として、**旧 task 0 件**（rolling 完了）を positive に確認する（4 章 step 2）。
これは #335 の不可逆境界 5 に対応する。

## 4. activation session の実行順序

各 step は「実行手段 / 合格条件 / 停止条件」を持つ。合格条件を満たさない限り次の step へ進まない。
`<env>` は `dev` / `staging`。

1. **compatibility release の確認**
   - 実行: API / Worker それぞれの ECS service が compatibility artifact（#376 / #389 / #377 を含む
     イメージ）の task definition で稼働していることを確認する。
   - 合格条件: 両 service の `taskDefinition` が対象 revision であること。
   - 停止条件: 片方でも旧 revision なら activation しない。
2. **旧 task 0 件の positive 確認**
   - 実行: `aws ecs list-tasks --cluster ticket-c2c-<env> --service-name <api|worker> --desired-status RUNNING`
     で列挙し、対象 revision 以外の task が **0 件（空配列）** であることを証跡として残す。
   - 合格条件: 旧 revision の RUNNING task が 0 件。
   - 停止条件: 1 件でも残っていれば rolling 完了まで待つ（統合 requestId index 適用後の旧 binary
     経路を混在させない）。
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
   - 実行: 既存 API artifact の command override（ECS run-task）で
     `node dist/src/cutover/reconcile-inventory-counters.js --namespace ticket-type --mode seed`。
   - 合格条件: 出力 JSON の `initialized` 件数が DB の `ticket_type_inventory` 行数と一致し、
     `processed == initialized`。exit 0。
   - 停止条件: exit 2（guard による refuse。writer mode が `legacy` でないと ticket-type namespace は
     seed できない）または exit 1。
6. **preflight**
   - 実行: workflow `ticket-type-cutover-<env>.yml` を `operation=preflight-activation` で dispatch。
   - 合格条件: 全 category の `violationCount` が 0（exit 0）。
   - 停止条件: exit 2（violation ≥ 1）。violation を解消してから preflight をやり直す。
7. **activation**
   - 実行: 同 workflow を `operation=activate` で dispatch。
   - 合格条件: switch の exit code が 0（切替成功）または 3（COMMIT 応答喪失だが再確認で
     `ticket_type` を確認 = 切替は有効）であり、**同一 run 内の postflight step が success** で
     終わること。workflow の gate step がこの 2 条件を機械的に強制する。
   - 停止条件: exit 2 / 4 / 1、run の cancel、postflight の skip / 失敗（6 章）。
8. **smoke**
   - 実行: `staging-smoke-test.yml` / `dev-smoke-test.yml` を dispatch。
   - 合格条件: smoke の全ケース成功（失敗 0）。
   - 停止条件: 1 件でも失敗したら rollback session（5 章）の判断へ入る。
   - 注意: smoke workflow は独立 concurrency group のため機械排他されない。**この step 以外で
     session 中に smoke を dispatch しない**。
9. **postflight の再実行**
   - 実行: 同 workflow を `operation=postflight-activation` で dispatch（smoke 後の状態を再検査する）。
   - 合格条件: 全 category violation 0（exit 0）。
   - 停止条件: exit 2 の場合は「postflight 差分の収束手順」（下記）へ。
10. **証跡の永続化**
    - 実行: 各 run の evidence JSON（artifact `cutover-evidence-<env>-*` と step summary）、run URL、
      taskArn / taskDefinition / image digest、9 章の数値を #335 へ comment する。
    - 合格条件: **destroy 前に** remote（GitHub）へ永続化されていること。
    - 停止条件: 証跡を残せない場合、環境を destroy しない。

### postflight 差分の収束手順

postflight（`operation=postflight-activation` / `postflight-rollback`）が exit 2 になった場合、
workflow は自動で reconcile しない（ADR-0032 は reconcile の実行順序を runbook 所有と定めている）。

1. evidence の category 別 `violationCount` を確認し、差分が Valkey か OpenSearch かを切り分ける。
2. Valkey 差分: `node dist/src/cutover/reconcile-inventory-counters.js --namespace <active側> --mode reconcile`
   を実行する（`reconcile` は counter 不在を作らず、revision 不一致は skip する CAS 補正）。
3. OpenSearch 差分: projection runbook の rebuild / repair に従う。
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

1. **legacy namespace の再 seed**
   - 実行: `node dist/src/cutover/reconcile-inventory-counters.js --namespace legacy --mode seed`。
   - 合格条件: `initialized` 件数が `ticket_inventory` 行数と一致し、exit 0。
   - 停止条件: exit 2（`writer_mode` が `ticket_type` でない = 前提が崩れている）または exit 1。
2. **preflight**
   - 実行: workflow を `operation=preflight-rollback` で dispatch。
   - 合格条件: 全 category violation 0（exit 0）。
   - 停止条件: exit 2 の場合、legacy counter の差分なら step 1 を再実行してから preflight をやり直す。
3. **rollback**
   - 実行: workflow を `operation=rollback` で dispatch。
   - 合格条件: exit 0 / 3 かつ同一 run 内の postflight step が success。
   - 停止条件: exit 2 / 4 / 1、run の cancel、postflight の skip / 失敗。
4. **smoke**
   - 実行: `staging-smoke-test.yml` / `dev-smoke-test.yml`。合格条件は失敗 0。
5. **postflight の再実行**
   - 実行: workflow を `operation=postflight-rollback` で dispatch。合格条件は差分 0。
6. **証跡の永続化**
   - activation session の step 10 と同じ。rollback を実施した事実・理由・数値を #335 へ残す。

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
  cancel を防げない）。
- gate step が job を失敗させた場合（exit code が 0 / 3 以外、exit code が空、postflight が
  success 以外）。
- reconciliation が `contract_corruption` または `malformed_projection` を示した場合
  （projection runbook を参照）。
- smoke が 1 件でも失敗した場合。

exit 3（COMMIT 応答喪失だが切替は有効）は停止条件ではないが、**同一 run 内の postflight 結果を
必ず確認する**。evidence の `commitOutcome=ambiguous` を証跡に明記する。

## 7. Gate B session 中の禁止操作チェックリスト

session 開始前に確認し、session 中は次を実行しない。

- [ ] 同一環境の `terraform-apply-<env>` / `terraform-destroy-<env>` を起動しない。
      **これらは別の concurrency group（`terraform-<env>`）のため機械排他されない**
      （恒久解の受け皿は #419）。
- [ ] `db-migrate-<env>` を起動しない。
- [ ] `deploy-backend-<env>`（`run_migrations=true` を含む）を起動しない。同一 concurrency group
      （`backend-database-operation-<env>`）による直列化は「同時実行の防止」であって
      「順序の保証」ではない。
- [ ] smoke workflow を 4 章 step 8 / 5 章 step 4 以外で dispatch しない（smoke は独立 group）。
- [ ] PoC script 等、共有 writer barrier を取得しない直接 SQL writer を実行しない。
- [ ] `--mode seed` を active 側 namespace に対して実行しない（CLI が exit 2 で refuse するが、
      手順としても禁止する）。
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
  全 0 であること）と `writerMode` / `schemaRevision`。
- switch の exit code と `postSwitchDatabaseResults`（切替 transaction 内の parity 検査結果）、
  exit 3 の場合は `commitOutcome` と `verifiedMode`。
- 旧 revision の RUNNING task 件数（0 であること）。
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
