// ファイル概要:
// このファイルは Aurora PostgreSQL（正本）と OpenSearch（projection）の差分を検出する
// read-only reconciliation service です（Issue #377 / ADR-0031）。
// PostgreSQL も OpenSearch も変更しません。#378 の Gate B checker から再利用できる
// service / CLI interface を提供します。
//
// cross-store snapshot は原子的ではないため、Gate B では queue drain 後に実行し、
// 必要なら再実行します（runbook 参照）。

import type { Client } from '@opensearch-project/opensearch';
import { POSTGRES_INT4_MAX } from '../common/validation-primitives';
import { EVENTS_INDEX } from './events-projection.store';
import {
  AuthoritativeEventInventory,
  AuthoritativeEventMetadata,
  beginReadOnlySnapshot,
  DEFAULT_PAGE_SIZE,
  endReadOnlySnapshot,
  iterateAuthoritativeInventory,
  SqlClient,
} from './inventory-projection-source';

// ReconciliationCategory は検出する差分カテゴリの有限集合です。
//
// review 2: EventListed だけが反映された未購入の正常な legacy/metadata document を
// malformed 扱いしないため、`unversioned_projection` を追加する。versioned inventory field が
// すべて未作成で legacy/metadata document として妥当なものは unversioned（rebuild で収束させる）。
// versioned field が部分的に壊れている・legacy document としても成立しないものは malformed。
//
// `contract_corruption` は「projection の version が正本と一致しているのに値（total /
// remaining / name）が異なる」状態を指す。単に projection の version が遅れているための
// 値差分（cross-store snapshot が非原子的なための許容される一時的なズレ）とは意味が異なり、
// 書き込みパスの version guard script が本来防ぐべき真の破損シグナルである。
// runbook の停止条件（rebuild / activation を止めて調査）はこのカテゴリと対応する。
//
// `metadata_mismatch` は events table（正本）の title / event_type / starts_at / location と
// projection の対応 field の不一致（欠損を含む）を指す。rebuild が metadata も復元するため、
// rebuild 後の検証で metadata 欠損を見逃さない。
export type ReconciliationCategory =
  | 'missing_event_document'
  | 'unexpected_event_document'
  | 'missing_ticket_type'
  | 'unexpected_ticket_type'
  | 'ticket_type_total_mismatch'
  | 'ticket_type_remaining_mismatch'
  | 'ticket_type_version_mismatch'
  | 'event_total_mismatch'
  | 'event_remaining_mismatch'
  | 'event_version_mismatch'
  | 'metadata_mismatch'
  | 'contract_corruption'
  | 'unversioned_projection'
  | 'malformed_projection';

const ALL_CATEGORIES: ReconciliationCategory[] = [
  'missing_event_document',
  'unexpected_event_document',
  'missing_ticket_type',
  'unexpected_ticket_type',
  'ticket_type_total_mismatch',
  'ticket_type_remaining_mismatch',
  'ticket_type_version_mismatch',
  'event_total_mismatch',
  'event_remaining_mismatch',
  'event_version_mismatch',
  'metadata_mismatch',
  'contract_corruption',
  'unversioned_projection',
  'malformed_projection',
];

// ReconciliationFinding は差分 1 件のサンプルです（machine-readable。secret を含めない）。
export interface ReconciliationFinding {
  eventId: string;
  category: ReconciliationCategory;
  ticketTypeId?: string;
}

// ReconciliationReport は reconciliation 結果です（machine-readable JSON）。
export interface ReconciliationReport {
  index: string;
  checkedEvents: number;
  checkedDocuments: number;
  counts: Record<ReconciliationCategory, number>;
  totalDiffs: number;
  // findings は bounded なサンプル（全件は載せない）。
  findings: ReconciliationFinding[];
  hasDiff: boolean;
}

export interface ReconciliationOptions {
  index?: string;
  pageSize?: number;
  // maxFindings は findings 配列の上限（bounded memory）。
  maxFindings?: number;
}

interface RawProjectionDoc {
  event_id?: unknown;
  event_total_quantity?: unknown;
  event_remaining_quantity?: unknown;
  event_inventory_version?: unknown;
  ticket_types?: unknown;
  // legacy / metadata document 判定と metadata 比較に使う top-level field。
  remaining_quantity?: unknown;
  title?: unknown;
  event_type?: unknown;
  starts_at?: unknown;
  location?: unknown;
}

