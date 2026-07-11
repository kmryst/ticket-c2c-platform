// ファイル概要:
// このファイルは trace context を扱う共通 helper です（ADR-0014 / Issue #203, #255）。
// 役割は 2 つあります。
// 1. EventBridge → SQS を跨いだ trace context の受け渡し（inject / extract。Issue #203）。
//    EventBridge はメッセージ属性による trace 伝搬を持たないため、イベントの detail に
//    `_traceContext` フィールドとして carrier（X-Amzn-Trace-Id 形式）を同梱し、
//    Worker 側で取り出して同じ trace の続きとして span を張ります。
// 2. ログ ↔ trace の相関 ID 取得（traceLogFields。Issue #255）。
//    構造化ログ・EMF record に trace id / span id を含め、CloudWatch Logs から
//    X-Ray trace へ辿れるようにします。
//
// SDK 未起動時（ローカル PoC）は @opentelemetry/api が no-op になるため、
// inject / traceLogFields は undefined を返し、ログ・detail を汚しません。

import {
  context,
  isSpanContextValid,
  propagation,
  trace,
  Context,
} from '@opentelemetry/api';

// TRACE_CONTEXT_FIELD は EventBridge detail 内で trace carrier を運ぶフィールド名です。
// ドメインデータと区別できるようアンダースコア始まりにしています。
export const TRACE_CONTEXT_FIELD = '_traceContext';

// injectTraceContext は現在のアクティブな trace context を carrier オブジェクトへ書き出します。
// アクティブな trace がない（または SDK 未起動の）場合は undefined を返します。
export function injectTraceContext(): Record<string, string> | undefined {
  const carrier: Record<string, string> = {};
  // 登録済みの propagator（AWS 上では AWSXRayPropagator）が carrier へ header 形式で書き込みます。
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length > 0 ? carrier : undefined;
}

// extractTraceContext は detail に同梱された carrier から trace context を復元します。
// carrier が無い・不正な場合は現在の context（通常は root）をそのまま返します。
export function extractTraceContext(carrier: unknown): Context {
  if (
    typeof carrier !== 'object' ||
    carrier === null ||
    Array.isArray(carrier)
  ) {
    return context.active();
  }
  return propagation.extract(context.active(), carrier as Record<string, string>);
}

// TraceLogFields は構造化ログ・EMF record に付与するログ ↔ trace 相関 ID です。
export interface TraceLogFields {
  // traceId は X-Ray console でそのまま検索できる X-Ray 形式（1-xxxxxxxx-xxxx...）です。
  traceId: string;
  // spanId は trace 内のどの span（segment）の処理中に出たログかを示す 16 hex です。
  spanId: string;
}

// traceLogFields は現在アクティブな span の trace id / span id をログ用フィールドとして返します。
// アクティブな span がない、または SDK 未起動（ローカル PoC）の場合は undefined を返すため、
// 呼び出し側は `{ ...traceLogFields() }` とスプレッドするだけで安全に使えます
// （undefined のスプレッドは no-op で、ログ構造を壊しません）。
export function traceLogFields(): TraceLogFields | undefined {
  const spanContext = trace.getSpanContext(context.active());
  // INVALID_SPAN_CONTEXT（全ゼロ）をログへ出しても検索の役に立たないため、valid な場合のみ返します。
  if (!spanContext || !isSpanContextValid(spanContext)) {
    return undefined;
  }
  // OTel の traceId は 32 hex です。AWSXRayIdGenerator 採番では先頭 8 hex が epoch 秒のため、
  // X-Ray console で検索できる `1-<epoch 8hex>-<残り 24hex>` 形式へ変換して返します。
  return {
    traceId: `1-${spanContext.traceId.slice(0, 8)}-${spanContext.traceId.slice(8)}`,
    spanId: spanContext.spanId,
  };
}
