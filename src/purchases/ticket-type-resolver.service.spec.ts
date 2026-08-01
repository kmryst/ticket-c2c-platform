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
  const connect = jest.fn(async () => client);
  const database = { connect } as unknown as DatabaseService;
  return { database, client, connect };
}

// createDeferredDb は query の解決タイミングをテストが制御できる fake DB です。
// singleflight（並行 cache miss の coalescing）検証に使います。
function createDeferredDb(rows: Row[], shouldReject = false) {
  const gates: Array<() => void> = [];
  const client = {
    query: jest.fn(
      () =>
        new Promise((resolve, reject) => {
          gates.push(() =>
            shouldReject
              ? reject(new Error('db down'))
              : resolve({ rowCount: rows.length, rows }),
          );
        }),
    ),
    release: jest.fn(),
  };
  const connect = jest.fn(async () => client);
  const database = { connect } as unknown as DatabaseService;
  return {
    database,
    client,
    connect,
    releaseAll: () => {
      const pending = gates.splice(0, gates.length);
      pending.forEach((gate) => gate());
    },
  };
}

const singlePlan = (id: string): Row => ({
  writer_mode: 'ticket_type',
  ticket_type_id: id,
});

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

// tick は保留中の DB query gate が登録される（connect の microtask 解決後）まで待つ。
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TicketTypeResolverService singleflight（Issue #389 指摘4）', () => {
  it('同じ event への N 並行 miss で DB query は 1 回、全 caller が同じ結果を得る', async () => {
    const { database, client, connect, releaseAll } = createDeferredDb([
      singlePlan(TYPE_A),
    ]);
    const resolver = new TicketTypeResolverService(database);

    const promises = [
      resolver.resolvePrefilterPlan(EVENT_ID),
      resolver.resolvePrefilterPlan(EVENT_ID),
      resolver.resolvePrefilterPlan(EVENT_ID),
    ];
    await tick();
    releaseAll();
    const results = await Promise.all(promises);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toEqual({
        writerMode: 'ticket_type',
        scope: { kind: 'single', ticketTypeId: TYPE_A },
      });
    }
  });

  it('異なる event は独立して解決する（別 query）', async () => {
    const { database, connect, releaseAll } = createDeferredDb([
      { writer_mode: 'legacy', ticket_type_id: null },
    ]);
    const resolver = new TicketTypeResolverService(database);

    const p1 = resolver.resolvePrefilterPlan('event-1');
    const p2 = resolver.resolvePrefilterPlan('event-2');
    await tick();
    releaseAll();
    await Promise.all([p1, p2]);

    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('load 失敗後は in-flight entry が残らず次回 retry できる', async () => {
    const failing = createDeferredDb([], true);
    const resolver = new TicketTypeResolverService(failing.database);

    const p1 = resolver.resolvePrefilterPlan(EVENT_ID);
    await tick();
    failing.releaseAll();
    await expect(p1).rejects.toThrow('db down');

    // in-flight が残っていれば 2 回目は同じ失敗 promise を返すが、削除済みなら新規 load。
    const p2 = resolver.resolvePrefilterPlan(EVENT_ID);
    await tick();
    failing.releaseAll();
    await expect(p2).rejects.toThrow('db down');
    expect(failing.connect).toHaveBeenCalledTimes(2);
  });

  it('prime() は進行中の古い load 完了に上書きされない', async () => {
    const { database, connect, releaseAll } = createDeferredDb([
      singlePlan(TYPE_A),
    ]);
    const resolver = new TicketTypeResolverService(database);

    const loading = resolver.resolvePrefilterPlan(EVENT_ID);
    await tick();
    // load 中に prime で別の plan を確定させる。
    resolver.prime(EVENT_ID, {
      writerMode: 'ticket_type',
      scope: { kind: 'single', ticketTypeId: TYPE_B },
    });
    releaseAll();
    await loading;

    // 古い load（TYPE_A）は prime（TYPE_B）を上書きしない。cache hit で DB へ行かない。
    await expect(resolver.resolvePrefilterPlan(EVENT_ID)).resolves.toEqual({
      writerMode: 'ticket_type',
      scope: { kind: 'single', ticketTypeId: TYPE_B },
    });
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('invalidate() 後は古い load 結果が cache へ復活しない', async () => {
    const { database, connect, releaseAll } = createDeferredDb([
      singlePlan(TYPE_A),
    ]);
    const resolver = new TicketTypeResolverService(database);

    const loading = resolver.resolvePrefilterPlan(EVENT_ID);
    await tick();
    resolver.invalidate(EVENT_ID);
    releaseAll();
    await loading;

    // 古い load 結果は cache へ入らない。次回は再度 DB を読む。
    const second = resolver.resolvePrefilterPlan(EVENT_ID);
    await tick();
    releaseAll();
    await second;
    expect(connect).toHaveBeenCalledTimes(2);
  });
});

describe('TicketTypeResolverService bounded cache（Issue #389 指摘8）', () => {
  const withMaxEntries = async (
    max: string,
    run: () => Promise<void>,
  ): Promise<void> => {
    const saved = process.env.TICKET_TYPE_PREFILTER_CACHE_MAX_ENTRIES;
    process.env.TICKET_TYPE_PREFILTER_CACHE_MAX_ENTRIES = max;
    try {
      await run();
    } finally {
      if (saved === undefined) {
        delete process.env.TICKET_TYPE_PREFILTER_CACHE_MAX_ENTRIES;
      } else {
        process.env.TICKET_TYPE_PREFILTER_CACHE_MAX_ENTRIES = saved;
      }
    }
  };

  it('resolve() は上限を超えず、最も古いエントリを追い出す', async () => {
    await withMaxEntries('1', async () => {
      const { database, connect } = createDb([
        { writer_mode: 'legacy', ticket_type_id: null },
      ]);
      const resolver = new TicketTypeResolverService(database);

      await resolver.resolvePrefilterPlan('event-a'); // cache {a}
      await resolver.resolvePrefilterPlan('event-b'); // a を追い出し {b}
      await resolver.resolvePrefilterPlan('event-a'); // a は再度 miss

      // a(miss) + b(miss) + a(miss) = 3 回 DB。上限 1 で a が evict された証拠。
      expect(connect).toHaveBeenCalledTimes(3);
    });
  });

  it('prime() も上限を守り、最も古いエントリを追い出す', async () => {
    await withMaxEntries('2', async () => {
      const { database, connect } = createDb([
        { writer_mode: 'legacy', ticket_type_id: null },
      ]);
      const resolver = new TicketTypeResolverService(database);
      const plan: PrefilterPlan = { writerMode: 'legacy' };

      resolver.prime('event-a', plan);
      resolver.prime('event-b', plan);
      resolver.prime('event-c', plan); // a を追い出し {b,c}

      await resolver.resolvePrefilterPlan('event-b'); // hit
      await resolver.resolvePrefilterPlan('event-c'); // hit
      await resolver.resolvePrefilterPlan('event-a'); // miss（evict 済み）

      expect(connect).toHaveBeenCalledTimes(1);
    });
  });

  it('LRU touch されたエントリは新しい挿入より優先して残る', async () => {
    await withMaxEntries('2', async () => {
      const { database, connect } = createDb([
        { writer_mode: 'legacy', ticket_type_id: null },
      ]);
      const resolver = new TicketTypeResolverService(database);

      await resolver.resolvePrefilterPlan('event-a'); // {a}
      await resolver.resolvePrefilterPlan('event-b'); // {a,b}
      await resolver.resolvePrefilterPlan('event-a'); // hit, a を末尾へ（{b,a}）
      await resolver.resolvePrefilterPlan('event-c'); // b を追い出し {a,c}

      const before = connect.mock.calls.length;
      await resolver.resolvePrefilterPlan('event-a'); // hit
      expect(connect.mock.calls.length).toBe(before);

      await resolver.resolvePrefilterPlan('event-b'); // miss（LRU で evict 済み）
      expect(connect.mock.calls.length).toBe(before + 1);
    });
  });
});
