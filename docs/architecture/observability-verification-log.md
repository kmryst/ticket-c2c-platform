# 可観測性 実地検証ログ

[observability.md](observability.md) から切り出した実地検証の記録（発火手順・実測値・タイムスタンプ）です。監視構成・設計判断・運用上の注意の正本は [observability.md](observability.md) 側にあります。

## 購入 API SLO burn-rate 実地検証（2026-07-09〜10）

対象: 購入 API の SLO 閾値アラーム 6 本（ADR-0017 / Issue #227、`terraform/modules/observability`）。見出しとアラーム名の `burn-rate` は既存の物理名に合わせた表記であり、実際の評価方式は [observability.md「購入 API の SLO 目標値と閾値アラーム」](observability.md#購入-api-の-slo-目標値と閾値アラームadr-0017--issue-227) を正本とする。

**実発火（Aurora の SG から app SG への ingress を一時 revoke → ECS API タスクを force-new-deployment して DB プールを切断 → 事前取得済み JWT トークンで購入 API を呼び出し、technical_failure（HTTP 500）を実際に発生させて検証）**:

| アラーム | 実測値 | ALARM 遷移 | SNS action（ALARM 側） | OK 復帰 | SNS action（OK 側） |
| --- | --- | --- | --- | --- | --- |
| `purchase-error-burn-rate-fast` | error_burn_ratio = 200.0（閾値 14.4。success=0, technical_failure=8 → error_rate=100%） | 2026-07-10 00:38:08 JST | `Successfully executed action` | 2026-07-10 00:44:08 JST | `Successfully executed action` |
| `purchase-technical-failure-weak` | Sum = 8 件 / 5分（閾値 1件） | 2026-07-10 01:12:18 JST | `Successfully executed action` | 2026-07-10 01:16:18 JST | `Successfully executed action` |
| `purchase-technical-failure-normal` | Sum = 35 件 / 30分（閾値 3件） | 2026-07-10 00:38:28 JST | `Successfully executed action` | 2026-07-10 01:11:26 JST | `Successfully executed action` |

`error-burn-rate-slow`（6 期間連続 = 30 分の持続条件）は、JWT トークンの有効期限（15 分）・購入エンドポイントのレート制限（user_id 主体 10 回/15分、ADR-0015）という運用制約により、実際に 30 分間切れ目なく閾値超過を維持することが困難だった（トークン更新・レート制限回避のためのユーザーローテーションを挟むと、5 分バケットの一部で `eligible_count < 5`（低トラフィックガード）を割り込み、6 期間連続の条件が崩れる）。

**SNS 配線確認のみ（`aws cloudwatch set-alarm-state` で ALARM → SNS action → OK を直接確認。metric math の計算ロジック自体は error-burn-rate-fast の実発火で検証済みのため、evaluation_periods の違いのみの slow burn / latency 系はここでは配線確認に留めた）**:

| アラーム | ALARM 遷移 | SNS action | OK 復帰 | SNS action |
| --- | --- | --- | --- | --- |
| `purchase-error-burn-rate-slow` | 確認済み | `Successfully executed action` | 確認済み | `Successfully executed action` |
| `purchase-latency-burn-rate-fast` | 確認済み | `Successfully executed action` | 確認済み | `Successfully executed action` |
| `purchase-latency-burn-rate-slow` | 確認済み | `Successfully executed action` | 確認済み | `Successfully executed action` |

**staging 確認**: `terraform plan` / `apply` が通り、上記 6 アラームすべてが `OK` 状態で作成されたことを確認（軽量パターン）。`alarm_actions` が空でない（`ticket-c2c-staging-alerts` SNS トピック ARN が設定されている）ことも確認した。

## CloudWatch アラーム実地検証（2026-07-09）

対象: Four Golden Signals ベースの CloudWatch アラーム（Issue #218）。`terraform-apply-dev` 実行後、dev 環境で各アラームを実際に発火させ、ALARM 遷移と SNS action の実行、OK 復帰までを確認した。検証中に発見した前提条件（Aurora / ECR が新規作成直後で空だったこと）への対応も記録する。

