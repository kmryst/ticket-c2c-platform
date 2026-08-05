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
  eventCounterKey,
  eventCounterVersionKey,
  parseTicketTypeCounterKey,
  TICKET_TYPE_COUNTER_SCAN_PATTERN,
  ticketTypeCounterKey,
  ticketTypeCounterRevisionKey,
} from '../cache/inventory-cache.keys';
import {
  RECONCILIATION_CATEGORIES,
  ReconciliationCategory,
  ReconciliationFinding,
  reconcileInventoryProjection,
  ReconciliationReport,
} from '../search/inventory-reconciliation.service';
import { DEFAULT_PAGE_SIZE, SqlClient } from '../search/inventory-projection-source';
import { EVENTS_INDEX } from '../search/events-projection.store';

// category は Gate B が検査する差分の有限集合です（合計 23）。
// - DB 未紐付け・在庫差分: 10
// - control state: 2
// - compatibility schema object（#376 の trigger 配線・関数本文 hash・index 定義）: 1
// - Valkey counter / revision / version 差分（Ticket Type 5 + legacy Event 4）: 9
// - OpenSearch projection 差分: 1
export const TICKET_TYPE_CUTOVER_READINESS_CATEGORIES = [
  // --- DB 未紐付け・在庫差分（10） ---
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
  // --- control state（2） ---
  'writer_control_state_missing_or_invalid',
  'writer_control_mode_mismatch',
  // --- compatibility schema object（1） ---
  'compatibility_object_missing_or_invalid',
  // --- Valkey counter / revision / version 差分（9） ---
  'valkey_counter_missing',
  'valkey_counter_without_inventory_row',
  'valkey_counter_value_invalid',
  'valkey_counter_remaining_mismatch',
  'valkey_revision_missing_or_invalid',
  'valkey_legacy_counter_missing',
  'valkey_legacy_counter_value_invalid',
  'valkey_legacy_counter_remaining_mismatch',
  'valkey_legacy_version_value_invalid',
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
  // checkPhase は CLI --phase（この検査の局面）。postflight では expect-mode の writer が
  // 更新しない他方 namespace の counter 不在・stale を許容するため、evidence 単体で
  // 「どの規則で緑になったか」を判別できるよう必須で記録する。
  checkPhase: CutoverCheckPhase;
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

// CutoverCheckPhase は「expect-mode（現在有効であるべき writer mode）に対して、
// この検査がどの局面で走っているか」を表します。実購入は現 mode 側の counter しか
// 更新しない（legacy 経路は Event counter、ticket_type 経路は Ticket Type counter）ため、
// mode だけでは「切替前の厳密検査」と「切替後の平常運用検査」を区別できません。
// - 'preflight': これから他方の mode へ切り替える直前の検査。切替先 namespace も
//   厳密に照合する（未 seed / stale を violation にする）。
// - 'postflight': expect-mode へ切り替えた後（またはその mode での平常運用中）の検査。
//   現 mode の writer が更新しない他方 namespace は、不在・stale を許容し、
//   構造的に不正な値（非整数・total 超過）だけを violation にする。
export type CutoverCheckPhase = 'preflight' | 'postflight';

const CHECK_PHASES: readonly CutoverCheckPhase[] = ['preflight', 'postflight'];

function assertCheckPhase(value: unknown, label: string): CutoverCheckPhase {
  if (value !== 'preflight' && value !== 'postflight') {
    throw new Error(
      `${label} must be one of ${CHECK_PHASES.join(', ')}: ${String(value)}`,
    );
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

  -- 逆方向: Ticket Type 定義はあるのに在庫行が無い（非 default を含む）。この状態の Type へ
  -- 購入が来ると在庫行 UPDATE が 0 件になり API が 500 を返すため、mode に関係なく violation。
  SELECT
    'ticket_type_without_ticket_type_inventory',
    count(*)::bigint
  FROM public.ticket_types tt
  LEFT JOIN public.ticket_type_inventory shadow
    ON shadow.event_id = tt.event_id
   AND shadow.ticket_type_id = tt.id
  WHERE shadow.ticket_type_id IS NULL

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

  UNION ALL

  -- #376 の compatibility object が「migration 履歴上は適用済み」でも、後から
  -- ALTER TABLE ... DISABLE TRIGGER や CREATE OR REPLACE FUNCTION による関数本体の
  -- no-op 差し替えがあれば writer guard / mirror は働かない。schemaRevision（migration 名）
  -- だけでは検出できないため、ADR-0029 の「置換前後の function 本文を exact hash で識別する」
  -- 契約に従い、Gate A（required_bridge_trigger_missing_or_disabled）と同水準で
  -- trigger の配線（tgfoid / tgtype / 引数・制約属性）、関数属性（plpgsql / volatile /
  -- search_path 固定等）、関数本文の md5(prosrc)、および統合 requestId unique index の
  -- key 列と predicate の完全一致を pg_catalog から検査する。
  -- function_body_md5 は canonical PL/pgSQL prosrc の許可 hash。
  -- ticket_type_expand_sync_inventory は Gate A と異なり #376 の successor 版
  -- （nested bounce を止める版）だけを許可する（#336 単体版へ戻っていたら violation）。
  SELECT
    'compatibility_object_missing_or_invalid',
    (
      SELECT count(*)::bigint
      FROM (VALUES
        (
          'events'::text,
          'inventory_compatibility_mark_event_delete_before_trg'::text,
          'inventory_compatibility_mark_event_delete_cascade'::text,
          '824fc3b87181f8feae6a582a5ec59591'::text,
          10::smallint
        ),
        (
          'ticket_inventory',
          'inventory_compatibility_fence_legacy_statement_trg',
          'inventory_compatibility_fence_inventory_statement',
          '64716d53339a3c529079f61c2377b8d0',
          22
        ),
        (
          'ticket_inventory',
          'inventory_compatibility_guard_legacy_write_trg',
          'inventory_compatibility_guard_legacy_write',
          '3a3971b24bb14e3f5c23138d7688d065',
          23
        ),
        (
          'ticket_inventory',
          'inventory_compatibility_guard_legacy_delete_trg',
          'inventory_compatibility_guard_delete_cascade',
          '0127f775847e6d28fa6c83d73fa6a1f6',
          10
        ),
        (
          'ticket_inventory',
          'inventory_compatibility_reject_legacy_truncate_trg',
          'inventory_compatibility_reject_truncate',
          '41793cc2f9cd2451c70505a22df5e225',
          34
        ),
        (
          'ticket_inventory',
          'ticket_inventory_ticket_type_expand_sync_trg',
          'ticket_type_expand_sync_inventory',
          '56894124575b9c7825a172fa67cf5d86',
          21
        ),
        (
          'ticket_type_inventory',
          'inventory_compatibility_fence_ticket_type_statement_trg',
          'inventory_compatibility_fence_inventory_statement',
          '64716d53339a3c529079f61c2377b8d0',
          22
        ),
        (
          'ticket_type_inventory',
          'inventory_compatibility_guard_ticket_type_write_trg',
          'inventory_compatibility_guard_ticket_type_write',
          'c70407a9864736bbf6322356ea55f51f',
          23
        ),
        (
          'ticket_type_inventory',
          'inventory_compatibility_guard_ticket_type_delete_trg',
          'inventory_compatibility_guard_delete_cascade',
          '0127f775847e6d28fa6c83d73fa6a1f6',
          10
        ),
        (
          'ticket_type_inventory',
          'inventory_compatibility_reject_ticket_type_truncate_trg',
          'inventory_compatibility_reject_truncate',
          '41793cc2f9cd2451c70505a22df5e225',
          34
        ),
        (
          'ticket_type_inventory',
          'inventory_compatibility_sync_ticket_type_to_legacy_trg',
          'inventory_compatibility_sync_ticket_type_to_legacy',
          'c347780b856f90d05d68e1800e1d36f1',
          21
        ),
        (
          'ticket_types',
          'inventory_compatibility_guard_ticket_type_definition_delete_trg',
          'inventory_compatibility_guard_delete_cascade',
          '0127f775847e6d28fa6c83d73fa6a1f6',
          10
        ),
        -- #376 の CREATE TRIGGER 名は 66 文字のため、PostgreSQL の NAMEDATALEN 制限で
        -- catalog 上は 63 文字に切り詰められる。ここでは catalog 上の実名で照合する。
        (
          'ticket_types',
          'inventory_compatibility_reject_ticket_type_definition_truncate_',
          'inventory_compatibility_reject_truncate',
          '41793cc2f9cd2451c70505a22df5e225',
          34
        )
      ) AS required(
        table_name,
        trigger_name,
        function_name,
        function_body_md5,
        trigger_type
      )
      LEFT JOIN pg_catalog.pg_trigger database_trigger
        ON database_trigger.tgrelid =
          to_regclass('public.' || required.table_name)
       AND database_trigger.tgname = required.trigger_name
       AND NOT database_trigger.tgisinternal
      LEFT JOIN pg_catalog.pg_proc database_function
        ON database_function.oid = database_trigger.tgfoid
      WHERE database_trigger.oid IS NULL
         OR database_trigger.tgenabled <> 'O'
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
         OR database_function.prorettype IS DISTINCT FROM 'trigger'::pg_catalog.regtype
         OR database_function.pronargs <> 0
         OR database_function.prokind <> 'f'
         OR database_function.provolatile <> 'v'
         OR database_function.proparallel <> 'u'
         OR database_function.prolang IS DISTINCT FROM (
           SELECT oid
           FROM pg_catalog.pg_language
           WHERE lanname = 'plpgsql'
         )
         OR database_function.prosecdef
         OR database_function.proleakproof
         OR database_function.proconfig IS DISTINCT FROM
           ARRAY['search_path=pg_catalog, public, pg_temp']::text[]
         OR md5(database_function.prosrc) IS DISTINCT FROM required.function_body_md5
    )
    + CASE WHEN EXISTS (
        SELECT 1
        FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
        JOIN pg_catalog.pg_class tc ON tc.oid = i.indrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = tc.relnamespace
        JOIN pg_catalog.pg_am am ON am.oid = ic.relam
        WHERE n.nspname = 'public'
          AND tc.relname = 'purchases'
          AND ic.relname = 'purchases_request_id_uq'
          AND i.indisunique
          AND i.indisvalid
          AND i.indisready
          AND i.indislive
          AND NOT i.indisprimary
          AND NOT i.indisexclusion
          AND i.indnatts = i.indnkeyatts
          AND am.amname = 'btree'
          -- key 列と predicate は部分文字列比較ではなく、pg_get_indexdef の列単位出力と
          -- pg_get_expr の完全一致で照合する（狭い predicate への差し替えを検出する）。
          AND ARRAY(
            SELECT pg_get_indexdef(i.indexrelid, key_position, true)
            FROM generate_series(1, i.indnkeyatts) AS key_position
            ORDER BY key_position
          ) = ARRAY['buyer_id', 'event_id', 'request_id']::text[]
          AND pg_get_expr(i.indpred, i.indrelid, true) = 'request_id IS NOT NULL'
      ) THEN 0::bigint ELSE 1::bigint END
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
  'ticket_type_without_ticket_type_inventory',
  'purchase_without_ticket_type',
  'purchase_ticket_type_event_mismatch',
  'legacy_aggregate_total_mismatch',
  'legacy_aggregate_remaining_mismatch',
  'non_default_ticket_type_inventory_in_legacy_mode',
  'writer_control_state_missing_or_invalid',
  'writer_control_mode_mismatch',
  'compatibility_object_missing_or_invalid',
];

const VALKEY_CATEGORIES: readonly TicketTypeCutoverReadinessCategory[] = [
  'valkey_counter_missing',
  'valkey_counter_without_inventory_row',
  'valkey_counter_value_invalid',
  'valkey_counter_remaining_mismatch',
  'valkey_revision_missing_or_invalid',
  'valkey_legacy_counter_missing',
  'valkey_legacy_counter_value_invalid',
  'valkey_legacy_counter_remaining_mismatch',
  'valkey_legacy_version_value_invalid',
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

// checkCutoverValkey は Ticket Type counter / revision と legacy Event counter を
// DB 在庫行（ticket_type_inventory / ticket_inventory）と突き合わせて検査します。
// DB は呼び出し側 transaction の snapshot から読み、Valkey は read-only コマンド
// （GET / SCAN）だけを使います。Valkey エラーは fail-open にせず throw します
// （購入 API と異なり、checker は誤って green を返してはいけない）。
//
// namespace ごとの厳密さは expect-mode と phase の組で決めます。実購入
// （purchases.service）は現 mode 側の counter しか更新しないため:
// - Ticket Type namespace は「legacy mode の postflight（rollback 後の平常運用）」で
//   だけ緩和する。legacy 経路の購入は forward bridge で ticket_type_inventory の DB 行を
//   進める一方 Ticket Type counter を更新しないので、不在・stale は正常。
// - legacy Event namespace は「ticket_type mode の postflight（activation 後の平常運用）」で
//   だけ緩和する。ticket_type 経路の購入は reverse mirror で ticket_inventory の DB 行を
//   進める一方 Event counter を更新しないので、stale は正常。counter 不在は
//   「legacy namespace がこれから active になる rollback preflight
//   （expect-mode ticket_type / preflight）」でだけ violation とし、それ以外の局面では
//   購入 API の fail-open 設計に合わせて許容する（詳細は Pass 3 のコメント参照）。
// preflight（これから他方 mode へ切り替える直前）は従来どおり両 namespace とも厳密で、
// 切替先の未 seed / stale counter を fail closed に violation とします。
// 緩和中も構造的に不正な値（非整数・負数・total 超過）は常に violation とします。
export async function checkCutoverValkey(
  sql: SqlClient,
  valkey: ValkeyReadClient,
  expectedWriterMode: InventoryWriterMode,
  checkPhase: CutoverCheckPhase,
  options: CutoverValkeyOptions = {},
): Promise<TicketTypeCutoverReadinessResult[]> {
  assertWriterMode(expectedWriterMode, 'expected writer mode');
  assertCheckPhase(checkPhase, 'check phase');
  const pageSize = boundedPageSize(options.pageSize);

  // 現 mode の writer が更新しない側の namespace だけ、postflight で緩和する。
  const strictTicketTypeNamespace = !(
    expectedWriterMode === 'legacy' && checkPhase === 'postflight'
  );
  const strictLegacyNamespace = !(
    expectedWriterMode === 'ticket_type' && checkPhase === 'postflight'
  );

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
        // activation 直前 preflight（expect-mode legacy / preflight）の時点で
        // ticket_type counter が全件 seed 済みでなければ activation してはいけない
        // （切替後の誤拒否/素通りの温床）。ticket_type mode の検査（preflight /
        // postflight とも）でも active namespace の不在は violation とする。
        // 例外は legacy postflight（rollback 後の平常運用）だけで、legacy 経路の購入は
        // Ticket Type counter を更新しないため、不在は正常として許容する。
        if (strictTicketTypeNamespace) {
          bump('valkey_counter_missing');
        }
        continue;
      }

      if (
        !NON_NEGATIVE_INTEGER.test(counterRaw) ||
        !Number.isSafeInteger(Number(counterRaw)) ||
        Number(counterRaw) > POSTGRES_INT4_MAX ||
        Number(counterRaw) > row.total_quantity
      ) {
        // 構造的にあり得ない counter 値（非整数・負数・total 超過）は mismatch と区別して
        // 数える（緩和中の namespace でも常に violation）。
        bump('valkey_counter_value_invalid');
      } else if (
        strictTicketTypeNamespace &&
        Number(counterRaw) !== row.remaining_quantity
      ) {
        // legacy postflight では forward bridge が DB 行だけを進めるため、
        // 値のある counter の stale も正常として数えない。
        bump('valkey_counter_remaining_mismatch');
      }

      if (strictTicketTypeNamespace) {
        const revisionRaw = await valkey.get(
          ticketTypeCounterRevisionKey(row.event_id, row.ticket_type_id),
        );
        // counter があるのに CAS revision が無い/壊れていると sync が成立しない。
        // 形式（非負整数）に加えて範囲も検査する: safe integer を超える値
        // （signed INT64 上限 9223372036854775807 等）は正規表現を通過するが、
        // reserve Lua script の INCR が signed 64-bit 範囲外エラーで落ち、
        // DECRBY だけが反映される部分適用を招くため fail closed に violation とする
        // （Valkey/Redis に MULTI/EXEC 内のコマンド単位 rollback は無い）。
        // 緩和中（legacy postflight）は namespace 自体が休止中なので検査しない
        // （次の activation preflight が seed し直しを強制する）。
        if (
          revisionRaw === null ||
          !NON_NEGATIVE_INTEGER.test(revisionRaw) ||
          !Number.isSafeInteger(Number(revisionRaw))
        ) {
          bump('valkey_revision_missing_or_invalid');
        }
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

  // Pass 3: legacy mode で実際に使われる Event 単位 counter（inventory:<eventId>）を
  // ticket_inventory と突き合わせる。
  //
  // counter 不在の扱いは局面で分ける:
  // - rollback preflight（expect-mode ticket_type / preflight。legacy namespace が
  //   これから active になる局面）では不在を violation にする。ticket_type mode 稼働中に
  //   EventsService が作った新規 Event は Ticket Type counter だけが seed され legacy
  //   Event counter が未 seed のまま残るため、ここで見逃すと rollback 後に購入 API が
  //   そのEventについて恒常的に fail-open（unknown）で DB 判定へ流れ続け、売り切れ判定
  //   トラフィックが Valkey で遮断されず Aurora へ到達し続ける（preflight は
  //   「legacy counter を seed してから戻す」ことを強制する）。
  // - それ以外（legacy が現 mode の preflight/postflight、および ticket_type postflight）
  //   では不在を violation にしない。legacy 稼働中の counter 不在（eviction 等）は
  //   購入 API が fail-open で DB 判定へ流す設計済みの正常状態であり、activation
  //   preflight では legacy namespace はこれから休止する側なので不在は無害。
  //
  // 値が存在して DB と乖離している場合（rollback 直前の stale counter 等）は、在庫が
  // あるのに前段フィルタが sold_out で即時拒否する実害があるため violation とする
  // （preflight before rollback では「stale legacy counter を削除/再 seed してから戻す」
  // ことを強制する）。例外は ticket_type postflight（activation 後の平常運用）だけで、
  // ticket_type 経路の購入は reverse mirror で DB の legacy 集計行だけを進め Event
  // counter を更新しないため、stale は正常として許容する（構造的に不正な値は常に violation）。
  //
  // version キー（inventory:<eventId>:v）の不在は getCounterVersion が '0' として扱う
  // 正常状態なので許容するが、存在する場合の非整数・負数・safe integer 超過
  // （signed INT64 上限等。reserve Lua script の INCR が範囲外エラーになり DECRBY だけが
  // 反映される部分適用や、CAS sync の恒常的失敗を招く）は局面に依らず violation とする。
  const legacyNamespaceBecomingActive =
    expectedWriterMode === 'ticket_type' && checkPhase === 'preflight';
  let lastLegacyEventId: string | null = null;
  for (;;) {
    const page: {
      rows: {
        event_id: string;
        total_quantity: number;
        remaining_quantity: number;
      }[];
      rowCount: number | null;
    } = await sql.query<{
      event_id: string;
      total_quantity: number;
      remaining_quantity: number;
    }>(
      `
        SELECT event_id::text AS event_id,
               total_quantity,
               remaining_quantity
        FROM public.ticket_inventory
        WHERE ($1::uuid IS NULL OR event_id > $1::uuid)
        ORDER BY event_id ASC
        LIMIT $2
      `,
      [lastLegacyEventId, pageSize],
    );
    if (page.rows.length === 0) {
      break;
    }

    for (const row of page.rows) {
      // version キーは counter 不在でも壊れた値で残り得るため、counter 判定より先に
      // 検査する（counter 不在の continue で素通りさせない）。
      const versionRaw = await valkey.get(eventCounterVersionKey(row.event_id));
      if (
        versionRaw !== null &&
        (!NON_NEGATIVE_INTEGER.test(versionRaw) ||
          !Number.isSafeInteger(Number(versionRaw)))
      ) {
        bump('valkey_legacy_version_value_invalid');
      }

      const counterRaw = await valkey.get(eventCounterKey(row.event_id));
      if (counterRaw === null) {
        if (legacyNamespaceBecomingActive) {
          bump('valkey_legacy_counter_missing');
        }
        continue;
      }
      if (
        !NON_NEGATIVE_INTEGER.test(counterRaw) ||
        !Number.isSafeInteger(Number(counterRaw)) ||
        Number(counterRaw) > POSTGRES_INT4_MAX ||
        Number(counterRaw) > row.total_quantity
      ) {
        bump('valkey_legacy_counter_value_invalid');
      } else if (
        strictLegacyNamespace &&
        Number(counterRaw) !== row.remaining_quantity
      ) {
        bump('valkey_legacy_counter_remaining_mismatch');
      }
    }

    lastLegacyEventId = page.rows[page.rows.length - 1].event_id;
    if (page.rows.length < pageSize) {
      break;
    }
  }

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
  checkPhase: CutoverCheckPhase;
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
  assertCheckPhase(input.checkPhase, 'checkPhase');
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
    checkPhase: input.checkPhase,
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
  const checkPhase = assertCheckPhase(candidate.checkPhase, 'checkPhase');
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
  // opensearchReport は ReconciliationReport の必須フィールドすべてを存在・型・整合性まで
  // 検証する（fail closed）。totalDiffs と index だけの不完全な report を受理しない。
  const report = parseReconciliationReport(candidate.opensearchReport);
  const projectionResult = results.find(
    (result) => result.category === 'opensearch_projection_diff',
  );
  if (projectionResult?.violationCount !== report.totalDiffs) {
    throw new Error(
      'cutover evidence opensearch category does not match opensearchReport.totalDiffs',
    );
  }
  if (report.index !== candidate.opensearchIndex) {
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
    checkPhase,
    writerMode,
    schemaRevision: candidate.schemaRevision,
    opensearchIndex: candidate.opensearchIndex,
    results,
    categoryCount: results.length,
    opensearchReport: report,
    complete: true,
  };
}

// parseReconciliationReport は #377 の ReconciliationReport を fail closed に検証します。
// - counts は RECONCILIATION_CATEGORIES と 1:1（欠落・追加を許さない）で、各値は
//   非負の safe integer。
// - totalDiffs は counts の合計と一致し、hasDiff は totalDiffs > 0 と一致する。
// - findings は bounded なサンプル配列で、各 entry は eventId / category（既知の
//   category のみ）/ 任意の ticketTypeId を持つ。
function parseReconciliationReport(value: unknown): ReconciliationReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('cutover evidence opensearchReport must be an object');
  }
  const record = value as Record<string, unknown>;

  if (typeof record.index !== 'string' || record.index.length === 0) {
    throw new Error('cutover evidence opensearchReport.index is missing or empty');
  }
  const requireCount = (field: 'checkedEvents' | 'checkedDocuments' | 'totalDiffs'): number => {
    const raw = record[field];
    if (
      typeof raw !== 'number' ||
      !Number.isSafeInteger(raw) ||
      raw < 0
    ) {
      throw new Error(`cutover evidence opensearchReport.${field} is invalid`);
    }
    return raw;
  };
  const checkedEvents = requireCount('checkedEvents');
  const checkedDocuments = requireCount('checkedDocuments');
  const totalDiffs = requireCount('totalDiffs');

  const rawCounts = record.counts;
  if (
    typeof rawCounts !== 'object' ||
    rawCounts === null ||
    Array.isArray(rawCounts)
  ) {
    throw new Error('cutover evidence opensearchReport.counts must be an object');
  }
  const countsRecord = rawCounts as Record<string, unknown>;
  const knownCategories = new Set<string>(RECONCILIATION_CATEGORIES);
  for (const key of Object.keys(countsRecord)) {
    if (!knownCategories.has(key)) {
      throw new Error(
        `cutover evidence opensearchReport.counts has unexpected category: ${key}`,
      );
    }
  }
  const counts = {} as Record<ReconciliationCategory, number>;
  let countsSum = 0;
  for (const category of RECONCILIATION_CATEGORIES) {
    const raw = countsRecord[category];
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
      throw new Error(
        `cutover evidence opensearchReport.counts.${category} is missing or invalid`,
      );
    }
    counts[category] = raw;
    countsSum += raw;
  }
  if (countsSum !== totalDiffs) {
    throw new Error(
      'cutover evidence opensearchReport.totalDiffs does not equal the sum of counts',
    );
  }

  if (!Array.isArray(record.findings)) {
    throw new Error('cutover evidence opensearchReport.findings must be an array');
  }
  const findings = record.findings.map((entry): ReconciliationFinding => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(
        'cutover evidence opensearchReport.findings entries must be objects',
      );
    }
    const finding = entry as Record<string, unknown>;
    if (typeof finding.eventId !== 'string' || finding.eventId.length === 0) {
      throw new Error(
        'cutover evidence opensearchReport finding eventId is missing or empty',
      );
    }
    if (
      typeof finding.category !== 'string' ||
      !knownCategories.has(finding.category)
    ) {
      throw new Error(
        `cutover evidence opensearchReport finding category is invalid: ${String(finding.category)}`,
      );
    }
    if (
      finding.ticketTypeId !== undefined &&
      (typeof finding.ticketTypeId !== 'string' || finding.ticketTypeId.length === 0)
    ) {
      throw new Error(
        'cutover evidence opensearchReport finding ticketTypeId is invalid',
      );
    }
    return {
      eventId: finding.eventId,
      category: finding.category as ReconciliationCategory,
      ...(finding.ticketTypeId !== undefined
        ? { ticketTypeId: finding.ticketTypeId as string }
        : {}),
    };
  });

  if (typeof record.hasDiff !== 'boolean' || record.hasDiff !== totalDiffs > 0) {
    throw new Error(
      'cutover evidence opensearchReport.hasDiff does not match totalDiffs',
    );
  }

  return {
    index: record.index,
    checkedEvents,
    checkedDocuments,
    counts,
    totalDiffs,
    findings,
    hasDiff: record.hasDiff,
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
