// ファイル概要:
// このファイルは trace-context.ts（trace 伝搬・ログ相関 helper）の unit test です（Issue #203, #255）。
// AWSXRayPropagator を明示的に登録し、inject → extract の往復で trace が継続することと、
// traceLogFields が trace context の有無に応じて正しくログ用フィールドを返すことを検証します。

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
import {
  extractTraceContext,
  injectTraceContext,
  traceLogFields,
} from './trace-context';

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

  it('アクティブな span がなければ traceLogFields は undefined を返す（ローカル PoC でログを汚さない）', () => {
    expect(traceLogFields()).toBeUndefined();
    // undefined のスプレッドは no-op のため、呼び出し側のログ構造も壊れません。
    expect({ eventId: 'e1', ...traceLogFields() }).toEqual({ eventId: 'e1' });
  });

  it('アクティブな span context があれば X-Ray 形式の traceId と spanId を返す', () => {
    const spanContext = {
      traceId: '5f84c7a1aaaaaaaaaaaaaaaaaaaaaaaa',
      spanId: 'bbbbbbbbbbbbbbbb',
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    };

    const fields = context.with(
      trace.setSpanContext(context.active(), spanContext),
      () => traceLogFields(),
    );

    expect(fields).toEqual({
      // OTel の 32 hex traceId は X-Ray console で検索できる 1-<8hex>-<24hex> 形式へ変換されます。
      traceId: '1-5f84c7a1-aaaaaaaaaaaaaaaaaaaaaaaa',
      spanId: 'bbbbbbbbbbbbbbbb',
    });
  });

  it('invalid な span context（全ゼロ）では traceLogFields は undefined を返す', () => {
    const invalidSpanContext = {
      traceId: '00000000000000000000000000000000',
      spanId: '0000000000000000',
      traceFlags: TraceFlags.NONE,
      isRemote: false,
    };

    const fields = context.with(
      trace.setSpanContext(context.active(), invalidSpanContext),
      () => traceLogFields(),
    );

    expect(fields).toBeUndefined();
  });

  it('extract は carrier が undefined や不正値でも例外にせず現在の context を返す', () => {
    expect(() => extractTraceContext(undefined)).not.toThrow();
    expect(() => extractTraceContext('garbage')).not.toThrow();
    expect(() => extractTraceContext([1, 2])).not.toThrow();
    expect(trace.getSpanContext(extractTraceContext(undefined))).toBeUndefined();
  });
});