// reconcileInventoryProjection は正本と projection を比較し、差分レポートを返します。
// PostgreSQL は REPEATABLE READ READ ONLY、OpenSearch は read-only（search / mget）だけを使います。
export async function reconcileInventoryProjection(
  sql: SqlClient,
  opensearch: Client,
  options: ReconciliationOptions = {},
): Promise<ReconciliationReport> {
  const index = options.index ?? EVENTS_INDEX;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxFindings = options.maxFindings ?? 100;

  const counts = emptyCounts();
  const findings: ReconciliationFinding[] = [];
  let checkedEvents = 0;
  let checkedDocuments = 0;

  const record = (
    eventId: string,
    category: ReconciliationCategory,
    ticketTypeId?: string,
  ): void => {
    counts[category] += 1;
    if (findings.length < maxFindings) {
      findings.push({ eventId, category, ...(ticketTypeId ? { ticketTypeId } : {}) });
    }
  };

  await beginReadOnlySnapshot(sql);
  try {
    // Pass 1: 正本 event ごとに projection を突き合わせる（missing / mismatch を検出）。
    // ページ単位に authoritative snapshot を集め、まとめて mget する（bounded）。
    let page: AuthoritativeEventInventory[] = [];
    const flush = async (): Promise<void> => {
      if (page.length === 0) return;
      const docs = await mgetDocuments(
        opensearch,
        index,
        page.map((e) => e.eventId),
      );
      for (const authoritative of page) {
        checkedEvents += 1;
        const doc = docs.get(authoritative.eventId);
        if (!doc) {
          record(authoritative.eventId, 'missing_event_document');
          continue;
        }
        checkedDocuments += 1;
        compareEvent(authoritative, doc, record);
      }
      page = [];
    };

    for await (const authoritative of iterateAuthoritativeInventory(sql, pageSize)) {
      page.push(authoritative);
      if (page.length >= pageSize) {
        await flush();
      }
    }
    await flush();

    // Pass 2: projection にあって正本に無い document / ticket type（unexpected）を検出する。
    await detectUnexpected(sql, opensearch, index, pageSize, record);
  } finally {
    await endReadOnlySnapshot(sql);
  }

  const totalDiffs = ALL_CATEGORIES.reduce((sum, c) => sum + counts[c], 0);
  return {
    index,
    checkedEvents,
    checkedDocuments,
    counts,
    totalDiffs,
    findings,
    hasDiff: totalDiffs > 0,
  };
}

