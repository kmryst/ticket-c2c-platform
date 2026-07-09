# 可観測性（分散トレーシング・ビジネスメトリクス）

このドキュメントは ticket-c2c-platform の可観測性構成の正本です。
設計判断の経緯は [ADR-0014](../adr/0014-xray-distributed-tracing-with-adot-sidecar.md) を参照してください。

## 全体像

```
[client]
   │ HTTP
   ▼
[API (NestJS)] ──────────────► [ADOT collector sidecar] ──► [AWS X-Ray]
   │  span: HTTP / pg /            (OTLP localhost:4318)
   │        ioredis / PutEvents
   │  EventBridge detail に _traceContext を同梱
   ▼
[EventBridge] ─► [SQS] ─► [Worker] ────► [ADOT collector sidecar] ──► [AWS X-Ray]
                             │  detail から trace context を復元し
                             │  CONSUMER span として同一 trace を継続
                             ▼
                        [OpenSearch]

API / Worker ─ EMF（stdout 構造化ログ）─► CloudWatch Logs ─► CloudWatch Metrics
```

## 分散トレーシング（AWS X-Ray）

### 計装

- 初期化: `src/observability/tracing.ts`（`main.ts` / `worker.ts` の import 最上部で副作用初期化）。
- **opt-in**: `OTEL_TRACING_ENABLED=true` のときだけ NodeSDK を起動する。ローカル PoC の既定では何も起きない（`@opentelemetry/api` は no-op）。
- 自動計装: http（受信リクエスト・外向き HTTP）、pg、ioredis、aws-sdk（EventBridge / SQS）。health check パス（`/health` 等）は除外。
- TraceId は X-Ray 形式（`AWSXRayIdGenerator`）、伝搬は `X-Amzn-Trace-Id` 形式（`AWSXRayPropagator`）。

### EventBridge を跨ぐ trace 継続

- publish 側（`src/messaging/domain-events.service.ts`）: 現在の trace context を detail の `_traceContext` フィールドへ同梱する（`src/observability/trace-context.ts`）。
- consume 側（`src/worker/search-projection.worker.ts`）: detail から context を復元し、`search-projection <detail-type>` という CONSUMER span を張る。context が無ければ独立 trace になる（後方互換）。
- `_traceContext` は OpenSearch のプロジェクションドキュメントへは書き込まれない。

### Exporter / collector

- アプリは OTLP/HTTP で `localhost:4318`（既定 URL）へ送るだけ。X-Ray への SigV4 署名・リトライは同一タスク内の **ADOT collector sidecar** が担う。
- sidecar はイメージ同梱の ECS 用既定設定（`--config=/etc/ecs/ecs-default-config.yaml`）で動く。イメージはタグ固定（`terraform/environments/<env>/main.tf` の `otel_collector_image`）。
- sidecar は `essential = false`。collector が落ちてもアプリ本体は落ちない（トレースのみ欠落）。
- deploy workflow（`deploy-service.yml`）は `.containerDefinitions[0].image` のみ差し替えるため、**アプリコンテナは必ず index 0、sidecar は index 1 以降**（`terraform/modules/ecs-service/main.tf` の規約）。

### サンプリング

| 環境 | sampler | 率 | 理由 |
|---|---|---|---|
| dev | `parentbased_traceidratio` | 1.0 | 検証用途のため全量 |
| staging | `parentbased_traceidratio` | 0.1 | 本番相当の負荷試験でトレース量・コストを抑える |

- Worker は parentbased のため API 側の sampling 判定に追従する（trace が途中で切れない）。
- X-Ray の centralized sampling rule は使わない（OTel 標準 sampler から参照されないため）。率の変更はタスク定義の環境変数変更（Terraform apply）で行う。

### X-Ray console での見方

- 環境ごとに X-Ray group（`ticket-<env>`、filter: `service("ticket-<env>-api") OR service("ticket-<env>-worker")`）を Terraform（observability モジュール）で作成している。
- 購入 1 リクエストは「API の HTTP span → pg / ioredis / EventBridge PutEvents → Worker の CONSUMER span → OpenSearch 更新」まで 1 trace で表示される。

## ビジネスメトリクス（CloudWatch EMF）

