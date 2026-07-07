// ファイル概要:
// このファイルは trace-context.ts（EventBridge detail 経由の trace 伝搬 helper）の unit test です（Issue #203）。
// AWSXRayPropagator を明示的に登録し、inject → extract の往復で trace が継続することを検証します。

import {
  context,
  propagation,
  trace,
  TraceFlags,
} from '@opentelemetry/api';
import { AWSXRayPropagator } from '@opentelemetry/propagator-aws-xray';
// AsyncLocalStorageContextManager は context.with / context.active を実際に機能させるために登録します。
// SDK 未起動の既定では no-op context manager のため、active() が常に ROOT_CONTEXT になるからです。
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { extractTraceContext, injectTraceContext } from './trace-context';

describe('trace-context', () => {
  beforeAll(() => {
    // SDK は起動せず、propagator と context manager だけを登録して inject / extract の変換を検証します。
    propagation.setGlobalPropagator(new AWSXRayPropagator());
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
  });

  afterAll(() => {
    propagation.disable();
    context.disable();
  });

  it('アクティブな span がなければ inject は undefined を返す（detail を汚さない）', () => {
    expect(injectTraceContext()).toBeUndefined();
  });

  it('アクティブな span context があれば X-Amzn-Trace-Id carrier として書き出し、extract で復元できる', () => {
    // X-Ray 形式（先頭 8 hex が epoch 秒）の traceId を持つ span context を手動で用意します。
    const spanContext = {
      traceId: '5f84c7a1aaaaaaaaaaaaaaaaaaaaaaaa',
      spanId: 'bbbbbbbbbbbbbbbb',
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };

    const carrier = context.with(
      trace.setSpanContext(context.active(), spanContext),
      () => injectTraceContext(),
    );

    expect(carrier).toBeDefined();
    // AWSXRayPropagator の carrier キーは X-Amzn-Trace-Id（小文字）です。
    expect(Object.keys(carrier as object)).toContain('x-amzn-trace-id');

    const restored = trace.getSpanContext(extractTraceContext(carrier));
    expect(restored?.traceId).toBe(spanContext.traceId);
    expect(restored?.spanId).toBe(spanContext.spanId);
  });

  it('extract は carrier が undefined や不正値でも例外にせず現在の context を返す', () => {
    expect(() => extractTraceContext(undefined)).not.toThrow();
    expect(() => extractTraceContext('garbage')).not.toThrow();
    expect(() => extractTraceContext([1, 2])).not.toThrow();
    expect(trace.getSpanContext(extractTraceContext(undefined))).toBeUndefined();
  });
});
