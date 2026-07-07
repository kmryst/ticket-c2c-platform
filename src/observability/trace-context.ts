// ファイル概要:
// このファイルは EventBridge → SQS を跨いだ trace context の受け渡し helper です（ADR-0014 / Issue #203）。
// EventBridge はメッセージ属性による trace 伝搬を持たないため、イベントの detail に
// `_traceContext` フィールドとして carrier（X-Amzn-Trace-Id 形式）を同梱し、
// Worker 側で取り出して同じ trace の続きとして span を張ります。
//
// SDK 未起動時（ローカル PoC）は @opentelemetry/api が no-op になるため、
// inject は undefined を返し、detail にフィールドは追加されません。

import { context, propagation, Context } from '@opentelemetry/api';

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
