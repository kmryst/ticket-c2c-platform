// ファイル概要:
// Ticket Type expand schema（Issue #336）が internal cutover（Issue #337）へ進める状態か、
// 旧 Event 単位在庫と expand 後の shadow data を読み取り専用 SQL で照合します。
// 1 category でも violation_count > 0 なら、呼び出し側は fail closed で切替を停止します。

export const TICKET_TYPE_EXPAND_READINESS_CATEGORIES = [
  'event_without_exactly_one_default',
  'event_without_exactly_one_ticket_type_before_cutover',
  'event_without_legacy_inventory',
  'legacy_inventory_without_default_shadow',
  'legacy_shadow_remaining_mismatch',
  'legacy_shadow_total_mismatch',
  'legacy_shadow_updated_at_mismatch',
  'legacy_shadow_version_mismatch',
  'non_default_inventory_before_cutover',
  'purchase_ticket_type_event_mismatch',
  'purchase_without_ticket_type',
  'required_bridge_trigger_missing_or_disabled',
  'required_ticket_type_fk_missing_or_unvalidated',
  'required_ticket_type_not_null_missing',
  'required_unique_index_missing_or_invalid',
  'ticket_type_inventory_event_mismatch',
] as const;

export type TicketTypeExpandReadinessCategory =
  (typeof TICKET_TYPE_EXPAND_READINESS_CATEGORIES)[number];

export const TICKET_TYPE_EXPAND_READINESS_EVIDENCE_TYPE =
  'ticket-type-expand-readiness';
export const TICKET_TYPE_EXPAND_READINESS_EVIDENCE_VERSION = 1;

export interface TicketTypeExpandReadinessResult {
  category: TicketTypeExpandReadinessCategory;
  violationCount: number;
}

export interface TicketTypeExpandReadinessEvidence {
  evidenceType: typeof TICKET_TYPE_EXPAND_READINESS_EVIDENCE_TYPE;
  evidenceVersion: typeof TICKET_TYPE_EXPAND_READINESS_EVIDENCE_VERSION;
  results: readonly TicketTypeExpandReadinessResult[];
  categoryCount: number;
  complete: true;
}

interface ReadinessQueryRow {
  category: unknown;
  violation_count: unknown;
}

interface ReadinessQueryable {
  query: (
    sql: string,
  ) => Promise<
    | ReadinessQueryRow[]
    | { rows: ReadinessQueryRow[]; rowCount?: number | null }
  >;
}

