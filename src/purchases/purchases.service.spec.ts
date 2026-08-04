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
import {
  PrefilterPlan,
  TicketTypeResolverService,
} from './ticket-type-resolver.service';

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
  // ticketTypeStateMissing: #377 の Ticket Type 単位 state JOIN が 0 行を返す（schema 不整合）。
  ticketTypeStateMissing?: boolean;
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
      text.includes('SELECT total_quantity, remaining_quantity, version') &&
      text.includes('FROM ticket_inventory')
    ) {
      // #377: Event 互換集計（total / remaining / version）を同じ transaction から読む。
      // review 6: Type version（7）と別の異なる値（41）を使い、swap bug を検出できるようにする。
      return {
        rowCount: 1,
        rows: [
          {
            total_quantity: 100,
            remaining_quantity:
              behavior.compatibilityRemaining ??
              behavior.remainingAfterUpdate ??
              behavior.remainingOnReject ??
              0,
            version: 41,
          },
        ],
      };
    }
    if (
      text.includes('FROM ticket_type_inventory tti') &&
      text.includes('JOIN ticket_types tt')
    ) {
      // #377: versioned InventoryChanged 用の Ticket Type 単位 state。
      // review 6: Event version（41）と別の異なる値（7）を使う。
      if (behavior.ticketTypeStateMissing) {
        return { rowCount: 0, rows: [] };
      }
      return {
        rowCount: 1,
        rows: [
          {
            name: 'General Admission',
            total_quantity: 100,
            remaining_quantity: behavior.remainingAfterUpdate ?? 0,
            version: 7,
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
// resolver は mock を注入し、prefilter plan（writer mode / Type scope）を
// テストが直接制御できるようにします。plan の DB 解決自体は
// ticket-type-resolver.service.spec.ts で別途検証します。
function createService(options: {
  reserveOutcome: 'reserved' | 'sold_out' | 'unknown';
  wasRequestSeen?: boolean;
  syncCounterResult?: boolean;
  syncTicketTypeResult?: boolean;
  reserveTicketTypeRevision?: string | null;
  releaseTicketTypeOk?: boolean;
  ticketTypeRevision?: string;
  db?: FakeDbBehavior;
  plan?: PrefilterPlan;
  // resolverError=true で resolvePrefilterPlan を失敗させ、DB-only bypass を検証する。
  resolverError?: boolean;
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
    // Ticket Type 単位 API（Issue #389）。
    reserveTicketType: jest.fn(async () => ({
      outcome: options.reserveOutcome,
      revision:
        options.reserveOutcome === 'reserved'
          ? (options.reserveTicketTypeRevision ?? 'rev-1')
          : null,
    })),
    releaseTicketType: jest.fn(async () => options.releaseTicketTypeOk ?? true),
    getTicketTypeCounterRevision: jest.fn(
      async () => options.ticketTypeRevision ?? 'rev-1',
    ),
    syncTicketTypeCounter: jest.fn(
      async () => options.syncTicketTypeResult ?? true,
    ),
    initTicketTypeCounter: jest.fn(async () => undefined),
  } as unknown as InventoryCacheService;

  const domainEvents = {
    publish: jest.fn(async () => undefined),
  } as unknown as DomainEventsService;

  const writerMode = options.db?.writerMode ?? 'legacy';
  let plan: PrefilterPlan;
  if (options.plan) {
    plan = options.plan;
  } else if (writerMode === 'legacy') {
    plan = { writerMode: 'legacy' };
  } else {
    const ids = options.db?.ticketTypeIds ?? [TICKET_TYPE_ID];
    plan =
      ids.length === 1
        ? {
            writerMode: 'ticket_type',
            scope: { kind: 'single', ticketTypeId: ids[0] },
          }
        : { writerMode: 'ticket_type', scope: { kind: 'multi' } };
  }
  const resolver = {
    resolvePrefilterPlan: jest.fn(async () => {
      if (options.resolverError) {
        throw new Error('resolver failed');
      }
      return plan;
    }),
    prime: jest.fn(),
    invalidate: jest.fn(),
  } as unknown as TicketTypeResolverService;

  const service = new PurchasesService(
    database,
    inventoryCache,
    domainEvents,
    resolver,
  );
  return { service, database, inventoryCache, domainEvents, dbClient, resolver };
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
    // public result は Event 集計残数を維持し、内部 version を漏らさない（#377）。
    expect(result.remainingQuantity).toBe(9);
    expect(result).not.toHaveProperty('ticketTypeId');
    expect(result).not.toHaveProperty('inventoryVersion');
    expect(result).not.toHaveProperty('eventInventoryVersion');
    expect(domainEvents.publish).toHaveBeenCalledWith(
      'TicketPurchased',
      expect.objectContaining({ remainingQuantity: 9 }),
    );
    // #377: versioned InventoryChanged。legacy 互換 field（eventId / remainingQuantity）を
    // 保ちつつ、transaction 由来の Ticket Type state（remaining=6）と Event 集計（remaining=9）を
    // 独立 version 付きで発行する。
    // review 6: Type version（7）と Event 集計 version（41）は独立で、入れ替わらない。
    expect(domainEvents.publish).toHaveBeenCalledWith('InventoryChanged', {
      eventId: EVENT_ID,
      remainingQuantity: 9,
      inventoryEventVersion: 1,
      ticketTypeId: TICKET_TYPE_ID,
      ticketTypeName: 'General Admission',
      ticketTypeTotalQuantity: 100,
      ticketTypeRemainingQuantity: 6,
      inventoryVersion: 7,
      eventTotalQuantity: 100,
      eventRemainingQuantity: 9,
      eventInventoryVersion: 41,
    });
  });

  it('TicketPurchased publish が失敗しても InventoryChanged publish を試行する（#377）', async () => {
    const { service, domainEvents } = createService({
      reserveOutcome: 'unknown',
      db: {
        writerMode: 'ticket_type',
        inventoryUpdated: true,
        remainingAfterUpdate: 6,
        compatibilityRemaining: 9,
      },
    });
    (domainEvents.publish as jest.Mock).mockImplementation(
      async (detailType: string) => {
        if (detailType === 'TicketPurchased') {
          throw new Error('TicketPurchased publish failed');
        }
      },
    );

    await service.createPurchase(
      EVENT_ID,
      BUYER_ID,
      { quantity: 2 },
      { ticketTypeId: TICKET_TYPE_ID },
    );

    // TicketPurchased の失敗にかかわらず InventoryChanged を試行する。
    expect(domainEvents.publish).toHaveBeenCalledWith(
      'InventoryChanged',
      expect.objectContaining({
        eventId: EVENT_ID,
        inventoryEventVersion: 1,
        ticketTypeId: TICKET_TYPE_ID,
      }),
    );
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

describe('PurchasesService の Ticket Type 単位経路（Issue #389）', () => {
  const ticketTypeDb = (extra: FakeDbBehavior = {}): FakeDbBehavior => ({
    writerMode: 'ticket_type',
    ...extra,
  });

  it('explicit Type は reserve に明示 Type を使い、別 Type counter を使わない', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'reserved',
      plan: {
        writerMode: 'ticket_type',
        scope: { kind: 'single', ticketTypeId: OTHER_TICKET_TYPE_ID },
      },
      db: ticketTypeDb({ inventoryUpdated: true, remainingAfterUpdate: 4 }),
    });

    await service.createPurchase(
      EVENT_ID,
      BUYER_ID,
      { quantity: 1 },
      { ticketTypeId: TICKET_TYPE_ID },
    );

    // 明示 Type が優先され、cache の別 Type（OTHER）は使わない。
    expect(inventoryCache.reserveTicketType).toHaveBeenCalledWith(
      EVENT_ID,
      TICKET_TYPE_ID,
      1,
    );
    expect(inventoryCache.reserve).not.toHaveBeenCalled();
  });

  it('requestId なしの sold_out は前段拒否し DB に到達しない（ticket_type）', async () => {
    const { service, database } = createService({
      reserveOutcome: 'sold_out',
      db: ticketTypeDb(),
    });

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
      quantity: 2,
    });

    expect(result.status).toBe('rejected');
    expect(result.rejectionReason).toBe('sold_out_precheck');
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('requestId 付きの sold_out は DB へ進み結果を永続化する（ticket_type）', async () => {
    const { service, database, inventoryCache, dbClient } = createService({
      reserveOutcome: 'sold_out',
      db: ticketTypeDb({
        inventoryUpdated: true,
        remainingAfterUpdate: 0,
        compatibilityRemaining: 0,
      }),
    });

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
      quantity: 2,
      requestId: 'tt-sold-out-to-db',
    });

    expect(result.status).toBe('confirmed');
    expect(database.connect).toHaveBeenCalled();
    expect(inventoryCache.markRequestSeen).toHaveBeenCalled();
    expect(
      dbClient.queries.some((q) => q.includes('INSERT INTO purchases')),
    ).toBe(true);
  });

  it('複数 Type かつ Type 省略は Valkey を bypass し DB へ判断させる', async () => {
    const { service, inventoryCache, dbClient } = createService({
      reserveOutcome: 'unknown',
      db: ticketTypeDb({
        ticketTypeIds: [TICKET_TYPE_ID, OTHER_TICKET_TYPE_ID],
        inventoryUpdated: true,
        remainingAfterUpdate: 3,
        compatibilityRemaining: 3,
      }),
    });

    // 複数 Type で Type 省略の新規 request は #376 の transaction が 400 にする。
    await expect(
      service.createPurchase(EVENT_ID, BUYER_ID, { quantity: 1 }),
    ).rejects.toMatchObject({ status: 400 });

    // bypass のため reserveTicketType を呼ばない。
    expect(inventoryCache.reserveTicketType).not.toHaveBeenCalled();
    expect(
      dbClient.queries.some((q) => q.includes('FROM ticket_types')),
    ).toBe(true);
  });

  it('reserved で通過した replay は reserve 分を同じ Type へ release で戻す', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'reserved',
      db: ticketTypeDb({ existingConfirmed: true }),
    });

    const result = await service.createPurchase(
      EVENT_ID,
      BUYER_ID,
      { quantity: 2, requestId: 'tt-replay' },
      { ticketTypeId: TICKET_TYPE_ID },
    );

    expect(result.status).toBe('confirmed');
    expect(inventoryCache.releaseTicketType).toHaveBeenCalledWith(
      EVENT_ID,
      TICKET_TYPE_ID,
      2,
    );
    expect(inventoryCache.syncTicketTypeCounter).not.toHaveBeenCalled();
  });

  it('DB エラー時は reserve した同じ Type と数量だけを release で戻す', async () => {
    const { service, inventoryCache, dbClient } = createService({
      reserveOutcome: 'reserved',
      db: ticketTypeDb(),
    });
    dbClient.query.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      service.createPurchase(
        EVENT_ID,
        BUYER_ID,
        { quantity: 3 },
        { ticketTypeId: TICKET_TYPE_ID },
      ),
    ).rejects.toThrow('connection lost');

    expect(inventoryCache.releaseTicketType).toHaveBeenCalledWith(
      EVENT_ID,
      TICKET_TYPE_ID,
      3,
    );
  });

  it('DB rejected（reserved）は Type 残数で CAS sync し、成立すれば release しない', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'reserved',
      reserveTicketTypeRevision: 'rev-42',
      syncTicketTypeResult: true,
      db: ticketTypeDb({ inventoryUpdated: false, remainingOnReject: 1 }),
    });

    const result = await service.createPurchase(
      EVENT_ID,
      BUYER_ID,
      { quantity: 3 },
      { ticketTypeId: TICKET_TYPE_ID },
    );

    expect(result.status).toBe('rejected');
    // reserve が原子的に返した revision を使い、別途 getCounterVersion は呼ばない。
    expect(
      inventoryCache.getTicketTypeCounterRevision,
    ).not.toHaveBeenCalled();
    expect(inventoryCache.syncTicketTypeCounter).toHaveBeenCalledWith(
      EVENT_ID,
      TICKET_TYPE_ID,
      1,
      'rev-42',
    );
    expect(inventoryCache.releaseTicketType).not.toHaveBeenCalled();
  });

  it('DB rejected（reserved）で CAS sync が見送られた場合だけ正確に release する', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'reserved',
      syncTicketTypeResult: false,
      db: ticketTypeDb({ inventoryUpdated: false, remainingOnReject: 1 }),
    });

    const result = await service.createPurchase(
      EVENT_ID,
      BUYER_ID,
      { quantity: 3 },
      { ticketTypeId: TICKET_TYPE_ID },
    );

    expect(result.status).toBe('rejected');
    expect(inventoryCache.releaseTicketType).toHaveBeenCalledWith(
      EVENT_ID,
      TICKET_TYPE_ID,
      3,
    );
  });

  it('gate=unknown で confirmed した場合は Type 残数で CAS sync する', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'unknown',
      ticketTypeRevision: 'rev-9',
      db: ticketTypeDb({ inventoryUpdated: true, remainingAfterUpdate: 5 }),
    });

    const result = await service.createPurchase(
      EVENT_ID,
      BUYER_ID,
      { quantity: 2 },
      { ticketTypeId: TICKET_TYPE_ID },
    );

    expect(result.status).toBe('confirmed');
    expect(inventoryCache.syncTicketTypeCounter).toHaveBeenCalledWith(
      EVENT_ID,
      TICKET_TYPE_ID,
      5,
      'rev-9',
    );
  });

  it('prefilter Type と transaction Type が異なる場合は cross-Type sync しない', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'reserved',
      // cache は OTHER を指すが、transaction は default（TICKET_TYPE_ID）を解決する。
      plan: {
        writerMode: 'ticket_type',
        scope: { kind: 'single', ticketTypeId: OTHER_TICKET_TYPE_ID },
      },
      db: ticketTypeDb({
        ticketTypeIds: [TICKET_TYPE_ID],
        inventoryUpdated: true,
        remainingAfterUpdate: 6,
      }),
    });

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
      quantity: 1,
    });

    expect(result.status).toBe('confirmed');
    // reserve した OTHER の DB 残数を別 Type の key へ sync しない。安全側に release する。
    expect(inventoryCache.syncTicketTypeCounter).not.toHaveBeenCalled();
    expect(inventoryCache.releaseTicketType).toHaveBeenCalledWith(
      EVENT_ID,
      OTHER_TICKET_TYPE_ID,
      1,
    );
  });

  it('public response は Event 互換集計を維持し Type 内部値を露出しない', async () => {
    const { service } = createService({
      reserveOutcome: 'reserved',
      db: ticketTypeDb({
        inventoryUpdated: true,
        remainingAfterUpdate: 6,
        compatibilityRemaining: 9,
      }),
    });

    const result = await service.createPurchase(
      EVENT_ID,
      BUYER_ID,
      { quantity: 2 },
      { ticketTypeId: TICKET_TYPE_ID },
    );

    // 公開 response は Event 互換集計（9）を返し、Type 残数（6）や内部値を露出しない。
    expect(result.remainingQuantity).toBe(9);
    expect(result).not.toHaveProperty('ticketTypeId');
    expect(result).not.toHaveProperty('inventoryVersion');
  });

  it('gate=unknown の sync anchor は transaction 前に取得する（reserved では取得しない）', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'unknown',
      ticketTypeRevision: 'pre-rev',
      db: ticketTypeDb({ inventoryUpdated: true, remainingAfterUpdate: 5 }),
    });

    await service.createPurchase(
      EVENT_ID,
      BUYER_ID,
      { quantity: 2 },
      { ticketTypeId: TICKET_TYPE_ID },
    );

    // transaction 前に取得した anchor revision で sync する（transaction 後には取得しない）。
    expect(inventoryCache.getTicketTypeCounterRevision).toHaveBeenCalledTimes(1);
    expect(inventoryCache.syncTicketTypeCounter).toHaveBeenCalledWith(
      EVENT_ID,
      TICKET_TYPE_ID,
      5,
      'pre-rev',
    );
  });
});

