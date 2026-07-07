// ファイル概要:
// このファイルは AWS X-Ray 向け分散トレーシング（OpenTelemetry SDK）の初期化です（ADR-0014 / Issue #203）。
// OTEL_TRACING_ENABLED=true のときだけ NodeSDK を起動し、それ以外（ローカル PoC 既定）は
// 何もしない opt-in 設計です。SDK 未起動でも @opentelemetry/api は no-op で安全に使えます。
//
// 構成（ADR-0014）:
// - Exporter は OTLP/HTTP で localhost:4318 の ADOT collector sidecar へ送り、
//   X-Ray への SigV4 署名・バッファリング・リトライは collector に任せます。
//   アプリ側をベンダー中立な標準 OTLP のままにでき、X-Ray 用の署名実装を持たずに済むためです。
// - TraceId は X-Ray 形式（先頭 4 byte が epoch 秒）でないと X-Ray console に表示されないため、
//   AWSXRayIdGenerator を使います。
// - Propagator は X-Ray 形式（X-Amzn-Trace-Id）にし、ALB が付与する trace header とも整合させます。
// - サンプリングは OTel 標準の環境変数 OTEL_TRACES_SAMPLER / OTEL_TRACES_SAMPLER_ARG で制御します。
//   X-Ray の centralized sampling rule は OTel 標準 sampler から参照されないため使いません（ADR-0014）。
//
// このモジュールは import の副作用で初期化します。pg / ioredis / http の計装は
// 「対象モジュールが require される前」に登録する必要があるため、
// main.ts / worker.ts の import 並びの最上部（dotenv の直後）に置きます。

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { AWSXRayIdGenerator } from '@opentelemetry/id-generator-aws-xray';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { AwsInstrumentation } from '@opentelemetry/instrumentation-aws-sdk';

// 環境変数は process.env を直接読みます。config.ts の helper を使わないのは、
// このファイルの import が計装対象モジュールより先に評価される必要があり、
// アプリコードへの依存を一切持たせたくないためです。
const tracingEnabled = process.env.OTEL_TRACING_ENABLED === 'true';

if (tracingEnabled) {
  const sdk = new NodeSDK({
    // serviceName は X-Ray サービスマップ上のノード名です。
    // ECS タスク定義の OTEL_SERVICE_NAME（api / worker で別名）から渡します。
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'ticket-c2c',
    // OTLP/HTTP exporter の既定 URL は http://localhost:4318/v1/traces で、
    // 同一タスク内の ADOT collector sidecar 宛と一致するため URL 指定は不要です。
    traceExporter: new OTLPTraceExporter(),
    // X-Ray console が受理できる TraceId 形式（先頭が epoch 秒）で採番します。
    idGenerator: new AWSXRayIdGenerator(),
    // X-Amzn-Trace-Id 形式で trace context を伝搬します（EventBridge detail への注入にも使われます）。
    textMapPropagator: new AWSXRayPropagator(),
    instrumentations: [
      // HTTP server span（API の各リクエスト）と外向き HTTP（OpenSearch 含む）を計装します。
      new HttpInstrumentation({
        // health check はトレースとしての価値がなく量だけ増えるため除外します。
        ignoreIncomingRequestHook: (request) => {
          const url = request.url ?? '';
          return (
            url === '/health' ||
            url === '/healthz' ||
            url === '/readyz' ||
            url.startsWith('/api/health')
          );
        },
      }),
      // PostgreSQL のクエリ span（購入 transaction の内訳が見えます）。
      new PgInstrumentation(),
      // Valkey（ioredis）の前段フィルタ・レート制限呼び出しの span。
      new IORedisInstrumentation(),
      // AWS SDK v3（EventBridge PutEvents / SQS Receive・Delete）の span。
      new AwsInstrumentation(),
    ],
  });

  sdk.start();

  // ECS タスク停止時（SIGTERM）に未送信 span を flush します。listener の追加だけなので、
  // main.ts / worker.ts 側の既存 SIGTERM 処理とは競合しません。
  const shutdown = () => {
    sdk.shutdown().catch((error) => {
      console.error('otel sdk shutdown failed:', error);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
