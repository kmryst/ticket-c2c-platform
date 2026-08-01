// ファイル概要:
// このファイルは TicketTypeResolverService の単体テストです（Issue #389）。
// prefilter plan の cache hit / miss と writer mode / Type scope 解決を、
// fake DB で検証します。cache hit で PostgreSQL へ到達しないことが要点です。

import { DatabaseService } from '../database/database.service';
import { TicketTypeResolverService } from './ticket-type-resolver.service';

const EVENT_ID = '11111111-1111-4111-8111-111111111111';
const TYPE_A = '44444444-4444-4444-8444-444444444444';
const TYPE_B = '55555555-5555-4555-8555-555555555555';

type Row = { writer_mode: string; ticket_type_id: string | null };

function createDb(rows: Row[]) {
  const client = {
    query: jest.fn(async () => ({ rowCount: rows.length, rows })),
    release: jest.fn(),
  };
  const database = {
    connect: jest.fn(async () => client),
  } as unknown as DatabaseService;
  return { database, client };
}

describe('TicketTypeResolverService', () => {
  it('legacy mode の plan を返す', async () => {
    const { database } = createDb([
      { writer_mode: 'legacy', ticket_type_id: null },
    ]);
    const resolver = new TicketTypeResolverService(database);

    await expect(resolver.resolvePrefilterPlan(EVENT_ID)).resolves.toEqual({
      writerMode: 'legacy',
    });
  });

  it('単一 Type の ticket_type mode は single scope を返す', async () => {
    const { database } = createDb([
      { writer_mode: 'ticket_type', ticket_type_id: TYPE_A },
    ]);
    const resolver = new TicketTypeResolverService(database);

    await expect(resolver.resolvePrefilterPlan(EVENT_ID)).resolves.toEqual({
      writerMode: 'ticket_type',
      scope: { kind: 'single', ticketTypeId: TYPE_A },
    });
  });

  it('複数 Type の ticket_type mode は multi scope（bypass）を返す', async () => {
    const { database } = createDb([
      { writer_mode: 'ticket_type', ticket_type_id: TYPE_A },
      { writer_mode: 'ticket_type', ticket_type_id: TYPE_B },
    ]);
    const resolver = new TicketTypeResolverService(database);

    await expect(resolver.resolvePrefilterPlan(EVENT_ID)).resolves.toEqual({
      writerMode: 'ticket_type',
      scope: { kind: 'multi' },
    });
  });

  it('cache hit では DB へ到達しない（2 回目は connect しない）', async () => {
    const { database } = createDb([
      { writer_mode: 'ticket_type', ticket_type_id: TYPE_A },
    ]);
    const resolver = new TicketTypeResolverService(database);

    await resolver.resolvePrefilterPlan(EVENT_ID);
    await resolver.resolvePrefilterPlan(EVENT_ID);

    // cache miss は 1 回だけ DB を読む。
    expect(database.connect).toHaveBeenCalledTimes(1);
  });

  it('cache miss のときだけ DB で解決して cache する', async () => {
    const { database, client } = createDb([
      { writer_mode: 'ticket_type', ticket_type_id: TYPE_A },
    ]);
    const resolver = new TicketTypeResolverService(database);

    await resolver.resolvePrefilterPlan(EVENT_ID);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('prime した plan は DB を読まずに返る', async () => {
    const { database } = createDb([
      { writer_mode: 'legacy', ticket_type_id: null },
    ]);
    const resolver = new TicketTypeResolverService(database);

    resolver.prime(EVENT_ID, {
      writerMode: 'ticket_type',
      scope: { kind: 'single', ticketTypeId: TYPE_A },
    });

    await expect(resolver.resolvePrefilterPlan(EVENT_ID)).resolves.toEqual({
      writerMode: 'ticket_type',
      scope: { kind: 'single', ticketTypeId: TYPE_A },
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('invalidate 後は再び DB を読む', async () => {
    const { database } = createDb([
      { writer_mode: 'legacy', ticket_type_id: null },
    ]);
    const resolver = new TicketTypeResolverService(database);

    await resolver.resolvePrefilterPlan(EVENT_ID);
    resolver.invalidate(EVENT_ID);
    await resolver.resolvePrefilterPlan(EVENT_ID);

    expect(database.connect).toHaveBeenCalledTimes(2);
  });

  it('TTL 経過後は再解決する', async () => {
    const saved = process.env.TICKET_TYPE_PREFILTER_CACHE_TTL_MS;
    process.env.TICKET_TYPE_PREFILTER_CACHE_TTL_MS = '1';
    try {
      const { database } = createDb([
        { writer_mode: 'legacy', ticket_type_id: null },
      ]);
      const resolver = new TicketTypeResolverService(database);

      await resolver.resolvePrefilterPlan(EVENT_ID);
      await new Promise((r) => setTimeout(r, 5));
      await resolver.resolvePrefilterPlan(EVENT_ID);

      expect(database.connect).toHaveBeenCalledTimes(2);
    } finally {
      if (saved === undefined) {
        delete process.env.TICKET_TYPE_PREFILTER_CACHE_TTL_MS;
      } else {
        process.env.TICKET_TYPE_PREFILTER_CACHE_TTL_MS = saved;
      }
    }
  });

  it('control 状態が不正なら例外を投げる', async () => {
    const { database } = createDb([
      { writer_mode: 'bogus', ticket_type_id: null },
    ]);
    const resolver = new TicketTypeResolverService(database);

    await expect(resolver.resolvePrefilterPlan(EVENT_ID)).rejects.toThrow(
      'inventory writer control state is missing or invalid',
    );
  });
});