describe('PurchasesService の resolver 失敗時 DB-only bypass（Issue #389 指摘3）', () => {
  it('resolver reject 時は Event/Type reserve も sync もせず authoritative transaction を試行する', async () => {
    const { service, database, inventoryCache } = createService({
      reserveOutcome: 'reserved',
      resolverError: true,
      db: { inventoryUpdated: true, remainingAfterUpdate: 8 },
    });

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
      quantity: 2,
    });

    expect(result.status).toBe('confirmed');
    expect(database.connect).toHaveBeenCalled();
    // legacy を推測せず、どちらの counter も使わない。
    expect(inventoryCache.reserve).not.toHaveBeenCalled();
    expect(inventoryCache.reserveTicketType).not.toHaveBeenCalled();
    expect(inventoryCache.syncCounter).not.toHaveBeenCalled();
    expect(inventoryCache.syncTicketTypeCounter).not.toHaveBeenCalled();
    expect(inventoryCache.release).not.toHaveBeenCalled();
    expect(inventoryCache.releaseTicketType).not.toHaveBeenCalled();
  });

  it('resolver も transaction も失敗した場合は transaction のエラーを返す', async () => {
    const { service, dbClient } = createService({
      reserveOutcome: 'reserved',
      resolverError: true,
    });
    dbClient.query.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      service.createPurchase(EVENT_ID, BUYER_ID, { quantity: 1 }),
    ).rejects.toThrow('connection lost');
  });

  it('bypass でも confirmed metric・marker・domain event の contract を維持する', async () => {
    const { service, inventoryCache, domainEvents } = createService({
      reserveOutcome: 'reserved',
      resolverError: true,
      db: { inventoryUpdated: true, remainingAfterUpdate: 8 },
    });

    await service.createPurchase(EVENT_ID, BUYER_ID, {
      quantity: 2,
      requestId: 'bypass-req',
    });

    expect(inventoryCache.markRequestSeen).toHaveBeenCalledWith(
      BUYER_ID,
      EVENT_ID,
      'bypass-req',
    );
    expect(domainEvents.publish).toHaveBeenCalledWith(
      'TicketPurchased',
      expect.objectContaining({ eventId: EVENT_ID }),
    );
  });
});

