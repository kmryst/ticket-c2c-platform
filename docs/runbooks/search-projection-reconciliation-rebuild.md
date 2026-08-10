# Runbook: 検索 projection の reconciliation / rebuild

対象: dev / staging の Search Projection（EventBridge → SQS → Worker → OpenSearch）。Issue #377 / ADR-0031。

在庫の正本は Aurora PostgreSQL。OpenSearch は再構築可能な projection である。本 runbook は、
projection の欠損・遅延・差分を検出し、Aurora から rebuild して収束させる手順を定める。
OpenSearch から PostgreSQL への逆同期は行わない。

## owner と停止条件

- owner: Search Projection failure domain（Issue #377）。Gate B の呼び出し順序・cross-store checker・
  evidence・activation・controlled rollback は #378 が所有する。
- 停止条件: 次のいずれかに該当したら、rebuild / activation を進めず調査する。
  - reconciliation が `contract_corruption`（projection の version が正本と一致しているのに
    total / remaining / name が異なる）または `malformed_projection` を示す。
  - mixed Worker 期間（pre-version-guard Worker が 0 件でない）。
  - PostgreSQL 正本自体の不整合が疑われる（#376 の failure domain。この runbook では扱わない）。

## 検出信号（それぞれ別軸として区別する）

| 信号 | 何を示すか | 確認先 |
| --- | --- | --- |
| API publish failure | InventoryChanged が発行されていない | `DomainEventPublish`（Outcome=sdk_error / partial_failure） |
| source queue backlog / oldest age | 配信は届くが Worker が追いつかない | dashboard「Search Projection source queue」widget |
| Worker processing lag | 正常系での消費遅延 | `WorkerProcessingLagMs`（p90） |
| Worker outcome | applied / stale / legacy_ignore / error の内訳 | `ProjectionOutcome`（Operation / Outcome dimension） |
| DLQ 滞留 | Worker 処理失敗（malformed / OpenSearch error） | dashboard「SQS DLQ」widget、`alarm-sqs-dlq.md` |
| reconciliation 差分 | 正本と projection の乖離 | reconciliation CLI の JSON 出力 |

「未送信（publish failure）」「配信停滞（backlog / lag / DLQ）」「projection 差分（reconciliation）」を
それぞれ独立に確認し、原因を切り分ける。

## reconciliation（read-only 差分確認）

PostgreSQL も OpenSearch も変更しない。cross-store snapshot は原子的ではないため、Gate B では
**queue drain 後**（source queue backlog と oldest age が 0 に落ち着いた後）に実行し、必要なら
再実行する。

AWS 環境（dev / staging）では、OpenSearch は VPC 内にあり SigV4 署名が必須なので、operator 端末から
`node dist/src/search/...` を直接実行できない。**`scripts/deployment/run-cutover-task.sh` の
projection operation として、既存 API artifact の task definition を command override で流用して
ECS run-task から実行する**（下記「AWS 環境での実行手段」）。

```bash
# ローカル / コンテナ内での素の実行形（AWS 環境では下記 helper を使う）。
# exit code: 0 = 差分 0、2 = 差分あり、1 = 実行エラー。
node dist/src/search/inventory-reconciliation.cli.js --page-size 200
```

### AWS 環境での実行手段（ECS run-task helper）

`run-cutover-task.sh` は task definition / network configuration / command override / container 名
一致の exit code 取得 / task 固有ログの取得 / evidence 検証 / JSONL lineage / step summary を
まとめて行う。cutover workflow の choice には載せない（書き込み primitive の起動面を増やさない）。
**手順から手動実行する専用経路**である。

| operation | 実行する CLI | exit code |
| --- | --- | --- |
| `search-index-migrate` | `search-index:migrate` | 0 = 成功 / 1 = 実行エラー |
| `projection-rebuild` | `projection:rebuild --page-size 200 --bulk-size 200` | 0 = 成功 / 1 = 実行エラー |
| `projection-reconcile` | `projection:reconcile --page-size 200` | 0 = 差分 0 / 2 = 差分あり / 1 = 実行エラー |

