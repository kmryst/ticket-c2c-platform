// ファイル概要:
// このファイルは EventsService.createEvent の作成者（created_by）取り扱いの単体テストです
// （production-readiness L-10、Issue #194）。
// 認証統合により作成者は body ではなく createEvent の第 2 引数（JWT sub 由来）として渡します。
// DB / Valkey / EventBridge / OpenSearch はモックし、
// 「INSERT へ渡る created_by がトークン由来の値であり、client 供給値が混入しないこと」だけを検証します。

import { EventsService } from './events.service';
import { DatabaseService } from '../database/database.service';
import { InventoryCacheService } from '../cache/inventory-cache.service';
import { DomainEventsService } from '../messaging/domain-events.service';
import { SearchService } from '../search/search.service';
import { TicketTypeResolverService } from '../purchases/ticket-type-resolver.service';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const CREATOR_ID = '22222222-2222-4222-8222-222222222222';
const SPOOFED_ID = '33333333-3333-4333-8333-333333333333';
const TICKET_TYPE_ID = '44444444-4444-4444-8444-444444444444';

// createFakeDbClient はイベント登録 transaction の SQL 発行を記録する fake PoolClient です。
function createFakeDbClient(writerMode: 'legacy' | 'ticket_type' = 'legacy') {
  const calls: { text: string; values?: unknown[] }[] = [];
  const query = jest.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (text.includes('FROM inventory_writer_control')) {
      return { rowCount: 1, rows: [{ writer_mode: writerMode }] };
    }
    if (text.includes('INSERT INTO events')) {
      return {
        rowCount: 1,
        rows: [{ id: EVENT_ID, created_at: '2026-07-06T00:00:00.000Z' }],
      };
    }
    if (text.includes('FROM ticket_types')) {
      return { rowCount: 1, rows: [{ id: TICKET_TYPE_ID }] };
    }
    // BEGIN / COMMIT / ticket_inventory INSERT はここへ落ちます。
    return { rowCount: 0, rows: [] };
  });
  return { query, release: jest.fn(), calls };
}

function createService(client: ReturnType<typeof createFakeDbClient>) {
  const database = {
    connect: jest.fn(async () => client),
  } as unknown as DatabaseService;
  const inventoryCache = {
    initCounter: jest.fn(async () => undefined),
    initTicketTypeCounter: jest.fn(async () => undefined),
  } as unknown as InventoryCacheService;
  const domainEvents = {
    publish: jest.fn(async () => undefined),
  } as unknown as DomainEventsService;
  const searchService = {
    search: jest.fn(async () => null),
  } as unknown as SearchService;
  const resolver = {
    resolvePrefilterPlan: jest.fn(),
    prime: jest.fn(),
    invalidate: jest.fn(),
  } as unknown as TicketTypeResolverService;

  return new EventsService(
    database,
    inventoryCache,
    domainEvents,
    searchService,
    resolver,
  );
}

// validBody は parseCreateEventInput を通過する最小のイベント登録 body です。
const validBody = {
  title: 'unit test event',
  eventType: 'music',
  startsAt: '2026-08-01T10:00:00.000Z',
  totalQuantity: 10,
};

