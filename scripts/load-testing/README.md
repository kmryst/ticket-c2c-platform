# 負荷試験（k6）

購入 API に対するスパイク負荷試験のシナリオ置き場です。
[ADR-0004](../../docs/adr/0004-defer-sqs-fifo.md)（SQS FIFO 見送り）の「再検討のトリガー」を実測判定するために使います。
シナリオ設計は [技術検証計画](../../docs/poc/technical-validation-plan.md) フェーズ 3（スパイク PoC）に対応します。

## 前提

- [k6](https://k6.io/) v1.x
- `curl`
- 対象環境（dev）が稼働していること

## 手順

### 1. イベントを seed する

hot（人気イベント）1 件と background（分散負荷用）4 件を API 経由で作成します。

```bash
eval "$(./scripts/load-testing/seed-events.sh https://ticket-app-dev.ticket-c2c.click/api)"
```

hot の在庫は既定 6,000 枚です。HOT_RATE=200 req/s なら約 30 秒で売り切れ、
前半で「在庫あり期間の Aurora ホット行競合」、後半で「売り切れ後の Valkey 前段拒否」を観測できます。

### 2. warm-up（Aurora auto-pause 解除）

dev の Aurora は min ACU 0 の auto-pause 構成のため、計測前に軽負荷で cold start の影響を除きます。

```bash
MODE=warmup k6 run scripts/load-testing/purchase-spike.js
```

注意: warmup は hot イベントの在庫を少し消費します（10 req/s × 30s ≒ 300 枚）。
oversold 検証で confirmed 件数を突き合わせる際は warmup 分も合算してください。

### 3. baseline（分散負荷のみ）

```bash
MODE=baseline BG_RATE=20 DURATION=60s \
  k6 run --summary-export baseline-summary.json scripts/load-testing/purchase-spike.js
```

### 4. spike（集中負荷 + 分散負荷）

```bash
MODE=spike HOT_RATE=200 BG_RATE=20 DURATION=60s \
  k6 run --summary-export spike-summary.json scripts/load-testing/purchase-spike.js
```

## 測定・判定の観点

| 観点 | 見る場所 |
| --- | --- |
| background の p50 / p95 / p99（baseline と spike の比較） | k6 summary の `http_req_duration{traffic:background}` |
| hot の p50 / p95 / p99 | k6 summary の `http_req_duration{traffic:hot}` |
| エラー率 | `http_req_failed{traffic:*}`、`purchase_http_error` |
| Valkey 前段拒否の効き | `purchase_rejected_precheck` と `purchase_rejected_db` の比率 |
| oversold = 0 | 下記の在庫突き合わせ |
| Aurora のコネクション / ACU | CloudWatch `AWS/RDS` の `DatabaseConnections` / `ServerlessDatabaseCapacity` / `Deadlocks` |

### oversold（在庫超過）の検証

`GET /events` で最終在庫を確認し、次を満たすことを確認します。

- すべてのイベントで `remainingQuantity >= 0`
- イベントごとに `totalQuantity - remainingQuantity == purchase_confirmed の合計`（warmup 分を含む）

```bash
curl -s "${BASE_URL}/events" | python3 -m json.tool
```

### Aurora メトリクスの取得例

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name DatabaseConnections \
  --dimensions Name=DBClusterIdentifier,Value=ticket-c2c-dev-aurora \
  --start-time <試験開始UTC> --end-time <試験終了UTC> \
  --period 60 --statistics Maximum
```

## 判定結果の記録先

測定結果と FIFO 要否の判定は [ADR-0004](../../docs/adr/0004-defer-sqs-fifo.md) に記録します。
