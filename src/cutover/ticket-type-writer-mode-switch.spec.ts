// ファイル概要:
// executeWriterModeSwitch（ADR-0032 の切替 transaction）の単体テストです。
// scripted fake client で SQL の実行順序（BEGIN → SET LOCAL → 排他 barrier →
// table lock → 切替前 parity → UPDATE → 切替後 parity → COMMIT）と、
// 失敗時の ROLLBACK / UPDATE 未実行（fail closed）を検証します。

import {
  assertNoCutoverViolations,
  DEFAULT_WRITER_MODE_SWITCH_TIMEOUTS,
  executeWriterModeSwitch,
  oppositeWriterMode,
  WriterModeSwitchCommitOutcomeUnknownError,
} from './ticket-type-writer-mode-switch';
import {
  INVENTORY_WRITER_TABLE_LOCK_SQL,
  InventoryWriterMode,
} from '../database/inventory-writer-control';
import { LOCK_WRITER_TABLES_SQL } from '../database/migrations/1785542400000-add-ticket-type-compatibility-writer';

// checkCutoverDatabase が要求する DB / control / schema category（13 件）。
const DATABASE_CATEGORIES = [
  'event_without_exactly_one_default',
  'event_without_legacy_inventory',
  'legacy_inventory_without_default_ticket_type_inventory',
  'ticket_type_inventory_without_ticket_type',
  'ticket_type_without_ticket_type_inventory',
  'purchase_without_ticket_type',
  'purchase_ticket_type_event_mismatch',
  'legacy_aggregate_total_mismatch',
  'legacy_aggregate_remaining_mismatch',
  'non_default_ticket_type_inventory_in_legacy_mode',
  'writer_control_state_missing_or_invalid',
  'writer_control_mode_mismatch',
  'compatibility_object_missing_or_invalid',
] as const;

interface FakeClientOptions {
  initialMode: InventoryWriterMode | null;
  schemaRevision?: string;
  // 何回目の readiness 検査で violation を返すか（1-origin。undefined なら常に 0 件）。
  violationOnReadinessCall?: number;
  violationCategory?: (typeof DATABASE_CATEGORIES)[number];
  // readiness 検査の回数（1-origin）ごとに schemaRevision を差し替える
  // （切替 transaction 中の migration commit を模す）。
  schemaRevisionByReadinessCall?: Record<number, string>;
  // COMMIT の応答喪失を模す: サーバ側では commit 済み（currentMode は UPDATE 済みの
  // まま）だが、COMMIT の query が connection エラーで reject される。
  failCommit?: boolean;
}

interface FakeClient {
  query: (text: string, params?: unknown[]) => Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount: number;
  }>;
  executed: string[];
  currentMode: InventoryWriterMode | null;
  committed: boolean;
  rolledBack: boolean;
}

