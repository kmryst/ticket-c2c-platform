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

```bash
# 既存 API artifact の command override で実行する（DB / OpenSearch 双方へ接続できる）。
# exit code: 0 = 差分 0、2 = 差分あり、1 = 実行エラー。
node dist/src/search/inventory-reconciliation.cli.js --page-size 200
```

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
  真の破損シグナル。rebuild / activation を止めて調査する。
- `malformed_projection`: versioned field の部分欠損・不正な ticket_types 要素・範囲外の値
  （負数、quantity の int4 超過など）・event_id だけで legacy document としても成立しないもの。
  rebuild / activation を止めて調査する。
- `unexpected_event_document` / `unexpected_ticket_type`: OpenSearch 側にあって正本
  （ticket_inventory / ticket_types）に無い document / ticket type。rebuild は正本からの
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

rebuild で収束する category は `unversioned_projection` / `metadata_mismatch` /
`contract_corruption`（原因を修正済みなら）/ `malformed_projection` と、missing / version
遅延系の差分である。`unexpected_event_document` / `unexpected_ticket_type` は rebuild では
自動収束しないため、次節の手動手順で対応する。

```bash
# rebuild 前後に reconciliation を実行して収束を確認する。
node dist/src/search/inventory-reconciliation.cli.js   # before
node dist/src/search/inventory-rebuild.cli.js --page-size 200 --bulk-size 200
node dist/src/search/inventory-reconciliation.cli.js   # after（metadata_mismatch を含め差分 0 を確認）
```

bulk API が HTTP 200 でも item error が 1 件でもあれば rebuild は失敗する（exit 1）。失敗時は
原因を確認し、restart（再実行）する。

## unexpected（orphan）document の手動対応

`unexpected_event_document` / `unexpected_ticket_type` は「OpenSearch 側にあって正本に無い」
差分であり、正本からの upsert しか行わない rebuild では収束しない。自動削除は実装しない
（reconciliation のスナップショット確立後に新規作成された event の projection は構造的に必ず
unexpected と誤判定されるため、query 駆動の自動削除は正当な新規 event を消し得る）。
operator が次の手順で対応する。

1. reconciliation は read-only のまま維持する（この手順の中で reconciliation 自体に削除を
   させない）。
2. queue drain 後（source queue backlog / oldest age が 0 に落ち着いた後）、**時間を空けて
   2 回以上** reconciliation を実行し、同じ event_id / ticket_type_id が恒常的に unexpected で
   あることを確認する（snapshot タイミングによる誤検知を除外するため）。
3. 正本（events / ticket_inventory テーブル、ticket type なら ticket_types）へ直接クエリし、
   該当 event_id / ticket_type_id が本当に存在しないことを人手で確認する。

   ```sql
   SELECT 1 FROM ticket_inventory WHERE event_id = '<event_id>';
   SELECT 1 FROM events WHERE id = '<event_id>';
   ```

4. operator が **event_id 明示指定**で該当 document を個別削除する。query 駆動の一括削除
   （delete_by_query 等）は行わない。

   ```bash
   # 手動の個別削除で十分（対象は手順 2-3 で確定した event_id のみ）。
   curl -X DELETE "<opensearch-endpoint>/<index>/_doc/<event_id>"
   ```

   `unexpected_ticket_type`（document は正当で特定 Type だけが余剰）の場合は document 削除では
   なく、rebuild 済みであることを確認のうえ該当 Type 要素の扱いを個別に判断する（自動化する
   としても `--event-id` 必須・dry-run 前提の CLI に限定する。現時点では未実装の提案に留める）。

5. reconciliation を再実行し、該当 unexpected が解消したことを確認する。

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

AWS 環境では既存 API artifact の command override（ECS run-task）から実行できる。deploy
pipeline（`deploy-backend-<env>.yml` 相当）への自動組み込みは別 Issue で扱う。

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
- 在庫 read/write 全体の activation / rollback は #378 が所有する。
