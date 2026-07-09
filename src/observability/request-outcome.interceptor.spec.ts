// ファイル概要:
// このファイルは RequestOutcomeInterceptor（Issue #225 / ADR-0016）の unit test です。
// NestJS の CallHandler を最小限のスタブで用意し、成功 / 各種例外パスでの
// Outcome 分類とメトリクス出力（レイテンシ・件数）を検証します。

import { of, throwError, lastValueFrom } from 'rxjs';
import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as emf from './emf';
import { RequestOutcomeInterceptor } from './request-outcome.interceptor';

describe('RequestOutcomeInterceptor', () => {
  let emitMetricSpy: jest.SpyInstance;
  const dummyContext = {} as ExecutionContext;

  beforeEach(() => {
    emitMetricSpy = jest.spyOn(emf, 'emitMetric').mockImplementation(() => undefined);
  });

  afterEach(() => {
    emitMetricSpy.mockRestore();
  });

  function callHandlerReturning(observable: ReturnType<typeof of> | ReturnType<typeof throwError>) {
    return { handle: () => observable };
  }

  // outcomeOf は emitMetric 呼び出し引数から Outcome dimension の値を取り出します。
  function outcomesRecorded(): string[] {
    return emitMetricSpy.mock.calls
      .filter(([name]) => name === 'TestOutcome')
      .map(([, , , dimensions]) => (dimensions as { Outcome: string }).Outcome);
  }

  it('正常応答（confirmed / rejected いずれも 200）は success として計測する', async () => {
    const interceptor = new RequestOutcomeInterceptor('TestLatencyMs', 'TestOutcome');
    const result$ = interceptor.intercept(
      dummyContext,
      callHandlerReturning(of({ status: 'confirmed' })),
    );

    await lastValueFrom(result$);

    expect(outcomesRecorded()).toEqual(['success']);
    // レイテンシメトリクスも同時に出力される。
    const latencyCall = emitMetricSpy.mock.calls.find(([name]) => name === 'TestLatencyMs');
    expect(latencyCall).toBeDefined();
    expect(latencyCall?.[2]).toBe('Milliseconds');
    expect(typeof latencyCall?.[1]).toBe('number');
    expect(latencyCall?.[1] as number).toBeGreaterThanOrEqual(0);
  });

  it('429（レート制限）は rate_limited として計測し、例外はそのまま再送出する', async () => {
    const interceptor = new RequestOutcomeInterceptor('TestLatencyMs', 'TestOutcome');
    const error = new HttpException(
      { statusCode: 429, message: 'rate limited', retryAfterSeconds: 1 },
      429,
    );
    const result$ = interceptor.intercept(dummyContext, callHandlerReturning(throwError(() => error)));

    await expect(lastValueFrom(result$)).rejects.toBe(error);
    expect(outcomesRecorded()).toEqual(['rate_limited']);
  });

  it.each([
    ['BadRequestException (400)', new BadRequestException('invalid input')],
    ['UnauthorizedException (401)', new UnauthorizedException()],
    ['NotFoundException (404)', new NotFoundException('event not found')],
    ['ConflictException (409)', new ConflictException('requestId already exists')],
  ])('%s は invalid_request として計測する（SLI 分母から除外対象）', async (_label, error) => {
    const interceptor = new RequestOutcomeInterceptor('TestLatencyMs', 'TestOutcome');
    const result$ = interceptor.intercept(dummyContext, callHandlerReturning(throwError(() => error)));

    await expect(lastValueFrom(result$)).rejects.toBe(error);
    expect(outcomesRecorded()).toEqual(['invalid_request']);
  });

  it('5xx（InternalServerErrorException）は technical_failure として計測する', async () => {
    const interceptor = new RequestOutcomeInterceptor('TestLatencyMs', 'TestOutcome');
    const error = new InternalServerErrorException('inventory row missing');
    const result$ = interceptor.intercept(dummyContext, callHandlerReturning(throwError(() => error)));

    await expect(lastValueFrom(result$)).rejects.toBe(error);
    expect(outcomesRecorded()).toEqual(['technical_failure']);
  });

  it('HttpException 以外の未分類例外（DB ドライバエラー等）も technical_failure として計測する', async () => {
    const interceptor = new RequestOutcomeInterceptor('TestLatencyMs', 'TestOutcome');
    const error = new Error('connection terminated unexpectedly');
    const result$ = interceptor.intercept(dummyContext, callHandlerReturning(throwError(() => error)));

    await expect(lastValueFrom(result$)).rejects.toBe(error);
    expect(outcomesRecorded()).toEqual(['technical_failure']);
  });

  it('メトリクス名はコンストラクタ引数のみに依存し、別インスタンスなら別名で出力される（再利用性の確認）', async () => {
    const interceptor = new RequestOutcomeInterceptor(
      'OtherEndpointLatencyMs',
      'OtherEndpointOutcome',
    );
    const result$ = interceptor.intercept(dummyContext, callHandlerReturning(of({ ok: true })));

    await lastValueFrom(result$);

    const names = emitMetricSpy.mock.calls.map(([name]) => name);
    expect(names).toEqual(
      expect.arrayContaining(['OtherEndpointLatencyMs', 'OtherEndpointOutcome']),
    );
  });
});
