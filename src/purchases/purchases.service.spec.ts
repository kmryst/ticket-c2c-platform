// ファイル概要:
// このファイルは PurchasesService の requestId 分岐（production-readiness M-1）と
// カウンタ補正の呼び分け（M-2）の単体テストです（Issue #129）。
// 認証統合（ADR-0010、Issue #135）により buyerId は body ではなく
// createPurchase の第 2 引数（JWT sub 由来）として渡します。
// DB / Valkey / EventBridge はモックし、購入判定フローの分岐だけを検証します。
// Lua script の実挙動は inventory-cache.service.spec.ts（実 Valkey）で検証します。

import { PurchasesService } from './purchases.service';
import { InventoryCacheService } from '../cache/inventory-cache.service';
import { DatabaseService } from '../database/database.service';
import { DomainEventsService } from '../messaging/domain-events.service';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const BUYER_ID = '22222222-2222-4222-8222-222222222222';
const PURCHASE_ID = '33333333-3333-4333-8333-333333333333';
const TICKET_TYPE_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_TICKET_TYPE_ID = '55555555-5555-4555-8555-555555555555';

// 既存 confirmed row の再送応答（DB からの読み出し結果）です。
const existingConfirmedRow = {
  purchase_id: PURCHASE_ID,
  event_id: EVENT_ID,
  buyer_id: BUYER_ID,
  ticket_type_id: TICKET_TYPE_ID,
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
  // compatibilityRemaining: Event単位互換在庫として読む残数。
  compatibilityRemaining?: number;
  writerMode?: 'legacy' | 'ticket_type';
  ticketTypeIds?: string[];
}