- 実装: `src/observability/emf.ts`。EMF 形式の JSON を stdout へ 1 行出すだけ（awslogs → CloudWatch Logs → 自動抽出）。PutMetricData 不使用、追加 IAM 不要。
- **opt-in**: `METRICS_NAMESPACE` 未設定（ローカル PoC 既定）では何も出さない。
- 名前空間: `TicketC2C/dev` / `TicketC2C/staging`。dimension は `Service`（api / worker）+ メトリクス固有の追加 dimension。

| メトリクス | 単位 | 出所 | dimension | 意味 |
|---|---|---|---|---|
| PurchaseConfirmed | Count | API | Service | 購入確定数 |
| PurchaseRejected | Count | API | Service, Reason | 購入拒否数（sold_out_precheck / DB 判定理由別） |
| ValkeyFailOpen | Count | API | Service, Operation | 前段フィルタ障害で fail-open した回数。増加は Aurora 素通りの兆候 |
| WorkerProcessingLagMs | Milliseconds | Worker | Service | SQS 送信から処理完了（削除）までの経過時間 |

- confirm / reject 率は CloudWatch 側で 2 メトリクスの比として算出する。
- キュー全体の滞留は SQS 標準メトリクス `ApproximateAgeOfOldestMessage`（DLQ アラーム含む。Issue #201）を併用する。WorkerProcessingLagMs は「正常系での消費までの遅延」を見る用途。

## CloudWatch アラーム（Issue #218）

SRE の Four Golden Signals（Errors / Availability / Saturation / Latency 相当）を、既存パターン（sqs モジュールの DLQ アラーム）に倣い「リソースを所有する terraform モジュール内に配置し、`alarm_actions` を root module から注入」する形で実装している。全アラームの通知先は observability モジュールのアラート用 SNS トピック（`<name>-alerts` → email。L-5 / Issue #200）で、ALARM / OK 両遷移を通知する。

| アラーム | 所有モジュール | メトリクス | 条件 | 意図 |
|---|---|---|---|---|
| `<name>-alb-5xx` | alb | `HTTPCode_Target_5XX_Count` + `HTTPCode_ELB_5XX_Count`（metric math 合算、FILL 0 埋め） | Sum >= 10 / 5 分 x 2 期間 | Errors: API / frontend のエラー急増 |
| `<name>-alb-{api,frontend}-unhealthy-hosts` | alb | `UnHealthyHostCount` | Max >= 1 / 5 分 x 2 期間 | Availability: 回復しないヘルスチェック失敗 |
| `<service>-cpu-high` / `<service>-memory-high` | ecs-service（api / worker / frontend 各サービス） | `CPUUtilization` / `MemoryUtilization` | Avg > 85% / 5 分 x 3 期間 | Saturation: スケール不足・OOM kill 前兆 |
| `<name>-aurora-cpu-high` | aurora | `CPUUtilization`（DBClusterIdentifier） | Avg > 80% / 5 分 x 3 期間 | Saturation: クエリ性能劣化 |
| `<name>-aurora-freeable-memory-low` | aurora | `FreeableMemory` | Avg < 256 MiB / 5 分 x 3 期間 | Saturation: メモリ枯渇 |
| `<name>-aurora-connections-high` | aurora | `DatabaseConnections` | Avg > 推定 max_connections の 80% / 5 分 x 3 期間 | Saturation: 接続リーク。閾値は max ACU から自動導出 |
| `<name>-aurora-acu-near-max` | aurora | `ServerlessDatabaseCapacity` | Avg > max_capacity の 90% / 5 分 x 3 期間 | Saturation: スケール上限到達 |
| `<name>-valkey-fail-open` | observability | `ValkeyFailOpen`（EMF、Service=api） | Sum >= 1 / 1 分 x 1 期間 | 前段フィルタ無効化のサイレント進行を即検知 |
| `<name>-worker-processing-lag` | observability | `WorkerProcessingLagMs`（EMF、Service=worker） | p90 > 30,000 ms / 5 分 x 2 期間 | Latency: 検索プロジェクション鮮度劣化 |
| `<name>-search-projection-dlq-messages-visible` | sqs（既存。L-5 / Issue #200） | `ApproximateNumberOfMessagesVisible` | Max >= 1 / 1 分 | Worker の処理失敗（DLQ 滞留） |

