# Runbook: 検索 projection の reconciliation / rebuild

対象: dev / staging の Search Projection（EventBridge → SQS → Worker → OpenSearch）。Issue #377 / ADR-0031。

在庫の正本は Aurora PostgreSQL。OpenSearch は再構築可能な projection である。本 runbook は、
projection の欠損・遅延・差分を検出し、Aurora から rebuild して収束させる手順を定める。
OpenSearch から PostgreSQL への逆同期は行わない。

## owner と停止条件

- owner: Search Projection failure domain（Issue #377）。Gate B の呼び出し順序・cross-store checker・
  evidence・activation・controlled rollback は #378 が所有する。
- 停止条件: 次のいずれかに該当したら、rebuild / activation を進めず調査する。
  - reconciliation が `contract corruption`（同一 version で値が異なる）を示す。
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
Event 集計の total / remaining / version 差分、malformed projection。

## rebuild / reindex（Aurora を正本に再構築）

Worker と同じ atomic version guard を共有するため、rebuild 中に届いた新しい event（version N+1）を
巻き戻さない。restart 可能・idempotent。index を全削除しない（mapping は additive）。

```bash
# rebuild 前後に reconciliation を実行して収束を確認する。
node dist/src/search/inventory-reconciliation.cli.js   # before
node dist/src/search/inventory-rebuild.cli.js --page-size 200 --bulk-size 200
node dist/src/search/inventory-reconciliation.cli.js   # after（差分 0 を確認）
```

bulk API が HTTP 200 でも item error が 1 件でもあれば rebuild は失敗する（exit 1）。失敗時は
原因を確認し、restart（再実行）する。

## mixed Worker 期間の制約

- 新 payload は旧 Worker が既存 field を処理し追加 field を無視できるが、旧 Worker は EventListed の
  全置換で versioned field を消し得る。
- したがって mixed Worker 期間（pre-version-guard Worker が 0 件でない）は、新 projection を
  active 扱いしない。
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
