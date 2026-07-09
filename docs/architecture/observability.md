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