describe('PurchasesService の writer mode drift 補償（Issue #389 指摘1）', () => {
  // prefilter は ticket_type で reserve するが、transaction は legacy で実行される drift。
  const driftPlan: PrefilterPlan = {
    writerMode: 'ticket_type',
    scope: { kind: 'single', ticketTypeId: TICKET_TYPE_ID },
  };

  it('rejected では legacy aggregate を sync せず、同じ Type・数量を exact release する', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'reserved',
      plan: driftPlan,
      // transaction は legacy mode で在庫不足 → rejected。
      db: { writerMode: 'legacy', inventoryUpdated: false, remainingOnReject: 0 },
    });

    const result = await service.createPurchase(
      EVENT_ID,
      BUYER_ID,
      { quantity: 3 },
      { ticketTypeId: TICKET_TYPE_ID },
    );

    expect(result.status).toBe('rejected');
    // legacy aggregate を Ticket Type key へ sync しない。
    expect(inventoryCache.syncTicketTypeCounter).not.toHaveBeenCalled();
    // reserve した同じ Type・数量だけを戻す。
    expect(inventoryCache.releaseTicketType).toHaveBeenCalledWith(
      EVENT_ID,
      TICKET_TYPE_ID,
      3,
    );
  });

  it('confirmed では reserve が実消費に対応するため二重補償（release / sync）しない', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'reserved',
      plan: driftPlan,
      db: { writerMode: 'legacy', inventoryUpdated: true, remainingAfterUpdate: 5 },
    });

    const result = await service.createPurchase(
      EVENT_ID,
      BUYER_ID,
      { quantity: 1 },
      { ticketTypeId: TICKET_TYPE_ID },
    );

    expect(result.status).toBe('confirmed');
    expect(inventoryCache.releaseTicketType).not.toHaveBeenCalled();
    expect(inventoryCache.syncTicketTypeCounter).not.toHaveBeenCalled();
  });

  it('replay では drift でも reserve 分を同じ Type へ戻し、別 Type を変えない', async () => {
    const { service, inventoryCache } = createService({
      reserveOutcome: 'reserved',
      plan: driftPlan,
      db: { writerMode: 'legacy', existingConfirmed: true },
    });

    const result = await service.createPurchase(
      EVENT_ID,
      BUYER_ID,
      { quantity: 2, requestId: 'drift-replay' },
      { ticketTypeId: TICKET_TYPE_ID },
    );

    expect(result.status).toBe('confirmed');
    expect(inventoryCache.releaseTicketType).toHaveBeenCalledWith(
      EVENT_ID,
      TICKET_TYPE_ID,
      2,
    );
    expect(inventoryCache.syncTicketTypeCounter).not.toHaveBeenCalled();
  });
});

