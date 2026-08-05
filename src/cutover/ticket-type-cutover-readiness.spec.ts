// ファイル概要:
// Gate B cutover readiness library の単体テストです（Issue #378）。
// fake SQL / fake Valkey で category 集計と fail-closed 検証（evidence parser を含む）を確認します。
// 実 PostgreSQL / Valkey / OpenSearch を使う end-to-end 検証は
// cutover-readiness.integration.spec.ts が担当します。

import { randomUUID } from 'node:crypto';
import {
  eventCounterKey,
  parseTicketTypeCounterKey,
  ticketTypeCounterKey,
  ticketTypeCounterRevisionKey,
} from '../cache/inventory-cache.keys';
import type { ReconciliationReport } from '../search/inventory-reconciliation.service';
import {
  assertTicketTypeCutoverReadinessComplete,
  checkCutoverDatabase,
  checkCutoverValkey,
  hasTicketTypeCutoverViolations,
  parseTicketTypeCutoverEvidence,
  serializeTicketTypeCutoverEvidence,
  TICKET_TYPE_CUTOVER_EVIDENCE_TYPE,
  TICKET_TYPE_CUTOVER_EVIDENCE_VERSION,
  TICKET_TYPE_CUTOVER_READINESS_CATEGORIES,
  TicketTypeCutoverReadinessResult,
  ValkeyReadClient,
} from './ticket-type-cutover-readiness';

const DATABASE_CATEGORIES = TICKET_TYPE_CUTOVER_READINESS_CATEGORIES.filter(
  (c) => !c.startsWith('valkey_') && c !== 'opensearch_projection_diff',
);
const VALKEY_CATEGORIES = TICKET_TYPE_CUTOVER_READINESS_CATEGORIES.filter((c) =>
  c.startsWith('valkey_'),
);

interface FakeSqlCall {
  text: string;
  params?: unknown[];
}

// createFakeSql は SQL 本文の特徴で応答を切り替える最小 SqlClient を作ります。
function createFakeSql(handlers: {
  violations?: () => { category: string; violation_count: string }[];
  control?: () => { writer_mode: string }[];
  revision?: () => { name: string }[];
  inventoryPage?: (params: unknown[]) => Record<string, unknown>[];
  legacyInventoryPage?: (params: unknown[]) => Record<string, unknown>[];
  presentPairs?: (params: unknown[]) => Record<string, unknown>[];
}): { client: { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> }; calls: FakeSqlCall[] } {
  const calls: FakeSqlCall[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      let rows: Record<string, unknown>[];
      if (text.includes('violations AS')) {
        rows = handlers.violations?.() ?? [];
      } else if (text.includes('FROM public.inventory_writer_control')) {
        rows = handlers.control?.() ?? [];
      } else if (text.includes('FROM public.typeorm_migrations')) {
        rows = handlers.revision?.() ?? [];
      } else if (text.includes('FROM public.ticket_type_inventory\n        WHERE ($1::uuid IS NULL')) {
        rows = handlers.inventoryPage?.(params ?? []) ?? [];
      } else if (text.includes('FROM public.ticket_inventory\n        WHERE ($1::uuid IS NULL')) {
        rows = handlers.legacyInventoryPage?.(params ?? []) ?? [];
      } else if (text.includes('unnest($1::uuid[], $2::uuid[])')) {
        rows = handlers.presentPairs?.(params ?? []) ?? [];
      } else {
        throw new Error(`unexpected SQL in fake: ${text.slice(0, 80)}`);
      }
      return { rows, rowCount: rows.length };
    },
  };
  return { client, calls };
}

function healthyViolationRows(): { category: string; violation_count: string }[] {
  return DATABASE_CATEGORIES.map((category) => ({
    category,
    violation_count: '0',
  })).sort((a, b) => a.category.localeCompare(b.category));
}

function zeroResults(): TicketTypeCutoverReadinessResult[] {
  return TICKET_TYPE_CUTOVER_READINESS_CATEGORIES.map((category) => ({
    category,
    violationCount: 0,
  }));
}