// 各 SELECT は必ず 1 row を返すため、正常時も category ごとの 0 件を証跡へ残せます。
// FK / NOT NULL が通常は防ぐ違反も明示的に数え、constraint の欠落・無効化を検出対象にします。
export const TICKET_TYPE_EXPAND_READINESS_SQL = `
WITH event_default_counts AS (
  SELECT
    e.id AS event_id,
    count(tt.id) FILTER (WHERE tt.is_default) AS default_count
  FROM public.events e
  LEFT JOIN public.ticket_types tt ON tt.event_id = e.id
  GROUP BY e.id
),
default_ticket_types AS (
  SELECT event_id, id AS ticket_type_id
  FROM public.ticket_types
  WHERE is_default
),
-- function_body_md5s は canonical PL/pgSQL prosrc の許可hash。
-- #336単体のbridgeと、#376がnested bounceだけを止めるsuccessor版を明示的に区別する。
required_bridge_triggers(
  table_name,
  trigger_name,
  function_name,
  function_body_md5s,
  trigger_type
) AS (
  VALUES
    (
      'events'::text,
      'events_ticket_type_expand_default_trg'::text,
      'ticket_type_expand_create_default_ticket_type'::text,
      ARRAY['b93a46dd7d53cb4f5833ff8ce5f447f5']::text[],
      5::smallint
    ),
    (
      'ticket_inventory',
      'ticket_inventory_ticket_type_expand_sync_trg',
      'ticket_type_expand_sync_inventory',
      ARRAY[
        '4c5fc01e805ed4fb42cd4d35c493aa78',
        '56894124575b9c7825a172fa67cf5d86'
      ],
      21
    ),
    (
      'purchases',
      'purchases_ticket_type_expand_default_trg',
      'ticket_type_expand_set_purchase_ticket_type',
      ARRAY['9b5c4e4e463f9d632afcd449ce80281f'],
      7
    )
),
required_ticket_type_foreign_keys(
  table_name,
  constraint_name,
  local_columns,
  referenced_table_name,
  referenced_columns,
  delete_action
) AS (
  VALUES
    (
      'ticket_types'::text,
      'ticket_types_event_id_fkey'::text,
      ARRAY['event_id']::text[],
      'events'::text,
      ARRAY['id']::text[],
      'c'::"char"
    ),
    (
      'ticket_type_inventory',
      'ticket_type_inventory_event_ticket_type_fkey',
      ARRAY['event_id', 'ticket_type_id'],
      'ticket_types',
      ARRAY['event_id', 'id'],
      'c'::"char"
    ),
    (
      'purchases',
      'purchases_event_ticket_type_fkey',
      ARRAY['event_id', 'ticket_type_id'],
      'ticket_types',
      ARRAY['event_id', 'id'],
      'r'::"char"
    )
),
required_not_null_columns(table_name, column_name) AS (
  VALUES
    ('ticket_types'::text, 'id'::text),
    ('ticket_types', 'event_id'),
    ('ticket_types', 'name'),
    ('ticket_types', 'is_default'),
    ('ticket_types', 'created_at'),
    ('ticket_types', 'updated_at'),
    ('ticket_type_inventory', 'ticket_type_id'),
    ('ticket_type_inventory', 'event_id'),
    ('ticket_type_inventory', 'total_quantity'),
    ('ticket_type_inventory', 'remaining_quantity'),
    ('ticket_type_inventory', 'version'),
    ('ticket_type_inventory', 'updated_at'),
    ('purchases', 'ticket_type_id')
),
required_unique_indexes(
  table_name,
  index_name,
  key_expressions,
  predicate,
  is_primary
) AS (
  VALUES
    (
      'ticket_types'::text,
      'ticket_types_pkey'::text,
      ARRAY['id']::text[],
      NULL::text,
      true
    ),
    (
      'ticket_types',
      'ticket_types_event_id_id_key',
      ARRAY['event_id', 'id'],
      NULL,
      false
    ),
    (
      'ticket_types',
      'ticket_types_event_normalized_name_uq',
      ARRAY['event_id', 'lower(name)'],
      NULL,
      false
    ),
    (
      'ticket_types',
      'ticket_types_one_default_per_event_uq',
      ARRAY['event_id'],
      'is_default',
      false
    ),
    (
      'ticket_type_inventory',
      'ticket_type_inventory_pkey',
      ARRAY['ticket_type_id'],
      NULL,
      true
    )
),
violations AS (
  SELECT
    'event_without_exactly_one_default'::text AS category,
    count(*)::bigint AS violation_count
  FROM event_default_counts
  WHERE default_count <> 1

  UNION ALL

  SELECT
    'event_without_exactly_one_ticket_type_before_cutover',
    count(*)::bigint
  FROM (
    SELECT e.id
    FROM public.events e
    LEFT JOIN public.ticket_types tt ON tt.event_id = e.id
    GROUP BY e.id
    HAVING count(tt.id) <> 1
  ) unexpected_ticket_type_counts

  UNION ALL

  SELECT
    'event_without_legacy_inventory',
    count(*)::bigint
  FROM public.events e
  LEFT JOIN public.ticket_inventory legacy ON legacy.event_id = e.id
  WHERE legacy.event_id IS NULL

  UNION ALL

  SELECT
    'legacy_inventory_without_default_shadow',
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
    'legacy_shadow_total_mismatch',
    count(*)::bigint
  FROM public.ticket_inventory legacy
  JOIN default_ticket_types defaults
    ON defaults.event_id = legacy.event_id
  JOIN public.ticket_type_inventory shadow
    ON shadow.event_id = legacy.event_id
   AND shadow.ticket_type_id = defaults.ticket_type_id
  WHERE shadow.total_quantity IS DISTINCT FROM legacy.total_quantity

  UNION ALL

  SELECT
    'legacy_shadow_remaining_mismatch',
    count(*)::bigint
  FROM public.ticket_inventory legacy
  JOIN default_ticket_types defaults
    ON defaults.event_id = legacy.event_id
  JOIN public.ticket_type_inventory shadow
    ON shadow.event_id = legacy.event_id
   AND shadow.ticket_type_id = defaults.ticket_type_id
  WHERE shadow.remaining_quantity IS DISTINCT FROM legacy.remaining_quantity

  UNION ALL

  SELECT
    'legacy_shadow_version_mismatch',
    count(*)::bigint
  FROM public.ticket_inventory legacy
  JOIN default_ticket_types defaults
    ON defaults.event_id = legacy.event_id
  JOIN public.ticket_type_inventory shadow
    ON shadow.event_id = legacy.event_id
   AND shadow.ticket_type_id = defaults.ticket_type_id
  WHERE shadow.version IS DISTINCT FROM legacy.version

  UNION ALL

  SELECT
    'legacy_shadow_updated_at_mismatch',
    count(*)::bigint
  FROM public.ticket_inventory legacy
  JOIN default_ticket_types defaults
    ON defaults.event_id = legacy.event_id
  JOIN public.ticket_type_inventory shadow
    ON shadow.event_id = legacy.event_id
   AND shadow.ticket_type_id = defaults.ticket_type_id
  WHERE shadow.updated_at IS DISTINCT FROM legacy.updated_at

  UNION ALL

  SELECT
    'non_default_inventory_before_cutover',
    count(*)::bigint
  FROM public.ticket_type_inventory shadow
  JOIN public.ticket_types tt
    ON tt.event_id = shadow.event_id
   AND tt.id = shadow.ticket_type_id
  WHERE NOT tt.is_default

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

  SELECT
    'ticket_type_inventory_event_mismatch',
    count(*)::bigint
  FROM public.ticket_type_inventory shadow
  LEFT JOIN public.ticket_types tt
    ON tt.event_id = shadow.event_id
   AND tt.id = shadow.ticket_type_id
  WHERE tt.id IS NULL

  UNION ALL

  SELECT
    'required_bridge_trigger_missing_or_disabled',
    count(*)::bigint
  FROM required_bridge_triggers required
  LEFT JOIN pg_trigger database_trigger
    ON database_trigger.tgrelid =
      to_regclass('public.' || required.table_name)
   AND database_trigger.tgname = required.trigger_name
   AND NOT database_trigger.tgisinternal
  LEFT JOIN pg_proc database_function
    ON database_function.oid = database_trigger.tgfoid
  WHERE database_trigger.oid IS NULL
     OR database_trigger.tgenabled NOT IN ('O', 'A')
     OR database_trigger.tgfoid IS DISTINCT FROM
       to_regprocedure('public.' || required.function_name || '()')
     OR database_trigger.tgtype IS DISTINCT FROM required.trigger_type
     OR database_trigger.tgnargs <> 0
     OR database_trigger.tgqual IS NOT NULL
     OR database_trigger.tgconstraint <> 0
     OR database_trigger.tgdeferrable
     OR database_trigger.tginitdeferred
     OR database_trigger.tgattr::text <> ''
     OR database_trigger.tgoldtable IS NOT NULL
     OR database_trigger.tgnewtable IS NOT NULL
     OR database_function.oid IS NULL
     OR database_function.prorettype IS DISTINCT FROM 'trigger'::regtype
     OR database_function.pronargs <> 0
     OR database_function.prokind <> 'f'
     OR database_function.provolatile <> 'v'
     OR database_function.proparallel <> 'u'
     OR database_function.prolang IS DISTINCT FROM (
       SELECT oid
       FROM pg_language
       WHERE lanname = 'plpgsql'
     )
     OR database_function.prosecdef
     OR database_function.proleakproof
     OR database_function.proconfig IS DISTINCT FROM
       ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
     OR NOT (
       md5(database_function.prosrc) = ANY(required.function_body_md5s)
     )

  UNION ALL

  SELECT
    'required_ticket_type_fk_missing_or_unvalidated',
    count(*)::bigint
  FROM required_ticket_type_foreign_keys required
  LEFT JOIN pg_constraint database_constraint
    ON database_constraint.conrelid =
      to_regclass('public.' || required.table_name)
   AND database_constraint.conname = required.constraint_name
  WHERE database_constraint.oid IS NULL
     OR database_constraint.contype <> 'f'
     OR NOT database_constraint.convalidated
     OR database_constraint.confrelid IS DISTINCT FROM
       to_regclass('public.' || required.referenced_table_name)
     OR database_constraint.confdeltype IS DISTINCT FROM
       required.delete_action
     OR database_constraint.confupdtype <> 'a'
     OR database_constraint.confmatchtype <> 's'
     OR database_constraint.condeferrable
     OR database_constraint.condeferred
     OR ARRAY(
       SELECT database_column.attname::text
       FROM unnest(database_constraint.conkey)
         WITH ORDINALITY AS constraint_key(attnum, position)
       JOIN pg_attribute database_column
         ON database_column.attrelid = database_constraint.conrelid
        AND database_column.attnum = constraint_key.attnum
       ORDER BY constraint_key.position
     ) IS DISTINCT FROM required.local_columns
     OR ARRAY(
       SELECT referenced_column.attname::text
       FROM unnest(database_constraint.confkey)
         WITH ORDINALITY AS referenced_key(attnum, position)
       JOIN pg_attribute referenced_column
         ON referenced_column.attrelid = database_constraint.confrelid
        AND referenced_column.attnum = referenced_key.attnum
       ORDER BY referenced_key.position
     ) IS DISTINCT FROM required.referenced_columns

  UNION ALL

  SELECT
    'required_ticket_type_not_null_missing',
    count(*)::bigint
  FROM required_not_null_columns required
  LEFT JOIN pg_attribute database_column
    ON database_column.attrelid =
      to_regclass('public.' || required.table_name)
   AND database_column.attname = required.column_name
   AND database_column.attnum > 0
   AND NOT database_column.attisdropped
  WHERE database_column.attnum IS NULL
     OR NOT database_column.attnotnull

  UNION ALL

  SELECT
    'required_unique_index_missing_or_invalid',
    count(*)::bigint
  FROM required_unique_indexes required
  LEFT JOIN pg_index database_index
    ON database_index.indexrelid =
      to_regclass('public.' || required.index_name)
   AND database_index.indrelid =
      to_regclass('public.' || required.table_name)
  LEFT JOIN pg_class index_relation
    ON index_relation.oid = database_index.indexrelid
  LEFT JOIN pg_am index_access_method
    ON index_access_method.oid = index_relation.relam
  WHERE database_index.indexrelid IS NULL
     OR NOT database_index.indisunique
     OR NOT database_index.indisvalid
     OR NOT database_index.indisready
     OR database_index.indisprimary IS DISTINCT FROM required.is_primary
     OR database_index.indisexclusion
     OR database_index.indnatts <> database_index.indnkeyatts
     OR index_access_method.amname IS DISTINCT FROM 'btree'
     OR ARRAY(
       SELECT pg_get_indexdef(
         database_index.indexrelid,
         key_position,
         true
       )
       FROM generate_series(
         1,
         database_index.indnkeyatts
       ) AS key_position
       ORDER BY key_position
     ) IS DISTINCT FROM required.key_expressions
     OR pg_get_expr(
       database_index.indpred,
       database_index.indrelid,
       true
     ) IS DISTINCT FROM required.predicate
)
SELECT category, violation_count::text
FROM violations
ORDER BY category
`;