// createFakeDbClient は購入 transaction の SQL 発行順を substring で見分ける fake PoolClient です。
function createFakeDbClient(behavior: FakeDbBehavior) {
  const queries: string[] = [];
  const query = jest.fn(async (text: string, values?: unknown[]) => {
    queries.push(text);
    if (text.includes('FROM inventory_writer_control')) {
      return {
        rowCount: 1,
        rows: [{ writer_mode: behavior.writerMode ?? 'legacy' }],
      };
    }
    if (text.includes('SELECT id FROM events')) {
      return { rowCount: 1, rows: [{ id: EVENT_ID }] };
    }
    if (text.includes('FROM ticket_types')) {
      const ids = text.includes('AND id = $2')
        ? [String(values?.[1])]
        : (behavior.ticketTypeIds ?? [TICKET_TYPE_ID]);
      return { rowCount: ids.length, rows: ids.map((id) => ({ id })) };
    }
    if (text.includes('FROM purchases')) {
      return behavior.existingConfirmed
        ? { rowCount: 1, rows: [existingConfirmedRow] }
        : { rowCount: 0, rows: [] };
    }
    if (text.includes('UPDATE ticket_inventory')) {
      return behavior.inventoryUpdated
        ? {
            rowCount: 1,
            rows: [
              {
                remaining_quantity: behavior.remainingAfterUpdate ?? 0,
                version: 1,
              },
            ],
          }
        : { rowCount: 0, rows: [] };
    }
    if (text.includes('UPDATE ticket_type_inventory')) {
      return behavior.inventoryUpdated
        ? {
            rowCount: 1,
            rows: [
              {
                remaining_quantity: behavior.remainingAfterUpdate ?? 0,
                version: 1,
              },
            ],
          }
        : { rowCount: 0, rows: [] };
    }
    if (
      text.includes('SELECT remaining_quantity, version') &&
      text.includes('FROM ticket_inventory')
    ) {
      return {
        rowCount: 1,
        rows: [
          {
            remaining_quantity: behavior.remainingOnReject ?? 0,
            version: 0,
          },
        ],
      };
    }
    if (text.includes('INSERT INTO purchases')) {
      return { rowCount: 1, rows: [{ id: PURCHASE_ID }] };
    }
    if (
      text.includes('SELECT remaining_quantity, version') &&
      text.includes('FROM ticket_type_inventory')
    ) {
      return {
        rowCount: 1,
        rows: [
          {
            remaining_quantity: behavior.remainingOnReject ?? 0,
            version: 0,
          },
        ],
      };
    }
    if (
      text.includes('SELECT remaining_quantity') &&
      text.includes('FROM ticket_inventory')
    ) {
      return {
        rowCount: 1,
        rows: [
          {
            remaining_quantity:
              behavior.compatibilityRemaining ??
              behavior.remainingAfterUpdate ??
              behavior.remainingOnReject ??
              0,
          },
        ],
      };
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

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
      quantity: 2,
    });

    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('sold_out_precheck');
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('requestId + sold_out はmarkerなしでもDB判定へ進み結果を永続化する', async () => {
    const { service, database, inventoryCache, dbClient } = createService({
      reserveOutcome: 'sold_out',
      wasRequestSeen: false,
      db: {
        inventoryUpdated: true,
        remainingAfterUpdate: 0,
        compatibilityRemaining: 0,
      },
    });

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
      quantity: 2,
      requestId: 'db-backed-request-id',
    });

    expect(result.status).toBe('confirmed');
    expect(inventoryCache.reserve).toHaveBeenCalledWith(EVENT_ID, 2);
    expect(inventoryCache.wasRequestSeen).not.toHaveBeenCalled();
    expect(database.connect).toHaveBeenCalled();
    expect(
      dbClient.queries.some((query) => query.includes('INSERT INTO purchases')),
    ).toBe(true);
  });

  it('requestId + sold_out のDB在庫不足もsold_out_precheckではなくrejected rowを保存する', async () => {
    const { service, database, dbClient } = createService({
      reserveOutcome: 'sold_out',
      db: {
        inventoryUpdated: false,
        remainingOnReject: 0,
        compatibilityRemaining: 0,
      },
    });

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
      quantity: 2,
      requestId: 'db-backed-rejection',
    });

    expect(result).toMatchObject({
      purchaseId: PURCHASE_ID,
      status: 'rejected',
      rejectionReason: 'insufficient_inventory',
    });
    expect(database.connect).toHaveBeenCalled();
    expect(
      dbClient.queries.some((query) => query.includes('INSERT INTO purchases')),
    ).toBe(true);
  });

  it('requestId + sold_out はValkey markerを読まず、DBから元のconfirmedを返す', async () => {
    const { service, database, inventoryCache, dbClient } = createService({
      reserveOutcome: 'sold_out',
      db: { existingConfirmed: true },
    });

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
      quantity: 2,
      requestId: 'original-request-id',
    });

    expect(database.connect).toHaveBeenCalled();
    expect(result.status).toBe('confirmed');
    expect(result.purchaseId).toBe(PURCHASE_ID);
    expect(result.remainingQuantity).toBe(5);
    expect(inventoryCache.wasRequestSeen).not.toHaveBeenCalled();
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

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
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

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
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

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
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

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
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

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
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
      service.createPurchase(EVENT_ID, BUYER_ID, {
        quantity: 2,
      }),
    ).rejects.toThrow('connection lost');

    expect(inventoryCache.release).toHaveBeenCalledWith(EVENT_ID, 2);
  });
});

