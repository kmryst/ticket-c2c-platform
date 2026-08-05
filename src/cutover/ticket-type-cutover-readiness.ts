// ファイル概要:
// Ticket Type 在庫の Gate B cutover checker library です（Issue #378 / 親 Issue #335）。
// Aurora PostgreSQL（正本）、inventory_writer_control（control state）、Valkey
// （Ticket Type counter / revision）、OpenSearch（検索 projection）を read-only で横断検査し、
// 1 category でも violation_count > 0 なら呼び出し側は fail closed で activation を停止します。
//
// - DB / control state は 1 つの REPEATABLE READ READ ONLY snapshot で検査します
//   （transaction 開始は CLI 側の責務）。
// - OpenSearch は #377 の reconcileInventoryProjection をそのまま呼び、比較規則を再実装しません。
// - evidence は Gate A（ticket-type-expand-readiness）と別の evidenceType / version を持ち、
//   parser は JSON 不完全・category 欠落/追加/重複・revision 不明をすべて失敗にします。

import type { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import { POSTGRES_INT4_MAX } from '../common/validation-primitives';
import type { InventoryWriterMode } from '../database/inventory-writer-control';
import {
  parseTicketTypeCounterKey,
  TICKET_TYPE_COUNTER_SCAN_PATTERN,
  ticketTypeCounterKey,
  ticketTypeCounterRevisionKey,
} from '../cache/inventory-cache.keys';
import {
  reconcileInventoryProjection,
  ReconciliationReport,
} from '../search/inventory-reconciliation.service';
import { DEFAULT_PAGE_SIZE, SqlClient } from '../search/inventory-projection-source';
import { EVENTS_INDEX } from '../search/events-projection.store';

// category は Gate B が検査する差分の有限集合です（合計 17）。
// - DB 未紐付け・在庫差分: 9
// - control state: 2
// - Valkey counter / revision 差分: 5
// - OpenSearch projection 差分: 1
export const TICKET_TYPE_CUTOVER_READINESS_CATEGORIES = [
  // --- DB 未紐付け・在庫差分（9） ---
  'event_without_exactly_one_default',
  'event_without_legacy_inventory',
  'legacy_inventory_without_default_ticket_type_inventory',
  'ticket_type_inventory_without_ticket_type',
  'purchase_without_ticket_type',
  'purchase_ticket_type_event_mismatch',
  'legacy_aggregate_total_mismatch',
  'legacy_aggregate_remaining_mismatch',
  'non_default_ticket_type_inventory_in_legacy_mode',
  // --- control state（2） ---
  'writer_control_state_missing_or_invalid',
  'writer_control_mode_mismatch',
  // --- Valkey counter / revision 差分（5） ---
  'valkey_counter_missing_in_ticket_type_mode',
  'valkey_counter_without_inventory_row',
  'valkey_counter_value_invalid',
  'valkey_counter_remaining_mismatch',
  'valkey_revision_missing_or_invalid',
  // --- OpenSearch projection 差分（1） ---
  'opensearch_projection_diff',
] as const;

export type TicketTypeCutoverReadinessCategory =
  (typeof TICKET_TYPE_CUTOVER_READINESS_CATEGORIES)[number];

// Gate A（ticket-type-expand-readiness / version 1）と別 type・別 version 系列にする。
export const TICKET_TYPE_CUTOVER_EVIDENCE_TYPE = 'ticket-type-cutover-readiness';
export const TICKET_TYPE_CUTOVER_EVIDENCE_VERSION = 1;

export interface TicketTypeCutoverReadinessResult {
  category: TicketTypeCutoverReadinessCategory;
  violationCount: number;
}

// TicketTypeCutoverEvidence は 1 回の checker 実行の証跡です（machine-readable JSON）。
// secret / credential を含めてはいけません。
export interface TicketTypeCutoverEvidence {
  evidenceType: typeof TICKET_TYPE_CUTOVER_EVIDENCE_TYPE;
  evidenceVersion: typeof TICKET_TYPE_CUTOVER_EVIDENCE_VERSION;
  // expectedWriterMode は CLI --expect-mode（この検査が前提とする control state）。
  expectedWriterMode: InventoryWriterMode;
  // writerMode は snapshot 時点の実際の control state。
  writerMode: InventoryWriterMode;
  // schemaRevision は snapshot 時点で最後に適用済みの migration 名（対象 revision の特定）。
  schemaRevision: string;
  opensearchIndex: string;
  results: readonly TicketTypeCutoverReadinessResult[];
  categoryCount: number;
  // opensearchReport は #377 の ReconciliationReport 全文（category 別 counts と bounded findings）。
  opensearchReport: ReconciliationReport;
  complete: true;
}

const WRITER_MODES: readonly InventoryWriterMode[] = ['legacy', 'ticket_type'];

function assertWriterMode(value: unknown, label: string): InventoryWriterMode {
  if (value !== 'legacy' && value !== 'ticket_type') {
    throw new Error(`${label} must be one of ${WRITER_MODES.join(', ')}: ${String(value)}`);
  }
  return value;
}

// --- DB / control state 検査 ---

// 各 SELECT は必ず 1 row を返すため、正常時も category ごとの 0 件を証跡へ残せます。
// $1 = expected writer mode（'legacy' | 'ticket_type'）。
// mode 依存 category（non_default_... / writer_control_mode_mismatch）は expected mode を
// パラメータとして評価し、それ以外は mode に依存しません。
export const TICKET_TYPE_CUTOVER_DATABASE_SQL = `
WITH expected AS (
  SELECT $1::text AS mode
),
default_ticket_types AS (
  SELECT event_id, id AS ticket_type_id
  FROM public.ticket_types
  WHERE is_default
),
type_aggregates AS (
  SELECT event_id,
         sum(total_quantity)::bigint AS total_quantity,
         sum(remaining_quantity)::bigint AS remaining_quantity
  FROM public.ticket_type_inventory
  GROUP BY event_id
),
violations AS (
  SELECT
    'event_without_exactly_one_default'::text AS category,
    count(*)::bigint AS violation_count
  FROM (
    SELECT e.id
    FROM public.events e
    LEFT JOIN public.ticket_types tt ON tt.event_id = e.id AND tt.is_default
    GROUP BY e.id
    HAVING count(tt.id) <> 1
  ) unexpected_default_counts

  UNION ALL

  SELECT
    'event_without_legacy_inventory',
    count(*)::bigint
  FROM public.events e
  LEFT JOIN public.ticket_inventory legacy ON legacy.event_id = e.id
  WHERE legacy.event_id IS NULL

  UNION ALL

  SELECT
    'legacy_inventory_without_default_ticket_type_inventory',
    count(*)::bigint
  FROM public.ticket_inventory legacy
  LEFT JOIN default_ticket_types defaults
    ON defaults.event_id = legacy.event_id
  LEFT JOIN public.ticket_type_inventory shadow
    ON shadow.event_id = legacy.event_id
   AND shadow.ticket_type_id = defaults.ticket_type_id
  WHERE shadow.ticket_type_id IS NULL

  UNION ALL

  SELECT
    'ticket_type_inventory_without_ticket_type',
    count(*)::bigint
  FROM public.ticket_type_inventory shadow
  LEFT JOIN public.ticket_types tt
    ON tt.event_id = shadow.event_id
   AND tt.id = shadow.ticket_type_id
  WHERE tt.id IS NULL

  UNION ALL

  SELECT
    'purchase_without_ticket_type',
    count(*)::bigint
  FROM public.purchases
  WHERE ticket_type_id IS NULL

  UNION ALL

  SELECT
    'purchase_ticket_type_event_mismatch',
    count(*)::bigint
  FROM public.purchases p
  LEFT JOIN public.ticket_types tt ON tt.id = p.ticket_type_id
  WHERE p.ticket_type_id IS NOT NULL
    AND (tt.id IS NULL OR tt.event_id IS DISTINCT FROM p.event_id)

  UNION ALL

  -- legacy 集計行と Ticket Type 在庫合計の parity。legacy mode（default 1 Type だけ）では
  -- Gate A の行単位 parity と一致し、ticket_type mode（複数 Type）では合計で比較する。
  SELECT
    'legacy_aggregate_total_mismatch',
    count(*)::bigint
  FROM public.ticket_inventory legacy
  LEFT JOIN type_aggregates aggregate ON aggregate.event_id = legacy.event_id
  WHERE COALESCE(aggregate.total_quantity, 0)
    IS DISTINCT FROM legacy.total_quantity::bigint

  UNION ALL

  SELECT
    'legacy_aggregate_remaining_mismatch',
    count(*)::bigint
  FROM public.ticket_inventory legacy
  LEFT JOIN type_aggregates aggregate ON aggregate.event_id = legacy.event_id
  WHERE COALESCE(aggregate.remaining_quantity, 0)
    IS DISTINCT FROM legacy.remaining_quantity::bigint

  UNION ALL

  -- legacy mode を期待する検査（rollback 後の postflight を含む）では、非 default Type の
  -- 在庫行が残っていてはいけない。ticket_type mode の検査では常に 0。
  SELECT
    'non_default_ticket_type_inventory_in_legacy_mode',
    CASE
      WHEN (SELECT mode FROM expected) = 'legacy' THEN (
        SELECT count(*)::bigint
        FROM public.ticket_type_inventory shadow
        JOIN public.ticket_types tt
          ON tt.event_id = shadow.event_id
         AND tt.id = shadow.ticket_type_id
        WHERE NOT tt.is_default
      )
      ELSE 0::bigint
    END

  UNION ALL

  -- control state は singleton 1 行・有効値のみを許す。CHECK constraint が通常防ぐ状態も
  -- 明示的に数え、constraint の欠落・無効化を検出対象にする（Gate A と同じ方針）。
  SELECT
    'writer_control_state_missing_or_invalid',
    CASE
      WHEN (SELECT count(*) FROM public.inventory_writer_control) = 1
       AND (
         SELECT count(*)
         FROM public.inventory_writer_control
         WHERE singleton AND writer_mode IN ('legacy', 'ticket_type')
       ) = 1
      THEN 0::bigint
      ELSE 1::bigint
    END

  UNION ALL

  SELECT
    'writer_control_mode_mismatch',
    (
      SELECT count(*)::bigint
      FROM public.inventory_writer_control
      WHERE singleton
        AND writer_mode IS DISTINCT FROM (SELECT mode FROM expected)
    )
)
SELECT category, violation_count::text
FROM violations
ORDER BY category
`;

// DB / control state 検査が担当する category（結果の完全性検証に使う）。
const DATABASE_CATEGORIES: readonly TicketTypeCutoverReadinessCategory[] = [
  'event_without_exactly_one_default',
  'event_without_legacy_inventory',
  'legacy_inventory_without_default_ticket_type_inventory',
  'ticket_type_inventory_without_ticket_type',
  'purchase_without_ticket_type',
  'purchase_ticket_type_event_mismatch',
  'legacy_aggregate_total_mismatch',
  'legacy_aggregate_remaining_mismatch',
  'non_default_ticket_type_inventory_in_legacy_mode',
  'writer_control_state_missing_or_invalid',
  'writer_control_mode_mismatch',
];

const VALKEY_CATEGORIES: readonly TicketTypeCutoverReadinessCategory[] = [
  'valkey_counter_missing_in_ticket_type_mode',
  'valkey_counter_without_inventory_row',
  'valkey_counter_value_invalid',
  'valkey_counter_remaining_mismatch',
  'valkey_revision_missing_or_invalid',
];

export interface CutoverDatabaseCheck {
  results: TicketTypeCutoverReadinessResult[];
  // writerMode は control state が singleton 1 行・有効値のときだけ確定する。
  // null は「attest できない」状態で、evidence は作れない（呼び出し側は実行エラーで停止）。
  writerMode: InventoryWriterMode | null;
  schemaRevision: string;
}

// checkCutoverDatabase は DB 未紐付け・在庫差分と control state を 1 snapshot で検査します。
// 呼び出し側（CLI）が REPEATABLE READ READ ONLY transaction を開始してから呼びます。
export async function checkCutoverDatabase(
  sql: SqlClient,
  expectedWriterMode: InventoryWriterMode,
): Promise<CutoverDatabaseCheck> {
  assertWriterMode(expectedWriterMode, 'expected writer mode');

  const violationRows = await sql.query<{
    category: string;
    violation_count: string;
  }>(TICKET_TYPE_CUTOVER_DATABASE_SQL, [expectedWriterMode]);
  const results = collectCategoryCounts(violationRows.rows, DATABASE_CATEGORIES);

  // control state を同じ snapshot から読む（category 判定と同じ条件）。
  const controlRows = await sql.query<{ writer_mode: string }>(
    `
      SELECT writer_mode
      FROM public.inventory_writer_control
      WHERE singleton
    `,
  );
  const rawMode = controlRows.rows[0]?.writer_mode;
  const writerMode: InventoryWriterMode | null =
    controlRows.rows.length === 1 &&
    (rawMode === 'legacy' || rawMode === 'ticket_type')
      ? rawMode
      : null;

  // schemaRevision は最後に適用済みの migration 名。migration 履歴が読めない・空の場合は
  // 「対象 revision 不明」であり、evidence を作らず fail closed に停止する。
  const revisionRows = await sql.query<{ name: string }>(
    `
      SELECT name
      FROM public.typeorm_migrations
      ORDER BY timestamp DESC, id DESC
      LIMIT 1
    `,
  );
  const schemaRevision = revisionRows.rows[0]?.name;
  if (typeof schemaRevision !== 'string' || schemaRevision.length === 0) {
    throw new Error('cutover readiness cannot determine applied schema revision');
  }

  return { results, writerMode, schemaRevision };
}

// --- Valkey 検査 ---

// ValkeyReadClient は checker が使う read-only コマンドの最小 interface です（ioredis 互換）。
export interface ValkeyReadClient {
  get(key: string): Promise<string | null>;
  scan(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
}

export interface CutoverValkeyOptions {
  pageSize?: number;
}

const NON_NEGATIVE_INTEGER = /^(0|[1-9]\d*)$/;

// checkCutoverValkey は Ticket Type counter / revision と DB 在庫行の差分を検査します。
// DB は呼び出し側 transaction の snapshot から読み、Valkey は read-only コマンド
// （GET / SCAN）だけを使います。Valkey エラーは fail-open にせず throw します
// （購入 API と異なり、checker は誤って green を返してはいけない）。
export async function checkCutoverValkey(
  sql: SqlClient,
  valkey: ValkeyReadClient,
  expectedWriterMode: InventoryWriterMode,
  options: CutoverValkeyOptions = {},
): Promise<TicketTypeCutoverReadinessResult[]> {
  assertWriterMode(expectedWriterMode, 'expected writer mode');
  const pageSize = boundedPageSize(options.pageSize);

  const counts = new Map<TicketTypeCutoverReadinessCategory, number>(
    VALKEY_CATEGORIES.map((category) => [category, 0]),
  );
  const bump = (category: TicketTypeCutoverReadinessCategory): void => {
    counts.set(category, (counts.get(category) ?? 0) + 1);
  };

  // Pass 1: DB 在庫行ごとに counter / revision を突き合わせる（keyset pagination で bounded）。
  let lastEventId: string | null = null;
  let lastTicketTypeId: string | null = null;
  for (;;) {
    const page: {
      rows: {
        event_id: string;
        ticket_type_id: string;
        total_quantity: number;
        remaining_quantity: number;
      }[];
      rowCount: number | null;
    } = await sql.query<{
      event_id: string;
      ticket_type_id: string;
      total_quantity: number;
      remaining_quantity: number;
    }>(
      `
        SELECT event_id::text AS event_id,
               ticket_type_id::text AS ticket_type_id,
               total_quantity,
               remaining_quantity
        FROM public.ticket_type_inventory
        WHERE ($1::uuid IS NULL OR (event_id, ticket_type_id) > ($1::uuid, $2::uuid))
        ORDER BY event_id ASC, ticket_type_id ASC
        LIMIT $3
      `,
      [lastEventId, lastTicketTypeId, pageSize],
    );
    if (page.rows.length === 0) {
      break;
    }

    for (const row of page.rows) {
      const counterRaw = await valkey.get(
        ticketTypeCounterKey(row.event_id, row.ticket_type_id),
      );
      if (counterRaw === null) {
        // legacy mode では counter 未 seed が正常（前段フィルタは fail-open で DB 判定に流れる）。
        // ticket_type mode では seed 漏れ＝切替後に誤拒否/素通りの温床なので violation。
        if (expectedWriterMode === 'ticket_type') {
          bump('valkey_counter_missing_in_ticket_type_mode');
        }
        continue;
      }

      if (
        !NON_NEGATIVE_INTEGER.test(counterRaw) ||
        !Number.isSafeInteger(Number(counterRaw)) ||
        Number(counterRaw) > POSTGRES_INT4_MAX ||
        Number(counterRaw) > row.total_quantity
      ) {
        // 構造的にあり得ない counter 値（非整数・負数・total 超過）は mismatch と区別して数える。
        bump('valkey_counter_value_invalid');
      } else if (Number(counterRaw) !== row.remaining_quantity) {
        bump('valkey_counter_remaining_mismatch');
      }

      const revisionRaw = await valkey.get(
        ticketTypeCounterRevisionKey(row.event_id, row.ticket_type_id),
      );
      if (revisionRaw === null || !NON_NEGATIVE_INTEGER.test(revisionRaw)) {
        // counter があるのに CAS revision が無い/壊れていると sync が成立しない。
        bump('valkey_revision_missing_or_invalid');
      }
    }

    const lastRow = page.rows[page.rows.length - 1];
    lastEventId = lastRow.event_id;
    lastTicketTypeId = lastRow.ticket_type_id;
    if (page.rows.length < pageSize) {
      break;
    }
  }

  // Pass 2: Valkey にあって DB に無い counter（未紐付け）を SCAN で検出する。
  // パターンに一致するのに parse できないキーも「DB に紐付かないキー」として数える。
  let cursor = '0';
  do {
    const [nextCursor, keys] = await valkey.scan(
      cursor,
      'MATCH',
      TICKET_TYPE_COUNTER_SCAN_PATTERN,
      'COUNT',
      pageSize,
    );
    cursor = nextCursor;

    const parsed: { eventId: string; ticketTypeId: string }[] = [];
    for (const key of keys) {
      const parts = parseTicketTypeCounterKey(key);
      if (!parts) {
        bump('valkey_counter_without_inventory_row');
        continue;
      }
      parsed.push(parts);
    }
    if (parsed.length > 0) {
      const present = await sql.query<{
        event_id: string;
        ticket_type_id: string;
      }>(
        `
          SELECT candidate.event_id::text AS event_id,
                 candidate.ticket_type_id::text AS ticket_type_id
          FROM unnest($1::uuid[], $2::uuid[])
            AS candidate(event_id, ticket_type_id)
          JOIN public.ticket_type_inventory shadow
            ON shadow.event_id = candidate.event_id
           AND shadow.ticket_type_id = candidate.ticket_type_id
        `,
        [
          parsed.map((p) => p.eventId),
          parsed.map((p) => p.ticketTypeId),
        ],
      );
      const presentSet = new Set(
        present.rows.map((r) => `${r.event_id}:${r.ticket_type_id}`),
      );
      for (const p of parsed) {
        if (!presentSet.has(`${p.eventId}:${p.ticketTypeId}`)) {
          bump('valkey_counter_without_inventory_row');
        }
      }
    }
  } while (cursor !== '0');

  return VALKEY_CATEGORIES.map((category) => ({
    category,
    violationCount: counts.get(category) ?? 0,
  }));
}

// --- OpenSearch 検査 ---

export interface CutoverOpenSearchOptions {
  index?: string;
  pageSize?: number;
  maxFindings?: number;
}

export interface CutoverOpenSearchCheck {
  result: TicketTypeCutoverReadinessResult;
  report: ReconciliationReport;
}

// checkCutoverOpenSearch は #377 の reconcileInventoryProjection をそのまま呼び、
// totalDiffs を 1 category（opensearch_projection_diff）へ集約します。
// reconcileInventoryProjection は自前の REPEATABLE READ READ ONLY snapshot を開始するため、
// 呼び出し側 transaction の外（専用 connection）で呼びます。cross-store snapshot は
// 原子的でないため、Gate B では queue drain 後に実行し必要なら再実行します（runbook 参照）。
export async function checkCutoverOpenSearch(
  sql: SqlClient,
  opensearch: OpenSearchClient,
  options: CutoverOpenSearchOptions = {},
): Promise<CutoverOpenSearchCheck> {
  const report = await reconcileInventoryProjection(sql, opensearch, {
    index: options.index ?? EVENTS_INDEX,
    pageSize: options.pageSize,
    maxFindings: options.maxFindings,
  });
  return {
    result: {
      category: 'opensearch_projection_diff',
      violationCount: report.totalDiffs,
    },
    report,
  };
}

// --- 完全性検証・violation 判定・evidence ---

export function assertTicketTypeCutoverReadinessComplete(
  results: readonly TicketTypeCutoverReadinessResult[],
): void {
  const expectedCategories = new Set<string>(
    TICKET_TYPE_CUTOVER_READINESS_CATEGORIES,
  );
  const seenCategories = new Set<string>();

  for (const result of results) {
    if (
      typeof result.category !== 'string' ||
      !expectedCategories.has(result.category)
    ) {
      throw new Error(
        `unexpected Ticket Type cutover category: ${String(result.category)}`,
      );
    }
    if (seenCategories.has(result.category)) {
      throw new Error(
        `duplicate Ticket Type cutover category: ${result.category}`,
      );
    }
    if (
      typeof result.violationCount !== 'number' ||
      !Number.isSafeInteger(result.violationCount) ||
      result.violationCount < 0
    ) {
      throw new Error(
        `invalid Ticket Type cutover count for ${result.category}: ${String(result.violationCount)}`,
      );
    }
    seenCategories.add(result.category);
  }

  const missingCategories = TICKET_TYPE_CUTOVER_READINESS_CATEGORIES.filter(
    (category) => !seenCategories.has(category),
  );
  if (missingCategories.length > 0) {
    throw new Error(
      `missing Ticket Type cutover categories: ${missingCategories.join(', ')}`,
    );
  }
}

export function hasTicketTypeCutoverViolations(
  results: readonly TicketTypeCutoverReadinessResult[],
): boolean {
  assertTicketTypeCutoverReadinessComplete(results);
  return results.some((result) => result.violationCount > 0);
}

export interface SerializeCutoverEvidenceInput {
  expectedWriterMode: InventoryWriterMode;
  writerMode: InventoryWriterMode;
  schemaRevision: string;
  opensearchIndex: string;
  results: readonly TicketTypeCutoverReadinessResult[];
  opensearchReport: ReconciliationReport;
}

// serializeTicketTypeCutoverEvidence は evidence を 1 行 JSON にします。
// CloudWatch Logs で 1 event として構造検証できるよう、改行なしの JSON にします。
export function serializeTicketTypeCutoverEvidence(
  input: SerializeCutoverEvidenceInput,
): string {
  assertTicketTypeCutoverReadinessComplete(input.results);
  assertWriterMode(input.expectedWriterMode, 'expectedWriterMode');
  assertWriterMode(input.writerMode, 'writerMode');
  if (
    typeof input.schemaRevision !== 'string' ||
    input.schemaRevision.length === 0
  ) {
    throw new Error('cutover evidence requires a non-empty schemaRevision');
  }
  if (
    typeof input.opensearchIndex !== 'string' ||
    input.opensearchIndex.length === 0
  ) {
    throw new Error('cutover evidence requires a non-empty opensearchIndex');
  }
  const projectionResult = input.results.find(
    (result) => result.category === 'opensearch_projection_diff',
  );
  if (
    !projectionResult ||
    projectionResult.violationCount !== input.opensearchReport.totalDiffs
  ) {
    throw new Error(
      'cutover evidence opensearch category must equal opensearchReport.totalDiffs',
    );
  }
  if (input.opensearchReport.index !== input.opensearchIndex) {
    throw new Error(
      'cutover evidence opensearchIndex must equal opensearchReport.index',
    );
  }

  const evidence: TicketTypeCutoverEvidence = {
    evidenceType: TICKET_TYPE_CUTOVER_EVIDENCE_TYPE,
    evidenceVersion: TICKET_TYPE_CUTOVER_EVIDENCE_VERSION,
    expectedWriterMode: input.expectedWriterMode,
    writerMode: input.writerMode,
    schemaRevision: input.schemaRevision,
    opensearchIndex: input.opensearchIndex,
    results: input.results,
    categoryCount: input.results.length,
    opensearchReport: input.opensearchReport,
    complete: true,
  };
  return JSON.stringify(evidence);
}

// parseTicketTypeCutoverEvidence は evidence JSON を fail closed に検証して返します。
// activation CLI（後続 PR）は parse に成功した complete な evidence だけを前提にできます。
export function parseTicketTypeCutoverEvidence(
  json: string,
): TicketTypeCutoverEvidence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `cutover evidence is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('cutover evidence must be a JSON object');
  }
  const candidate = parsed as Record<string, unknown>;

  if (candidate.evidenceType !== TICKET_TYPE_CUTOVER_EVIDENCE_TYPE) {
    throw new Error(
      `cutover evidence type mismatch: ${String(candidate.evidenceType)}`,
    );
  }
  if (candidate.evidenceVersion !== TICKET_TYPE_CUTOVER_EVIDENCE_VERSION) {
    throw new Error(
      `cutover evidence version mismatch: ${String(candidate.evidenceVersion)}`,
    );
  }
  const expectedWriterMode = assertWriterMode(
    candidate.expectedWriterMode,
    'expectedWriterMode',
  );
  const writerMode = assertWriterMode(candidate.writerMode, 'writerMode');
  if (
    typeof candidate.schemaRevision !== 'string' ||
    candidate.schemaRevision.length === 0
  ) {
    throw new Error('cutover evidence schemaRevision is missing or empty');
  }
  if (
    typeof candidate.opensearchIndex !== 'string' ||
    candidate.opensearchIndex.length === 0
  ) {
    throw new Error('cutover evidence opensearchIndex is missing or empty');
  }
  if (!Array.isArray(candidate.results)) {
    throw new Error('cutover evidence results must be an array');
  }
  const results = candidate.results.map((entry): TicketTypeCutoverReadinessResult => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('cutover evidence result entries must be objects');
    }
    const { category, violationCount } = entry as Record<string, unknown>;
    return {
      category: category as TicketTypeCutoverReadinessCategory,
      violationCount: violationCount as number,
    };
  });
  // category 欠落・追加・重複・count 不正はここで throw する。
  assertTicketTypeCutoverReadinessComplete(results);
  if (candidate.categoryCount !== results.length) {
    throw new Error(
      `cutover evidence categoryCount mismatch: ${String(candidate.categoryCount)}`,
    );
  }
  const report = candidate.opensearchReport;
  if (typeof report !== 'object' || report === null || Array.isArray(report)) {
    throw new Error('cutover evidence opensearchReport must be an object');
  }
  const reportRecord = report as Record<string, unknown>;
  if (
    typeof reportRecord.totalDiffs !== 'number' ||
    !Number.isSafeInteger(reportRecord.totalDiffs) ||
    reportRecord.totalDiffs < 0
  ) {
    throw new Error('cutover evidence opensearchReport.totalDiffs is invalid');
  }
  const projectionResult = results.find(
    (result) => result.category === 'opensearch_projection_diff',
  );
  if (projectionResult?.violationCount !== reportRecord.totalDiffs) {
    throw new Error(
      'cutover evidence opensearch category does not match opensearchReport.totalDiffs',
    );
  }
  if (reportRecord.index !== candidate.opensearchIndex) {
    throw new Error(
      'cutover evidence opensearchIndex does not match opensearchReport.index',
    );
  }
  if (candidate.complete !== true) {
    throw new Error('cutover evidence is not marked complete');
  }

  return {
    evidenceType: TICKET_TYPE_CUTOVER_EVIDENCE_TYPE,
    evidenceVersion: TICKET_TYPE_CUTOVER_EVIDENCE_VERSION,
    expectedWriterMode,
    writerMode,
    schemaRevision: candidate.schemaRevision,
    opensearchIndex: candidate.opensearchIndex,
    results,
    categoryCount: results.length,
    opensearchReport: report as unknown as ReconciliationReport,
    complete: true,
  };
}

// --- 内部 helper ---

function boundedPageSize(pageSize: number | undefined): number {
  const requested = pageSize ?? DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(requested, 1000));
}

// collectCategoryCounts は SQL の category/violation_count 行を検証付きで集めます
// （Gate A と同じ fail-closed 規則: 未知 category・重複・不正 count は throw）。
function collectCategoryCounts(
  rows: readonly { category: unknown; violation_count: unknown }[],
  expected: readonly TicketTypeCutoverReadinessCategory[],
): TicketTypeCutoverReadinessResult[] {
  const expectedSet = new Set<string>(expected);
  const countsByCategory = new Map<TicketTypeCutoverReadinessCategory, number>();

  for (const row of rows) {
    if (typeof row.category !== 'string' || !expectedSet.has(row.category)) {
      throw new Error(
        `unexpected Ticket Type cutover category: ${String(row.category)}`,
      );
    }
    const category = row.category as TicketTypeCutoverReadinessCategory;
    if (countsByCategory.has(category)) {
      throw new Error(`duplicate Ticket Type cutover category: ${category}`);
    }
    if (
      typeof row.violation_count !== 'string' ||
      !NON_NEGATIVE_INTEGER.test(row.violation_count) ||
      !Number.isSafeInteger(Number(row.violation_count))
    ) {
      throw new Error(
        `invalid Ticket Type cutover count for ${category}: ${String(row.violation_count)}`,
      );
    }
    countsByCategory.set(category, Number(row.violation_count));
  }

  const missing = expected.filter((category) => !countsByCategory.has(category));
  if (missing.length > 0) {
    throw new Error(
      `missing Ticket Type cutover categories: ${missing.join(', ')}`,
    );
  }
  return expected.map((category) => ({
    category,
    violationCount: countsByCategory.get(category) as number,
  }));
}
