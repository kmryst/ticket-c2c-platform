// ファイル概要:
// PurchasesController の例外マッピングの単体テストです（Issue #378 / ADR-0029 関連）。
// compatibility 期間中に旧 write pattern が rejected key を再試行すると、統合 requestId
// index（purchases_request_id_uq）が 23505 を返します。DB 側の拒否は migration spec
// （1785542400000-add-ticket-type-compatibility-writer.spec.ts）が担保しており、
// ここでは「API 層がその 23505 を HTTP 409 へマップすること」を controller の handler
// 経由の振る舞いとして検証します（内部 helper は export せず、可視性を広げない）。

import { ConflictException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JwtPayload } from '../auth/auth.types';
import type { AuthRateLimitService } from '../auth/rate-limit.service';
import { PurchasesController } from './purchases.controller';
import type { PurchasesService } from './purchases.service';

// pg の unique violation error は code / constraint を持つ plain object 相当です。
function pgUniqueViolation(constraint: string): Error & {
  code: string;
  constraint: string;
} {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint,
  });
}

interface Harness {
  controller: PurchasesController;
  invoke: () => Promise<unknown>;
  headerCalls: Array<[string, string]>;
}

function buildHarness(createPurchase: jest.Mock): Harness {
  const purchasesService = { createPurchase } as unknown as PurchasesService;
  const rateLimit = {
    enforce: jest.fn(async () => undefined),
  } as unknown as AuthRateLimitService;
  const controller = new PurchasesController(purchasesService, rateLimit);

  const headerCalls: Array<[string, string]> = [];
  const request = {
    headers: {},
    ip: '127.0.0.1',
  } as unknown as FastifyRequest;
  const reply = {
    header: (name: string, value: string) => {
      headerCalls.push([name, value]);
      return reply;
    },
  } as unknown as FastifyReply;
  const user = { sub: 'buyer-1' } as unknown as JwtPayload;

  return {
    controller,
    headerCalls,
    invoke: () =>
      controller.createPurchase(
        'event-1',
        user,
        { requestId: 'r-1', quantity: 1 },
        request,
        reply,
      ),
  };
}

describe('PurchasesController の requestId 競合マッピング', () => {
  it('統合 requestId index の 23505 を HTTP 409 Conflict へマップする', async () => {
    const harness = buildHarness(
      jest.fn(async () => {
        throw pgUniqueViolation('purchases_request_id_uq');
      }),
    );

    await expect(harness.invoke()).rejects.toBeInstanceOf(ConflictException);
    await expect(harness.invoke()).rejects.toMatchObject({ status: 409 });
  });

  it('統合前の rejected 専用 constraint 名でも同じく 409 へマップする', async () => {
    const harness = buildHarness(
      jest.fn(async () => {
        throw pgUniqueViolation('purchases_rejected_request_id_uq');
      }),
    );

    await expect(harness.invoke()).rejects.toMatchObject({ status: 409 });
  });

  it('対象外の unique violation は 409 に変換せず元の例外のまま伝播する', async () => {
    // requestId 以外の制約（例: 別 index）を 409 に潰すと、原因の異なる衝突を
    // クライアントに冪等性の競合として誤って伝えてしまう。
    const original = pgUniqueViolation('purchases_some_other_uq');
    const harness = buildHarness(
      jest.fn(async () => {
        throw original;
      }),
    );

    await expect(harness.invoke()).rejects.toBe(original);
  });

  it('unique violation 以外の SQLSTATE も 409 に変換しない', async () => {
    const original = Object.assign(new Error('serialization failure'), {
      code: '40001',
      constraint: 'purchases_request_id_uq',
    });
    const harness = buildHarness(
      jest.fn(async () => {
        throw original;
      }),
    );

    await expect(harness.invoke()).rejects.toBe(original);
  });

  it('成功時は service の戻り値をそのまま返す', async () => {
    const result = { status: 'confirmed' };
    const harness = buildHarness(jest.fn(async () => result));

    await expect(harness.invoke()).resolves.toBe(result);
  });
});
