// ファイル概要:
// このファイルは PurchasesService の requestId 分岐（production-readiness M-1）と
// カウンタ補正の呼び分け（M-2）の単体テストです（Issue #129）。
// DB / Valkey / EventBridge はモックし、購入判定フローの分岐だけを検証します。
// Lua script の実挙動は inventory-cache.service.spec.ts（実 Valkey）で検証します。

import { PurchasesService } from './purchases.service';
import { InventoryCacheService } from '../cache/inventory-cache.service';
import { DatabaseService } from '../database/database.service';
import { DomainEventsService } from '../messaging/domain-events.service';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const BUYER_ID = '22222222-2222-4222-8222-222222222222';
const PURCHASE_ID = '33333333-3333-4333-8333-333333333333';

// 既存 confirmed row の再送応答（DB からの読み出し結果）です。
const existingConfirmedRow = {
  purchase_id: PURCHASE_ID,
  event_id: EVENT_ID,
  buyer_id: BUYER_ID,
  quantity: 2,
  status: 'confirmed' as const,
  rejection_reason: null,
  remaining_quantity_after: 5,
};

// FakeDbBehavior は fake pg client の応答を test case ごとに調整するための設定です。
interface FakeDbBehavior {
  // existingConfirmed: requestId 再送確認 SELECT が既存 confirmed row を返すか。
  existingConfirmed?: boolean;
  // inventoryUpdated: 在庫 conditional UPDATE が成功する（在庫あり）か。
  inventoryUpdated?: boolean;
  // remainingAfterUpdate: UPDATE 成功時の RETURNING remaining_quantity。
  remainingAfterUpdate?: number;
  // remainingOnReject: UPDATE 失敗時に SELECT で読む現在の残在庫。
  remainingOnReject?: number;
}

// createFakeDbClient は購入 transaction の SQL 発行順を substring で見分ける fake PoolClient です。
function createFakeDbClient(behavior: FakeDbBehavior) {
  const queries: string[] = [];
  const query = jest.fn(async (text: string) => {
    queries.push(text);
    if (text.includes('SELECT id FROM events')) {
      return { rowCount: 1, rows: [{ id: EVENT_ID }] };
    }
    if (text.includes("status = 'confirmed'")) {
      return behavior.existingConfirmed
        ? { rowCount: 1, rows: [existingConfirmedRow] }
        : { rowCount: 0, rows: [] };
    }
    if (text.includes('UPDATE ticket_inventory')) {
      return behavior.inventoryUpdated
        ? {
            rowCount: 1,
            rows: [
              { remaining_quantity: behavior.remainingAfterUpdate ?? 0 },
            ],
          }
        : { rowCount: 0, rows: [] };
    }
    if (text.includes('SELECT remaining_quantity FROM ticket_inventory')) {
      return {
        rowCount: 1,
        rows: [{ remaining_quantity: behavior.remainingOnReject ?? 0 }],
      };
    }
    if (text.includes("status = 'rejected'")) {
      return { rowCount: 0, rows: [] };
    }
    if (text.includes('INSERT INTO purchases')) {
      return { rowCount: 1, rows: [{ id: PURCHASE_ID }] };
    }
    // BEGIN / COMMIT / ROLLBACK / FOR SHARE 以外は届かない想定です。
    return { rowCount: 0, rows: [] };
  });

  return { query, release: jest.fn(), queries };
}

// createService はモック依存で PurchasesService を組み立てる helper です。
function createService(options: {
  reserveOutcome: 'reserved' | 'sold_out' | 'unknown';
  wasRequestSeen?: boolean;
  syncCounterResult?: boolean;
  db?: FakeDbBehavior;
}) {
  const dbClient = createFakeDbClient(options.db ?? {});

  const database = {
    connect: jest.fn(async () => dbClient),
  } as unknown as DatabaseService;

  const inventoryCache = {
    reserve: jest.fn(async () => options.reserveOutcome),
    release: jest.fn(async () => undefined),
    getCounterVersion: jest.fn(async () => '7'),
    syncCounter: jest.fn(async () => options.syncCounterResult ?? true),
    markRequestSeen: jest.fn(async () => undefined),
    wasRequestSeen: jest.fn(async () => options.wasRequestSeen ?? false),
  } as unknown as InventoryCacheService;

  const domainEvents = {
    publish: jest.fn(async () => undefined),
  } as unknown as DomainEventsService;

  const service = new PurchasesService(database, inventoryCache, domainEvents);
  return { service, database, inventoryCache, domainEvents, dbClient };
}