// review 1: COMMIT 後に throw しない（「throw したら DB 未 commit」という呼び出し元の前提を守る）。
describe('PurchasesService の COMMIT 前完了保証（review 1）', () => {
  const joinQuery = (q: string): boolean =>
    q.includes('FROM ticket_type_inventory tti') &&
    q.includes('JOIN ticket_types tt');

  it('legacy confirmed で Ticket Type state が欠落したら COMMIT せず ROLLBACK する', async () => {
    const { service, dbClient, domainEvents, inventoryCache } = createService({
      reserveOutcome: 'reserved',
      db: {
        inventoryUpdated: true,
        remainingAfterUpdate: 8,
        compatibilityRemaining: 8,
        ticketTypeStateMissing: true,
      },
    });

    await expect(
      service.createPurchase(EVENT_ID, BUYER_ID, { quantity: 2 }),
    ).rejects.toMatchObject({ status: 500 });

    // COMMIT せず ROLLBACK。purchase は永続化されない。
    expect(dbClient.queries.some((q) => q.includes('COMMIT'))).toBe(false);
    expect(dbClient.queries.some((q) => q.includes('ROLLBACK'))).toBe(true);
    // domain event は発行しない。
    expect(domainEvents.publish).not.toHaveBeenCalled();
    // Valkey 予約は同じ scope・quantity について一度だけ補償される。
    expect(inventoryCache.release).toHaveBeenCalledTimes(1);
    expect(inventoryCache.release).toHaveBeenCalledWith(EVENT_ID, 2);
  });

  it('confirmed 正常系では JOIN と検証が COMMIT 前に終わり、COMMIT 後に query を発行しない', async () => {
    const { service, dbClient, domainEvents } = createService({
      reserveOutcome: 'reserved',
      db: {
        inventoryUpdated: true,
        remainingAfterUpdate: 6,
        compatibilityRemaining: 9,
      },
    });

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
      quantity: 2,
    });
    expect(result.status).toBe('confirmed');

    const joinIdx = dbClient.queries.findIndex(joinQuery);
    const commitIdx = dbClient.queries.findIndex((q) => q.includes('COMMIT'));
    const insertIdx = dbClient.queries.findIndex((q) =>
      q.includes('INSERT INTO purchases'),
    );
    // Ticket Type state JOIN と INSERT は COMMIT より前（post-COMMIT throw の再導入を検出）。
    expect(joinIdx).toBeGreaterThan(-1);
    expect(commitIdx).toBeGreaterThan(-1);
    expect(joinIdx).toBeLessThan(commitIdx);
    expect(insertIdx).toBeLessThan(commitIdx);
    // COMMIT は最後の DB query（COMMIT 後に query / validation を置かない）。
    expect(commitIdx).toBe(dbClient.queries.length - 1);
    // publish は正常に進む。
    expect(domainEvents.publish).toHaveBeenCalledWith(
      'InventoryChanged',
      expect.objectContaining({ inventoryVersion: 7, eventInventoryVersion: 41 }),
    );
  });
});