```bash
ENV=dev                     # または staging
CLUSTER="ticket-c2c-${ENV}"
API_SERVICE="ticket-c2c-${ENV}-api"

# 承認済み API task definition ARN を明示する（`current` に解決させない）。
TASK_DEFINITION_ARN=$(aws ecs describe-services --cluster "$CLUSTER" \
  --services "$API_SERVICE" --query 'services[0].taskDefinition' --output text)

AWS_REGION=ap-northeast-1 \
CUTOVER_EVIDENCE_FILE="$(pwd)/projection-evidence-${ENV}.jsonl" \
  ./scripts/deployment/run-cutover-task.sh \
    "$CLUSTER" "$API_SERVICE" "$TASK_DEFINITION_ARN" projection-reconcile
echo "exit=$?"
```

script は exit code をそのまま返す（0 / 2 / 1 を潰さない）が、**exit 0 でも operation に対応する
evidence JSON が揃っていなければ exit 1 で失敗させる**（false-green 禁止）。
`CUTOVER_EVIDENCE_FILE` に JSON Lines で lineage（`operation` / `exitCode` / `taskArn` /
`taskDefinition` / `image` / `imageDigest` / `operationStartedAtUtc` / `clientToken` /
`startedBy` / `executionContext`、ローカル実行では `operator` / `operatorHost`）と CLI 出力が
追記される。ローカル実行の証跡の保存先は
[Gate B runbook の「ローカル実行の証跡（provenance）」](./gate-b-ticket-type-cutover.md#ローカル実行の証跡provenance)
に従う。

`projection-repair` CLI は対象 ID の手打ちと `--apply` の明示が本質なので、この helper の
operation allowlist には**載せない**（後述の手順どおり command override で個別に実行する）。

出力は machine-readable JSON（`counts` に category 別件数、`findings` に bounded なサンプル、
`hasDiff`）。secret は含めない。差分 category は missing / unexpected document、Ticket Type /
Event 集計の total / remaining / version 差分、`metadata_mismatch`、`contract_corruption`、
`unversioned_projection`、`malformed_projection`。

category ごとに意味と対応が異なるため区別して扱う。

- `unversioned_projection`: EventListed だけが反映された購入前の正常な legacy/metadata document
  （versioned inventory field が未作成）。compatibility 期間中は発生し得る。rebuild で収束させる。
- `metadata_mismatch`: events table（正本）の title / event_type / starts_at / location と
  projection の対応 field の不一致（欠損を含む）。これらの metadata は Aurora に authoritative に
  保存されており、rebuild が在庫と併せて復元するため、rebuild で収束させる。
- `contract_corruption`: projection の version が正本の version と一致しているのに
  total / remaining / name が異なる状態。単に projection の version が遅れているための値差分
  （cross-store snapshot が非原子的なための許容される一時的なズレ。version mismatch 系
  category で記録される）とは別物で、書き込みパスの version guard script が本来防ぐべき
  真の破損シグナル。rebuild / activation を止めて調査する。**rebuild では収束しない**:
  正本の version は rebuild で変わらないため、Worker と共有する version guard script が
  同一 version・値相違を throw し、rebuild 自体が毎回 bulk item error で失敗する（fail closed）。
  原因を特定・修正したうえで、後述の projection-repair CLI（`repair-corruption` mode）で
  正本値へ修復してから rebuild / reconciliation を再開する。
- `malformed_projection`: versioned field の部分欠損・不正な ticket_types 要素・範囲外の値
  （負数、quantity の int4 超過など）・event_id だけで legacy document としても成立しないもの。
  rebuild / activation を止めて調査する。
- `unexpected_event_document` / `unexpected_ticket_type`: OpenSearch 側にあって正本
  （ticket_inventory）に無い event document / その event の正本 Type 集合
  （ticket_types / ticket_type_inventory の `(event_id, ticket_type_id)`）に属さない
  ticket type。別 event に正当に存在する Type が誤混入した場合も per-event の帰属で
  unexpected と判定される。rebuild は正本からの
  upsert のみで削除・隔離経路を持たないため、**rebuild では自動収束しない**。また
  reconciliation の unexpected 検出は REPEATABLE READ READ ONLY スナップショット内で動くため、
  スナップショット確立後に新規作成された event の projection は構造的に必ず unexpected と
  誤判定される（ページング中に限った一時的な話ではない）。後述の手動手順で対応する。

Worker outcome（`ProjectionOutcome`）では、version guard による no-op（lower stale および
equal かつ同値 duplicate）は `Outcome=stale`、少なくとも一方を更新した場合は `applied`、
versioned state 作成後に version なし legacy を無視した場合は `legacy_ignore`、処理失敗は `error`。
同一 version で値が異なる contract corruption は stale ではなく error として表面化する。

## rebuild / reindex（Aurora を正本に再構築）

Worker と同じ atomic version guard を共有するため、rebuild 中に届いた新しい event（version N+1）を
巻き戻さない。restart 可能・idempotent。index を全削除しない（mapping は additive）。

Aurora は在庫（versioned Ticket Type / Event 集計）だけでなく event metadata
（title / event_type / starts_at / location）の正本でもあるため、rebuild は metadata も
Aurora から復元する。rebuild 後の reconciliation では、在庫差分に加えて `metadata_mismatch`
（metadata の欠損・不一致）が 0 であることも確認する。

rebuild で収束する category は `unversioned_projection` / `metadata_mismatch` と、missing /
version 遅延系の差分である。次の category は rebuild では収束しない。

- `contract_corruption`: 正本の version は rebuild で変わらないため、version guard script が
  同一 version・値相違を throw し、**rebuild は毎回失敗する**。projection-repair CLI
  （`repair-corruption` mode。次節）で修復してから rebuild する。
- `malformed_projection`: 壊れ方に依存する（versioned field の部分欠損や同一 version・値相違を
  含む場合、rebuild は guard script / script エラーで失敗し得る）。調査のうえ個別に判断する。
- `unexpected_event_document` / `unexpected_ticket_type`: rebuild は削除・隔離経路を持たない
  ため自動収束しない。projection-repair CLI（次節）で対応する。

```bash
# AWS 環境（dev / staging）: ECS run-task helper 経由で実行する。
# rebuild 前後に reconciliation を実行して収束を確認する。
for op in projection-reconcile projection-rebuild projection-reconcile; do
  AWS_REGION=ap-northeast-1 \
  CUTOVER_EVIDENCE_FILE="$(pwd)/projection-evidence-${ENV}.jsonl" \
    ./scripts/deployment/run-cutover-task.sh \
      "$CLUSTER" "$API_SERVICE" "$TASK_DEFINITION_ARN" "$op"
  echo "${op} exit=$?"
done
# 期待値: before は 0 / 2 のどちらでもよい。rebuild は 0。after は **0（差分 0）**。
```

```bash
# ローカル / コンテナ内での素の実行形（参考）。
node dist/src/search/inventory-reconciliation.cli.js   # before
node dist/src/search/inventory-rebuild.cli.js --page-size 200 --bulk-size 200
node dist/src/search/inventory-reconciliation.cli.js   # after（metadata_mismatch を含め差分 0 を確認）
```

bulk API が HTTP 200 でも item error が 1 件でもあれば rebuild は失敗する（exit 1）。失敗時は
原因を確認し、restart（再実行）する。

## projection-repair CLI による手動修復（rebuild で収束しない差分）

`unexpected_event_document` / `unexpected_ticket_type` / `contract_corruption` は rebuild では
収束しない（前節）。自動修復は実装しない（reconciliation のスナップショット確立後に新規作成
された event の projection は構造的に必ず unexpected と誤判定されるため、query 駆動の自動削除は
正当な新規 event を消し得る。corruption の自動上書きは version guard の改ざん防止保証を
形骸化させる）。operator が projection-repair CLI で対応する。

CLI の安全制約（実装で強制される）:

- 完全一致 UUID 指定必須（`--event-id`、Type 除去は `--ticket-type-id` も）。query 駆動の
  一括操作（delete_by_query 等）は存在しない。
- **dry-run 既定**。`--apply` を明示しない限り OpenSearch へ書き込まない。
- 書き込み前に必ず PostgreSQL（正本）の該当 event_id / ticket_type_id の現在値を再確認し、
  前提が崩れていれば refuse する（exit 2。何も書かない）。orphan document 削除は event が
  正本に 1 行でも存在すれば拒否する。orphan ticket type 除去は「対象 event への帰属」
  （ticket_types / ticket_type_inventory の `(event_id, ticket_type_id)` 複合）で判定し、
  対象 event に属していれば拒否する（reconciliation の unexpected_ticket_type と同じ
  per-event 基準。別 event に正当に存在するだけでは拒否しない。ticket_type_id 単体の
  グローバル存在確認にすると、誤混入した Type を検出できても除去できず収束しない）。
  corruption 修復は「同一 version・値相違」が現存しなければ拒否する。
- corruption 修復は version guard を経由しない専用 script で行うが、script 内でも
  「stored version == 正本 version かつ値相違」を atomic に再判定し、より新しい version を
  決して巻き戻さない。version guard script 自体（通常書き込み経路の保証）は変更しない。
- staging / dev の OpenSearch は VPC 内・IAM principal・SigV4 署名必須のため、reconciliation /
  rebuild と同じく **既存 API artifact の command override（ECS run-task）から実行する**
  （SigV4 署名は接続 helper が担う。手元からの無署名 curl は実行できない）。

手順:

1. reconciliation は read-only のまま維持する（この手順の中で reconciliation 自体に削除を
   させない）。
2. queue drain 後（source queue backlog / oldest age が 0 に落ち着いた後）、**時間を空けて
   2 回以上** reconciliation を実行し、同じ event_id / ticket_type_id が恒常的に差分として
   残ることを確認する（snapshot タイミングによる誤検知を除外するため）。
3. 正本（events / ticket_inventory、ticket type なら ticket_types）へ直接クエリし、状態を人手で
   確認する（orphan なら「存在しないこと」、corruption なら「正本の現在値」）。CLI も書き込み
   直前に同じ再確認を行うが、operator の事前確認を省略しない。

   ```sql
   SELECT 1 FROM ticket_inventory WHERE event_id = '<event_id>';
   SELECT 1 FROM events WHERE id = '<event_id>';
   -- ticket type は「対象 event への帰属」で確認する（別 event に正当に存在する Type の
   -- 誤混入は、ID 単体のグローバル存在確認では orphan と判別できない）。
   SELECT 1 FROM ticket_types WHERE event_id = '<event_id>' AND id = '<ticket_type_id>';
   SELECT 1 FROM ticket_type_inventory
    WHERE event_id = '<event_id>' AND ticket_type_id = '<ticket_type_id>';
   ```

4. dry-run で対象と内容を確認してから、`--apply` で実行する。

   ```bash
   # orphan document の個別削除（正本に無い event の document）。
   node dist/src/search/projection-repair.cli.js --mode delete-document --event-id <event_id>
   node dist/src/search/projection-repair.cli.js --mode delete-document --event-id <event_id> --apply

   # orphan ticket type の個別除去（document は正当で特定 Type だけが余剰）。
   node dist/src/search/projection-repair.cli.js --mode delete-ticket-type \
     --event-id <event_id> --ticket-type-id <ticket_type_id> --apply

   # contract corruption の修復。dry-run が field 単位の事前 diff（projection 値 / 正本値）を
   # 出力するため、必ず diff を確認してから --apply する。
   node dist/src/search/projection-repair.cli.js --mode repair-corruption --event-id <event_id>
   node dist/src/search/projection-repair.cli.js --mode repair-corruption --event-id <event_id> --apply
   ```

   exit code: 0 = 成功（dry-run レポート / apply 完了）、2 = refuse（安全チェックで拒否。
   出力 JSON の `refusals` を確認する）、1 = 実行エラー。apply 時でも、書き込み直前の
   並行書き込みにより修復 script が no-op になった場合（対象要素が既に無い・version が
   進んだ等）は出力 JSON の `applied` が false になる。その場合は reconciliation を再実行
   して現状を確認してから判断する。

5. reconciliation を再実行し、該当差分が解消（差分 0）したことを確認する。contract corruption を
   修復した場合は、根本原因（何が guard を迂回して書いたか）の調査結果を残してから activation を
   再開する。修復は症状の除去であり、原因の除去ではない。

## mapping migration（deploy 時 1 回の独立ステップ）

OpenSearch events index の mapping 作成・additive 更新（`ensureEventsIndex`）は、Worker の
起動処理から分離した独立の migration ステップとして実行する（PostgreSQL の DDL を起動時ではなく
`db-migrate-<env>.yml` / `migration:run:local` で扱うのと同じパターン）。Worker の起動処理は
index の存在確認だけを行い、mapping 更新 API を呼ばない（OpenSearch の一時不調が Worker 起動
全体を失敗させる障害モードを持ち込まないため）。

```bash
# mapping を含む変更のリリースでは、新 Worker 起動前に 1 回だけ実行する。
# 未存在なら完全 mapping で index を作成し、存在すれば idempotent な additive putMapping を適用する。
node dist/src/search/search-index-migrate.cli.js
# ローカル: npm run search-index:migrate:local
```

AWS 環境では、`run-cutover-task.sh` の `search-index-migrate` operation で実行する。

```bash
AWS_REGION=ap-northeast-1 \
CUTOVER_EVIDENCE_FILE="$(pwd)/projection-evidence-${ENV}.jsonl" \
  ./scripts/deployment/run-cutover-task.sh \
    "$CLUSTER" "$API_SERVICE" "$TASK_DEFINITION_ARN" search-index-migrate
```

deploy pipeline（`deploy-backend-<env>.yml` 相当）への自動組み込みは別 Issue で扱う。

### 「新 Worker 起動前に 1 回」が守れなかった場合に起きること（順序が本質である理由）

`assertEventsIndexExists`（`src/search/events-projection.store.ts`）は **index の存在しか確認せず、
mapping を適用しない**。したがって index が既に存在していれば、mapping migration を飛ばしても
新 Worker は正常に起動する。その状態で Worker が `ticket_types` を書くと、OpenSearch の
dynamic mapping が `ticket_types` を **`object`** として作成する。

OpenSearch は既存 field の型を変更できないため、以後の additive putMapping は
`illegal_argument_exception`（`mapper [ticket_types] cannot be changed from type [object] to
[nested]`）で **恒久的に失敗する**。復旧には index の作り直し（再 rebuild）が必要になる。

この非対称性から、次の 2 つが導かれる。

- **適用点は「新 Worker 起動前」だけ**である。Worker が動き始めた後に migrate を実行しても、
  壊れた mapping は直らない。
- **`search-index-migrate` の exit 0 は「`ticket_types` が `nested` である」ことの positive
  確認になる**。`object` に化けていれば putMapping が拒否され exit 1 になるため、
  「実行して exit 0 だった」ことが型の positive 証拠として使える（`aws opensearch` API は
  index の mapping を返さないので、この確認には使えない）。

Gate B での呼び出し順序は
[Gate B Ticket Type cutover runbook](./gate-b-ticket-type-cutover.md) の 4 章が正本。

## mixed Worker 期間の制約

- 新 payload は旧 Worker が既存 field を処理し追加 field を無視できるが、旧 Worker は EventListed の
  全置換で versioned field を消し得る。
- したがって mixed Worker 期間（pre-version-guard Worker が 0 件でない）は、新 projection を
  active 扱いしない。
- Worker rolling deployment 中は、旧 Worker（version guard なし）が新 Worker の適用済み残数を
  一時的に上書きし得るため、検索結果の表示残数に一時的なブレが生じ得る。PostgreSQL が正本で
  ある以上、在庫超過や二重販売には直結せず、次の InventoryChanged で自己修復する結果整合の
  範囲の事象である。Gate B の reconciliation / rebuild は、全 Worker の入れ替えが完了してから
  実行する。
- old Worker が 0 件であることを確認してから rebuild / reconciliation する。
- versioned state 作成後、pre-version-guard Worker だけへ独立 rollback しない。

## 手動実行契機（M-12 / L-30 まで）

恒久運用方式（定期実行頻度・alarm・EventBridge target delivery 用 DLQ・transactional outbox）が
確定するまでは、次を手動実行契機とする。

- 各検証 session の開始・終了時。
- 後続 Gate の preflight。

一度の Gate B PASS を将来の projection 整合性保証として扱わない。

## rollback

ADR-0031 の rollback 方針に統一する。

> Aurora PostgreSQL を正本として、互換 artifact へ戻すか修正版 Worker を展開し、version guard 付き
> rebuild で OpenSearch を再収束させる。OpenSearch から PostgreSQL へ逆同期しない。

- mapping は additive なので rollback 時に field や index を削除しない。
- 在庫 read/write 全体の activation / rollback は #378 が所有する。手順の正本は
  [Gate B Ticket Type cutover runbook](./gate-b-ticket-type-cutover.md)。呼び出し関係は次のとおり:
  **mapping migration は Gate B session の前段（compatibility release 手順。4 章冒頭）**で
  新 Worker 起動前に 1 回実行し、**rebuild / reconciliation は Gate B session の 4 章 step 4**
  （旧 Worker 0 件・queue drain 後）から呼ばれる。session 中の `search-index-migrate` は
  mapping の適用ではなく `ticket_types` が `nested` であることの positive 確認として実行する。fresh session の final cleanup における writer mode 切替の所有は final cleanup transaction へ移管する（[ADR-0033](../adr/0033-ticket-type-migration-irreversible-boundaries.md)）。