- Aurora Serverless v2 に `CPUCreditBalance` は存在しない（バーストクレジットは t 系インスタンス専用）。CPU の頭打ちは CPUUtilization + ACU 上限接近で捕捉する。
- min 0 ACU の auto-pause 中や ECS タスク 0 台ではメトリクスのデータ点自体が出ないため、全アラームで `treat_missing_data = notBreaching`（destroy 前提運用・pause は正常状態）。
- EMF メトリクスは CloudWatch Logs から自動抽出されるため metric filter は不要（アラーム定義のみ）。EMF アラームはメトリクスを所有する terraform モジュールが存在しないため、SNS トピックを所有する observability モジュールに置く。

### dev 実地検証（2026-07-09）

`terraform-apply-dev` 実行後、dev 環境で各アラームを実際に発火させ、ALARM 遷移と SNS action の実行、OK 復帰までを確認した。検証中に発見した前提条件（Aurora / ECR が新規作成直後で空だったこと）への対応も記録する。

**前提対応**: `terraform-apply-dev` は新規 Aurora クラスタ・空の ECR リポジトリを作るため、そのままでは ECS タスクが `CannotPullContainerError`（イメージなし）で起動できず、起動できても `relation "users" does not exist`（未マイグレーション）で失敗した。`deploy-backend-dev.yml` / `deploy-frontend-dev.yml`（イメージビルド・push・ECS 更新）と `db-migrate-dev.yml`（TypeORM migration 適用）を実行してから検証を開始した。

| アラーム | 発火方法 | 実測値 | ALARM 遷移 | SNS action | OK 復帰 |
|---|---|---|---|---|---|
| `ticket-c2c-dev-valkey-fail-open` | Valkey の SG（`sg-063b...`）から app SG への ingress（tcp/6379）を一時 revoke → API を force-new-deployment で新規接続にさせる → 購入 API を 1 回叩く（`connectTimeout=3000ms` で fail-open） | `ValkeyFailOpen` Sum=2.0（api, 07:13 UTC）。閾値 >=1 | 2026-07-09 16:14:07 JST | `Successfully executed action` (SNS) | 2026-07-09 16:20:07 JST（SG 復元 + 再デプロイ後） |
| `ticket-c2c-dev-worker-processing-lag` | Worker `desired_count=0` → イベント登録 API を 5 回叩き SQS にメッセージを滞留 → 約 45〜60 秒後に `desired_count=1` に戻す（2 回繰り返し、2 期間連続で閾値超過させる） | p90 = 113,674 ms（07:17 UTC）、51,535 ms（07:22 UTC）。閾値 >30,000 ms、2 期間連続 | 2026-07-09 16:27:33 JST | `Successfully executed action` (SNS) | 2026-07-09 16:43:33 JST（低遅延イベントを 1 件流して再評価を促した） |
| `ticket-c2c-dev-alb-5xx` | app SG から ALB SG への ingress（tcp/3000）を一時 revoke → target が unhealthy になり ALB が 5xx（`HTTPCode_ELB_5XX_Count`）を返す状態で `/healthz` に約 30 リクエスト送信 | Sum = 31.0（07:49 UTC）、10.0（07:44 UTC）。閾値 >=10、2 期間連続 | 2026-07-09 16:56:29 JST | `Successfully executed action` (SNS) | 2026-07-09 17:03:29 JST（SG 復元・target healthy 復帰後） |
| `ticket-c2c-dev-alb-api-unhealthy-hosts` | 上記と同一操作（app SG ingress revoke） | `UnHealthyHostCount` Max = 1.0（07:42 UTC, 07:47 UTC）。閾値 >=1、2 期間連続 | 2026-07-09 16:54:19 JST | `Successfully executed action` (SNS) | 2026-07-09 17:05:19 JST |
| `ticket-c2c-dev-api-cpu-high` | API task（Fargate cpu=256）に対し、bcrypt（cost factor 12）を伴う signup API を並列度 100 で連続実行 | `CPUUtilization` Avg = 99.61% / 99.84% / 99.80%（3 期間、08:00〜08:10 UTC）。閾値 >85%、3 期間連続 | 2026-07-09 17:17:40 JST | `Successfully executed action` (SNS) | ALARM 確認後、負荷生成プロセスを直ちに kill して停止（restrictions: ECS CPU / Aurora CPU・ACU near max は ALARM 確認後即負荷停止する方針で合意済み） |
| `ticket-c2c-dev-aurora-acu-near-max` | API を `desired_count=4→8` に一時スケール（DB connection pool 上限 10/task を活かすため）→ `GET /events`（DB 直読み）を並列度 200〜400 で連続実行 | `ServerlessDatabaseCapacity` Avg = 1.93 / 2.0 / 2.0 ACU（3 期間、08:27〜08:37 UTC）。閾値 >1.8 ACU（`max_capacity=2` の 90%）、3 期間連続 | 2026-07-09 17:42:13 JST | `Successfully executed action` (SNS) | 2026-07-09 18:02:13 JST（負荷停止・API を `desired_count=1` へ復帰後、自然回復） |
| `ticket-c2c-dev-aurora-cpu-high` | 上記と同一の DB 負荷（API 8 タスク、並列度 200〜400 の `GET /events`） | `CPUUtilization` Avg = 84.71 / 98.87 / 99.64%（3 期間、08:42〜08:52 UTC）。閾値 >80%、3 期間連続 | 2026-07-09 17:58:24 JST | `Successfully executed action` (SNS) | 2026-07-09 18:02:24 JST（負荷停止後、自然回復） |

