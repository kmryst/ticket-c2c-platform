// ファイル概要:
// このファイルは Aurora PostgreSQL（正本）と OpenSearch（projection）の差分を検出する
// read-only reconciliation service です（Issue #377 / ADR-0031）。
// PostgreSQL も OpenSearch も変更しません。#378 の Gate B checker から再利用できる
// service / CLI interface を提供します。
//
// cross-store snapshot は原子的ではないため、Gate B では queue drain 後に実行し、
// 必要なら再実行します（runbook 参照）。

import type { Client } from '@opensearch-project/opensearch';
import { EVENTS_INDEX } from './events-projection.store';
import {
  AuthoritativeEventInventory,
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
  // legacy / metadata document 判定に使う top-level field（review 2）。
  remaining_quantity?: unknown;
  title?: unknown;
  event_type?: unknown;
  starts_at?: unknown;
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
  const docEventVersion = asIntOrNull(doc.event_inventory_version);
  const docEventTotal = asIntOrNull(doc.event_total_quantity);
  const docEventRemaining = asIntOrNull(doc.event_remaining_quantity);

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
    const legacyRemaining = asIntOrNull(doc.remaining_quantity);
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
  if (docEventTotal !== authoritative.eventTotalQuantity) {
    record(eventId, 'event_total_mismatch');
  }
  if (docEventRemaining !== authoritative.eventRemainingQuantity) {
    record(eventId, 'event_remaining_mismatch');
  }
  if (docEventVersion !== authoritative.eventInventoryVersion) {
    record(eventId, 'event_version_mismatch');
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
    const dtTotal = asIntOrNull((dt as { total_quantity?: unknown }).total_quantity);
    const dtRemaining = asIntOrNull(
      (dt as { remaining_quantity?: unknown }).remaining_quantity,
    );
    const dtVersion = asIntOrNull(
      (dt as { inventory_version?: unknown }).inventory_version,
    );
    if (dtTotal === null || dtRemaining === null || dtVersion === null) {
      record(eventId, 'malformed_projection', at.ticketTypeId);
      continue;
    }
    if (dtTotal !== at.totalQuantity) {
      record(eventId, 'ticket_type_total_mismatch', at.ticketTypeId);
    }
    if (dtRemaining !== at.remainingQuantity) {
      record(eventId, 'ticket_type_remaining_mismatch', at.ticketTypeId);
    }
    if (dtVersion !== at.inventoryVersion) {
      record(eventId, 'ticket_type_version_mismatch', at.ticketTypeId);
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

function asIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
