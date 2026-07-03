# スパイク PoC（フェーズ 3）結果 — dev 環境 k6 負荷試験

## ステータス

実施済み（2026-07-03）。[技術検証計画](./technical-validation-plan.md) フェーズ 3（スパイク PoC）を AWS dev 環境に対して実施した記録。FIFO 要否の判定は [ADR-0004](../adr/0004-defer-sqs-fifo.md) に記録する。

## 目的

[ADR-0004](../adr/0004-defer-sqs-fifo.md) の「再検討のトリガー」を実測判定する。

1. 人気イベントへの集中負荷が、他イベントの購入レイテンシを許容範囲を超えて悪化させるか。
2. Aurora のロック待ち・コネクション枯渇が Valkey フィルタでは抑えられないか。

## 環境・条件

- 対象: dev 環境（`https://ticket-api-dev.hamilcar-hannibal.click`）。API 1 タスク（0.25 vCPU / 512MB）、pg pool max 10（接続待ちタイムアウト 5 秒）、Aurora Serverless v2 min 0 / max 2 ACU、Valkey cache.t4g.micro ×1。
- ツール: k6 v1.1.0（[scripts/load-testing/](../../scripts/load-testing/README.md)）。負荷元はローカル PC（東京リージョンへのインターネット経由）。
- 購入リクエストは `requestId` なし・quantity 1（Valkey 前段フィルタを通る本番ホットパス）。
- 計測前に warmup（10 req/s × 30 秒）で Aurora auto-pause の cold start を除去した。

## 実施した測定（すべて 2026-07-03、時刻は UTC）

| # | ケース | 負荷 | 期間 |
|---|---|---|---|
| 1 | baseline（分散のみ） | background 20 req/s を 4 イベントへ分散 | 12:15–12:19 に 60 秒 ×3 回 |
| 2 | spike（集中 + 分散） | hot 1 イベントへ 200 req/s + background 20 req/s | 12:20–12:21 |
| 3 | distributed（同一総量を分散） | 220 req/s を 4 イベントへ分散（hot なし） | 12:22–12:23 |
| 4 | sold-out spike | 売り切れ済み hot イベントへ 200 req/s + background 20 req/s | 12:24–12:25 |

## 結果

### レイテンシ・エラー率（http_req_duration、単位 ms）

| ケース | traffic | p50 | p95 | p99 | エラー率 | confirmed |
|---|---|---|---|---|---|---|
| baseline 1 回目 | background | 43 | 99 | —(p90=68) | 0% | 1,201 |
| baseline 2 回目 | background | 62 | 417 | 700 | 0% | 1,200 |
| baseline 3 回目 | background | 194 | 3,942 | 5,134 | 0% | 1,173 |
| spike | hot | 5,013 | 5,203 | 7,118 | **97.7%** | 158 |
| spike | background | 5,014 | 5,202 | 5,362 | **95.5%** | 51 |
| distributed | background | 4,337 | 5,492 | 5,932 | 19.6% | 2,336 |
| sold-out spike | hot | **10.7** | **36.8** | **177** | **0%** | 0（全 12,001 件が前段拒否） |
| sold-out spike | background | 3,947 | 5,825 | 10,895 | 21.2% | 898 |

補足:

- baseline が回を追うごとに悪化しているのは、Aurora が warmup 直後から max 2 ACU に張り付き（ACUUtilization 100%）、20 req/s ですら余力がなかったため。
- spike / distributed / sold-out の 5 秒付近に集中するレイテンシとエラーは、pg pool（max 10）の接続待ちタイムアウト（5 秒）による HTTP 500（`timeout exceeded when trying to connect`、CloudWatch Logs で確認）。

### スループット比較（集中 vs 分散、総量 220 req/s）

| ケース | confirmed スループット | エラー率 |
|---|---|---|
| spike（200 req/s を同一イベントへ集中） | 約 3.5 件/s（60 秒で 209 件） | 96–98% |
| distributed（220 req/s を 4 イベントへ分散） | 約 39 件/s（60 秒で 2,336 件） | 19.6% |

同一総量でも、集中時は分散時の約 1/11 のスループットに崩壊した。同一在庫行の行ロック直列化でトランザクション時間が伸び、共有 pg pool（10 本）が hot リクエストに占有されて background も巻き添えで枯渇した（head-of-line blocking）。

### Aurora 側メトリクス（CloudWatch）

- `ServerlessDatabaseCapacity`: warmup 開始 1 分で 2.0 ACU（上限）へ到達し、全測定を通して張り付き。
- `ACUUtilization`: 12:14–12:23 の全期間で 100%。
- `Deadlocks`: 0。
- 12:24 頃から約 7 分間、インスタンスがメトリクス発行を停止し、負荷停止後も 12:32 頃まで新規 DB 接続を受け付けなかった（`readyz` 503）。過負荷からの回復に負荷停止後 約 6 分を要した。
- RDS Performance Insights は dev では未有効のため、ロック待ちの内訳は取得していない（Deadlocks 0 と、分散時にスループットが 11 倍出る事実から、行ロック待ちが支配的と推定）。

### oversold（在庫超過）検証

**oversold = 0**。全 6 イベントで `remainingQuantity >= 0` を確認し、k6 の confirmed 件数と DB の販売数が完全一致した。

| イベント | 初期在庫 | 最終残在庫 | 販売数 | k6 confirmed 合計 |
|---|---|---|---|---|
| hot | 6,000 | 5,541 | 459 | 459（warmup 301 + spike 158） |
| background ×4 | 100,000 ×4 | 計 393,141 | 計 6,859 | 6,859（全 run 合計） |
| hot2（sold-out 用） | 10 | 0 | 10 | 10（手動購入。spike 中の confirmed 0） |

### Valkey 前段フィルタの効果

売り切れ後の hot イベントへの 12,001 リクエストは **全件が Valkey 前段で拒否され、1 件も Aurora に到達しなかった**（`purchase_rejected_db` = 0、p50 10.7ms、エラー 0）。売り切れ後の保護は完全に機能する。一方、**在庫がある期間の集中負荷には前段フィルタは作用しない**（設計どおり素通しして DB に到達させる）。

## 結論

- 在庫超過防止（正確性）は集中負荷下でも維持された（oversold 0）。
- 売り切れ後の DB 保護は Valkey で完全に機能した。
- 在庫あり期間の集中負荷では、dev 最小構成において ADR-0004 の再検討トリガー相当の劣化（background の p50 60ms → 5 秒、エラー率 95%）が観測された。ただし支配的なボトルネックは「行ロック直列化 + 共有コネクションプールの head-of-line blocking + Aurora 2 ACU 上限」の複合であり、FIFO 導入の要否判断は本番相当サイジング（staging-full）での再測定が必要。判定の詳細は [ADR-0004](../adr/0004-defer-sqs-fifo.md) の追記を正本とする。

## 再現手順

[scripts/load-testing/README.md](../../scripts/load-testing/README.md) を参照。