export async function checkTicketTypeExpandReadiness(
  database: ReadinessQueryable,
): Promise<TicketTypeExpandReadinessResult[]> {
  const result = await database.query(TICKET_TYPE_EXPAND_READINESS_SQL);
  const rows = Array.isArray(result) ? result : result.rows;
  const expectedCategories = new Set<string>(
    TICKET_TYPE_EXPAND_READINESS_CATEGORIES,
  );
  const countsByCategory = new Map<TicketTypeExpandReadinessCategory, number>();

  for (const row of rows) {
    if (
      typeof row.category !== 'string' ||
      !expectedCategories.has(row.category)
    ) {
      throw new Error(
        `unexpected Ticket Type readiness category: ${String(row.category)}`,
      );
    }
    const category = row.category as TicketTypeExpandReadinessCategory;
    if (countsByCategory.has(category)) {
      throw new Error(`duplicate Ticket Type readiness category: ${category}`);
    }
    if (
      typeof row.violation_count !== 'string' ||
      !/^(0|[1-9]\d*)$/.test(row.violation_count)
    ) {
      throw new Error(
        `invalid Ticket Type readiness count for ${category}: ${String(row.violation_count)}`,
      );
    }
    const violationCount = Number(row.violation_count);
    if (!Number.isSafeInteger(violationCount)) {
      throw new Error(
        `invalid Ticket Type readiness count for ${category}: ${row.violation_count}`,
      );
    }
    countsByCategory.set(category, violationCount);
  }

  const results = TICKET_TYPE_EXPAND_READINESS_CATEGORIES.flatMap(
    (category) => {
      const violationCount = countsByCategory.get(category);
      return violationCount === undefined ? [] : [{ category, violationCount }];
    },
  );
  assertTicketTypeExpandReadinessComplete(results);
  return results;
}