describe('PurchasesService の認証統合（Issue #135）', () => {
  it('body にクライアント申告の buyerId が含まれる場合は 400 を返す', async () => {
    const { service, database } = createService({
      reserveOutcome: 'reserved',
    });

    await expect(
      service.createPurchase(EVENT_ID, BUYER_ID, {
        buyerId: '99999999-9999-4999-8999-999999999999',
        quantity: 1,
      }),
    ).rejects.toMatchObject({ status: 400 });
    // validation で弾かれるため、前段フィルタにも DB にも到達しない。
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('認証済みユーザー ID が UUID でない場合は 400 を返す', async () => {
    const { service, database } = createService({
      reserveOutcome: 'reserved',
    });

    await expect(
      service.createPurchase(EVENT_ID, 'not-a-uuid', { quantity: 1 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(database.connect).not.toHaveBeenCalled();
  });
});

describe('PurchasesService の compatibility writer（Issue #376）', () => {
  it('table access前のlock順を shared barrier -> requestId lock に固定する', async () => {
    const { service, dbClient } = createService({
      reserveOutcome: 'reserved',
      db: { inventoryUpdated: true, remainingAfterUpdate: 8 },
    });

    await service.createPurchase(EVENT_ID, BUYER_ID, {
      quantity: 2,
      requestId: 'lock-order',
    });

    const sharedBarrier = dbClient.queries.findIndex((query) =>
      query.includes('pg_advisory_xact_lock_shared'),
    );
    const requestLock = dbClient.queries.findIndex((query) =>
      query.includes('hashtextextended'),
    );
    const firstTable = dbClient.queries.findIndex((query) =>
      query.includes('FROM inventory_writer_control'),
    );
    expect(sharedBarrier).toBeGreaterThan(-1);
    expect(requestLock).toBeGreaterThan(sharedBarrier);
    expect(firstTable).toBeGreaterThan(requestLock);
  });

  it('ticket_type modeではType在庫を更新しpublic resultと旧eventにはEvent集計を返す', async () => {
    const { service, dbClient, domainEvents } = createService({
      reserveOutcome: 'unknown',
      db: {
        writerMode: 'ticket_type',
        inventoryUpdated: true,
        remainingAfterUpdate: 6,
        compatibilityRemaining: 9,
      },
    });

    const result = await service.createPurchase(
      EVENT_ID,
      BUYER_ID,
      { quantity: 2 },
      { ticketTypeId: TICKET_TYPE_ID },
    );

    const update = dbClient.queries.find((query) =>
      query.includes('UPDATE ticket_type_inventory'),
    );
    expect(update).toContain('ticket_type_id = $2');
    expect(update).toContain('remaining_quantity >= $3');
    expect(update).toContain('RETURNING remaining_quantity, version');
    expect(result.remainingQuantity).toBe(9);
    expect(result).not.toHaveProperty('ticketTypeId');
    expect(result).not.toHaveProperty('inventoryVersion');
    expect(domainEvents.publish).toHaveBeenCalledWith(
      'TicketPurchased',
      expect.objectContaining({ remainingQuantity: 9 }),
    );
    expect(domainEvents.publish).toHaveBeenCalledWith('InventoryChanged', {
      eventId: EVENT_ID,
      remainingQuantity: 9,
    });
  });

  it('ticketTypeId省略の既存keyは現在Typeが複数でも保存済み結果をreplayする', async () => {
    const { service, dbClient } = createService({
      reserveOutcome: 'unknown',
      db: {
        writerMode: 'ticket_type',
        existingConfirmed: true,
        ticketTypeIds: [TICKET_TYPE_ID, OTHER_TICKET_TYPE_ID],
      },
    });

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
      quantity: 2,
      requestId: 'omitted-type-replay',
    });

    expect(result.purchaseId).toBe(PURCHASE_ID);
    expect(result.status).toBe('confirmed');
    expect(
      dbClient.queries.some((query) => query.includes('FROM ticket_types')),
    ).toBe(false);
  });

  it('同じrequestIdでquantityが異なる場合は在庫更新前に409にする', async () => {
    const { service, dbClient } = createService({
      reserveOutcome: 'reserved',
      db: { existingConfirmed: true },
    });

    await expect(
      service.createPurchase(EVENT_ID, BUYER_ID, {
        quantity: 1,
        requestId: 'payload-conflict',
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      dbClient.queries.some((query) => query.includes('UPDATE ticket_inventory')),
    ).toBe(false);
  });

  it('同じrequestIdでticketTypeIdが異なる場合も在庫更新前に409にする', async () => {
    const { service, dbClient } = createService({
      reserveOutcome: 'reserved',
      db: {
        writerMode: 'ticket_type',
        existingConfirmed: true,
      },
    });

    await expect(
      service.createPurchase(
        EVENT_ID,
        BUYER_ID,
        { quantity: 2, requestId: 'type-conflict' },
        { ticketTypeId: OTHER_TICKET_TYPE_ID },
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      dbClient.queries.some((query) =>
        query.includes('UPDATE ticket_type_inventory'),
      ),
    ).toBe(false);
    expect(
      dbClient.queries.some((query) => query.includes('FROM ticket_types')),
    ).toBe(false);
  });

  it('confirmed replayではdomain eventを再発行しない', async () => {
    const { service, domainEvents } = createService({
      reserveOutcome: 'unknown',
      db: { existingConfirmed: true },
    });

    await service.createPurchase(EVENT_ID, BUYER_ID, {
      quantity: 2,
      requestId: 'no-republish',
    });

    expect(domainEvents.publish).not.toHaveBeenCalled();
  });
});