describe('EventsService.createEvent', () => {
  it('INSERT INTO events の created_by には第 2 引数（JWT sub 由来）が渡る', async () => {
    const client = createFakeDbClient();
    const service = createService(client);

    const result = await service.createEvent(validBody, CREATOR_ID);

    const insert = client.calls.find((c) =>
      c.text.includes('INSERT INTO events'),
    );
    expect(insert).toBeDefined();
    // INSERT 文が created_by カラムを含み、パラメータ末尾（$6）に作成者 ID が入ること。
    expect(insert!.text).toContain('created_by');
    expect(insert!.values).toEqual([
      validBody.title,
      validBody.eventType,
      validBody.startsAt,
      null,
      null,
      CREATOR_ID,
    ]);
    expect(result.eventId).toBe(EVENT_ID);
  });

  it('body に作成者 ID 系のフィールドを混ぜても無視され、トークン由来の値が使われる', async () => {
    const client = createFakeDbClient();
    const service = createService(client);

    // クライアントが作成者を偽装しようとする body（createdBy / created_by / userId のどれも定義外フィールド）。
    await service.createEvent(
      {
        ...validBody,
        createdBy: SPOOFED_ID,
        created_by: SPOOFED_ID,
        userId: SPOOFED_ID,
      },
      CREATOR_ID,
    );

    const insert = client.calls.find((c) =>
      c.text.includes('INSERT INTO events'),
    );
    // 偽装値はどのパラメータにも現れず、created_by はトークン由来の値になること。
    expect(insert!.values).not.toContain(SPOOFED_ID);
    expect(insert!.values![5]).toBe(CREATOR_ID);
  });

  it('登録成功後にカウンタ初期化と EventListed 発行が行われる（既存動作の回帰確認）', async () => {
    const client = createFakeDbClient();
    const database = {
      connect: jest.fn(async () => client),
    } as unknown as DatabaseService;
    const initCounter = jest.fn(async () => undefined);
    const publish = jest.fn(async () => undefined);
    const service = new EventsService(
      database,
      { initCounter } as unknown as InventoryCacheService,
      { publish } as unknown as DomainEventsService,
      { search: jest.fn() } as unknown as SearchService,
    );

    await service.createEvent(validBody, CREATOR_ID);

    expect(initCounter).toHaveBeenCalledWith(EVENT_ID, validBody.totalQuantity);
    expect(publish).toHaveBeenCalledWith(
      'EventListed',
      expect.objectContaining({ eventId: EVENT_ID }),
    );
  });

  it('shared barrier後にmodeを読み、legacy modeでは既存在庫writerを維持する', async () => {
    const client = createFakeDbClient('legacy');
    const service = createService(client);

    await service.createEvent(validBody, CREATOR_ID);

    const sharedBarrier = client.calls.findIndex(({ text }) =>
      text.includes('pg_advisory_xact_lock_shared'),
    );
    const controlRead = client.calls.findIndex(({ text }) =>
      text.includes('FROM inventory_writer_control'),
    );
    const eventInsert = client.calls.findIndex(({ text }) =>
      text.includes('INSERT INTO events'),
    );
    expect(sharedBarrier).toBeGreaterThan(-1);
    expect(controlRead).toBeGreaterThan(sharedBarrier);
    expect(eventInsert).toBeGreaterThan(controlRead);
    expect(
      client.calls.some(({ text }) => text.includes('INSERT INTO ticket_inventory')),
    ).toBe(true);
  });

  it('ticket_type modeではdefault Typeのactive在庫を初期化しlegacyへ直接書かない', async () => {
    const client = createFakeDbClient('ticket_type');
    const service = createService(client);

    await service.createEvent(validBody, CREATOR_ID);

    expect(
      client.calls.some(({ text }) =>
        text.includes('INSERT INTO ticket_type_inventory'),
      ),
    ).toBe(true);
    expect(
      client.calls.some(({ text }) => text.includes('INSERT INTO ticket_inventory')),
    ).toBe(false);
  });

  it('ticket_type modeでは Type counter と mapping を初期化し、Event counter を作らない（Issue #389）', async () => {
    const client = createFakeDbClient('ticket_type');
    const database = {
      connect: jest.fn(async () => client),
    } as unknown as DatabaseService;
    const initCounter = jest.fn(async () => undefined);
    const initTicketTypeCounter = jest.fn(async () => undefined);
    const prime = jest.fn();
    const service = new EventsService(
      database,
      { initCounter, initTicketTypeCounter } as unknown as InventoryCacheService,
      { publish: jest.fn(async () => undefined) } as unknown as DomainEventsService,
      { search: jest.fn() } as unknown as SearchService,
      {
        resolvePrefilterPlan: jest.fn(),
        prime,
        invalidate: jest.fn(),
      } as unknown as TicketTypeResolverService,
    );

    await service.createEvent(validBody, CREATOR_ID);

    // commit 後に Type counter と mapping を初期化し、Event 単位 counter は作らない。
    expect(initTicketTypeCounter).toHaveBeenCalledWith(
      EVENT_ID,
      TICKET_TYPE_ID,
      validBody.totalQuantity,
    );
    expect(initCounter).not.toHaveBeenCalled();
    expect(prime).toHaveBeenCalledWith(EVENT_ID, {
      writerMode: 'ticket_type',
      scope: { kind: 'single', ticketTypeId: TICKET_TYPE_ID },
    });
  });
});