function compareEvent(
  authoritative: AuthoritativeEventInventory,
  doc: RawProjectionDoc,
  record: (
    eventId: string,
    category: ReconciliationCategory,
    ticketTypeId?: string,
  ) => void,
): void {
  const eventId = authoritative.eventId;

  // Event 集計の比較（version / total / remaining）。projection 側が malformed なら別カテゴリ。
  // quantity は int4 範囲、version は long 範囲（OpenSearch mapping）で個別に境界チェックする。
  const docEventVersion = asVersionOrNull(doc.event_inventory_version);
  const docEventTotal = asQuantityOrNull(doc.event_total_quantity);
  const docEventRemaining = asQuantityOrNull(doc.event_remaining_quantity);

  // review 2: versioned inventory field がすべて未作成かを判定する。
  // EventListed だけが反映された購入前の document（InventoryChanged 未着）は versioned field を
  // 持たない。これを malformed としないため、unversioned / malformed を明確に切り分ける。
  const ticketTypesIsArray = Array.isArray(doc.ticket_types);
  const ticketTypesEmpty =
    doc.ticket_types == null ||
    (ticketTypesIsArray && (doc.ticket_types as unknown[]).length === 0);
  const allVersionedAbsent =
    doc.event_inventory_version == null &&
    doc.event_total_quantity == null &&
    doc.event_remaining_quantity == null &&
    ticketTypesEmpty;

  if (allVersionedAbsent) {
    // versioned field が全て未作成。legacy top-level 残数か metadata を持つ妥当な
    // legacy/metadata document なら unversioned（compatibility 期間に発生し得る。rebuild で収束）。
    // event_id だけのように legacy document としても成立しないものは malformed。
    const legacyRemaining = asQuantityOrNull(doc.remaining_quantity);
    const hasMetadata =
      typeof doc.title === 'string' ||
      typeof doc.event_type === 'string' ||
      typeof doc.starts_at === 'string';
    if (legacyRemaining !== null || hasMetadata) {
      record(eventId, 'unversioned_projection');
    } else {
      record(eventId, 'malformed_projection');
    }
    return;
  }

  // versioned field が一部でも存在する。完全に妥当な versioned document でなければ malformed。
  if (
    docEventVersion === null ||
    docEventTotal === null ||
    docEventRemaining === null ||
    !ticketTypesIsArray
  ) {
    record(eventId, 'malformed_projection');
    return;
  }
  if (docEventVersion === authoritative.eventInventoryVersion) {
    // version が正本と一致しているのに値が異なるのは、version guard script が本来防ぐべき
    // 真の破損（contract corruption）。通常の version 遅延による値差分と区別して記録する。
    if (
      docEventTotal !== authoritative.eventTotalQuantity ||
      docEventRemaining !== authoritative.eventRemainingQuantity
    ) {
      record(eventId, 'contract_corruption');
    }
  } else {
    // version が異なる場合の値差分は、cross-store snapshot が非原子的なための
    // 許容される一時的なズレ（ファイル冒頭コメント参照）。従来カテゴリで記録する。
    record(eventId, 'event_version_mismatch');
    if (docEventTotal !== authoritative.eventTotalQuantity) {
      record(eventId, 'event_total_mismatch');
    }
    if (docEventRemaining !== authoritative.eventRemainingQuantity) {
      record(eventId, 'event_remaining_mismatch');
    }
  }

  // metadata の比較（title / event_type / starts_at / location）。events table が正本であり、
  // rebuild も metadata を復元するため、欠損・不一致は metadata_mismatch として検知する。
  if (!metadataMatches(authoritative.metadata, doc)) {
    record(eventId, 'metadata_mismatch');
  }

  // Ticket Type の比較。
  const docTypes = new Map<string, RawProjectionDoc>();
  for (const t of doc.ticket_types as unknown[]) {
    if (typeof t === 'object' && t !== null) {
      const tid = (t as { ticket_type_id?: unknown }).ticket_type_id;
      if (typeof tid === 'string') {
        docTypes.set(tid, t as RawProjectionDoc);
      } else {
        record(eventId, 'malformed_projection');
      }
    } else {
      record(eventId, 'malformed_projection');
    }
  }

  const authoritativeTypeIds = new Set<string>();
  for (const at of authoritative.ticketTypes) {
    authoritativeTypeIds.add(at.ticketTypeId);
    const dt = docTypes.get(at.ticketTypeId);
    if (!dt) {
      record(eventId, 'missing_ticket_type', at.ticketTypeId);
      continue;
    }
    const dtTotal = asQuantityOrNull(
      (dt as { total_quantity?: unknown }).total_quantity,
    );
    const dtRemaining = asQuantityOrNull(
      (dt as { remaining_quantity?: unknown }).remaining_quantity,
    );
    const dtVersion = asVersionOrNull(
      (dt as { inventory_version?: unknown }).inventory_version,
    );
    if (dtTotal === null || dtRemaining === null || dtVersion === null) {
      record(eventId, 'malformed_projection', at.ticketTypeId);
      continue;
    }
    if (dtVersion === at.inventoryVersion) {
      // 同一 version で total / remaining / name が異なるのは contract corruption
      //（version guard script の保証と同じ判定基準。name も含む）。
      const dtName = (dt as { name?: unknown }).name;
      if (
        dtTotal !== at.totalQuantity ||
        dtRemaining !== at.remainingQuantity ||
        dtName !== at.name
      ) {
        record(eventId, 'contract_corruption', at.ticketTypeId);
      }
    } else {
      record(eventId, 'ticket_type_version_mismatch', at.ticketTypeId);
      if (dtTotal !== at.totalQuantity) {
        record(eventId, 'ticket_type_total_mismatch', at.ticketTypeId);
      }
      if (dtRemaining !== at.remainingQuantity) {
        record(eventId, 'ticket_type_remaining_mismatch', at.ticketTypeId);
      }
    }
  }

  // projection にあって正本に無い Ticket Type は unexpected。
  for (const docTypeId of docTypes.keys()) {
    if (!authoritativeTypeIds.has(docTypeId)) {
      record(eventId, 'unexpected_ticket_type', docTypeId);
    }
  }
}