function emptyReport(index = 'events'): ReconciliationReport {
  return {
    index,
    checkedEvents: 0,
    checkedDocuments: 0,
    counts: {
      missing_event_document: 0,
      unexpected_event_document: 0,
      missing_ticket_type: 0,
      unexpected_ticket_type: 0,
      ticket_type_total_mismatch: 0,
      ticket_type_remaining_mismatch: 0,
      ticket_type_version_mismatch: 0,
      event_total_mismatch: 0,
      event_remaining_mismatch: 0,
      event_version_mismatch: 0,
      metadata_mismatch: 0,
      contract_corruption: 0,
      unversioned_projection: 0,
      malformed_projection: 0,
    },
    totalDiffs: 0,
    findings: [],
    hasDiff: false,
  };
}

function healthyEvidenceInput() {
  return {
    expectedWriterMode: 'legacy' as const,
    checkPhase: 'preflight' as const,
    writerMode: 'legacy' as const,
    schemaRevision: 'AddTicketTypeCompatibilityWriter1785542400000',
    opensearchIndex: 'events',
    results: zeroResults(),
    opensearchReport: emptyReport(),
  };
}

describe('TICKET_TYPE_CUTOVER_READINESS_CATEGORIES', () => {
  it('21 category（DB 10 + control 2 + schema object 1 + Valkey 7 + OpenSearch 1）で重複がない', () => {
    expect(TICKET_TYPE_CUTOVER_READINESS_CATEGORIES).toHaveLength(21);
    expect(new Set(TICKET_TYPE_CUTOVER_READINESS_CATEGORIES).size).toBe(21);
    expect(DATABASE_CATEGORIES).toHaveLength(13);
    expect(VALKEY_CATEGORIES).toHaveLength(7);
  });

  it('Gate A の evidenceType と衝突しない', () => {
    expect(TICKET_TYPE_CUTOVER_EVIDENCE_TYPE).toBe('ticket-type-cutover-readiness');
    expect(TICKET_TYPE_CUTOVER_EVIDENCE_TYPE).not.toBe('ticket-type-expand-readiness');
    expect(TICKET_TYPE_CUTOVER_EVIDENCE_VERSION).toBe(1);
  });
});

describe('checkCutoverDatabase', () => {
  it('正常系: 13 category・writerMode・schemaRevision を返す', async () => {
    const { client } = createFakeSql({
      violations: healthyViolationRows,
      control: () => [{ writer_mode: 'legacy' }],
      revision: () => [{ name: 'AddTicketTypeCompatibilityWriter1785542400000' }],
    });
    const check = await checkCutoverDatabase(client, 'legacy');
    expect(check.results).toHaveLength(13);
    expect(check.results.every((r) => r.violationCount === 0)).toBe(true);
    expect(check.writerMode).toBe('legacy');
    expect(check.schemaRevision).toBe(
      'AddTicketTypeCompatibilityWriter1785542400000',
    );
  });

  it('expected mode が不正なら throw する', async () => {
    const { client } = createFakeSql({});
    await expect(
      checkCutoverDatabase(client, 'both' as never),
    ).rejects.toThrow(/expected writer mode/);
  });

  it('未知 category / 重複 category / 不正 count / 欠落 category は throw する', async () => {
    const cases: (() => { category: string; violation_count: string }[])[] = [
      () => [...healthyViolationRows(), { category: 'bogus', violation_count: '0' }],
      () => [...healthyViolationRows(), healthyViolationRows()[0]],
      () =>
        healthyViolationRows().map((row, i) =>
          i === 0 ? { ...row, violation_count: '-1' } : row,
        ),
      () => healthyViolationRows().slice(1),
    ];
    for (const violations of cases) {
      const { client } = createFakeSql({
        violations,
        control: () => [{ writer_mode: 'legacy' }],
        revision: () => [{ name: 'X' }],
      });
      await expect(checkCutoverDatabase(client, 'legacy')).rejects.toThrow();
    }
  });

  it('control state が欠落・不正でも category を返しつつ writerMode は null になる', async () => {
    const rows = healthyViolationRows().map((row) =>
      row.category === 'writer_control_state_missing_or_invalid'
        ? { ...row, violation_count: '1' }
        : row,
    );
    const { client } = createFakeSql({
      violations: () => rows,
      control: () => [],
      revision: () => [{ name: 'X' }],
    });
    const check = await checkCutoverDatabase(client, 'legacy');
    expect(check.writerMode).toBeNull();
    expect(
      check.results.find(
        (r) => r.category === 'writer_control_state_missing_or_invalid',
      )?.violationCount,
    ).toBe(1);
  });

  it('schema revision が読めない場合は fail closed に throw する', async () => {
    const { client } = createFakeSql({
      violations: healthyViolationRows,
      control: () => [{ writer_mode: 'legacy' }],
      revision: () => [],
    });
    await expect(checkCutoverDatabase(client, 'legacy')).rejects.toThrow(
      /schema revision/,
    );
  });
});

