# 負荷試験（k6）

購入 API に対するスパイク負荷試験のシナリオ置き場です。
[ADR-0004](../../docs/adr/0004-defer-sqs-fifo.md)（SQS FIFO 見送り）の「再検討のトリガー」を実測判定するために使います。
シナリオ設計は [技術検証計画](../../docs/poc/technical-validation-plan.md) フェーズ 3（スパイク PoC）に対応します。

## 前提

- [k6](https://k6.io/) v1.x
- `curl`
- 対象環境（dev または staging）が稼働していること

## 対象環境の違い

k6 スクリプト（`purchase-spike.js`）と seed スクリプトは `BASE_URL` で環境を切り替えられます。
環境ごとの構成差は次のとおりです。

| | dev | staging（normal） | staging（full） |
| --- | --- | --- | --- |
| `BASE_URL` | `https://ticket-app-dev.ticket-c2c.click/api` | `https://ticket-app-staging.ticket-c2c.click/api` | 同左 |
| ECS api/worker desired count | 1 | 1 | 2 |
| ECS autoscaling（ADR-0018） | なし | なし | あり（min 2 / max 4、CPU target 60%） |
| Aurora ACU（min–max） | 0–4（auto-pause あり） | 0–4（auto-pause あり） | 0.5–8（auto-pause なし） |
| warm-up（手順 2） | 必須 | 必須 | 不要（下記参照） |

- autoscaling の実測検証（production-readiness L-8 / capacity-planning シナリオ②）は **staging full でのみ可能**です。dev / staging normal には autoscaling policy 自体がありません（Issue #234）。
- staging を `capacity_profile=full` で構築するには、`terraform-apply-staging.yml` を workflow_dispatch で実行し、入力 `capacity_profile` に `full` を指定します（環境構築手順の正本は [staging-environment.md](../../docs/architecture/staging-environment.md)）。

```bash
gh workflow run terraform-apply-staging.yml -f capacity_profile=full
```

- staging（https-dns）の ALB は CloudFront 経由アクセスに限定されています（ADR-0013）。`BASE_URL` は必ず CloudFront 経由の `ticket-app-staging.ticket-c2c.click/api` を使います。CloudFront には WAF（マネージドルール、block モード）が関連付いているため、試験中は dashboard の `WAF BlockedRequests` widget で誤ブロックが発生していないことも確認します（rate-based rule はないため、レートだけで遮断されることはありません）。

## 手順

### 1. イベントを seed する

hot（人気イベント）1 件と background（分散負荷用）4 件を API 経由で作成します。

```bash
# dev
eval "$(./scripts/load-testing/seed-events.sh https://ticket-app-dev.ticket-c2c.click/api)"

# staging
eval "$(./scripts/load-testing/seed-events.sh https://ticket-app-staging.ticket-c2c.click/api)"
```

hot の在庫は既定 6,000 枚です。HOT_RATE=200 req/s なら約 30 秒で売り切れ、
前半で「在庫あり期間の Aurora ホット行競合」、後半で「売り切れ後の Valkey 前段拒否」を観測できます。

### 2. warm-up（Aurora auto-pause 解除。dev / staging normal のみ）

dev と staging normal の Aurora は min ACU 0 の auto-pause 構成のため、計測前に軽負荷で cold start の影響を除きます。

```bash
MODE=warmup k6 run scripts/load-testing/purchase-spike.js
```

注意: warmup は hot イベントの在庫を少し消費します（10 req/s × 30s ≒ 300 枚）。
oversold 検証で confirmed 件数を突き合わせる際は warmup 分も合算してください。

staging full は min ACU 0.5 で auto-pause しないため、auto-pause 解除目的の warmup は不要です。
ACU 0.5 からのスケールアップ挙動も含めて「spike が来たときの実態」なので、そのまま spike を当てて構いません
（ECS タスクが desired count どおり RUNNING で安定していることだけ、試験前に確認してください）。

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
| ECS CPU 使用率 | CloudWatch dashboard（`<name>-overview`）の `ECS CPUUtilization` widget、または下記 CLI |
| autoscaling 発火の有無（staging full） | 下記の scaling activities / `describe-services`（一次情報） |

CloudWatch dashboard の widget は period 300s（5 分集計）です。60 秒の試験では平滑化されて山が見えにくいため、
判定には period 60 の CLI（下記）か、CloudWatch コンソールで period を 1 分に変更したグラフを使ってください。

### oversold（在庫超過）の検証

`GET /events` で最終在庫を確認し、次を満たすことを確認します。

- すべてのイベントで `remainingQuantity >= 0`
- イベントごとに `totalQuantity - remainingQuantity == purchase_confirmed の合計`（warmup 分を含む）

```bash
curl -s "${BASE_URL}/events" | python3 -m json.tool
```

### Aurora メトリクスの取得例

`DBClusterIdentifier` は dev が `ticket-c2c-dev-aurora`、staging が `ticket-c2c-staging-aurora` です。

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/RDS \
  --metric-name DatabaseConnections \
  --dimensions Name=DBClusterIdentifier,Value=ticket-c2c-staging-aurora \
  --start-time <試験開始UTC> --end-time <試験終了UTC> \
  --period 60 --statistics Maximum
```

### ECS CPUUtilization の取得例

クラスタ名 / サービス名は `<name>` = `ticket-c2c-dev` / `ticket-c2c-staging` に対して `<name>`（クラスタ）と `<name>-api`（API サービス）です。

```bash
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS \
  --metric-name CPUUtilization \
  --dimensions Name=ClusterName,Value=ticket-c2c-staging Name=ServiceName,Value=ticket-c2c-staging-api \
  --start-time <試験開始UTC> --end-time <試験終了UTC> \
  --period 60 --statistics Average Maximum
```

### autoscaling 発火の確認例（staging full）

autoscaling が発火したかどうかの一次情報は Application Auto Scaling の scaling activities です
（CloudWatch メトリクスではなく、スケール判断とその理由が記録されます）。

```bash
aws application-autoscaling describe-scaling-activities \
  --service-namespace ecs \
  --resource-id service/ticket-c2c-staging/ticket-c2c-staging-api \
  --max-results 20
```

試験中・試験後のタスク数（desired / running）は次で確認できます
（Container Insights は無効のため、CloudWatch にタスク数メトリクスはありません）。

```bash
aws ecs describe-services \
  --cluster ticket-c2c-staging \
  --services ticket-c2c-staging-api \
  --query 'services[0].{desired:desiredCount,running:runningCount}'
```

注意: target tracking（CPU 60%）のスケールアウトには、policy が自動作成する CloudWatch アラームの評価
（AWS 既定: 60 秒 × 3 データポイントの連続超過。cooldown 等はカスタマイズしていないため既定値）が挟まるため、
60 秒の spike では発火しない（間に合わない）可能性があります。autoscaling の発火自体を検証したい場合は
`DURATION` を 5 分以上（例: `DURATION=300s`）に伸ばして在庫（`HOT_INVENTORY`）も比例して増やすことを検討してください。

## 判定結果の記録先

測定結果と FIFO 要否の判定は [ADR-0004](../../docs/adr/0004-defer-sqs-fifo.md) に記録します。
autoscaling / 接続プール枯渇の再検証（L-8 / capacity-planning シナリオ②）の結果は
[production-readiness.md](../../docs/architecture/production-readiness.md) と
[capacity-planning.md](../../docs/architecture/capacity-planning.md) の該当項目、および対応する ADR に記録します。
