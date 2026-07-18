# 可観測性（分散トレーシング・ビジネスメトリクス）

このドキュメントは ticket-c2c-platform の可観測性構成の正本です。
設計判断の経緯は [ADR-0014](../adr/0014-xray-distributed-tracing-with-adot-sidecar.md) を参照してください。

## 全体像

```text
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
| --- | --- | --- | --- |
| dev | `parentbased_traceidratio` | 1.0 | 検証用途のため全量 |
| staging | `parentbased_traceidratio` | 0.1 | 本番相当の負荷試験でトレース量・コストを抑える |

- Worker は parentbased のため API 側の sampling 判定に追従する（trace が途中で切れない）。
- X-Ray の centralized sampling rule は使わない（OTel 標準 sampler から参照されないため）。率の変更はタスク定義の環境変数変更（Terraform apply）で行う。

### X-Ray console での見方

- 環境ごとに X-Ray group（`ticket-<env>`、filter: `service("ticket-<env>-api") OR service("ticket-<env>-worker")`）を Terraform（observability モジュール）で作成している。
- 購入 1 リクエストは「API の HTTP span → pg / ioredis / EventBridge PutEvents → Worker の CONSUMER span → OpenSearch 更新」まで 1 trace で表示される。

### ログ ↔ trace 相関（Issue #255）

API / Worker の主要な構造化ログと EMF record には、出力時点でアクティブな span の相関 ID が含まれる。

- 共通 helper: `src/observability/trace-context.ts` の `traceLogFields()`。current span context から `traceId`（X-Ray console でそのまま検索できる `1-<epoch 8hex>-<24hex>` 形式）と `spanId`（16 hex）を返す。アクティブな span がない・トレーシング無効（ローカル PoC）の場合は `undefined` を返すため、`{ ...traceLogFields() }` とスプレッドするだけでログ構造を壊さず安全に使える。
- 付与済みのログ: Worker の処理ログ（`indexed event` / `updated inventory` 等）、購入 API の在庫不整合エラーログ、`rate_limit_exceeded` セキュリティイベントログ、EventBridge 発行失敗ログ、および EMF record（`emf.ts`。出力時点で span がアクティブなもの）。
- 例外: `WorkerProcessingLagMs` は「SQS 送信から削除完了まで」を計測する設計上、CONSUMER span 終了後（メッセージ削除後）に出力されるため trace id は付かない（計測点を span 内へ動かすと意味が変わるため意図的にそのままにしている）。
- **EMF での制約**: `traceId` / `spanId` は EMF record のログ属性としてのみ含め、`_aws.CloudWatchMetrics.Dimensions` には絶対に加えない。trace id は高カーディナリティ値であり、dimension にすると CloudWatch メトリクスの系列数（課金対象）が無際限に増えるため。`eventId` / `buyerId` / `requestId` を dimension に入れない既存制約と同じ理由である。

**ログから trace を探す手順**:

1. CloudWatch Logs Insights で該当ロググループ（API / Worker の ECS ロググループ）を選び、調査対象のログを絞り込む。EMF record や JSON ログは自動でフィールド化される。

   ```text
   fields @timestamp, @message, traceId, spanId
   | filter ispresent(traceId)
   | sort @timestamp desc
   | limit 50
   ```

2. 見つけたログの `traceId`（例: `1-5f84c7a1-aaaaaaaaaaaaaaaaaaaaaaaa`）をコピーし、X-Ray console（CloudWatch → X-Ray traces）の trace 検索へそのまま貼り付けて開く。
3. 逆方向（trace → ログ）は、X-Ray で特定した trace id を Logs Insights で `filter traceId = "1-..."` として検索し、同一リクエスト・同一イベント処理に紐づく API / Worker 双方のログを横断取得する。

   ```text
   fields @timestamp, @log, @message
   | filter traceId = "1-5f84c7a1-aaaaaaaaaaaaaaaaaaaaaaaa"
   | sort @timestamp asc
   ```

注意: サンプリングで記録されなかったリクエスト（staging は 0.1）でも trace id 自体は採番されるため、ログに `traceId` があっても X-Ray 側に trace が存在しない場合がある（dev は全量サンプリングのため原則一致する）。

## ビジネスメトリクス（CloudWatch EMF）

- 実装: `src/observability/emf.ts`。EMF 形式の JSON を stdout へ 1 行出すだけ（awslogs → CloudWatch Logs → 自動抽出）。PutMetricData 不使用、追加 IAM 不要。
- **opt-in**: `METRICS_NAMESPACE` 未設定（ローカル PoC 既定）では何も出さない。
- 名前空間: `TicketC2C/dev` / `TicketC2C/staging`。dimension は `Service`（api / worker）+ メトリクス固有の追加 dimension。

| メトリクス | 単位 | 出所 | dimension | 意味 |
| --- | --- | --- | --- | --- |
| PurchaseConfirmed | Count | API | Service | 購入確定数 |
| PurchaseRejected | Count | API | Service, Reason | 購入拒否数（sold_out_precheck / DB 判定理由別） |
| ValkeyFailOpen | Count | API | Service, Operation | 前段フィルタ障害で fail-open した回数。増加は Aurora 素通りの兆候 |
| WorkerProcessingLagMs | Milliseconds | Worker | Service | SQS 送信から処理完了（削除）までの経過時間 |
| PurchaseRequestOutcome | Count | API | Service, Outcome | 購入 API の技術的な成否分類（success / technical_failure / rate_limited / invalid_request）。SLI: 成功率の算出元（ADR-0016 / Issue #225） |
| PurchaseRequestLatencyMs | Milliseconds | API | Service, Outcome | 購入 API の応答時間（Guard 通過後〜応答まで）。SLI: レイテンシ（ADR-0016 / Issue #225） |

- confirm / reject 率は CloudWatch 側で 2 メトリクスの比として算出する。
- キュー全体の滞留は SQS 標準メトリクス `ApproximateAgeOfOldestMessage`（DLQ アラーム含む。Issue #201）を併用する。WorkerProcessingLagMs は「正常系での消費までの遅延」を見る用途。
- `PurchaseConfirmed` / `PurchaseRejected` が「業務判定の結果」を表すのに対し、`PurchaseRequestOutcome` / `PurchaseRequestLatencyMs` は「HTTP 応答レベルでシステムとして正しく応答できたか」を表す別軸のメトリクス。sold_out 等のビジネス拒否は HTTP 200 のため `Outcome=success` に含まれる（ADR-0016）。

## 購入 API の SLI（成功率・レイテンシ。ADR-0016 / Issue #225）

購入 API（`POST /events/:eventId/purchases`）は C2C チケット販売の中核フローであり、Issue #218 の ALB 5xx アラーム（全エンドポイント横断の粗いインフラ監視）とは別に、購入 API 単体のユーザー体験としての SLI を定義している。実装は `src/observability/request-outcome.interceptor.ts`（`RequestOutcomeInterceptor`、汎用 NestJS Interceptor）で、`purchases.controller.ts` の `createPurchase` handler に適用している。

- **成功率 SLI**: `count(Outcome=success) / (count(Outcome=success) + count(Outcome=technical_failure))`。`rate_limited`（429）・`invalid_request`（400/401/404/409）は分母から除外する
- **レイテンシ SLI**: `PurchaseRequestLatencyMs`（`performance.now()` で計測。JwtAuthGuard 通過後〜応答まで）
- **401 は計測対象外**: NestJS の実行順序（Guard → Interceptor → Handler）により、Guard（`JwtAuthGuard`）が投げる 401 は Interceptor に到達する前に短絡するため。Issue #225 が元々「認証・検索は将来拡張」としていた範囲と一致する
- 設計判断の詳細（Outcome 分類の根拠、ALB 5xx アラームとの役割分担、`PurchaseRateLimited` との関係）は [ADR-0016](../adr/0016-purchase-api-sli-definition.md) を参照
- SLO 目標値・burn-rate アラームは [ADR-0017](../adr/0017-purchase-api-slo-burn-rate.md) / Issue #227 で実装済み（次節参照）

## 購入 API の SLO 目標値と burn-rate アラート（ADR-0017 / Issue #227）

購入 API の SLI（前節）に対して SLO 目標値を定め、CloudWatch metric math による multi-window multi-burn-rate アラート（fast burn / slow burn の2 window）を実装している。terraform-hannibal（別プロジェクト）の ADR-0026 を参考にしたが、購入 API 固有のアプリレベルメトリクス（ALB 集約値ではなく `PurchaseRequestOutcome` / `PurchaseRequestLatencyMs`）を使える点が異なる。実装は `terraform/modules/observability`。

### SLO 目標値

| 項目 | 値 |
| --- | --- |
| 成功率 SLO | 99.5% |
| レイテンシ SLO | p95 < 800ms（`Outcome=success` のみ対象） |
| 最小リクエスト数（低トラフィックガード） | 5 件 / 5 分 |

### アラーム一覧

| アラーム | 入力メトリクス | 条件 | 意図 |
| --- | --- | --- | --- |
| `<name>-purchase-error-burn-rate-fast` | `PurchaseRequestOutcome`（Service=api, Outcome=technical_failure / success） | error burn ratio > 14.4 / 5分 | 成功率 SLO からの急激な逸脱（fast burn） |
| `<name>-purchase-error-burn-rate-slow` | 同上 | error burn ratio > 3 / 30分（6期間連続） | 成功率 SLO からの持続的な逸脱（slow burn） |
| `<name>-purchase-technical-failure-weak` | `PurchaseRequestOutcome`（Outcome=technical_failure） | Sum >= 1 / 5分 | 低頻度時（burn-rateガード未満）の早期・弱め通知 |
| `<name>-purchase-technical-failure-normal` | 同上 | Sum >= 3 / 30分 | 低頻度時の持続検知・通常通知 |
| `<name>-purchase-latency-burn-rate-fast` | `PurchaseRequestLatencyMs`（Outcome=success、p95） | latency burn ratio > 2.0 / 5分 | レイテンシ SLO からの急激な逸脱（fast burn） |
| `<name>-purchase-latency-burn-rate-slow` | 同上 | latency burn ratio > 1.2 / 30分（6期間連続） | レイテンシ SLO からの持続的な逸脱（slow burn） |

- **dimension の注意**: `PurchaseRequestOutcome` / `PurchaseRequestLatencyMs` は `Service` + `Outcome` の組み合わせで別系列になる（`emf.ts` の dimension set 仕様）。metric math では必ず `Service="api"` を明示して参照する。
- **error burn rate の式**: `eligible_count = technical_failure + success`、`error_rate = IF(eligible_count >= 5, technical_failure/eligible_count*100, 0)`、`error_burn_ratio = error_rate / (100 - 99.5)`。「成功率」ではなく「error burn rate」を正本にすることで、しきい値の向き（大きいほど悪い）を直感的にしている。
- **14.4 / 3 の倍率**: Google SRE の月次 error budget 理論由来の数値だが、本設計は「起動期間中」ベースの SLO であり厳密な適用ではない。heuristic な初期値として扱う。
- **technical_failure 絶対数アラーム**: 購入 API は低頻度なため、burn-rate の低トラフィックガード（5件/5分）を割り込む時間帯が多い。見逃し防止のため、絶対数の静的閾値アラームを別途併設している。
- **latency のサンプル数ガード**: `PurchaseRequestLatencyMs` 自体の SampleCount は metric math で直接参照できないため、同時刻に出力される `PurchaseRequestOutcome{Outcome=success}` の Sum を代理指標として使う。

### dev / staging 実地検証（2026-07-09〜10）

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

**既知の運用事項**:

- 新規作成したアラーム（特に metric math ベース）は、実際のメトリクスデータが変化しても再評価まで数分〜数十分のラグが観測された。データが本当に届いているか（`get-metric-statistics` で確認）と、アラームの `StateUpdatedTimestamp` が古いままかどうかを切り分けて判断する必要がある。
- 購入 API のレート制限（user_id 主体 10 回/15分、ADR-0015）と JWT トークンの有効期限（15分）は、30 分以上の持続的な負荷試験を単一ユーザーで行う場合の制約になる。複数ユーザーのトークンをローテーションする、またはレート制限を一時的に緩めるなどの対応が必要。
- 設計判断の詳細（外部レビューで訂正・追加した点を含む）は [ADR-0017](../adr/0017-purchase-api-slo-burn-rate.md) を参照。

## B2C 購入ジャーニーの成功率 SLI（目標設計）

[ADR-0022](../adr/0022-b2c-purchase-journey-success-sli.md) により、B2C 目標フローでは Protected Zone Access Token の発行成功から終端状態確定までを 1 購入ジャーニーとして扱う。この SLI と関連メトリクスは未実装であり、現行 Purchase API の SLI / SLO を置き換えた状態ではない。

```text
技術的成功率 = success / (success + technical_failure)
```

- **`success`**: Purchase 確定、正常な在庫拒否、決済拒否など、Customer に利用者可視の技術障害を返さず仕様どおりの終端状態へ到達したジャーニー。
- **`technical_failure`**: Customer へ返した 5xx / timeout、状態不整合、入場権喪失、正規入場後の 429、15 分後も未解決の `payment_unknown` など。
- **除外**: 未使用 Token 失効、技術障害を伴わない放置期限切れ・本人キャンセル、Bot または未入場利用者への防御的な 429、クライアント起因の 4xx。
- **記録時点**: 終端状態の確定時に、同じジャーニーについて Outcome を正確に 1 回記録する。`payment_unknown` の Outcome だけが最大 15 分遅れて計上される。
- **リアルタイム検知**: 段階別 API SLI に加え、`payment_unknown` の件数と滞留時間を Amazon CloudWatch Alarm で別に監視する。
- **相関 ID**: API と Worker を跨ぐジャーニー識別子は Aurora、構造化ログ、trace の相関に使い、高カーディナリティになるため Amazon CloudWatch メトリクスの dimension には含めない。

現行 Purchase API が稼働している間は、ADR-0016 / ADR-0017 の成功率 99.5%・p95 800ms が現役 SLO である。B2C 切り替え後は旧 API 限定の履歴と各 API の計測方式の参考として扱い、数値を新しい各 API または購入ジャーニー全体へ自動的に流用しない。B2C の具体的な成功率 SLO と burn-rate アラームは Product 要件と staging full の実測後に別途決定する。

### B2C 購入ジャーニーのレイテンシ SLI

[ADR-0023](../adr/0023-split-b2c-purchase-journey-latency-sli.md) により、購入ジャーニーのレイテンシは単一の分布にせず、次の 2 つへ分ける。いずれも目標設計であり、メトリクスは未実装である。[ADR-0025](../adr/0025-b2c-synchronous-purchase-latency-slo.md) は同期購入処理時間の正式な SLO と補助集計の責務を分ける。

| SLI | 境界 |
| --- | --- |
| 同期購入処理時間 | Session 交換、Ticket Hold 作成、Purchase 確定、結果確認の 4 API 個別レイテンシを正式な SLO とし、Outcome 別のジャーニー合算は補助指標として扱う。Customer の操作時間と非同期の決済結果待ちは除外する |
| 決済結果解決時間 | Aurora PostgreSQL の `payment_processing` 遷移から、決済結果に基づく終端状態の確定までをサーバー側 wall-clock time で扱う |

各 API は、ADR-0024 の計測境界で技術的成功 request のレイテンシ p95 を SLI とし、API ごとの正式な SLO を定義する。`confirmed` 正常系の 4 API を各 1 回呼び出す経路には、各 API の目標値を導くレイテンシ予算を設けるが、予算自体は SLO または Amazon CloudWatch Alarm の対象にはしない。API 個別 p95 の達成はジャーニー全体の p95 を保証しない。p99 は API 単体の tail latency を確認する検証指標とし、具体的な目標値、SLO 化、アラーム化は staging full の実測後に判断する。

B2C 購入フローの API と Worker は、ジャーニー識別子を構造化ログ属性として記録し、Amazon CloudWatch Embedded Metric Format の dimension には含めない。同期フェーズ終端 Outcome の `confirmed`、`sold_out`、`payment_failed`、`payment_unknown` ごとに全 request のサーバー側処理時間と API 呼び出し回数を集計し、`abandoned` は除外する。業務終端 Outcome は ADR-0022 の `success` / `technical_failure` 分類とは独立して扱う。

終端 Outcome があるジャーニーでは、再試行、idempotent replay、`client_aborted` となった試行も同期フェーズ終端までの補助集計に含める。`payment_unknown` の集計は同期フェーズで状態が確定した時点で閉じ、それ以降の結果確認 request は各 API の SLI と決済結果解決時間 SLI で扱う。合算値は Customer の実待ち時間ではなく、プラットフォームのサーバー側処理時間である。

k6 とジャーニー識別子付きログによる Outcome 別の合算値は、容量試験、受入判定、診断の補助指標であり、正式な SLO にはしない。CloudWatch metric math による各 API p95 の合計はジャーニー p95 ではないため、表示する場合も Amazon CloudWatch Dashboard の参考値に限定する。Amazon CloudWatch Logs Insights の集計方法、具体的なメトリクス名、SLO 目標値、低トラフィック時の評価方法、burn-rate アラームは後続 Issue で決定し、現行 Purchase API の p95 800ms を流用しない。

#### B2C 同期 API のサーバー側計測境界

[ADR-0024](../adr/0024-b2c-synchronous-api-latency-boundary.md) により、B2C の同期 API は Fastify `onRequest` で計測を始め、`onResponse`、`onRequestAbort`、`onTimeout` のうち最初の終端で 1 request につき 1 回だけ記録する。これにより、認証前からレスポンス送信までを含め、切断と timeout を計測漏れにしない。

- SLO 用 percentile は、endpoint の契約どおりに技術的成功を返した request だけを対象にする。
- クライアント起因 4xx と防御的な 429 は percentile から除外する。
- 正規入場後の 429、5xx、server timeout は技術的失敗、`client_aborted` は診断指標として別に記録する。
- Application Load Balancer の `TargetResponseTime` / 5xx、Amazon CloudFront の `OriginLatency` / `5xxErrorRate`、Amazon CloudWatch Synthetics、k6 は、アプリケーションメトリクスが見ないレイヤーを診断・補完する。
- 現行 Purchase API の `PurchaseRequestLatencyMs` は B2C 切り替えまで境界を変えず、新しい B2C メトリクスと数値を直接比較しない。

[ADR-0027](../adr/0027-payment-timeout-boundaries.md) により、Purchase 確定 API は Fake Payment API の同期結果を最大 3 秒待ち、API 全体では 5 秒の application processing deadline を持つ。5 秒は socket を切断する server timeout ではなく、契約準拠応答または 5xx を返すためのアプリケーション処理期限である。通常は `onResponse`、Customer が切断した場合は `onRequestAbort` で計測を閉じ、`onTimeout` は将来 server timeout を有効化した場合の防御的な終端として維持する。

3 秒以内に決済結果を確定できない場合は、Aurora PostgreSQL で `payment_unknown` を commit した後に HTTP `202 Accepted` を返す。この応答は契約どおりの技術的成功として Purchase 確定 API の SLO 用 p95 に含める。5 秒以内に状態を commit して応答できず Customer へ 5xx / timeout を返した場合は `technical_failure` とする。3 秒 cutoff により同期依存の劣化が p95 ではなく `payment_unknown` 件数の増加として現れる場合があるため、両方を併用して監視する。

| 境界 | 目標値 | 観測上の役割 |
| --- | --- | --- |
| Fake Payment API outbound response deadline | 3 秒 | 超過または transport / HTTP 5xx を `payment_unknown` 件数で観測する |
| Purchase 確定 API application processing deadline | 5 秒 | 5xx / timeout を同期 API SLI と購入ジャーニーの `technical_failure` で観測する |
| Amazon CloudFront origin response timeout | 30 秒 | `OriginLatency` / `5xxErrorRate` と k6 でエッジ側の異常を観測する |
| Application Load Balancer idle timeout | 60 秒 | `TargetResponseTime` / `HTTPCode_ELB_5XX_Count` で接続境界の異常を観測する |
| Fastify target keep-alive timeout | 60 秒より長い値 | Application Load Balancer より先に接続を閉じる競合を防ぐ |
| stale `payment_processing` 回収閾値 | 60 秒 | API 停止後に残った attempt の滞留時間と Worker 回収時間を観測する |

DB connection の取得待ちは、処理時点で残っている application processing deadline より短くする。現行の `connectionTimeoutMillis=5000` は 5 秒の処理期限と同値であり、B2C 実装時に変更する。具体値、Worker 走査間隔、Reconciliation backoff、Alarm 閾値と severity は staging full の測定結果から決定する。

#### 決済結果解決時間の計測境界と SLO

[ADR-0026](../adr/0026-measure-payment-resolution-per-attempt.md) により、決済結果解決時間は 1 payment attempt を単位にする。payment attempt は、プラットフォームが Ticket Hold を `payment_processing` へ原子的に遷移させて受理した 1 エピソードである。開始と終了には、それぞれの状態遷移 UPDATE 文の実行時点に Aurora PostgreSQL が生成する時刻を使用する。

レイテンシメトリクスは `Service` と `ResolutionPath` を dimension に持つ。正式な SLO は `Service=api`、`ResolutionPath=sync` で仕様どおり `authorized` または `declined` へ確定した attempt の p95 とする。`ResolutionPath=reconciled` は Amazon CloudWatch Dashboard、件数、滞留時間による検証指標とし、具体的な SLO 目標値は staging full の実測後に決定する。sync 全体の percentile を維持するため、レイテンシメトリクスへ `Outcome` dimension は追加しない。

決済試行の結果件数メトリクスは `Service` と `Outcome` を dimension に持ち、`authorized`、`declined`、`unresolved_timeout` を記録する。`unresolved_timeout` は右側打ち切りサンプルのためレイテンシメトリクスを emit せず、ADR-0022 の `technical_failure` と件数 Alarm で扱う。`payment_failed` は 3 回目の `declined` 後の Hold / Purchase Session 終端であり、payment attempt の Outcome には含めない。

終端状態遷移の条件付き UPDATE で affected rows が 1 になり、commit に成功した API または Worker だけが Amazon CloudWatch Embedded Metric Format を at-most-once で出力する。計測専用の recorded flag と transactional outbox は使用せず、commit 後の稀な欠損とログ配送層の稀な重複を許容する。payment attempt の識別子は構造化ログ属性にだけ含める。

| 劣化モード | 検知手段 |
| --- | --- |
| 同期決済の解決遅延 | `ResolutionPath=sync` の p95 |
| 3 秒 cutoff による `payment_unknown` 増加 | `payment_unknown` 件数の Amazon CloudWatch Alarm。Alarm は維持し、閾値と severity は staging full の通常時発生率から決定する |
| Payment Reconciliation Worker の遅延・停止 | `payment_processing` / `payment_unknown` の滞留時間に対する Amazon CloudWatch Alarm |
| 15 分後も未解決 | `unresolved_timeout` 件数、購入ジャーニーの `technical_failure`、運用エスカレーション |
| EMF の欠損 | Aurora PostgreSQL の解決済み attempt 件数と結果件数メトリクスの突き合わせ。運用方法は後続 Issue |

## CloudWatch アラーム（Issue #218）

SRE の Four Golden Signals（Errors / Availability / Saturation / Latency 相当）を、既存パターン（sqs モジュールの DLQ アラーム）に倣い「リソースを所有する terraform モジュール内に配置し、`alarm_actions` を root module から注入」する形で実装している。全アラームの通知先は observability モジュールのアラート用 SNS トピック（`<name>-alerts` → email。L-5 / Issue #200）で、ALARM / OK 両遷移を通知する。

| アラーム | 所有モジュール | メトリクス | 条件 | 意図 |
| --- | --- | --- | --- | --- |
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

- SNS email subscription（`komurayoshitodesu@gmail.com`）は検証時点で `PendingConfirmation` のまま（L-5 / Issue #200 と同じ既知の制約）。SNS への publish（action 実行）自体は全アラームで `Successfully executed` を確認済みのため、配線としては完成している。次回 apply 時に届く確認メールを Confirm すれば以降のメール配信が有効になる。
- 新規作成した CloudWatch アラームは、作成直後の初回評価までに数分〜十数分のラグが観測された（`no datapoints were received` の状態が続いた後に実データで評価される）。実発火試験ではこのラグを見込んで負荷を維持し続けた。
- 既存の DLQ 滞留アラーム（`ticket-c2c-dev-search-projection-dlq-messages-visible`、L-5 / Issue #200）は本検証中 `OK` のまま維持され、配線・動作に影響がないことを確認した。
- 実地検証で発生した検証用データ（signup ユーザー・test event 等）は dev の test data 方針（`smoke-test.ts` と同様、削除せず destroy まで残置）に従い、そのまま dev destroy まで残す。

## エッジ監視アラーム（CloudFront / WAF。L-16 / Issue #252）

CloudFront / WAF（scope=CLOUDFRONT）のメトリクスは us-east-1 にのみ発行され、CloudWatch alarm の `alarm_actions` は同一リージョンの SNS トピックしか指定できないため、これら 3 アラームと通知先 SNS トピック（`<name>-edge-alerts` → email、`alert_email` 変数を再利用）は observability モジュールではなく各環境 root（`terraform/environments/{dev,staging}/main.tf`）に `aws.us_east_1` provider で直接定義する（既存の ACM 証明書・WAFv2 WebACL・CloudFront ログ配信と同じ配置パターン。設計判断の経緯は `production-readiness.md` L-16 行を参照）。

| アラーム | メトリクス | 条件 | severity | 意図 |
| --- | --- | --- | --- | --- |
| `<name>-cloudfront-5xx-rate` | `AWS/CloudFront` `5xxErrorRate` + `Requests`（metric math: `IF(Requests>=10, 5xxErrorRate, 0)`） | > 5% / 5 分 x 2 期間（10 分継続） | Critical | Errors: ユーザー入口の広範な障害。ADR-0017 と同じ低トラフィックガード付き割合パターン |
| `<name>-cloudfront-origin-latency` | `AWS/CloudFront` `OriginLatency`（p90） | > 2000 ms / 5 分 x 3 期間（15 分継続） | Warning | Latency: 購入 API p95（ADR-0017）が未カバーの経路（検索・イベント一覧・SSR）を含む全経路のバックエンド遅延 |
| `<name>-waf-block` | `AWS/WAFV2` `BlockedRequests`（WebACL + Rule=ALL） | Sum >= 50 件 / 5 分 x 1 期間（即時） | Warning | Security: 攻撃兆候の即時検知。割合ガードは初動を遅らせるため絶対数で評価 |

- **`aws_cloudfront_monitoring_subscription`（有料アドオン）**: `OriginLatency` 等の additional metrics の有効化に必要なため採用する。distribution 単位の定額課金だが、dev / staging とも destroy 前提運用のため実費は僅少（L-16 設計判断）。
- **CloudFront メトリクスの dimension**: `DistributionId` + `Region="Global"`。WAF（scope=CLOUDFRONT）のメトリクスには `Region` dimension が付かず、`WebACL`（metric name）+ `Rule="ALL"` で web ACL 全体のブロック数を集計する。
- 3 アラームとも `treat_missing_data = notBreaching`（destroy 運用・トラフィックゼロは正常状態。ADR-0017 パターン踏襲）。ALARM / OK 両遷移を us-east-1 側 SNS トピックへ通知する。
- severity プレフィックス（`[Critical]` / `[Warning]`）を `alarm_description` に付与済み（Issue #257 の後続 TODO 2 を本実装で適用）。

## CloudFront 経由の外形監視（synthetic monitoring。Issue #256）

内部メトリクス（ALB / ECS / Aurora / EMF / 購入 API SLO）とは別に、実ユーザーに近い入口（CloudFront）から代表 read-only 経路が実際に到達可能かを定期的に確認する外形監視を `terraform/modules/synthetics-canary` で実装している。EventBridge + Lambda の自前実装ではなく、**CloudWatch Synthetics canary の組み込みマルチステップ機能（`executeHttpStep`）を使う**（設計判断確定済み）。

### 監視対象

1 つの canary（multi-step API canary）が、CloudFront の alias ドメイン（`app_fqdn`）に対して以下 3 endpoint を順に GET する。いずれか 1 つでも 2xx 以外を返すと canary 全体が失敗として記録される。

| step | path | 内容 |
| --- | --- | --- |
| `healthzCheck` | `/api/healthz` | `/healthz` 相当の軽量到達確認（DB 等の依存に触れない liveness） |
| `frontendHtmlCheck` | `/` | frontend（Next.js SSR）の HTML 到達確認 |
| `apiReadEndpointCheck` | `/api/events` | API の代表 read endpoint（認証不要。L-10 参照） |

`/api/*` は CloudFront のパスルーティング経由でアプリの `stripApiPrefix`（`src/api-prefix.ts`）が `/api` プレフィックスを吸収し、既存ルート（`/healthz` / `/events`）へ写像される（ADR-0011 決定 2）。**認証・secret を要する操作は対象外**（read-only に限定。副作用のある操作は Issue #256 の補足どおりスコープ外）。

### 実行頻度・コスト影響

- 実行頻度: 5 分間隔（`rate(5 minutes)`）。
- CloudWatch Synthetics の課金は 1 canary run あたり約 $0.0012。5 分間隔で 24 時間稼働し続けた場合 288 run/日 ≈ $0.35/日 ≈ 月換算 $10 程度になるが、dev / staging は destroy 前提運用のため実際の課金対象時間は環境が稼働している期間のみに限られ、実費は僅少（cf_logs / waf_logs 等の既存 destroy 前提リソースと同じ考え方）。
- アーティファクト（実行ログ・HAR ファイル）用 S3 バケット（`<name>-synthetics-artifacts`）は 30 日で自動失効するライフサイクルルールを設定（cf_logs / waf_logs と同じ保持期間）。

### リージョン配置と通知配線

canary 自体・失敗アラームは **us-east-1** に作成する。理由は L-16 / Issue #252 の CloudFront / WAF エッジアラームと同じ: canary はテスト対象（CloudFront）と異なるリージョンでも実行できるが、canary のメトリクス（`CloudWatchSynthetics` namespace の `SuccessPercent` / `Duration`）は canary が作成されたリージョンに乗り、CloudWatch alarm の `alarm_actions` は同一リージョンの SNS トピックしか指定できない。そのため既存の us-east-1 側 SNS トピック（`<name>-edge-alerts`）をそのまま再利用できるよう canary も us-east-1 に作成する。

| アラーム | メトリクス | 条件 | severity | 意図 |
|---|---|---|---|---|
| `<name>-synthetic-check-failure` | `CloudWatchSynthetics` `SuccessPercent`（dimension: CanaryName） | Average < 100 / 5 分 x 2 期間（10 分継続） | Critical | Errors: CloudFront 経由のユーザー入口そのものの到達性喪失を検知。単発のネットワーク瞬断による誤発火を避けるため 2 期間継続を条件にする（`cloudfront-5xx-rate` と同じパターン） |

`treat_missing_data = notBreaching`（destroy 運用・canary 未稼働時はデータ点自体が出ないため）。ALARM / OK 両遷移を us-east-1 側 SNS トピック（`<name>-edge-alerts`）へ通知する。発報時の初動対応は [`docs/runbooks/alarm-synthetic-check-failure.md`](../runbooks/alarm-synthetic-check-failure.md)（Issue #272）を参照。severity は Critical（`docs/architecture/observability.md`「アラームの severity と escalation 方針」節参照）: CloudFront 経由の代表 read-only 経路の失敗は、内部メトリクスでは検知できない外形障害（DNS / CDN / WAF 誤設定など）を捕捉する最終防衛線であり、ユーザー入口そのものが死んでいるシグナルであるため。

### destroy 運用での残存リソース対策（Terraform 定義済み、実地未検証）

canary 本体（`aws_synthetics_canary`）・IAM 実行ロール・アーティファクト S3 バケット（`force_destroy = true`）はすべて Terraform 管理下にあり、`terraform destroy` で削除される設計にしている。canary 作成時に AWS 側が暗黙的に作る補助リソース（Lambda 関数・レイヤー等）も、`delete_lambda = true` を明示設定し canary 本体の削除に道連れで削除されるようにした（既定値 `false` のままだと canary 削除後もこれらが残存し、destroy 前提運用の受け入れ条件と矛盾するバグになる。第三者レビュー指摘で修正）。

**この節の内容は Terraform コード上の設計であり、実際に apply → destroy して残存リソースがないことを確認したものではない**（「AWS リソースは実際に作らない」方針のため、Issue #256 実装時点では未検証）。実地検証（apply 後の canary 稼働確認・destroy 後の残存リソースなしの確認）は次回 dev / staging apply の機会に行う。[AWS Synthetics DeleteCanary のドキュメント](https://docs.aws.amazon.com/AmazonSynthetics/latest/APIReference/API_DeleteCanary.html)も参照。

### staging の `alb-http-only` モードでの扱い

staging は `public_endpoint_mode=alb-http-only` の場合 CloudFront / `app_fqdn` が存在しないため、canary モジュール呼び出し自体を `count = local.https_enabled ? 1 : 0` で条件化し、この場合は canary を作成しない（dev は CloudFront が常設のため無条件で作成する）。

### 検証

`terraform fmt -check -recursive terraform` と dev / staging / bootstrap 全 root の `terraform validate` が通ることを確認済み。加えて `terraform plan -target=module.synthetic_check`（dev / staging 両方、実バックエンドに対して実行。両環境とも現在 destroy 済みのため空 state からの計画）で、S3 バケット・IAM ロール・canary 本体・失敗アラームの計 9 リソースがエラーなく作成計画されることを確認した（canary スクリプトの zip 化（`archive_file`）も実際にファイルハッシュを計算し成功している）。bootstrap 側の apply ロール IAM ポリシー変更（`synthetics:*` 系アクション・`iam:PassRole` の追加）も `terraform plan -target=module.github_oidc` で意図どおりの追加差分のみ（既存権限の削除なし）であることを確認した。**AWS リソースは実際に作らない方針のため、今回は apply しない**。Issue #256 の受け入れ条件にある「dev または staging での synthetic check 成功と alarm action 配線確認結果」は今回スキップした。実際の稼働確認・配線確認は次回 dev / staging apply の機会に行う。

## CloudWatch Dashboard（初動確認用。Issue #253）

障害発報時に、入口（CloudFront / WAF）→ ALB → ECS（API / Worker / Frontend）→ Aurora → 非同期処理（Valkey fail-open / Worker lag / SQS DLQ）→ 購入 API SLO までを 1 画面で横断確認できる Dashboard を `terraform/modules/dashboard` で定義している。最初の Dashboard は prod 運用の初動確認に絞り、詳細分析用の大量 widget は追加していない（Issue #253 の受け入れ条件）。

- **Dashboard 名**: `<name>-overview`（例: `ticket-c2c-dev-overview` / `ticket-c2c-staging-overview`）。既存リソースの命名規則（`${var.name}-...`）を踏襲しており、dev / staging で衝突しない。
- **配置**: `terraform/environments/{dev,staging}/main.tf` から `module "dashboard"` として、ALB / ECS / Aurora / SQS / CloudFront / WAF の各モジュール出力（arn_suffix・サービス名・クラスタ識別子等）を渡して呼び出す。Dashboard リソース自体は東京リージョン（デフォルト provider）に 1 つ作成する。
- **CloudFront / WAF widget の region 切り替え**: CloudWatch dashboard は widget ごとに `properties.region` を個別指定できるため、Dashboard リソースを us-east-1 provider で作り直す必要はない。CloudFront / WAF（L-16 / Issue #252 と同じ理由で us-east-1 にのみメトリクスが発行される）の widget だけ `region: "us-east-1"` を指定し、他の widget は東京リージョンのまま同じ画面に並べている。
- **staging の `alb-http-only` モード**: staging は `public_endpoint_mode` によって frontend / CloudFront / WAF が存在しない構成（`alb-http-only`）がありうる。この場合、dashboard モジュールは該当 output が `null` で渡ってくることを検知し、edge widget（CloudFront / WAF の 2 枚）と frontend 関連の metric（unhealthy hosts・CPU・Memory の frontend 系列）を自動的に省略する。dev は CloudFront / frontend が常設のため、常に全 widget が表示される。
- **dashboard_body の実装方法**: `aws_cloudwatch_dashboard` の `dashboard_body` は、HCL のオブジェクト/tuple リテラル + `jsonencode()` ではなく、JSON テンプレート（`terraform/modules/dashboard/templates/dashboard.json.tftpl`）+ `templatefile()` で組み立てている。widget ごとに `properties` の attribute 集合が異なる（`yAxis` の有無、`annotations` の有無等）ため、HCL 側で `has_edge ? [...] : []` のような条件分岐を書くと、tuple 型統一の際に「異なる属性を持つオブジェクトの unify に失敗する」（`Inconsistent conditional result types`）エラーになる。text template（`%{if}...%{endif}` ディレクティブ）なら文字列結合の問題に単純化でき、この制約を回避できる。

### widget 構成

| widget | 内容 | 対応する CloudWatch アラーム |
| --- | --- | --- |
| タイトル（text） | Dashboard の説明、severity 方針・runbook への導線 | - |
| CloudFront: Requests / 5xxErrorRate（edge 構築時のみ） | リクエスト数と 5xx 率 | `<name>-cloudfront-5xx-rate` |
| CloudFront Origin Latency (p90) / WAF BlockedRequests（edge 構築時のみ） | オリジン遅延と WAF ブロック数 | `<name>-cloudfront-origin-latency` / `<name>-waf-block` |
| ALB: 5xx / UnHealthyHostCount | ALB 5xx 応答と unhealthy ターゲット数（api / frontend） | `<name>-alb-5xx` / `<name>-alb-{api,frontend}-unhealthy-hosts` |
| ECS CPUUtilization | api / worker / frontend の CPU 使用率 | `<service>-cpu-high` |
| ECS MemoryUtilization | api / worker / frontend のメモリ使用率 | `<service>-memory-high` |
| Aurora: CPUUtilization / ServerlessDatabaseCapacity | Aurora の CPU と ACU 使用状況 | `<name>-aurora-cpu-high` / `<name>-aurora-acu-near-max` |
| Aurora: FreeableMemory / DatabaseConnections | Aurora の空きメモリと接続数 | `<name>-aurora-freeable-memory-low` / `<name>-aurora-connections-high` |
| ValkeyFailOpen / WorkerProcessingLagMs (EMF) | 前段フィルタのフェイルオープンと Worker 処理遅延 | `<name>-valkey-fail-open` / `<name>-worker-processing-lag` |
| SQS DLQ: ApproximateNumberOfMessagesVisible | DLQ 滞留状況 | `<name>-search-projection-dlq-messages-visible` |
| 購入 API: 成功率 / technical_failure | `PurchaseRequestOutcome` から算出した成功率（%）と technical_failure 件数。成功率 SLO（99.5%）を水平 annotation で表示 | `<name>-purchase-error-burn-rate-{fast,slow}` / `<name>-purchase-technical-failure-{weak,normal}` |
| 購入 API: レイテンシ p95 | `PurchaseRequestLatencyMs`（Outcome=success）の p95。レイテンシ SLO（800ms）を水平 annotation で表示 | `<name>-purchase-latency-burn-rate-{fast,slow}` |

### 確認方法

CloudWatch コンソール → Dashboards → `<name>-overview` で開く。障害発報時は、まずこの Dashboard で「入口（edge）→ ALB → ECS → Aurora → 非同期処理 → 購入 API SLO」のどの層で異常が出ているかを一目で確認し、該当する widget に対応するアラーム名から `docs/runbooks/`（Issue #254）の runbook を開いて初動対応に入る。

### 検証

`terraform fmt -check -recursive terraform` と dev / staging 両 root の `terraform validate` が通ることを確認済み。加えて、`dashboard_body`（JSON テンプレート）が `has_edge` / `has_frontend` の 4 通りの組み合わせ（true/true, true/false, false/true, false/false）すべてで妥当な JSON にレンダリングされ、widget 数が期待どおり（edge 込み 12 枚 / edge 抜き 10 枚）になることをローカルの `templatefile()` 単体レンダリングで確認した。**AWS リソースは実際に作らない方針のため、実 apply による表示確認は今回スキップしている**（`terraform plan` で `module.dashboard.aws_cloudwatch_dashboard.main` が dev / staging 両方でエラーなく作成計画されることは確認済み）。実際の表示確認は、次に dev または staging を apply する機会に行う。

## アラームの severity と escalation 方針（Issue #257）

prod 化前に、CloudWatch アラームをどの緊急度で扱うかを明文化する。現時点では通知経路（Terraform）は変更せず、運用方針のドキュメント化のみ行う。

### 対象アラームの総数

**既存 22 本 + edge alarms 3 本（#252 実装済み） + synthetic alarm 1 本（#256 実装済み）**。

- 既存 22 本の内訳: observability モジュール 8 本（EMF 2 本 + 購入 API SLO burn-rate 6 本）+ alb 3 本 + ecs-service 6 本（api / worker / frontend × cpu / memory）+ aurora 4 本 + sqs 1 本。
- `#252`（L-16、CloudFront / WAF edge、us-east-1）: `cloudfront-5xx-rate` / `cloudfront-origin-latency` / `waf-block` の 3 本（実装済み。上記「エッジ監視アラーム」節参照）。
- `#256`（synthetic monitoring、CloudFront 経由の外形監視）: `<name>-synthetic-check-failure` の 1 本（実装済み。上記「CloudFront 経由の外形監視」節参照）。単一の multi-step canary が healthz 相当・frontend HTML・API 代表 read endpoint の 3 step を実行し、いずれか 1 つでも失敗すると canary 全体が失敗として記録される（`SuccessPercent` メトリクス 1 系列）ため、エンドポイント別の複数アラームには分割していない。
- アラーム総数は今後の Issue 実装で変わりうるため、本ドキュメント・`production-readiness.md` を都度更新する前提で、絶対数ではなく上記の内訳表記で管理する。

### severity 3 段階（Critical / Warning / Info）

Google SRE の burn-rate 設計（fast burn ≒ page 相当、slow burn ≒ ticket 相当）と、ADR-0017 の `-weak` / `-normal` 命名が自然に 3 段階へ写像できるため、3 段階を採用する。2 段階では「weak（初動不要の早期シグナル）」の受け皿がなくなる。

- **Critical** — ユーザー影響が確定、または中核フロー（購入）の保護層喪失、またはユーザー入口そのものの到達性喪失。放置すると影響が拡大する。
- **Warning** — ユーザー影響の予兆・持続的劣化・容量逼迫。当日〜24h 以内の確認で足りる。ただし下記「併発エスカレーション」の条件が成立した場合は Critical として扱う。
- **Info** — 早期シグナル・傾向監視。単発では対応不要、頻度をレビューする。

| severity | アラーム |
| --- | --- |
| **Critical** | `purchase-error-burn-rate-fast` / `alb-5xx` / `valkey-fail-open` / `aurora-freeable-memory-low` / `cloudfront-5xx-rate`（#252） / `synthetic-check-failure`（#256） |
| **Warning（基本）** | `alb-api-unhealthy-hosts` / `alb-frontend-unhealthy-hosts` / `aurora-cpu-high` / `aurora-connections-high` / `aurora-acu-near-max` / `purchase-error-burn-rate-slow` / `purchase-latency-burn-rate-fast` / `purchase-latency-burn-rate-slow` / `purchase-technical-failure-normal` / `worker-processing-lag` / `search-projection-dlq-messages-visible` / `{api,worker,frontend}-{cpu,memory}-high`（6 本） / `cloudfront-origin-latency`・`waf-block`（#252） |
| **Info** | `purchase-technical-failure-weak` |

分類根拠の要点:

- `valkey-fail-open` を Critical にするのは、oversold 自体は DB 層で防御されるものの、購入フロー保護層（レート制限・売り切れ前段拒否）がサイレントに無効化され Aurora が無防備になるため。アラーム設計自体も「1 件で即 ALARM」の思想（本ドキュメント上記「ValkeyFailOpen」節参照）。
- `aurora-freeable-memory-low` は OOM →クラスタ不安定化の直前指標のため、Saturation 系で唯一 Critical。他の Saturation（CPU / ACU / 接続数）は劣化の予兆であり Warning（下記「併発エスカレーション」参照）。
- `purchase-latency-burn-rate-{fast,slow}` は「遅いが失敗していない」ため Warning（購入が失敗する error 系との差別化。ADR-0017 の役割分担どおり）。
- `synthetic-check-failure`（#256）を Critical とするのは、CloudFront 経由の代表 read-only 経路（healthz / frontend / API read endpoint）の失敗はユーザー入口そのものが死んでいるシグナルであり、内部メトリクスでは検知できない外形障害（DNS / CDN / WAF 誤設定など）を捕捉する最終防衛線であるため。
- `waf-block` は「WAF が防御に成功している」シグナル。即時検知（1 期間）は #252 の設計どおり維持しつつ、対応 severity としては Warning（当日中に攻撃パターンを確認する）。
- DLQ 滞留は「データはまだ失われていない（redrive 可能）」ため Warning。

### 併発エスカレーション運用（Terraform 実装なし、ドキュメントのみ）

`unhealthy-hosts` 系・Aurora 容量系は、実際の Composite Alarm（Terraform 実装）を追加しない。ADR-0017 が composite alarm（追加コスト $0.50/月/個）を「規模に対して過剰」として明示的に不採用にした前例（`docs/adr/0017-purchase-api-slo-burn-rate.md`）と整合させ、同じ判断を踏襲する。代わりに、通知受信時の確認手順として以下の運用ガイドラインをドキュメントで定義する。

**`alb-api-unhealthy-hosts` / `alb-frontend-unhealthy-hosts`**:

- staging には `capacity_profile=full`（AZ 跨ぎ failover 検証用。`terraform/environments/staging/main.tf`、`api_desired_count=2` / `worker_desired_count=2` / `frontend_desired_count=2`）が存在する。2 タスク構成では 1 台 unhealthy は即ユーザー影響ではなく縮退（degraded capacity、残り 1 台で捌けている状態）であるケースがあるため、基本 severity は **Warning**。
- **`alb-5xx` アラームが同時に ALARM 状態の場合は、Critical として扱う**（= unhealthy host が実際に 5xx を生んでいる = ユーザー影響が確定している状態）。

**`aurora-cpu-high` / `aurora-connections-high` / `aurora-acu-near-max`**:

- 基本 severity は **Warning**（容量逼迫の予兆であり、それ単体では応答が返せていないとは限らない）。
- **`purchase-error-burn-rate-fast`、`alb-5xx`、`synthetic-check-failure`（#256）のいずれかと同時に ALARM 状態の場合は、Critical へ格上げする**（= 容量逼迫が実際に購入 API の失敗・5xx・外形監視失敗という形でユーザー影響に転化している状態）。3 つのうちどれと併発しているかで一次切り分けの当たりがつけられる（例: `purchase-error-burn-rate-fast` と併発なら DB プール枯渇が濃厚）。

**確認方法**: 自動化はしない。CloudWatch アラームコンソール、または `aws cloudwatch describe-alarms --state-value ALARM` で該当アラームの状態を目視確認する。

### 通知チャネル: SNS email 1 系統を維持

現状の SNS email 1 系統（`<name>-alerts`、`docs/architecture/observability.md` 上記「CloudWatch アラーム」節参照）を維持する。理由:

1. 対応者が本人 1 名・通知先メールアドレス 1 つで、チャネルを分けても「読む人・読む場所」が同じ。ルーティングの分岐が意味を持たない。
2. dev / staging は destroy 運用が正常状態で、環境稼働中 = 本人が作業中である蓋然性が高く、email の確認遅延が実害になりにくい。
3. トピック分割は apply ごとの subscription Confirm 作業を系統数分に増やす（destroy 運用と相性が悪い）。
4. ADR-0017・L-16（`production-readiness.md`）の「規模に対して過剰な構成は採らない」前例と整合。

severity の区別は通知経路ではなく `alarm_description` の severity プレフィックス（後述 TODO）で email 件名 / 本文から判別できるようにする。併発エスカレーション（前節）の判断も、通知経路の自動分岐ではなく「本人が受信メールを読んだ際に severity 再判定する」運用手順として位置づける（= Terraform 側の `alarm_actions` は分岐させない）。

**prod 化時の再検討条件**（いずれか成立で複数トピック分割を再検討）:

- 実ユーザー・実トラフィックを伴う常設 prod 運用を開始する（destroy 運用でなくなる）。
- 対応者が 2 名以上になる、またはオンコール輪番が発生する。
- Critical の見逃し・気づき遅れが実際に発生する（下記の初動目標の超過が観測される）。
- アラーム本数増で email が Critical を埋もれさせるノイズ量になる（目安: Info / Warning 通知が週 10 件超）。

**導入判断基準**:

- **複数 SNS トピック（critical / non-critical の 2 分割）**: 上記条件成立時の第一選択。追加コストほぼゼロ、Terraform 変更も小さい。
- **Slack**: 「通知の既読管理・スレッドでの対応記録」が必要になった時点（= 対応者 2 名以上）。それまでは email で十分。
- **PagerDuty 等のインシデント管理 SaaS**: SLA を伴う商用運用・オンコール輪番が発生するまで**不採用**。個人規模では過剰（ADR-0011 のポートフォリオ主目的とも不整合）。

### エスカレーション表

対応者は全 severity で本人 1 名。したがって「人へのエスカレーション」ではなく「アクションのエスカレーション（severity 昇格・対処強度の引き上げ）」として定義する。

| severity | 確認タイミング | 初動目標 | エスカレーション条件 |
| --- | --- | --- | --- |
| **Critical** | 通知受信次第（即時） | 1 時間以内に状況確認開始。直近デプロイ起因なら rollback を第一手段とする | ALARM が 1 時間以上 OK 復帰しない → 影響範囲を記録し、復旧を最優先タスク化（他作業中断） |
| **Warning** | 24 時間以内 | 24 時間以内に原因確認・対応要否判断 | ①同一アラームが 1 週間に 3 回以上発報 → 恒久対策を Issue 化。②OK 復帰せず 24 時間継続 → Critical 相当として扱う。③上記「併発エスカレーション」の条件が成立 → 24 時間待たず直ちに Critical として扱う |
| **Info** | 次回作業セッション時（数日以内） | 対応不要。傾向として記録 | `-weak` が短期間に繰り返し発報（目安: 24 時間に 3 回以上）→ 対応する normal / burn-rate 系アラームと同等（Warning）として調査。normal 側が同時発報していれば Info 通知は無視してよい |

destroy 運用中（環境非稼働）はアラーム自体が発生しないため、この表は「環境稼働期間中」の運用定義である。prod 常設化した場合、Critical の初動目標のみ再検討対象（夜間対応をどうするか）になる。

Critical 通知（`alb-5xx`、`purchase-error-burn-rate-fast`、`synthetic-check-failure`）を受信した際は、CloudWatch コンソールで同時刻の Warning 系（`unhealthy-hosts`、Aurora 容量系）の ALARM 状態も併せて確認し、併発していれば根本原因の当たりをつける（前節「併発エスカレーション運用」参照）。

### `-weak` 命名規約

`-weak` サフィックス（実例: `purchase-technical-failure-weak`）は Info tier の命名規約として正式化する。「低トラフィックガードの隙間を埋める早期シグナルで、単発発報に初動は不要」という ADR-0017 の設計意図と一致する。対になる `-normal`（無サフィックス側）は Warning。`purchase-technical-failure-weak`（Info）が先に鳴り、持続すれば `-normal`（Warning）や `burn-rate-fast`（Critical）が追随する、という段階的エスカレーションの入口として位置づける。

既存アラームのリネームはしない（実地検証記録・ドキュメントとの整合を壊すため）。severity はこの節の対応表 + `alarm_description` のプレフィックス（後述 TODO）で表現する。

### 後続 TODO（Terraform 変更、別 Issue に切り出す粒度）

1. ~~全アラームの `alarm_description` に severity プレフィックス（`[Critical]` / `[Warning]` / `[Info]`）を付与する。email 件名 / 本文での判別性向上が目的。低リスク・plan 差分は description のみ。~~ → 2026-07-11 対応済み（Issue #272。既存 22 本（observability 8 / alb 3 / ecs-service 6 / aurora 4 / sqs 1）へ本節の分類どおり `[Critical]`×4 / `[Warning]`×17 / `[Info]`×1 を付与。edge 3 本・synthetic 1 本は実装時に付与済みのため変更なし。`alarm_description` 以外の属性は無変更で、plan 差分が description のみであることを dev / staging / bootstrap の plan で確認。実環境への apply・実発火確認は未実施で、次回 dev / staging apply の実地検証時に確認する）。
2. ~~#252 実装時、us-east-1 の 3 アラームへ本節の分類（`cloudfront-5xx-rate` = Critical、`cloudfront-origin-latency` / `waf-block` = Warning）を適用する。~~（#252 で適用済み。3 アラームの `alarm_description` に severity プレフィックス付与済み）
3. ~~#256 実装時、synthetic monitoring のアラーム構成（単一 / 複数）が決まり次第、本節の Critical 行を実アラーム名に更新する。~~ → 2026-07-11 対応済み（Issue #256。単一 canary・`<name>-synthetic-check-failure` の 1 本として実装し、本節の表・分類根拠を実アラーム名に更新した）。
4. （prod 化時・再検討条件成立時のみ）SNS トピックの critical / non-critical 2 分割。observability モジュールの `alarm_action_arns` を severity 別 map に拡張する。
5. 併発エスカレーション基準（`unhealthy-hosts` × `alb-5xx`、Aurora 容量系 × `purchase-error-burn-rate-fast` / `alb-5xx` / `synthetic-check-failure`）はドキュメント記載のみで自動化しない。将来 Composite Alarm や EventBridge によるアラーム相関の自動化を検討する場合は、ADR-0017 の不採用判断を覆す理由（コスト対効果の再評価）を伴う別 ADR として起票する。

## アラーム対応 runbook（Issue #254）

CloudWatch アラーム発報時の初動確認・切り分け・復旧判断は `docs/runbooks/` に runbook として整備している。各 runbook は影響範囲・初動確認・主な原因候補・確認コマンド・復旧/緩和の判断・エスカレーション条件を記載し、severity・エスカレーション条件は本ドキュメントの「アラームの severity と escalation 方針（Issue #257）」節と整合させている。

| アラーム群 | runbook |
| --- | --- |
| 購入 API SLO / burn-rate / technical_failure | [`docs/runbooks/alarm-purchase-api-slo.md`](../runbooks/alarm-purchase-api-slo.md) |
| ALB 5xx / unhealthy hosts | [`docs/runbooks/alarm-alb.md`](../runbooks/alarm-alb.md) |
| ECS CPU / Memory（api / worker / frontend） | [`docs/runbooks/alarm-ecs-cpu-memory.md`](../runbooks/alarm-ecs-cpu-memory.md) |
| Aurora CPU / memory / connections / ACU near max | [`docs/runbooks/alarm-aurora.md`](../runbooks/alarm-aurora.md) |
| ValkeyFailOpen | [`docs/runbooks/alarm-valkey-fail-open.md`](../runbooks/alarm-valkey-fail-open.md) |
| WorkerProcessingLagMs | [`docs/runbooks/alarm-worker-processing-lag.md`](../runbooks/alarm-worker-processing-lag.md) |
| SQS DLQ 滞留 | [`docs/runbooks/alarm-sqs-dlq.md`](../runbooks/alarm-sqs-dlq.md) |
| CloudFront / WAF edge（L-16 / Issue #252） | [`docs/runbooks/alarm-cloudfront-waf-edge.md`](../runbooks/alarm-cloudfront-waf-edge.md) |
| synthetic-check-failure（L-19 / Issue #256、runbook は Issue #272） | [`docs/runbooks/alarm-synthetic-check-failure.md`](../runbooks/alarm-synthetic-check-failure.md) |

secret / credential 値の出力に注意が必要な手順（Aurora マスター認証情報の取り扱い等）は該当 runbook にその旨を明記している。フォーマットは既存の `docs/runbooks/jwt-secret-rotation.md` を踏襲している。

## 環境変数一覧

| 変数 | 例 | 説明 |
| --- | --- | --- |
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
