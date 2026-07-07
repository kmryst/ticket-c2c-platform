# 0014. AWS X-Ray 分散トレーシングを OpenTelemetry SDK + ADOT collector sidecar で導入する

## ステータス

Accepted

## 日付

2026-07-07

## 背景

購入フローは HTTP → API（NestJS）→ PostgreSQL / Valkey → EventBridge → SQS → Worker → OpenSearch と複数コンポーネントを跨ぐが、これまでリクエストを横断して追跡する手段がなく、障害・遅延の切り分けは CloudWatch Logs の突き合わせに依存していた。特に「API では確定したのに検索結果に出ない」「p99 が悪化したがどの区間か分からない」といった調査で、時刻とログ本文を目視で突き合わせる必要があった。

また、購入判定（confirmed / rejected）、Valkey fail-open（前段フィルタ障害時に判定を DB へ流した事象）、Worker の処理遅延といったビジネス上重要な事象が、ログにしか残っておらずメトリクスとして時系列で追えなかった。

トレーシングの導入水準について、軽量な correlation-ID のみの案と X-Ray による本格的な分散トレーシングの二択を提示し、ユーザーが後者を選択した（Issue #203）。

## 決定

1. **OpenTelemetry SDK（`@opentelemetry/sdk-node`）でアプリを計装し、AWS X-Ray へトレースを送る。** 計装対象は http（API の各リクエスト）、pg（購入 transaction の内訳）、ioredis（前段フィルタ・レート制限）、aws-sdk（EventBridge PutEvents / SQS）。TraceId は `AWSXRayIdGenerator`（X-Ray 形式）、propagator は `AWSXRayPropagator`（`X-Amzn-Trace-Id` 形式）を使う。
2. **Exporter はアプリから直接 X-Ray へ送らず、同一 ECS タスク内の ADOT collector sidecar（OTLP/HTTP、localhost:4318）へ送る。** collector が X-Ray への SigV4 署名・バッファリング・リトライを担う。sidecar は `essential = false` とし、collector 停止時はトレースが失われるだけでアプリ本体を巻き込まない。
3. **トレーシングは opt-in（`OTEL_TRACING_ENABLED=true` のときのみ SDK を起動）。** ローカル PoC の既定では何も変わらない。`@opentelemetry/api` は SDK 未起動時 no-op のため、アプリコード内の span / propagation 呼び出しはガードなしで安全に残せる。
4. **EventBridge → SQS を跨ぐ trace 伝搬は、イベント detail 内の予約フィールド `_traceContext` に carrier を同梱する。** EventBridge にはメッセージ属性による trace 伝搬の仕組みがないため。Worker は detail から context を復元し、同じ trace の続きとして CONSUMER span を張る。
5. **サンプリングは OTel 標準の環境変数（`OTEL_TRACES_SAMPLER=parentbased_traceidratio` / `OTEL_TRACES_SAMPLER_ARG`）で制御する。** dev は検証用途のため全量（1.0）、staging は本番相当のため 10%（0.1）。X-Ray の centralized sampling rule は作らない。OTel 標準 sampler からは参照されないため。
6. **ビジネスメトリクス（PurchaseConfirmed / PurchaseRejected / ValkeyFailOpen / WorkerProcessingLagMs）は CloudWatch EMF（stdout への構造化ログ 1 行）で出す。** awslogs ドライバ経由で CloudWatch Logs に届き、CloudWatch がメトリクスを自動抽出する。名前空間は `TicketC2C/<env>`、`METRICS_NAMESPACE` 未設定時は何も出さない（opt-in）。
7. **IAM は task role へ `xray:PutTraceSegments` / `xray:PutTelemetryRecords` の 2 action のみ追加する**（X-Ray 書き込み API はリソースレベル制限非対応のため Resource は `*`）。EMF は追加権限不要。X-Ray console 用に環境ごとの X-Ray group（`service("<name>-api") OR service("<name>-worker")`）を作る。

## 根拠

