// ファイル概要:
// Gate B cutover readiness library の単体テストです（Issue #378）。
// fake SQL / fake Valkey で category 集計と fail-closed 検証（evidence parser を含む）を確認します。
// 実 PostgreSQL / Valkey / OpenSearch を使う end-to-end 検証は
// cutover-readiness.integration.spec.ts が担当します。

import { randomUUID } from 'node:crypto';
import {
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
    writerMode: 'legacy' as const,
    schemaRevision: 'AddTicketTypeCompatibilityWriter1785542400000',
    opensearchIndex: 'events',
    results: zeroResults(),
    opensearchReport: emptyReport(),
  };
}

describe('TICKET_TYPE_CUTOVER_READINESS_CATEGORIES', () => {
  it('17 category（DB 9 + control 2 + Valkey 5 + OpenSearch 1）で重複がない', () => {
    expect(TICKET_TYPE_CUTOVER_READINESS_CATEGORIES).toHaveLength(17);
    expect(new Set(TICKET_TYPE_CUTOVER_READINESS_CATEGORIES).size).toBe(17);
    expect(DATABASE_CATEGORIES).toHaveLength(11);
    expect(VALKEY_CATEGORIES).toHaveLength(5);
  });

  it('Gate A の evidenceType と衝突しない', () => {
    expect(TICKET_TYPE_CUTOVER_EVIDENCE_TYPE).toBe('ticket-type-cutover-readiness');
    expect(TICKET_TYPE_CUTOVER_EVIDENCE_TYPE).not.toBe('ticket-type-expand-readiness');
    expect(TICKET_TYPE_CUTOVER_EVIDENCE_VERSION).toBe(1);
  });
});

describe('checkCutoverDatabase', () => {
  it('正常系: 11 category・writerMode・schemaRevision を返す', async () => {
    const { client } = createFakeSql({
      violations: healthyViolationRows,
      control: () => [{ writer_mode: 'legacy' }],
      revision: () => [{ name: 'AddTicketTypeCompatibilityWriter1785542400000' }],
    });
    const check = await checkCutoverDatabase(client, 'legacy');
    expect(check.results).toHaveLength(11);
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

  function sqlForRows(rows: Record<string, unknown>[]) {
    return createFakeSql({
      inventoryPage: (params) => (params[0] === null ? rows : []),
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
    const store = new Map<string, string>([
      [ticketTypeCounterKey(row.event_id as string, row.ticket_type_id as string), '7'],
      [ticketTypeCounterRevisionKey(row.event_id as string, row.ticket_type_id as string), '3'],
    ]);
    const results = await checkCutoverValkey(
      sqlForRows([row]),
      fakeValkey(store),
      'ticket_type',
    );
    expect(results).toHaveLength(5);
    expect(results.every((r) => r.violationCount === 0)).toBe(true);
  });

  it('legacy mode では counter 未 seed は violation にならない', async () => {
    const results = await checkCutoverValkey(
      sqlForRows([inventoryRow()]),
      fakeValkey(new Map()),
      'legacy',
    );
    expect(results.every((r) => r.violationCount === 0)).toBe(true);
  });

  it('ticket_type mode では counter 未 seed は violation になる', async () => {
    const results = await checkCutoverValkey(
      sqlForRows([inventoryRow()]),
      fakeValkey(new Map()),
      'ticket_type',
    );
    expect(
      results.find((r) => r.category === 'valkey_counter_missing_in_ticket_type_mode')
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
    );
    const byCategory = new Map(results.map((r) => [r.category, r.violationCount]));
    expect(byCategory.get('valkey_counter_remaining_mismatch')).toBe(1);
    expect(byCategory.get('valkey_counter_value_invalid')).toBe(1);
    expect(byCategory.get('valkey_revision_missing_or_invalid')).toBe(1);
    expect(byCategory.get('valkey_counter_missing_in_ticket_type_mode')).toBe(0);
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
    );
    expect(
      results.find((r) => r.category === 'valkey_counter_without_inventory_row')
        ?.violationCount,
    ).toBe(2);
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
    expect(evidence.categoryCount).toBe(17);
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