describe('checkCutoverValkey', () => {
  function fakeValkey(store: Map<string, string>): ValkeyReadClient {
    return {
      get: async (key) => store.get(key) ?? null,
      scan: async (_cursor, _match, pattern, _count) => {
        const regex = new RegExp(
          `^${pattern.replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`,
        );
        return ['0', [...store.keys()].filter((k) => regex.test(k))];
      },
    };
  }

  function inventoryRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      event_id: randomUUID(),
      ticket_type_id: randomUUID(),
      total_quantity: 10,
      remaining_quantity: 7,
      ...overrides,
    };
  }

  // legacy Event 集計行（ticket_inventory）の fake row。
  function legacyInventoryRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      event_id: randomUUID(),
      total_quantity: 10,
      remaining_quantity: 7,
      ...overrides,
    };
  }

  function sqlForRows(
    rows: Record<string, unknown>[],
    legacyRows: Record<string, unknown>[] = [],
  ) {
    return createFakeSql({
      inventoryPage: (params) => (params[0] === null ? rows : []),
      legacyInventoryPage: (params) => (params[0] === null ? legacyRows : []),
      presentPairs: (params) => {
        const eventIds = params[0] as string[];
        const typeIds = params[1] as string[];
        return eventIds.flatMap((eventId, i) =>
          rows.some(
            (r) => r.event_id === eventId && r.ticket_type_id === typeIds[i],
          )
            ? [{ event_id: eventId, ticket_type_id: typeIds[i] }]
            : [],
        );
      },
    }).client;
  }

  it('counter / revision が DB と一致すれば全 category 0', async () => {
    const row = inventoryRow();
    const legacyRow = legacyInventoryRow({ event_id: row.event_id });
    const store = new Map<string, string>([
      [ticketTypeCounterKey(row.event_id as string, row.ticket_type_id as string), '7'],
      [ticketTypeCounterRevisionKey(row.event_id as string, row.ticket_type_id as string), '3'],
      [eventCounterKey(row.event_id as string), '7'],
    ]);
    const results = await checkCutoverValkey(
      sqlForRows([row], [legacyRow]),
      fakeValkey(store),
      'ticket_type',
      'preflight',
    );
    expect(results).toHaveLength(7);
    expect(results.every((r) => r.violationCount === 0)).toBe(true);
  });

  it('Ticket Type counter 未 seed は preflight では expect-mode に依らず violation になる', async () => {
    for (const mode of ['legacy', 'ticket_type'] as const) {
      const results = await checkCutoverValkey(
        sqlForRows([inventoryRow()]),
        fakeValkey(new Map()),
        mode,
        'preflight',
      );
      expect(
        results.find((r) => r.category === 'valkey_counter_missing')
          ?.violationCount,
      ).toBe(1);
    }
  });

  it('legacy Event counter 不在は violation にならない（購入 API は fail-open で DB 判定に流れる）', async () => {
    const row = inventoryRow();
    const store = new Map<string, string>([
      [ticketTypeCounterKey(row.event_id as string, row.ticket_type_id as string), '7'],
      [ticketTypeCounterRevisionKey(row.event_id as string, row.ticket_type_id as string), '3'],
    ]);
    const results = await checkCutoverValkey(
      sqlForRows([row], [legacyInventoryRow({ event_id: row.event_id })]),
      fakeValkey(store),
      'legacy',
      'preflight',
    );
    expect(results.every((r) => r.violationCount === 0)).toBe(true);
  });

  it('legacy Event counter の stale 値 / 不正値を preflight では expect-mode に依らず violation にする', async () => {
    const stale = legacyInventoryRow();
    const invalid = legacyInventoryRow();
    const store = new Map<string, string>([
      // DB は remaining 7 なのに counter が 0 のまま（rollback 後の stale counter を模す）。
      [eventCounterKey(stale.event_id as string), '0'],
      // total (10) を超える値は構造的に不正。
      [eventCounterKey(invalid.event_id as string), '11'],
    ]);
    for (const mode of ['legacy', 'ticket_type'] as const) {
      const results = await checkCutoverValkey(
        sqlForRows([], [stale, invalid]),
        fakeValkey(store),
        mode,
        'preflight',
      );
      const byCategory = new Map(results.map((r) => [r.category, r.violationCount]));
      expect(byCategory.get('valkey_legacy_counter_remaining_mismatch')).toBe(1);
      expect(byCategory.get('valkey_legacy_counter_value_invalid')).toBe(1);
    }
  });

  it('非整数の legacy Event counter は invalid として数える', async () => {
    const row = legacyInventoryRow();
    const store = new Map<string, string>([
      [eventCounterKey(row.event_id as string), 'not-a-number'],
    ]);
    const results = await checkCutoverValkey(
      sqlForRows([], [row]),
      fakeValkey(store),
      'legacy',
      'preflight',
    );
    expect(
      results.find((r) => r.category === 'valkey_legacy_counter_value_invalid')
        ?.violationCount,
    ).toBe(1);
  });

  it('counter 値の mismatch / invalid / revision 欠落を区別して数える', async () => {
    const mismatch = inventoryRow();
    const invalid = inventoryRow();
    const noRevision = inventoryRow();
    const store = new Map<string, string>([
      [ticketTypeCounterKey(mismatch.event_id as string, mismatch.ticket_type_id as string), '6'],
      [ticketTypeCounterRevisionKey(mismatch.event_id as string, mismatch.ticket_type_id as string), '1'],
      // total (10) を超える値は構造的に不正。
      [ticketTypeCounterKey(invalid.event_id as string, invalid.ticket_type_id as string), '11'],
      [ticketTypeCounterRevisionKey(invalid.event_id as string, invalid.ticket_type_id as string), '1'],
      [ticketTypeCounterKey(noRevision.event_id as string, noRevision.ticket_type_id as string), '7'],
    ]);
    const results = await checkCutoverValkey(
      sqlForRows([mismatch, invalid, noRevision]),
      fakeValkey(store),
      'ticket_type',
      'preflight',
    );
    const byCategory = new Map(results.map((r) => [r.category, r.violationCount]));
    expect(byCategory.get('valkey_counter_remaining_mismatch')).toBe(1);
    expect(byCategory.get('valkey_counter_value_invalid')).toBe(1);
    expect(byCategory.get('valkey_revision_missing_or_invalid')).toBe(1);
    expect(byCategory.get('valkey_counter_missing')).toBe(0);
  });

  it('非整数 counter は invalid として数える', async () => {
    const row = inventoryRow();
    const store = new Map<string, string>([
      [ticketTypeCounterKey(row.event_id as string, row.ticket_type_id as string), 'abc'],
      [ticketTypeCounterRevisionKey(row.event_id as string, row.ticket_type_id as string), '1'],
    ]);
    const results = await checkCutoverValkey(
      sqlForRows([row]),
      fakeValkey(store),
      'ticket_type',
      'preflight',
    );
    expect(
      results.find((r) => r.category === 'valkey_counter_value_invalid')
        ?.violationCount,
    ).toBe(1);
  });

  it('DB に紐付かない counter キーと parse 不能キーを未紐付けとして数える', async () => {
    const store = new Map<string, string>([
      [ticketTypeCounterKey(randomUUID(), randomUUID()), '5'],
      ['inventory:ticket-type:{broken}:remaining', '5'],
    ]);
    const results = await checkCutoverValkey(
      sqlForRows([]),
      fakeValkey(store),
      'legacy',
      'preflight',
    );
    expect(
      results.find((r) => r.category === 'valkey_counter_without_inventory_row')
        ?.violationCount,
    ).toBe(2);
  });

  it('legacy postflight は Ticket Type counter の不在・stale・revision 欠落を許容し、構造的な不正値だけを violation にする', async () => {
    // rollback 後の平常運用: legacy 経路の購入は forward bridge で DB 行だけを進め、
    // Ticket Type counter を更新しない。不在（削除済み）と stale は正常。
    const missing = inventoryRow();
    const stale = inventoryRow();
    const noRevision = inventoryRow();
    const invalid = inventoryRow();
    const store = new Map<string, string>([
      // remaining 7 に対して 4 のまま（legacy 購入で DB だけ進んだ stale）。
      [ticketTypeCounterKey(stale.event_id as string, stale.ticket_type_id as string), '4'],
      [ticketTypeCounterRevisionKey(stale.event_id as string, stale.ticket_type_id as string), '1'],
      [ticketTypeCounterKey(noRevision.event_id as string, noRevision.ticket_type_id as string), '7'],
      // total (10) を超える値は休止中 namespace でも構造的に不正。
      [ticketTypeCounterKey(invalid.event_id as string, invalid.ticket_type_id as string), '11'],
      [ticketTypeCounterRevisionKey(invalid.event_id as string, invalid.ticket_type_id as string), '1'],
    ]);
    const results = await checkCutoverValkey(
      sqlForRows([missing, stale, noRevision, invalid]),
      fakeValkey(store),
      'legacy',
      'postflight',
    );
    const byCategory = new Map(results.map((r) => [r.category, r.violationCount]));
    expect(byCategory.get('valkey_counter_missing')).toBe(0);
    expect(byCategory.get('valkey_counter_remaining_mismatch')).toBe(0);
    expect(byCategory.get('valkey_revision_missing_or_invalid')).toBe(0);
    expect(byCategory.get('valkey_counter_value_invalid')).toBe(1);
  });

  it('ticket_type postflight は stale な legacy Event counter を許容し、Ticket Type namespace は厳密なまま', async () => {
    // activation 後の平常運用: ticket_type 経路の購入は reverse mirror で DB の
    // legacy 集計行だけを進め、Event counter を更新しない。stale は正常。
    const row = inventoryRow();
    const legacyStale = legacyInventoryRow();
    const legacyInvalid = legacyInventoryRow();
    const store = new Map<string, string>([
      // remaining 7 に対して 5 のまま（activation 後の購入 smoke で stale になった counter）。
      [eventCounterKey(legacyStale.event_id as string), '5'],
      // total (10) を超える値は緩和中でも構造的に不正。
      [eventCounterKey(legacyInvalid.event_id as string), '11'],
    ]);
    const results = await checkCutoverValkey(
      sqlForRows([row], [legacyStale, legacyInvalid]),
      fakeValkey(store),
      'ticket_type',
      'postflight',
    );
    const byCategory = new Map(results.map((r) => [r.category, r.violationCount]));
    expect(byCategory.get('valkey_legacy_counter_remaining_mismatch')).toBe(0);
    expect(byCategory.get('valkey_legacy_counter_value_invalid')).toBe(1);
    // 現 mode（ticket_type）側の namespace は postflight でも厳密（未 seed は violation）。
    expect(byCategory.get('valkey_counter_missing')).toBe(1);
  });

  it('不正な phase は throw する', async () => {
    await expect(
      checkCutoverValkey(
        sqlForRows([]),
        fakeValkey(new Map()),
        'legacy',
        'smoke' as never,
      ),
    ).rejects.toThrow('check phase');
  });
});