- **ADOT sidecar 経由にする理由**: アプリを標準 OTLP のままにでき、X-Ray 固有の署名・送信実装（`aws-xray-sdk` 等ベンダー固有 SDK）を持たずに済む。将来バックエンドを変える場合も collector 設定の差し替えで済む。sidecar は AWS 公式イメージ（`public.ecr.aws/aws-observability/aws-otel-collector`、タグ固定）に ECS 用既定設定（OTLP 受信 → X-Ray 転送）が同梱されており、collector 設定ファイルの自前管理が不要。
- **EMF にする理由**: `PutMetricData` の API 呼び出し・IAM 追加・失敗時のハンドリングが一切不要で、メトリクス送信の失敗がアプリの処理を巻き込まない。stdout 1 行のため単体テストでも検証しやすい。
- **detail 同梱で trace を繋ぐ理由**: EventBridge → SQS の経路では SQS メッセージ属性がターゲット設定で引き継がれず、trace header を運ぶ標準手段がない。detail 内フィールドはスキーマ上の追加のみで、Worker 側は未知フィールドとして無視しても後方互換が保たれる（トレーシング無効時はフィールド自体が付かない）。
- **opt-in にする理由**: ローカル PoC（docker compose）には collector がなく、OTLP export の接続エラーがノイズになる。既定 off なら PoC の挙動・出力が一切変わらない（Issue #203 受け入れ条件）。

## 反対材料・トレードオフ

- **sidecar 分のリソース消費**: タスクごとに collector が常駐し、タスク定義の CPU / メモリを共有する。現状のタスクサイズ（0.25 vCPU / 512MB〜）でも collector の既定フットプリントは小さく、dev / staging の検証では問題にならなかった。本番でタスクが逼迫する場合は sidecar へのリソース明示割り当てを検討する。
- **detail への `_traceContext` 同梱はドメインイベントに運搬用フィールドを混ぜる**: イベントスキーマの純粋性は下がる。メッセージ属性で運べる SNS/SQS 直結構成なら不要だが、EventBridge 経由の現構成では他に手段がなく、アンダースコア始まりの予約フィールドとして区別することで許容する。
- **X-Ray centralized sampling を使わないため、サンプリング率の変更に再デプロイが要る**: OTel 標準 sampler は環境変数駆動のため、率の変更はタスク定義の更新（Terraform apply）になる。X-Ray console からの動的変更はできない。トラフィックが読める本リポジトリの用途では許容し、動的制御が要る場合は collector 側の sampling 拡張や X-Ray Remote Sampler の導入を再検討する。
- **deploy workflow はアプリコンテナが `containerDefinitions[0]` にある前提**: `deploy-service.yml` は `.containerDefinitions[0].image` だけを差し替えて新リビジョンを register する。sidecar は index 1 以降に置く規約とし、ecs-service モジュール側にコメントで明記した。

### 検討した代替案

- **correlation-ID のみの軽量案**: リクエスト ID をログに一貫して出すだけの案。実装は小さいが、区間ごとの所要時間・サービスマップ・エラーの局所化は得られず、ログ突き合わせ作業自体は残る。ユーザーが本格導入を選択したため不採用。
- **X-Ray SDK（`aws-xray-sdk-core`）直接利用**: collector 不要になるが、アプリがベンダー固有 SDK に固定され、NestJS / Fastify との統合も OTel より手薄。OTel が業界標準として収束している現状で採用する理由がない。
- **アプリから X-Ray へ直接 OTLP 送信（sidecar なし）**: X-Ray の OTLP エンドポイントは SigV4 署名が必要で、アプリ側に署名付き exporter を持ち込むことになる。sidecar に寄せる方が関心の分離が明確。

## 再検討のトリガー

- 本番相当の負荷でタスクの CPU / メモリが逼迫し、sidecar のフットプリントが無視できなくなったとき。
- サンプリング率を運用中に動的変更する必要が生じたとき（X-Ray Remote Sampler / collector 側 sampling の導入検討）。
- トレースバックエンドを X-Ray 以外（Jaeger / Grafana Tempo 等）へ移す判断が出たとき（アプリは OTLP のままのため collector 設定の変更で対応できるはず）。
- EventBridge がメッセージ属性等での trace 伝搬を公式サポートしたとき（`_traceContext` 同梱の撤去を検討）。