**SNS 配線確認のみ（実負荷試験は不要とユーザー判断。`aws cloudwatch set-alarm-state` で ALARM → SNS action → OK を直接確認）**:

| アラーム | ALARM 遷移 | SNS action | OK 復帰 |
|---|---|---|---|
| `ticket-c2c-dev-api-memory-high` | 2026-07-09 15:56:14 JST | `Successfully executed action` (SNS) | 2026-07-09 15:56:47 JST |
| `ticket-c2c-dev-aurora-freeable-memory-low` | 2026-07-09 15:56:15 JST | `Successfully executed action` (SNS) | 2026-07-09 15:56:48 JST |
| `ticket-c2c-dev-aurora-connections-high` | 2026-07-09 15:56:16 JST | `Successfully executed action` (SNS) | 2026-07-09 15:56:49 JST |

**既知の運用事項・確認事項**:
- SNS email subscription（`komurayoshitodesu@gmail.com`）は検証時点で `PendingConfirmation` のまま（L-5 / Issue #200 と同じ既知の制約）。SNS への publish（action 実行）自体は全アラームで `Successfully executed` を確認済みのため、配線としては完成している。次回 apply 時に届く確認メールを Confirm すれば以降のメール配信が有効になる。
- 新規作成した CloudWatch アラームは、作成直後の初回評価までに数分〜十数分のラグが観測された（`no datapoints were received` の状態が続いた後に実データで評価される）。実発火試験ではこのラグを見込んで負荷を維持し続けた。
- 既存の DLQ 滞留アラーム（`ticket-c2c-dev-search-projection-dlq-messages-visible`、L-5 / Issue #200）は本検証中 `OK` のまま維持され、配線・動作に影響がないことを確認した。
- 実地検証で発生した検証用データ（signup ユーザー・test event 等）は dev の test data 方針（`smoke-test.ts` と同様、削除せず destroy まで残置）に従い、そのまま dev destroy まで残す。

## 環境変数一覧

| 変数 | 例 | 説明 |
|---|---|---|
| `OTEL_TRACING_ENABLED` | `true` | トレーシングの opt-in フラグ。未設定 / `true` 以外で無効 |
| `OTEL_SERVICE_NAME` | `ticket-dev-api` | X-Ray サービスマップ上のノード名 |
| `OTEL_TRACES_SAMPLER` | `parentbased_traceidratio` | OTel 標準 sampler 指定 |
| `OTEL_TRACES_SAMPLER_ARG` | `1.0` | サンプリング率 |
| `METRICS_NAMESPACE` | `TicketC2C/dev` | EMF の名前空間。未設定で EMF 無効 |
| `METRICS_SERVICE` | `api` | EMF の Service dimension 値 |

いずれも Terraform（`terraform/environments/<env>/main.tf`）が ECS タスク定義へ設定する。ローカル PoC ではどれも設定しない。

## IAM

- API / Worker の task role に `xray:PutTraceSegments` / `xray:PutTelemetryRecords` のみ追加（X-Ray 書き込み API はリソースレベル制限非対応のため Resource は `*`）。
- EMF は CloudWatch Logs への書き込み（既存の awslogs 経路）だけで完結するため追加権限なし。