export function assertTicketTypeExpandReadinessComplete(
  results: readonly TicketTypeExpandReadinessResult[],
): void {
  const expectedCategories = new Set<string>(
    TICKET_TYPE_EXPAND_READINESS_CATEGORIES,
  );
  const seenCategories = new Set<string>();

  for (const result of results) {
    if (
      typeof result.category !== 'string' ||
      !expectedCategories.has(result.category)
    ) {
      throw new Error(
        `unexpected Ticket Type readiness category: ${String(result.category)}`,
      );
    }
    if (seenCategories.has(result.category)) {
      throw new Error(
        `duplicate Ticket Type readiness category: ${result.category}`,
      );
    }
    if (
      !Number.isSafeInteger(result.violationCount) ||
      result.violationCount < 0
    ) {
      throw new Error(
        `invalid Ticket Type readiness count for ${result.category}: ${String(result.violationCount)}`,
      );
    }
    seenCategories.add(result.category);
  }

  const missingCategories = TICKET_TYPE_EXPAND_READINESS_CATEGORIES.filter(
    (category) => !seenCategories.has(category),
  );
  if (missingCategories.length > 0) {
    throw new Error(
      `missing Ticket Type readiness categories: ${missingCategories.join(', ')}`,
    );
  }
}

export function hasTicketTypeExpandViolations(
  results: readonly TicketTypeExpandReadinessResult[],
): boolean {
  assertTicketTypeExpandReadinessComplete(results);
  return results.some((result) => result.violationCount > 0);
}

export function serializeTicketTypeExpandReadinessEvidence(
  results: readonly TicketTypeExpandReadinessResult[],
): string {
  assertTicketTypeExpandReadinessComplete(results);
  const evidence: TicketTypeExpandReadinessEvidence = {
    evidenceType: TICKET_TYPE_EXPAND_READINESS_EVIDENCE_TYPE,
    evidenceVersion: TICKET_TYPE_EXPAND_READINESS_EVIDENCE_VERSION,
    results,
    categoryCount: results.length,
    complete: true,
  };
  // CloudWatch Logsで1 eventとして構造検証できるよう、改行なしのJSONにする。
  return JSON.stringify(evidence);
}