// detectUnexpected は projection を search_after で bounded にスキャンし、
// 正本 ticket_inventory に存在しない event document（unexpected）を検出します。
async function detectUnexpected(
  sql: SqlClient,
  opensearch: Client,
  index: string,
  pageSize: number,
  record: (eventId: string, category: ReconciliationCategory) => void,
): Promise<void> {
  const size = Math.max(1, Math.min(pageSize, 1000));
  let searchAfter: string[] | undefined;

  for (;;) {
    const response = await opensearch.search({
      index,
      body: {
        size,
        _source: ['event_id'],
        sort: [{ event_id: 'asc' }],
        query: { match_all: {} },
        ...(searchAfter ? { search_after: searchAfter } : {}),
      },
    });

    const hits = (response.body?.hits?.hits ?? []) as unknown as Array<{
      _id: string;
      _source?: { event_id?: unknown };
      sort?: string[];
    }>;
    if (hits.length === 0) {
      return;
    }

    const eventIds = hits
      .map((h) => (typeof h._source?.event_id === 'string' ? h._source.event_id : h._id))
      .filter((v): v is string => typeof v === 'string');

    // このページの event_id のうち、正本 ticket_inventory に存在するものを取得する。
    const present = await sql.query<{ event_id: string }>(
      `SELECT event_id FROM ticket_inventory WHERE event_id = ANY($1::uuid[])`,
      [eventIds],
    );
    const presentSet = new Set(present.rows.map((r) => r.event_id));
    for (const eventId of eventIds) {
      if (!presentSet.has(eventId)) {
        record(eventId, 'unexpected_event_document');
      }
    }

    const lastSort = hits[hits.length - 1].sort;
    if (!lastSort || hits.length < size) {
      return;
    }
    searchAfter = lastSort;
  }
}

async function mgetDocuments(
  opensearch: Client,
  index: string,
  eventIds: string[],
): Promise<Map<string, RawProjectionDoc>> {
  const result = new Map<string, RawProjectionDoc>();
  if (eventIds.length === 0) {
    return result;
  }
  const response = await opensearch.mget({
    index,
    body: { ids: eventIds },
  });
  const docs = (response.body?.docs ?? []) as Array<{
    _id: string;
    found: boolean;
    _source?: RawProjectionDoc;
  }>;
  for (const doc of docs) {
    if (doc.found && doc._source) {
      result.set(doc._id, doc._source);
    }
  }
  return result;
}

function emptyCounts(): Record<ReconciliationCategory, number> {
  const counts = {} as Record<ReconciliationCategory, number>;
  for (const category of ALL_CATEGORIES) {
    counts[category] = 0;
  }
  return counts;
}

// asQuantityOrNull は quantity 系 field（OpenSearch mapping: integer、正本: int4）の
// 境界チェック付き読み取りです。contract（isNonNegativeInt）と同じ「finite safe integer・
// 0 以上・int4 上限以内」を課し、範囲外（負数・int4 超過・非整数）は不正な projection として
// null を返します（呼び出し側で malformed_projection に分類される）。
function asQuantityOrNull(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= POSTGRES_INT4_MAX
    ? value
    : null;
}

// asVersionOrNull は version 系 field（OpenSearch mapping: long）の境界チェック付き
// 読み取りです。quantity と異なり上限は long 側（JS で正確に扱える safe integer 上限）で
// bound します。負数・非整数・safe integer 超過は不正な projection として null を返します。
function asVersionOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

// COORDINATE_TOLERANCE は location 比較の許容誤差です。正本は NUMERIC(9,6)（小数 6 桁）で
// 丸めるため、event payload 由来の高精度値と正本値の差は最大でも 5e-7。1e-6 未満なら同値とみなす。
const COORDINATE_TOLERANCE = 1e-6;

// metadataMatches は events table（正本）の metadata と projection の対応 field を比較します。
// starts_at は表記揺れ（timezone / ミリ秒表記）を吸収するため epoch ms で比較します。
function metadataMatches(
  authoritative: AuthoritativeEventMetadata,
  doc: RawProjectionDoc,
): boolean {
  if (doc.title !== authoritative.title) {
    return false;
  }
  if (doc.event_type !== authoritative.eventType) {
    return false;
  }
  if (
    typeof doc.starts_at !== 'string' ||
    Number.isNaN(Date.parse(doc.starts_at)) ||
    Date.parse(doc.starts_at) !== Date.parse(authoritative.startsAt)
  ) {
    return false;
  }
  const location = doc.location as { lat?: unknown; lon?: unknown } | null | undefined;
  if (authoritative.latitude === null || authoritative.longitude === null) {
    // 正本に location が無ければ projection にも無いこと（stale location を許容しない）。
    return location === null || location === undefined;
  }
  if (
    location === null ||
    location === undefined ||
    typeof location.lat !== 'number' ||
    typeof location.lon !== 'number'
  ) {
    return false;
  }
  return (
    Math.abs(location.lat - authoritative.latitude) < COORDINATE_TOLERANCE &&
    Math.abs(location.lon - authoritative.longitude) < COORDINATE_TOLERANCE
  );
}