describe('PurchasesService の前段フィルタ分岐（M-1）', () => {
  it('requestId なし + sold_out は前段拒否し DB に到達しない', async () => {
    const { service, database } = createService({
      reserveOutcome: 'sold_out',
    });

    const result = await service.createPurchase(EVENT_ID, {
      buyerId: BUYER_ID,
      quantity: 2,
    });

    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('sold_out_precheck');
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('未知の requestId + sold_out は前段拒否し DB に到達しない（バイパス封鎖）', async () => {
    const { service, database, inventoryCache } = createService({
      reserveOutcome: 'sold_out',
      wasRequestSeen: false,
    });

    // 旧実装では requestId を付けるだけで前段フィルタを素通りして DB へ到達できた。
    const result = await service.createPurchase(EVENT_ID, {
      buyerId: BUYER_ID,
      quantity: 2,
      requestId: 'random-flood-request-id',
    });

    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('sold_out_precheck');
    expect(inventoryCache.reserve).toHaveBeenCalledWith(EVENT_ID, 2);
    expect(inventoryCache.wasRequestSeen).toHaveBeenCalledWith(
      BUYER_ID,
      EVENT_ID,
      'random-flood-request-id',
    );
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('確定済みマーカーのある requestId + sold_out は DB 判定へ流し、元の confirmed を返す（idempotent replay）', async () => {
    const { service, database, inventoryCache, dbClient } = createService({
      reserveOutcome: 'sold_out',
      wasRequestSeen: true,
      db: { existingConfirmed: true },
    });

    const result = await service.createPurchase(EVENT_ID, {
      buyerId: BUYER_ID,
      quantity: 2,
      requestId: 'original-request-id',
    });

    expect(database.connect).toHaveBeenCalled();
    expect(result.status).toBe('confirmed');
    expect(result.purchaseId).toBe(PURCHASE_ID);
    expect(result.remainingQuantity).toBe(5);
    // replay は在庫を消費しないため、新しい INSERT / UPDATE は発行されない。
    expect(
      dbClient.queries.some((q) => q.includes('UPDATE ticket_inventory')),
    ).toBe(false);
    expect(
      dbClient.queries.some((q) => q.includes('INSERT INTO purchases')),
    ).toBe(false);
    // gate は unknown（reserve していない）ため release も不要。
    expect(inventoryCache.release).not.toHaveBeenCalled();
  });

  it('reserved で通過した replay（既存 confirmed あり）は reserve 分を release で返す', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'reserved',
      db: { existingConfirmed: true },
    });

    const result = await service.createPurchase(EVENT_ID, {
      buyerId: BUYER_ID,
      quantity: 2,
      requestId: 'original-request-id',
    });

    expect(result.status).toBe('confirmed');
    // 在庫は元の購入で確保済み。今回の reserve 分はカウンタへ返す。
    expect(inventoryCache.release).toHaveBeenCalledWith(EVENT_ID, 2);
  });

  it('新規 confirmed（requestId 付き）は COMMIT 後にマーカーを記録する', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'reserved',
      db: { inventoryUpdated: true, remainingAfterUpdate: 8 },
    });

    const result = await service.createPurchase(EVENT_ID, {
      buyerId: BUYER_ID,
      quantity: 2,
      requestId: 'first-request-id',
    });

    expect(result.status).toBe('confirmed');
    expect(inventoryCache.markRequestSeen).toHaveBeenCalledWith(
      BUYER_ID,
      EVENT_ID,
      'first-request-id',
    );
  });
});

describe('PurchasesService のカウンタ補正（M-2）', () => {
  it('gate=unknown で confirmed した場合、控えた version 付きで syncCounter する', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'unknown',
      db: { inventoryUpdated: true, remainingAfterUpdate: 9 },
    });

    const result = await service.createPurchase(EVENT_ID, {
      buyerId: BUYER_ID,
      quantity: 1,
    });

    expect(result.status).toBe('confirmed');
    expect(inventoryCache.getCounterVersion).toHaveBeenCalledWith(EVENT_ID);
    expect(inventoryCache.syncCounter).toHaveBeenCalledWith(EVENT_ID, 9, '7');
  });

  it('gate=reserved で DB 在庫不足の場合、CAS 同期が成立すれば release しない', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'reserved',
      syncCounterResult: true,
      db: { inventoryUpdated: false, remainingOnReject: 1 },
    });

    const result = await service.createPurchase(EVENT_ID, {
      buyerId: BUYER_ID,
      quantity: 3,
    });

    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('insufficient_inventory');
    expect(inventoryCache.syncCounter).toHaveBeenCalledWith(EVENT_ID, 1, '7');
    expect(inventoryCache.release).not.toHaveBeenCalled();
  });

  it('gate=reserved で DB 在庫不足かつ CAS 同期が見送られた場合、reserve 分だけ release する', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'reserved',
      syncCounterResult: false,
      db: { inventoryUpdated: false, remainingOnReject: 1 },
    });

    const result = await service.createPurchase(EVENT_ID, {
      buyerId: BUYER_ID,
      quantity: 3,
    });

    expect(result.status).toBe('rejected');
    expect(inventoryCache.release).toHaveBeenCalledWith(EVENT_ID, 3);
  });

  it('DB エラー時（gate=reserved）は release で補償する（既存挙動の回帰確認）', async () => {
    const { service, inventoryCache, dbClient } = createService({
      reserveOutcome: 'reserved',
    });
    dbClient.query.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      service.createPurchase(EVENT_ID, {
        buyerId: BUYER_ID,
        quantity: 2,
      }),
    ).rejects.toThrow('connection lost');

    expect(inventoryCache.release).toHaveBeenCalledWith(EVENT_ID, 2);
  });
});