describe('assert / hasViolations', () => {
  it('complete な結果を受理し、violation 有無を判定する', () => {
    const results = zeroResults();
    expect(() => assertTicketTypeCutoverReadinessComplete(results)).not.toThrow();
    expect(hasTicketTypeCutoverViolations(results)).toBe(false);
    const withViolation = results.map((r, i) =>
      i === 0 ? { ...r, violationCount: 2 } : r,
    );
    expect(hasTicketTypeCutoverViolations(withViolation)).toBe(true);
  });

  it('category 欠落・追加・重複・不正 count を throw する', () => {
    const results = zeroResults();
    expect(() =>
      assertTicketTypeCutoverReadinessComplete(results.slice(1)),
    ).toThrow(/missing/);
    expect(() =>
      assertTicketTypeCutoverReadinessComplete([
        ...results,
        { category: 'bogus' as never, violationCount: 0 },
      ]),
    ).toThrow(/unexpected/);
    expect(() =>
      assertTicketTypeCutoverReadinessComplete([...results, results[0]]),
    ).toThrow(/duplicate/);
    expect(() =>
      assertTicketTypeCutoverReadinessComplete(
        results.map((r, i) => (i === 0 ? { ...r, violationCount: -1 } : r)),
      ),
    ).toThrow(/invalid/);
    expect(() =>
      assertTicketTypeCutoverReadinessComplete(
        results.map((r, i) =>
          i === 0 ? { ...r, violationCount: 1.5 } : r,
        ),
      ),
    ).toThrow(/invalid/);
  });
});