**前提対応**: `terraform-apply-dev` は新規 Aurora クラスタ・空の ECR リポジトリを作るため、そのままでは ECS タスクが `CannotPullContainerError`（イメージなし）で起動できず、起動できても `relation "users" does not exist`（未マイグレーション）で失敗した。`deploy-backend-dev.yml` / `deploy-frontend-dev.yml`（イメージビルド・push・ECS 更新）と `db-migrate-dev.yml`（TypeORM migration 適用）を実行してから検証を開始した。

| アラーム | 発火方法 | 実測値 | ALARM 遷移 | SNS action | OK 復帰 |
| --- | --- | --- | --- | --- | --- |
| `ticket-c2c-dev-valkey-fail-open` | Valkey の SG（`sg-063b...`）から app SG への ingress（tcp/6379）を一時 revoke → API を force-new-deployment で新規接続にさせる → 購入 API を 1 回叩く（`connectTimeout=3000ms` で fail-open） | `ValkeyFailOpen` Sum=2.0（api, 07:13 UTC）。閾値 >=1 | 2026-07-09 16:14:07 JST | `Successfully executed action` (SNS) | 2026-07-09 16:20:07 JST（SG 復元 + 再デプロイ後） |
| `ticket-c2c-dev-worker-processing-lag` | Worker `desired_count=0` → イベント登録 API を 5 回叩き SQS にメッセージを滞留 → 約 45〜60 秒後に `desired_count=1` に戻す（2 回繰り返し、2 期間連続で閾値超過させる） | p90 = 113,674 ms（07:17 UTC）、51,535 ms（07:22 UTC）。閾値 >30,000 ms、2 期間連続 | 2026-07-09 16:27:33 JST | `Successfully executed action` (SNS) | 2026-07-09 16:43:33 JST（低遅延イベントを 1 件流して再評価を促した） |
| `ticket-c2c-dev-alb-5xx` | app SG から ALB SG への ingress（tcp/3000）を一時 revoke → target が unhealthy になり ALB が 5xx（`HTTPCode_ELB_5XX_Count`）を返す状態で `/healthz` に約 30 リクエスト送信 | Sum = 31.0（07:49 UTC）、10.0（07:44 UTC）。閾値 >=10、2 期間連続 | 2026-07-09 16:56:29 JST | `Successfully executed action` (SNS) | 2026-07-09 17:03:29 JST（SG 復元・target healthy 復帰後） |
| `ticket-c2c-dev-alb-api-unhealthy-hosts` | 上記と同一操作（app SG ingress revoke） | `UnHealthyHostCount` Max = 1.0（07:42 UTC, 07:47 UTC）。閾値 >=1、2 期間連続 | 2026-07-09 16:54:19 JST | `Successfully executed action` (SNS) | 2026-07-09 17:05:19 JST |
| `ticket-c2c-dev-api-cpu-high` | API task（Fargate cpu=256）に対し、bcrypt（cost factor 12）を伴う signup API を並列度 100 で連続実行 | `CPUUtilization` Avg = 99.61% / 99.84% / 99.80%（3 期間、08:00〜08:10 UTC）。閾値 >85%、3 期間連続 | 2026-07-09 17:17:40 JST | `Successfully executed action` (SNS) | ALARM 確認後、負荷生成プロセスを直ちに kill して停止（restrictions: ECS CPU / Aurora CPU・ACU near max は ALARM 確認後即負荷停止する方針で合意済み） |
| `ticket-c2c-dev-aurora-acu-near-max` | API を `desired_count=4→8` に一時スケール（DB connection pool 上限 10/task を活かすため）→ `GET /events`（DB 直読み）を並列度 200〜400 で連続実行 | `ServerlessDatabaseCapacity` Avg = 1.93 / 2.0 / 2.0 ACU（3 期間、08:27〜08:37 UTC）。閾値 >1.8 ACU（`max_capacity=2` の 90%）、3 期間連続 | 2026-07-09 17:42:13 JST | `Successfully executed action` (SNS) | 2026-07-09 18:02:13 JST（負荷停止・API を `desired_count=1` へ復帰後、自然回復） |
| `ticket-c2c-dev-aurora-cpu-high` | 上記と同一の DB 負荷（API 8 タスク、並列度 200〜400 の `GET /events`） | `CPUUtilization` Avg = 84.71 / 98.87 / 99.64%（3 期間、08:42〜08:52 UTC）。閾値 >80%、3 期間連続 | 2026-07-09 17:58:24 JST | `Successfully executed action` (SNS) | 2026-07-09 18:02:24 JST（負荷停止後、自然回復） |

