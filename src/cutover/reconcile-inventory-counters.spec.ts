// ファイル概要:
// seed / reconcile CLI（reconcile-inventory-counters.ts）の単体テストです。
// 引数解析の fail-closed（既定値なしの必須オプション）、seed guard の refuse 分岐、
// refuse 時に Valkey へ一切書き込まないこと（transaction は ROLLBACK されること）を
// mock で検証します。実 store を使う経路は integration spec が担当します。

import type { Pool } from 'pg';
import {
  assertSeedNamespaceInactive,
  parseModeOption,
  parseNamespaceOption,
  runInventoryCounterReconcile,
  SeedNamespaceActiveError,
  serializeCounterReconcileEvidence,
  ValkeyCounterClient,
} from './reconcile-inventory-counters';

describe('parseNamespaceOption / parseModeOption（fail closed）', () => {
  it('--namespace は既定値を持たず、未指定・不正値は使用エラーで停止する', () => {
    expect(() => parseNamespaceOption([])).toThrow(/usage:/);
    expect(() => parseNamespaceOption(['--namespace', 'both'])).toThrow(/usage:/);
    // Valkey キー命名（inventory:ticket-type:...）と揃えた表記だけを受け付ける。
    expect(() => parseNamespaceOption(['--namespace', 'ticket_type'])).toThrow(
      /usage:/,
    );
    expect(parseNamespaceOption(['--namespace', 'ticket-type'])).toBe(
      'ticket-type',
    );
    expect(parseNamespaceOption(['--namespace=legacy'])).toBe('legacy');
  });

  it('--mode は既定値を持たず、未指定・不正値は使用エラーで停止する', () => {
    expect(() => parseModeOption([])).toThrow(/usage:/);
    expect(() => parseModeOption(['--mode', 'init'])).toThrow(/usage:/);
    expect(parseModeOption(['--mode', 'seed'])).toBe('seed');
    expect(parseModeOption(['--mode=reconcile'])).toBe('reconcile');
  });
});

describe('assertSeedNamespaceInactive（inactive namespace guard）', () => {
  it('active writer が触らない側の namespace だけ seed を許可する', () => {
    // activation 前 seed: ticket-type namespace は legacy mode のときだけ書ける。
    expect(() =>
      assertSeedNamespaceInactive('ticket-type', 'legacy'),
    ).not.toThrow();
    // rollback 前の legacy 再 seed: legacy namespace は ticket_type mode のときだけ書ける。
    expect(() =>
      assertSeedNamespaceInactive('legacy', 'ticket_type'),
    ).not.toThrow();
  });

  it('active namespace への seed は SeedNamespaceActiveError で refuse する', () => {
    expect(() =>
      assertSeedNamespaceInactive('ticket-type', 'ticket_type'),
    ).toThrow(SeedNamespaceActiveError);
    expect(() => assertSeedNamespaceInactive('legacy', 'legacy')).toThrow(
      SeedNamespaceActiveError,
    );
  });

  it('refuse の message は namespace と writer mode だけを含む（secret なし）', () => {
    try {
      assertSeedNamespaceInactive('legacy', 'legacy');
      throw new Error('expected SeedNamespaceActiveError');
    } catch (error) {
      expect(error).toBeInstanceOf(SeedNamespaceActiveError);
      expect((error as SeedNamespaceActiveError).message).toBe(
        'refusing to seed namespace legacy: it is active under writer_mode=legacy ' +
          '(seed is allowed only for the inactive namespace)',
      );
    }
  });
});

// mock 用の snapshot client / pool。発行 SQL を記録し、writer mode の SELECT に応答する。
interface MockDb {
  pool: Pool;
  statements: string[];
}