describe('serialize / parse evidence', () => {
  it('roundtrip: serialize した evidence を parse できる', () => {
    const json = serializeTicketTypeCutoverEvidence(healthyEvidenceInput());
    expect(json).not.toContain('\n');
    const evidence = parseTicketTypeCutoverEvidence(json);
    expect(evidence.evidenceType).toBe(TICKET_TYPE_CUTOVER_EVIDENCE_TYPE);
    expect(evidence.evidenceVersion).toBe(TICKET_TYPE_CUTOVER_EVIDENCE_VERSION);
    expect(evidence.categoryCount).toBe(21);
    expect(evidence.complete).toBe(true);
    expect(evidence.writerMode).toBe('legacy');
    expect(evidence.opensearchReport.totalDiffs).toBe(0);
  });

  it('serialize は opensearch category と report.totalDiffs の不一致を拒否する', () => {
    const input = healthyEvidenceInput();
    input.opensearchReport.totalDiffs = 3;
    expect(() => serializeTicketTypeCutoverEvidence(input)).toThrow(
      /totalDiffs/,
    );
  });

  it('serialize は index 不一致・空 schemaRevision を拒否する', () => {
    expect(() =>
      serializeTicketTypeCutoverEvidence({
        ...healthyEvidenceInput(),
        opensearchIndex: 'other-index',
      }),
    ).toThrow(/opensearchIndex/);
    expect(() =>
      serializeTicketTypeCutoverEvidence({
        ...healthyEvidenceInput(),
        schemaRevision: '',
      }),
    ).toThrow(/schemaRevision/);
  });

  it('parse は JSON 不完全を拒否する', () => {
    const json = serializeTicketTypeCutoverEvidence(healthyEvidenceInput());
    expect(() => parseTicketTypeCutoverEvidence(json.slice(0, -5))).toThrow(
      /JSON/,
    );
    expect(() => parseTicketTypeCutoverEvidence('null')).toThrow();
    expect(() => parseTicketTypeCutoverEvidence('[]')).toThrow();
  });

  it('parse は evidenceType / evidenceVersion の不一致を拒否する', () => {
    const base = JSON.parse(
      serializeTicketTypeCutoverEvidence(healthyEvidenceInput()),
    ) as Record<string, unknown>;
    expect(() =>
      parseTicketTypeCutoverEvidence(
        JSON.stringify({ ...base, evidenceType: 'ticket-type-expand-readiness' }),
      ),
    ).toThrow(/type mismatch/);
    expect(() =>
      parseTicketTypeCutoverEvidence(
        JSON.stringify({ ...base, evidenceVersion: 2 }),
      ),
    ).toThrow(/version mismatch/);
  });

  it('serialize / parse は checkPhase の欠落・不正を拒否する', () => {
    expect(() =>
      serializeTicketTypeCutoverEvidence({
        ...healthyEvidenceInput(),
        checkPhase: 'smoke' as never,
      }),
    ).toThrow(/checkPhase/);

    const base = JSON.parse(
      serializeTicketTypeCutoverEvidence(healthyEvidenceInput()),
    ) as Record<string, unknown>;
    expect(base.checkPhase).toBe('preflight');
    const missing = { ...base };
    delete missing.checkPhase;
    expect(() =>
      parseTicketTypeCutoverEvidence(JSON.stringify(missing)),
    ).toThrow(/checkPhase/);
    expect(() =>
      parseTicketTypeCutoverEvidence(
        JSON.stringify({ ...base, checkPhase: 'smoke' }),
      ),
    ).toThrow(/checkPhase/);
    // postflight も有効値として roundtrip する。
    const postflight = parseTicketTypeCutoverEvidence(
      serializeTicketTypeCutoverEvidence({
        ...healthyEvidenceInput(),
        checkPhase: 'postflight',
      }),
    );
    expect(postflight.checkPhase).toBe('postflight');
  });

  it('parse は category 欠落・追加・重複と count 不正を拒否する', () => {
    const base = JSON.parse(
      serializeTicketTypeCutoverEvidence(healthyEvidenceInput()),
    ) as { results: TicketTypeCutoverReadinessResult[] } & Record<string, unknown>;
    expect(() =>
      parseTicketTypeCutoverEvidence(
        JSON.stringify({ ...base, results: base.results.slice(1) }),
      ),
    ).toThrow();
    expect(() =>
      parseTicketTypeCutoverEvidence(
        JSON.stringify({
          ...base,
          results: [...base.results, { category: 'extra', violationCount: 0 }],
        }),
      ),
    ).toThrow(/unexpected/);
    expect(() =>
      parseTicketTypeCutoverEvidence(
        JSON.stringify({
          ...base,
          results: [...base.results.slice(0, -1), base.results[0]],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseTicketTypeCutoverEvidence(
        JSON.stringify({
          ...base,
          results: base.results.map((r, i) =>
            i === 0 ? { ...r, violationCount: '0' } : r,
          ),
        }),
      ),
    ).toThrow(/invalid/);
  });

  it('parse は categoryCount 不正・complete 欠落・writerMode / schemaRevision 欠落を拒否する', () => {
    const base = JSON.parse(
      serializeTicketTypeCutoverEvidence(healthyEvidenceInput()),
    ) as Record<string, unknown>;
    expect(() =>
      parseTicketTypeCutoverEvidence(JSON.stringify({ ...base, categoryCount: 16 })),
    ).toThrow(/categoryCount/);
    expect(() =>
      parseTicketTypeCutoverEvidence(JSON.stringify({ ...base, complete: false })),
    ).toThrow(/complete/);
    const noComplete = { ...base } as Record<string, unknown>;
    delete noComplete.complete;
    expect(() =>
      parseTicketTypeCutoverEvidence(JSON.stringify(noComplete)),
    ).toThrow(/complete/);
    expect(() =>
      parseTicketTypeCutoverEvidence(JSON.stringify({ ...base, writerMode: 'both' })),
    ).toThrow(/writerMode/);
    const noWriterMode = { ...base } as Record<string, unknown>;
    delete noWriterMode.writerMode;
    expect(() =>
      parseTicketTypeCutoverEvidence(JSON.stringify(noWriterMode)),
    ).toThrow(/writerMode/);
    expect(() =>
      parseTicketTypeCutoverEvidence(
        JSON.stringify({ ...base, schemaRevision: '' }),
      ),
    ).toThrow(/schemaRevision/);
    const noRevision = { ...base } as Record<string, unknown>;
    delete noRevision.schemaRevision;
    expect(() =>
      parseTicketTypeCutoverEvidence(JSON.stringify(noRevision)),
    ).toThrow(/schemaRevision/);
  });

  it('parse は opensearchReport の欠落・totalDiffs 不整合を拒否する', () => {
    const base = JSON.parse(
      serializeTicketTypeCutoverEvidence(healthyEvidenceInput()),
    ) as Record<string, unknown>;
    const noReport = { ...base } as Record<string, unknown>;
    delete noReport.opensearchReport;
    expect(() =>
      parseTicketTypeCutoverEvidence(JSON.stringify(noReport)),
    ).toThrow(/opensearchReport/);
    expect(() =>
      parseTicketTypeCutoverEvidence(
        JSON.stringify({
          ...base,
          opensearchReport: { ...(base.opensearchReport as object), totalDiffs: 5 },
        }),
      ),
    ).toThrow(/totalDiffs/);
  });

  it('parse は index / totalDiffs しか持たない不完全な opensearchReport を拒否する', () => {
    const base = JSON.parse(
      serializeTicketTypeCutoverEvidence(healthyEvidenceInput()),
    ) as Record<string, unknown>;
    expect(() =>
      parseTicketTypeCutoverEvidence(
        JSON.stringify({
          ...base,
          opensearchReport: { index: 'events', totalDiffs: 0 },
        }),
      ),
    ).toThrow(/opensearchReport/);
  });

  it('parse は opensearchReport の必須フィールド欠落・型不正をすべて拒否する', () => {
    const base = JSON.parse(
      serializeTicketTypeCutoverEvidence(healthyEvidenceInput()),
    ) as Record<string, unknown>;
    const report = base.opensearchReport as Record<string, unknown>;
    const tamperedReports: Record<string, unknown>[] = [
      // 各必須フィールドの欠落。
      ...(['index', 'checkedEvents', 'checkedDocuments', 'counts', 'findings', 'hasDiff'] as const).map(
        (field) => {
          const copy = { ...report };
          delete copy[field];
          return copy;
        },
      ),
      // 型不正。
      { ...report, checkedEvents: -1 },
      { ...report, checkedDocuments: 1.5 },
      { ...report, findings: 'none' },
      { ...report, findings: [{ category: 'missing_event_document' }] },
      { ...report, findings: [{ eventId: 'e-1', category: 'bogus_category' }] },
      { ...report, hasDiff: true },
      // counts の category 欠落・追加・値不正。
      {
        ...report,
        counts: (() => {
          const counts = { ...(report.counts as Record<string, number>) };
          delete counts.missing_event_document;
          return counts;
        })(),
      },
      {
        ...report,
        counts: { ...(report.counts as Record<string, number>), extra_category: 0 },
      },
      {
        ...report,
        counts: { ...(report.counts as Record<string, number>), missing_event_document: '0' },
      },
      // totalDiffs が counts の合計と一致しない（両方 5 にして opensearch category 側の
      // 突き合わせを素通りさせても、counts 合計との不整合で落ちること）。
      (() => {
        const inconsistent = { ...report, totalDiffs: 5, hasDiff: true };
        return inconsistent;
      })(),
    ];
    for (const tampered of tamperedReports) {
      const results = (base.results as TicketTypeCutoverReadinessResult[]).map(
        (r) =>
          r.category === 'opensearch_projection_diff'
            ? { ...r, violationCount: (tampered.totalDiffs as number) ?? r.violationCount }
            : r,
      );
      expect(() =>
        parseTicketTypeCutoverEvidence(
          JSON.stringify({ ...base, results, opensearchReport: tampered }),
        ),
      ).toThrow(/opensearchReport/);
    }
  });
});

describe('inventory-cache.keys', () => {
  it('ticketTypeCounterKey と parseTicketTypeCounterKey は逆関数になる', () => {
    const eventId = randomUUID();
    const ticketTypeId = randomUUID();
    const key = ticketTypeCounterKey(eventId, ticketTypeId);
    expect(parseTicketTypeCounterKey(key)).toEqual({ eventId, ticketTypeId });
  });

  it('UUID として不正な断片・形式外のキーは null を返す', () => {
    expect(parseTicketTypeCounterKey('inventory:ticket-type:{a:b}:remaining')).toBeNull();
    expect(
      parseTicketTypeCounterKey(
        `inventory:ticket-type:{${randomUUID()}:${randomUUID()}}:revision`,
      ),
    ).toBeNull();
    expect(parseTicketTypeCounterKey(`inventory:${randomUUID()}`)).toBeNull();
    expect(
      parseTicketTypeCounterKey(
        `inventory:ticket-type:{${'z'.repeat(36)}:${randomUUID()}}:remaining`,
      ),
    ).toBeNull();
  });
});