function createFakeClient(options: FakeClientOptions): FakeClient {
  const schemaRevision =
    options.schemaRevision ?? 'AddTicketTypeCompatibilityWriter1785542400000';
  let readinessCalls = 0;
  const fake: FakeClient = {
    executed: [],
    currentMode: options.initialMode,
    committed: false,
    rolledBack: false,
    query: async (text: string, params?: unknown[]) => {
      const sql = text.trim();
      fake.executed.push(sql);
      if (sql === 'COMMIT') {
        if (options.failCommit) {
          // サーバ側 commit は確定済み（currentMode は変更されたまま）という前提で
          // 応答だけが失われたことを模す。
          throw new Error('Connection terminated unexpectedly');
        }
        fake.committed = true;
        return { rows: [], rowCount: 0 };
      }
      if (sql === 'ROLLBACK') {
        fake.rolledBack = true;
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('WITH expected AS')) {
        readinessCalls += 1;
        const violate =
          options.violationOnReadinessCall === readinessCalls
            ? (options.violationCategory ?? 'legacy_aggregate_remaining_mismatch')
            : null;
        return {
          rows: DATABASE_CATEGORIES.map((category) => ({
            category,
            violation_count: category === violate ? '2' : '0',
          })),
          rowCount: DATABASE_CATEGORIES.length,
        };
      }
      if (sql.startsWith('UPDATE inventory_writer_control')) {
        if (fake.currentMode === null) {
          return { rows: [], rowCount: 0 };
        }
        fake.currentMode = params?.[0] as InventoryWriterMode;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM public.inventory_writer_control')) {
        return fake.currentMode === null
          ? { rows: [], rowCount: 0 }
          : { rows: [{ writer_mode: fake.currentMode }], rowCount: 1 };
      }
      if (sql.includes('FROM public.typeorm_migrations')) {
        const name =
          options.schemaRevisionByReadinessCall?.[readinessCalls] ??
          schemaRevision;
        return { rows: [{ name }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return fake;
}

function indexOfExecuted(fake: FakeClient, needle: string): number {
  return fake.executed.findIndex((sql) => sql.includes(needle));
}

describe('oppositeWriterMode', () => {
  it('legacy と ticket_type を相互に返す', () => {
    expect(oppositeWriterMode('legacy')).toBe('ticket_type');
    expect(oppositeWriterMode('ticket_type')).toBe('legacy');
  });
});

describe('assertNoCutoverViolations', () => {
  it('violation 0 件なら通過する', () => {
    expect(() =>
      assertNoCutoverViolations(
        [{ category: 'valkey_counter_missing', violationCount: 0 }],
        'test',
      ),
    ).not.toThrow();
  });

  it('violation ありは category と件数を列挙して停止する', () => {
    expect(() =>
      assertNoCutoverViolations(
        [
          { category: 'valkey_counter_missing', violationCount: 0 },
          { category: 'legacy_aggregate_total_mismatch', violationCount: 3 },
        ],
        'pre-switch (legacy)',
      ),
    ).toThrow(/pre-switch \(legacy\).*legacy_aggregate_total_mismatch=3/);
  });
});

describe('executeWriterModeSwitch', () => {
  it('BEGIN → SET LOCAL → 排他 barrier → table lock → parity → UPDATE → parity → COMMIT の順で実行する', async () => {
    const fake = createFakeClient({ initialMode: 'legacy' });
    const result = await executeWriterModeSwitch(fake, 'ticket_type');

    expect(result.sourceMode).toBe('legacy');
    expect(result.targetMode).toBe('ticket_type');
    expect(result.schemaRevision).toBe(
      'AddTicketTypeCompatibilityWriter1785542400000',
    );
    // 切替後（target mode）parity 検査の全 category 結果を機械可読な証跡として返す。
    expect(result.postSwitchDatabaseResults).toHaveLength(
      DATABASE_CATEGORIES.length,
    );
    expect(
      result.postSwitchDatabaseResults.every((r) => r.violationCount === 0),
    ).toBe(true);
    expect(fake.committed).toBe(true);
    expect(fake.rolledBack).toBe(false);
    expect(fake.currentMode).toBe('ticket_type');

    const begin = indexOfExecuted(fake, 'BEGIN');
    const lockTimeout = indexOfExecuted(
      fake,
      `SET LOCAL lock_timeout = '${DEFAULT_WRITER_MODE_SWITCH_TIMEOUTS.lockTimeout}'`,
    );
    const barrier = indexOfExecuted(fake, 'pg_advisory_xact_lock');
    const tableLock = indexOfExecuted(fake, 'LOCK TABLE events IN EXCLUSIVE MODE');
    const firstParity = fake.executed.findIndex((sql) =>
      sql.includes('WITH expected AS'),
    );
    const update = indexOfExecuted(fake, 'UPDATE inventory_writer_control');
    let secondParity = -1;
    for (let i = fake.executed.length - 1; i >= 0; i -= 1) {
      if (fake.executed[i].includes('WITH expected AS')) {
        secondParity = i;
        break;
      }
    }
    const commit = indexOfExecuted(fake, 'COMMIT');

    expect(begin).toBeGreaterThanOrEqual(0);
    expect(lockTimeout).toBeGreaterThan(begin);
    expect(barrier).toBeGreaterThan(lockTimeout);
    expect(tableLock).toBeGreaterThan(barrier);
    expect(firstParity).toBeGreaterThan(tableLock);
    expect(update).toBeGreaterThan(firstParity);
    expect(secondParity).toBeGreaterThan(update);
    expect(commit).toBeGreaterThan(secondParity);
  });

  it('共有 table lock SQL は #336 / #376 migration の LOCK_WRITER_TABLES_SQL と完全一致する', () => {
    // 共有定数と適用済み migration の lock 順が乖離したらこのテストで検出する
    // （migration の up() 本体は変更しない。export のみ追加）。
    expect(INVENTORY_WRITER_TABLE_LOCK_SQL).toBe(LOCK_WRITER_TABLES_SQL);
  });

  it('table lock 順は決定的（events → purchases → ticket_types → ticket_inventory → ticket_type_inventory）', () => {
    const order = [
      'LOCK TABLE events IN EXCLUSIVE MODE;',
      'LOCK TABLE purchases IN ACCESS EXCLUSIVE MODE NOWAIT;',
      'LOCK TABLE ticket_types IN SHARE ROW EXCLUSIVE MODE NOWAIT;',
      'LOCK TABLE ticket_inventory IN SHARE ROW EXCLUSIVE MODE NOWAIT;',
      'LOCK TABLE ticket_type_inventory IN SHARE ROW EXCLUSIVE MODE NOWAIT;',
    ];
    let cursor = -1;
    for (const statement of order) {
      const next = INVENTORY_WRITER_TABLE_LOCK_SQL.indexOf(statement);
      expect(next).toBeGreaterThan(cursor);
      cursor = next;
    }
  });

  it('切替前 parity の violation で ROLLBACK し、UPDATE を実行しない', async () => {
    const fake = createFakeClient({
      initialMode: 'legacy',
      violationOnReadinessCall: 1,
    });
    await expect(
      executeWriterModeSwitch(fake, 'ticket_type'),
    ).rejects.toThrow(/legacy_aggregate_remaining_mismatch=2/);
    expect(fake.rolledBack).toBe(true);
    expect(fake.committed).toBe(false);
    expect(indexOfExecuted(fake, 'UPDATE inventory_writer_control')).toBe(-1);
    expect(fake.currentMode).toBe('legacy');
  });

  it('切替後 parity の violation で ROLLBACK し、COMMIT しない（UPDATE は実行済みでも永続化されない）', async () => {
    const fake = createFakeClient({
      initialMode: 'legacy',
      violationOnReadinessCall: 2,
    });
    await expect(
      executeWriterModeSwitch(fake, 'ticket_type'),
    ).rejects.toThrow(/post-switch \(ticket_type\)/);
    expect(fake.rolledBack).toBe(true);
    expect(fake.committed).toBe(false);
    expect(
      indexOfExecuted(fake, 'UPDATE inventory_writer_control'),
    ).toBeGreaterThanOrEqual(0);
  });

  it('現 mode が source と一致しない場合は UPDATE 前に停止する（target と同一 mode を含む）', async () => {
    const fake = createFakeClient({ initialMode: 'ticket_type' });
    await expect(
      executeWriterModeSwitch(fake, 'ticket_type'),
    ).rejects.toThrow(/expected current mode legacy but found ticket_type/);
    expect(fake.rolledBack).toBe(true);
    expect(indexOfExecuted(fake, 'UPDATE inventory_writer_control')).toBe(-1);
  });

  it('control row 欠損は fail closed で停止する', async () => {
    const fake = createFakeClient({ initialMode: null });
    await expect(
      executeWriterModeSwitch(fake, 'ticket_type'),
    ).rejects.toThrow(/missing or invalid/);
    expect(fake.rolledBack).toBe(true);
    expect(fake.committed).toBe(false);
  });

  it('preflight 後に schema revision が変わっていたら停止する', async () => {
    const fake = createFakeClient({
      initialMode: 'legacy',
      schemaRevision: 'SomeNewerMigration1790000000000',
    });
    await expect(
      executeWriterModeSwitch(fake, 'ticket_type', {
        expectedSchemaRevision: 'AddTicketTypeCompatibilityWriter1785542400000',
      }),
    ).rejects.toThrow(/schema revision changed since preflight/);
    expect(fake.rolledBack).toBe(true);
    expect(indexOfExecuted(fake, 'UPDATE inventory_writer_control')).toBe(-1);
  });

  it('COMMIT の失敗は commit_outcome_unknown として区別し、ROLLBACK を試みない', async () => {
    const fake = createFakeClient({ initialMode: 'legacy', failCommit: true });
    let caught: unknown;
    try {
      await executeWriterModeSwitch(fake, 'ticket_type');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WriterModeSwitchCommitOutcomeUnknownError);
    const unknownError = caught as WriterModeSwitchCommitOutcomeUnknownError;
    expect(unknownError.kind).toBe('commit_outcome_unknown');
    // COMMIT 送信時点で確定していた切替内容（parity 0 件）を証跡として保持する。
    expect(unknownError.pendingResult.targetMode).toBe('ticket_type');
    expect(unknownError.pendingResult.postSwitchDatabaseResults).toHaveLength(
      DATABASE_CATEGORIES.length,
    );
    // transaction はサーバ側で終了済みか connection が死んでいるかのどちらかなので、
    // ROLLBACK は発行しない（他の失敗と異なり「取り消せた」と誤認させない）。
    expect(fake.rolledBack).toBe(false);
    expect(indexOfExecuted(fake, 'ROLLBACK')).toBe(-1);
  });

  it('切替 transaction 中に schema revision が動いたら COMMIT せず停止する', async () => {
    // table lock 対象外の typeorm_migrations への commit は READ COMMITTED で
    // statement ごとに可視になる。切替前後の 2 回の読み取りで差分を検出する。
    const fake = createFakeClient({
      initialMode: 'legacy',
      schemaRevisionByReadinessCall: {
        2: 'SomeNewerMigration1790000000000',
      },
    });
    await expect(
      executeWriterModeSwitch(fake, 'ticket_type'),
    ).rejects.toThrow(/schema revision changed during switch transaction/);
    expect(fake.rolledBack).toBe(true);
    expect(fake.committed).toBe(false);
  });

  it('timeout 0（PostgreSQL では timeout 無効化）は拒否する', async () => {
    for (const zero of ['0s', '0ms', '000min']) {
      const fake = createFakeClient({ initialMode: 'legacy' });
      await expect(
        executeWriterModeSwitch(fake, 'ticket_type', {
          timeouts: { lockTimeout: zero },
        }),
      ).rejects.toThrow(/lock_timeout must be a positive duration/);
      expect(fake.executed).toHaveLength(0);
    }
    const fakeStatement = createFakeClient({ initialMode: 'legacy' });
    await expect(
      executeWriterModeSwitch(fakeStatement, 'ticket_type', {
        timeouts: { statementTimeout: '0s' },
      }),
    ).rejects.toThrow(/statement_timeout must be a positive duration/);
    expect(fakeStatement.executed).toHaveLength(0);
  });

  it('不正な timeout literal は transaction 開始前に拒否する', async () => {
    const fake = createFakeClient({ initialMode: 'legacy' });
    await expect(
      executeWriterModeSwitch(fake, 'ticket_type', {
        timeouts: { lockTimeout: "10s'; DROP TABLE events; --" },
      }),
    ).rejects.toThrow(/lock_timeout must be a positive duration/);
    expect(fake.executed).toHaveLength(0);
  });

  it('不正な target mode を拒否する', async () => {
    const fake = createFakeClient({ initialMode: 'legacy' });
    await expect(
      executeWriterModeSwitch(fake, 'both' as InventoryWriterMode),
    ).rejects.toThrow(/invalid target writer mode/);
    expect(fake.executed).toHaveLength(0);
  });
});