function buildMockDb(writerMode: string): MockDb {
  const statements: string[] = [];
  const client = {
    query: jest.fn(async (text: string) => {
      statements.push(text.trim());
      if (text.includes('FROM inventory_writer_control')) {
        return { rows: [{ writer_mode: writerMode }], rowCount: 1 };
      }
      // barrier / BEGIN / SET LOCAL / COMMIT / ROLLBACK / 在庫 SELECT。
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
  const pool = {
    connect: jest.fn(async () => client),
    query: jest.fn(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as Pool;
  return { pool, statements };
}

function buildMockValkey(): ValkeyCounterClient {
  return {
    get: jest.fn(async () => null),
    eval: jest.fn(async () => 'initialized'),
  };
}

describe('runInventoryCounterReconcile（guard / transaction 規律）', () => {
  it('active namespace への seed は Valkey へ書き込まず ROLLBACK して refuse する', async () => {
    const db = buildMockDb('legacy');
    const valkey = buildMockValkey();

    await expect(
      runInventoryCounterReconcile(
        { pool: db.pool, valkey },
        { namespace: 'legacy', mode: 'seed' },
      ),
    ).rejects.toBeInstanceOf(SeedNamespaceActiveError);

    // refuse までに Valkey コマンドを一切発行しない（書き込みなしの保証）。
    expect(valkey.eval).not.toHaveBeenCalled();
    expect(valkey.get).not.toHaveBeenCalled();
    // transaction は ROLLBACK で閉じる（部分状態を残さない）。
    expect(db.statements.some((s) => s === 'ROLLBACK')).toBe(true);
    expect(db.statements.some((s) => s === 'COMMIT')).toBe(false);
  });

  it('guard 判定の前に READ ONLY snapshot と shared barrier を確立する（TOCTOU 対策の順序）', async () => {
    const db = buildMockDb('ticket_type');
    const valkey = buildMockValkey();

    await expect(
      runInventoryCounterReconcile(
        { pool: db.pool, valkey },
        { namespace: 'ticket-type', mode: 'seed' },
      ),
    ).rejects.toBeInstanceOf(SeedNamespaceActiveError);

    const beginIndex = db.statements.findIndex((s) =>
      s.startsWith('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'),
    );
    const barrierIndex = db.statements.findIndex((s) =>
      s.includes('pg_advisory_xact_lock_shared'),
    );
    const modeReadIndex = db.statements.findIndex((s) =>
      s.includes('FROM inventory_writer_control'),
    );
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(barrierIndex).toBeGreaterThan(beginIndex);
    expect(modeReadIndex).toBeGreaterThan(barrierIndex);
  });

  it('reconcile は guard を課さない（active namespace の postflight 収束に使える）', async () => {
    // writer_mode=ticket_type のまま ticket-type namespace を reconcile できる
    // （CAS が並行変更から守るため、seed と違い inactive 制約を課さない）。
    const db = buildMockDb('ticket_type');
    const valkey = buildMockValkey();

    const outcome = await runInventoryCounterReconcile(
      { pool: db.pool, valkey },
      { namespace: 'ticket-type', mode: 'reconcile' },
    );
    expect(outcome.writerMode).toBe('ticket_type');
    expect(outcome.counts).toEqual({
      processed: 0,
      initialized: 0,
      synced: 0,
      skipped: 0,
    });
    expect(db.statements.some((s) => s === 'COMMIT')).toBe(true);
  });
});

describe('serializeCounterReconcileEvidence', () => {
  it('1 行 JSON で namespace / mode / writerMode / 件数を出力する', () => {
    const evidence = serializeCounterReconcileEvidence({
      namespace: 'legacy',
      mode: 'seed',
      writerMode: 'ticket_type',
      counts: { processed: 3, initialized: 3, synced: 0, skipped: 0 },
    });
    expect(evidence).not.toContain('\n');
    expect(JSON.parse(evidence)).toEqual({
      action: 'inventory-counter-reconcile',
      namespace: 'legacy',
      mode: 'seed',
      writerMode: 'ticket_type',
      processed: 3,
      initialized: 3,
      synced: 0,
      skipped: 0,
    });
  });
});