**SNS 配線確認のみ（実負荷試験は不要とユーザー判断。`aws cloudwatch set-alarm-state` で ALARM → SNS action → OK を直接確認）**:

| アラーム | ALARM 遷移 | SNS action | OK 復帰 |
| --- | --- | --- | --- |
| `ticket-c2c-dev-api-memory-high` | 2026-07-09 15:56:14 JST | `Successfully executed action` (SNS) | 2026-07-09 15:56:47 JST |
| `ticket-c2c-dev-aurora-freeable-memory-low` | 2026-07-09 15:56:15 JST | `Successfully executed action` (SNS) | 2026-07-09 15:56:48 JST |
| `ticket-c2c-dev-aurora-connections-high` | 2026-07-09 15:56:16 JST | `Successfully executed action` (SNS) | 2026-07-09 15:56:49 JST |

**既知の運用事項・確認事項**:

- SNS email subscription（`<alert_email>`）は検証時点で `PendingConfirmation` のまま（L-5 / Issue #200 と同じ既知の制約）。SNS への publish（action 実行）自体は全アラームで `Successfully executed` を確認済みのため、配線としては完成している。次回 apply 時に届く確認メールを Confirm すれば以降のメール配信が有効になる。
- 新規作成した CloudWatch アラームは、作成直後の初回評価までに数分〜十数分のラグが観測された（`no datapoints were received` の状態が続いた後に実データで評価される）。実発火試験ではこのラグを見込んで負荷を維持し続けた。
- 既存の DLQ 滞留アラーム（`ticket-c2c-dev-search-projection-dlq-messages-visible`、L-5 / Issue #200）は本検証中 `OK` のまま維持され、配線・動作に影響がないことを確認した。
- 実地検証で発生した検証用データ（signup ユーザー・test event 等）は dev の test data 方針（`smoke-test.ts` と同様、削除せず destroy まで残置）に従い、そのまま dev destroy まで残す。

## Observability 一回通し実地検証（2026-07-12〜13）

対象: Issue #276 / #285。dev / staging の Dashboard 表示、severity description、edge alarm、Synthetics canary を一回通しで確認した。

| 環境 | Dashboard | severity description | edge alarm | Synthetics canary |
| --- | --- | --- | --- | --- |
| dev | `<name>-overview` の全体表示を確認 | Critical / Warning / Info の代表アラームと edge 3 本を確認 | 3 本を `set-alarm-state` で ALARM に遷移させ、次回評価で OK 復帰することを確認 | 成功 run（`PASSED`）を確認 |
| staging（https-dns） | `<name>-overview` の全体表示を確認 | Critical / Warning / Info の代表アラームと edge 3 本を確認 | 3 本を `set-alarm-state` で ALARM に遷移させ、次回評価で OK 復帰することを確認 | 複数回連続の成功 run（`PASSED`）を確認 |

`set-alarm-state` による確認は、アラーム状態遷移、description、action 配線を対象とし、メトリクス閾値の実発火試験ではない。メトリクスの実発火を行ったアラームは、上記の 2026-07-09〜10 の記録を参照する。

証跡:

- [dev スクリーンショット一覧](screenshots/observability-dev/README.md)
- [staging スクリーンショット一覧](screenshots/observability-staging/README.md)

## Synthetics canary 実地検証

対象: CloudFront 経由の外形監視 canary（Issue #256、`terraform/modules/synthetics-canary`）と `synthetic-check-failure` アラーム。

Issue #256 の実装時点では apply を見送ったが、2026-07-12、Issue #276 で dev / staging の canary 成功 run と alarm action 配線を実地確認した。画面証跡は上記の dev / staging スクリーンショット一覧を参照する。

**destroy 後の残存リソース確認（2026-07-19）**: dev / staging が destroy 済みの状態で実地確認した。両環境とも、Synthetics canary、`cwsyn-*` Lambda 関数・Layer、artifact S3 bucket、canary IAM role、`synthetic-check-failure` alarm、関連 CloudWatch Logs log group は 0 件であり、`delete_lambda = true` を含む削除設計どおり残存していないことを確認した。[AWS Synthetics DeleteCanary のドキュメント](https://docs.aws.amazon.com/AmazonSynthetics/latest/APIReference/API_DeleteCanary.html)も参照。