// review 7: rejected purchase では Ticket Type state JOIN を発行しない（不要な round trip / lock 除去）。
describe('PurchasesService の rejected path JOIN 抑止（review 7）', () => {
  const joinQuery = (q: string): boolean =>
    q.includes('FROM ticket_type_inventory tti') &&
    q.includes('JOIN ticket_types tt');

  it('legacy rejected では JOIN を一度も発行しない', async () => {
    const { service, dbClient } = createService({
      reserveOutcome: 'reserved',
      db: { inventoryUpdated: false, remainingOnReject: 0, compatibilityRemaining: 0 },
    });

    const result = await service.createPurchase(EVENT_ID, BUYER_ID, {
      quantity: 3,
    });
    expect(result.status).toBe('rejected');
    expect(dbClient.queries.some(joinQuery)).toBe(false);
  });

  it('ticket_type rejected では JOIN を一度も発行しない', async () => {
    const { service, dbClient } = createService({
      reserveOutcome: 'reserved',
      db: {
        writerMode: 'ticket_type',
        inventoryUpdated: false,
        remainingOnReject: 0,
        compatibilityRemaining: 0,
      },
    });

    const result = await service.createPurchase(
      EVENT_ID,
      BUYER_ID,
      { quantity: 3 },
      { ticketTypeId: TICKET_TYPE_ID },
    );
    expect(result.status).toBe('rejected');
    expect(dbClient.queries.some(joinQuery)).toBe(false);
  });

  it('confirmed では JOIN を COMMIT 前に一度だけ発行する', async () => {
    const { service, dbClient } = createService({
      reserveOutcome: 'reserved',
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
    expect(result.status).toBe('confirmed');
    expect(dbClient.queries.filter(joinQuery)).toHaveLength(1);
  });
});
