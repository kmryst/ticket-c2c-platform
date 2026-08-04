// ファイル概要:
// このファイルは検索 projection の手動修復 service です（Issue #377 / ADR-0031 / PR #396）。
// reconciliation が検出する「rebuild では収束しない」2 系統の差分を、operator の明示操作で
// 収束させる復旧経路を提供します。
//
// 対象:
// - unexpected_event_document: OpenSearch 側にあって正本（events / ticket_inventory）に無い
//   document の個別削除（orphan document）。
// - unexpected_ticket_type: document 自体は正当で、対象 event の正本 Type 集合に属さない
//   Type 要素だけが余剰な場合の該当要素の個別除去。帰属判定は reconciliation と同じく
//   (event_id, ticket_type_id) の複合で行う（別 event に正当に存在する Type の誤混入も対象）。
// - contract_corruption: projection の version が正本と一致しているのに値（total / remaining /
//   name）が異なる真の破損の、正本値による上書き修復。version guard script
//   （INVENTORY_VERSION_GUARD_SCRIPT）は同一 version・値相違を throw で拒否するため、
//   rebuild ではこの状態は収束せず毎回失敗する。修復は guard を経由しない専用 script で行う。
//
// 安全制約（設計上の不変条件）:
// - 完全一致 ID 指定のみ。query 駆動の一括削除・一括修復（delete_by_query 等）は行わない。
// - dry-run 既定。apply=true を明示しない限り OpenSearch へ書き込まない。
// - 書き込み前に必ず PostgreSQL（正本）の現在値を再確認する（reconciliation snapshot の
//   stale 判断を避ける）。正本の状態が前提と食い違う場合は refuse して何も書かない。
// - contract corruption 修復 script は「stored version == 正本 version かつ値相違」の場合だけ
//   上書きする（script 内で atomic に再判定する）。より新しい version は決して巻き戻さない。
//   version guard の「通常書き込み経路では同一 version の値変更を拒否する」保証は変更しない。
// - PostgreSQL へは書き込まない（逆同期しない。read-only 確認のみ）。
// - AWS 上では DB / OpenSearch 双方へ接続できる既存 API artifact の command override から
//   実行する（SigV4 は createOpenSearchClient が担う）。自動実行しない。

import type { Client } from '@opensearch-project/opensearch';
import { POSTGRES_INT4_MAX } from '../common/validation-primitives';
import { EVENTS_INDEX } from './events-projection.store';
import {
  beginReadOnlySnapshot,
  endReadOnlySnapshot,
  readAuthoritativeEventInventory,
  SqlClient,
} from './inventory-projection-source';

// RepairMode は修復 CLI が受け付ける操作の有限集合です。
export type RepairMode =
  | 'delete-document'
  | 'delete-ticket-type'
  | 'repair-corruption';

// RepairRefusalReason は「安全チェックにより書き込みを拒否した理由」の有限集合です。
// machine-readable な JSON 出力に載せる（secret を含めない）。
export type RepairRefusalReason =
  // 正本に該当 event が存在する（orphan ではない）。削除してはいけない。
  | 'event_exists_in_authoritative'
  // 正本上、対象 event に正当に属する ticket type（orphan ではない）。除去してはいけない。
  // 判定は (event_id, ticket_type_id) の複合。ticket_type_id 単体のグローバル存在確認では
  // ない（別 event に正当に存在する Type が対象 event の document へ誤混入したケースを
  // 除去できなくなるため。reconciliation の unexpected_ticket_type と同じ per-event 基準）。
  | 'ticket_type_exists_in_authoritative'
  // orphan ticket type 除去は「document 自体は正当」が前提。event が正本に無いなら
  // delete-document で document ごと扱う。
  | 'event_missing_in_authoritative'
  // OpenSearch 側に対象 document が存在しない（修復対象なし）。
  | 'document_not_found'
  // document は存在するが対象 Type 要素が無い（修復対象なし）。
  | 'ticket_type_not_in_document'
  // 同一 version・値相違（contract corruption）が検出されない。version 遅延による差分は
  // rebuild で収束させる（この CLI の対象外）。
  | 'no_contract_corruption_detected'
  // projection 側の値が数値として読めない等、修復以前に調査が必要な壊れ方をしている。
  | 'malformed_projection_detected';

// CorruptionDiffEntry は contract corruption 修復の field 単位 diff です。
// apply 前に operator が確認する事前 diff として dry-run でも同じ形で出力する。
export interface CorruptionDiffEntry {
  scope: 'ticket_type' | 'event_aggregate';
  ticketTypeId?: string;
  field: 'name' | 'total_quantity' | 'remaining_quantity';
  // version は「正本と projection で一致していることを確認済みの version」。
  version: number;
  projectionValue: string | number | null;
  authoritativeValue: string | number;
}

// RepairReport は修復操作 1 回の machine-readable な結果です。
export interface RepairReport {
  mode: RepairMode;
  index: string;
  eventId: string;
  ticketTypeId?: string;
  // apply=false は dry-run（書き込みなし）。
  apply: boolean;
  // 安全チェックの結果。1 件でもあれば書き込まない。
  refusals: RepairRefusalReason[];
  // contract corruption 修復の事前 diff（他 mode では空配列）。
  diff: CorruptionDiffEntry[];
  // 実際に OpenSearch へ書き込んだか（dry-run / refuse 時は false）。
  applied: boolean;
}

export interface RepairTarget {
  index?: string;
  eventId: string;
  ticketTypeId?: string;
  apply?: boolean;
}

// REMOVE_TICKET_TYPE_SCRIPT は完全一致 ticket_type_id の nested 要素だけを除去します。
// 何も除去しなかった場合は noop（並行する正当な書き込みへ余計な version bump をしない）。
export const REMOVE_TICKET_TYPE_SCRIPT = `
boolean removed = false;
if (ctx._source.ticket_types != null) {
  int before = ctx._source.ticket_types.size();
  ctx._source.ticket_types.removeIf(t -> t.ticket_type_id == params.ticketTypeId);
  removed = ctx._source.ticket_types.size() != before;
}
if (!removed) { ctx.op = 'noop'; }
`.trim();

// REPAIR_CONTRACT_CORRUPTION_SCRIPT は contract corruption（同一 version・値相違）だけを
// 正本値で上書きする専用 script です。version guard script とは意図的に分離する:
// guard は「通常書き込み経路で同一 version の値変更を拒否する」保証を持ち続け、
// この script は operator CLI からのみ、次の条件を script 内で atomic に再判定して上書きする。
// - stored version == 正本 version（読み取り時から version が進んだ場合は上書きしない）
// - かつ値（total / remaining / name）が相違（相違が無ければ noop）
// より新しい version（stored > 正本）は決して巻き戻さない。version 自体は変更しない。
export const REPAIR_CONTRACT_CORRUPTION_SCRIPT = `
long asLong(def v) { return ((Number) v).longValue(); }

boolean changed = false;

if (ctx._source.ticket_types != null) {
  for (def a : params.ticketTypes) {
    for (def t : ctx._source.ticket_types) {
      if (t.ticket_type_id == a.ticketTypeId
          && t.inventory_version != null
          && asLong(t.inventory_version) == asLong(a.inventoryVersion)) {
        if (asLong(t.total_quantity) != asLong(a.totalQuantity)
            || asLong(t.remaining_quantity) != asLong(a.remainingQuantity)
            || t.name != a.name) {
          t.name = a.name;
          t.total_quantity = a.totalQuantity;
          t.remaining_quantity = a.remainingQuantity;
          changed = true;
        }
      }
    }
  }
}

if (ctx._source.event_inventory_version != null
    && asLong(ctx._source.event_inventory_version) == asLong(params.eventInventoryVersion)) {
  if (asLong(ctx._source.event_total_quantity) != asLong(params.eventTotalQuantity)
      || asLong(ctx._source.event_remaining_quantity) != asLong(params.eventRemainingQuantity)) {
    ctx._source.event_total_quantity = params.eventTotalQuantity;
    ctx._source.event_remaining_quantity = params.eventRemainingQuantity;
    ctx._source.total_quantity = params.eventTotalQuantity;
    ctx._source.remaining_quantity = params.eventRemainingQuantity;
    changed = true;
  }
}

if (!changed) { ctx.op = 'noop'; }
`.trim();

// deleteOrphanDocument は正本に存在しない event の projection document を個別削除します。
// 正本（events / ticket_inventory）のどちらかに 1 行でも存在すれば refuse して何もしない。
export async function deleteOrphanDocument(
  sql: SqlClient,
  opensearch: Client,
  target: RepairTarget,
): Promise<RepairReport> {
  const index = target.index ?? EVENTS_INDEX;
  const apply = target.apply ?? false;
  const report = emptyReport('delete-document', index, target.eventId, apply);

  // 書き込み直前に正本の現在値を再確認する（reconciliation snapshot を信用しない）。
  if (await existsInAuthoritative(sql, target.eventId)) {
    report.refusals.push('event_exists_in_authoritative');
  }
  const docExists = await documentExists(opensearch, index, target.eventId);
  if (!docExists) {
    report.refusals.push('document_not_found');
  }
  if (report.refusals.length > 0 || !apply) {
    return report;
  }

  // 完全一致 _id の個別削除のみ（query 駆動の一括削除はしない）。
  await opensearch.delete({ index, id: target.eventId, refresh: true });
  report.applied = true;
  return report;
}

// deleteOrphanTicketType は正本に存在しない Ticket Type の nested 要素だけを除去します。
// event 自体が正本に無い場合は refuse（delete-document で document ごと扱う）。
export async function deleteOrphanTicketType(
  sql: SqlClient,
  opensearch: Client,
  target: RepairTarget,
): Promise<RepairReport> {
  const index = target.index ?? EVENTS_INDEX;
  const apply = target.apply ?? false;
  const ticketTypeId = target.ticketTypeId as string;
  const report = emptyReport('delete-ticket-type', index, target.eventId, apply);
  report.ticketTypeId = ticketTypeId;

  if (!(await existsInAuthoritative(sql, target.eventId))) {
    report.refusals.push('event_missing_in_authoritative');
  }
  if (
    await ticketTypeBelongsToEventInAuthoritative(sql, target.eventId, ticketTypeId)
  ) {
    report.refusals.push('ticket_type_exists_in_authoritative');
  }
  const doc = await getProjectionDoc(opensearch, index, target.eventId);
  if (!doc) {
    report.refusals.push('document_not_found');
  } else if (!documentContainsTicketType(doc, ticketTypeId)) {
    report.refusals.push('ticket_type_not_in_document');
  }
  if (report.refusals.length > 0 || !apply) {
    return report;
  }

  const response = await opensearch.update({
    index,
    id: target.eventId,
    body: {
      script: {
        lang: 'painless',
        source: REMOVE_TICKET_TYPE_SCRIPT,
        params: { ticketTypeId },
      },
    },
    refresh: true,
  });
  // script が ctx.op = 'noop' で終わった場合（事前確認後に並行書き込みで対象要素が消えた等）
  // は実際には何も書き込んでいないため、applied を true と報告しない。
  report.applied = updateWasApplied(response);
  return report;
}

// repairContractCorruption は同一 version・値相違（contract corruption）を正本値で修復します。
// - PostgreSQL の現在値（REPEATABLE READ READ ONLY snapshot）を読み、projection と field 単位で
//   突き合わせて事前 diff を作る。version が一致し値が相違する field だけが対象。
// - diff が空（corruption なし。version 遅延だけ）なら refuse する（rebuild で収束させる）。
// - apply 時は専用 script が同じ条件を atomic に再判定して上書きする（読み取り後に version が
//   進んだ Type / Event 集計は上書きされない）。
export async function repairContractCorruption(
  sql: SqlClient,
  opensearch: Client,
  target: RepairTarget,
): Promise<RepairReport> {
  const index = target.index ?? EVENTS_INDEX;
  const apply = target.apply ?? false;
  const report = emptyReport('repair-corruption', index, target.eventId, apply);

  await beginReadOnlySnapshot(sql);
  let authoritative;
  try {
    authoritative = await readAuthoritativeEventInventory(sql, target.eventId);
  } finally {
    await endReadOnlySnapshot(sql);
  }
  if (!authoritative) {
    // 正本に event が無いなら corruption 修復の対象外（orphan は delete-document で扱う）。
    report.refusals.push('event_missing_in_authoritative');
    return report;
  }

  const doc = await getProjectionDoc(opensearch, index, target.eventId);
  if (!doc) {
    report.refusals.push('document_not_found');
    return report;
  }

  // 事前 diff の計算。version が一致していて値が相違する field だけを対象にする。
  let malformed = false;

  const eventVersion = asVersionOrNull(doc.event_inventory_version);
  if (eventVersion !== null && eventVersion === authoritative.eventInventoryVersion) {
    const docTotal = asQuantityOrNull(doc.event_total_quantity);
    const docRemaining = asQuantityOrNull(doc.event_remaining_quantity);
    if (docTotal === null || docRemaining === null) {
      malformed = true;
    } else {
      if (docTotal !== authoritative.eventTotalQuantity) {
        report.diff.push({
          scope: 'event_aggregate',
          field: 'total_quantity',
          version: eventVersion,
          projectionValue: docTotal,
          authoritativeValue: authoritative.eventTotalQuantity,
        });
      }
      if (docRemaining !== authoritative.eventRemainingQuantity) {
        report.diff.push({
          scope: 'event_aggregate',
          field: 'remaining_quantity',
          version: eventVersion,
          projectionValue: docRemaining,
          authoritativeValue: authoritative.eventRemainingQuantity,
        });
      }
    }
  }

  const docTypes = Array.isArray(doc.ticket_types)
    ? (doc.ticket_types as Array<Record<string, unknown>>)
    : [];
  for (const at of authoritative.ticketTypes) {
    const dt = docTypes.find(
      (t) => t != null && typeof t === 'object' && t.ticket_type_id === at.ticketTypeId,
    );
    if (!dt) continue;
    const dtVersion = asVersionOrNull(dt.inventory_version);
    if (dtVersion === null || dtVersion !== at.inventoryVersion) continue;
    const dtTotal = asQuantityOrNull(dt.total_quantity);
    const dtRemaining = asQuantityOrNull(dt.remaining_quantity);
    if (dtTotal === null || dtRemaining === null) {
      malformed = true;
      continue;
    }
    if (dtTotal !== at.totalQuantity) {
      report.diff.push({
        scope: 'ticket_type',
        ticketTypeId: at.ticketTypeId,
        field: 'total_quantity',
        version: dtVersion,
        projectionValue: dtTotal,
        authoritativeValue: at.totalQuantity,
      });
    }
    if (dtRemaining !== at.remainingQuantity) {
      report.diff.push({
        scope: 'ticket_type',
        ticketTypeId: at.ticketTypeId,
        field: 'remaining_quantity',
        version: dtVersion,
        projectionValue: dtRemaining,
        authoritativeValue: at.remainingQuantity,
      });
    }
    if (dt.name !== at.name) {
      report.diff.push({
        scope: 'ticket_type',
        ticketTypeId: at.ticketTypeId,
        field: 'name',
        version: dtVersion,
        projectionValue: typeof dt.name === 'string' ? dt.name : null,
        authoritativeValue: at.name,
      });
    }
  }

  if (malformed) {
    // 数値として読めない等の壊れ方は上書き修復の前に調査する（malformed_projection の領分）。
    report.refusals.push('malformed_projection_detected');
  }
  if (report.diff.length === 0) {
    // 同一 version・値相違が無い。version 遅延による差分は rebuild で収束させる。
    report.refusals.push('no_contract_corruption_detected');
  }
  if (report.refusals.length > 0 || !apply) {
    return report;
  }

  const response = await opensearch.update({
    index,
    id: target.eventId,
    body: {
      script: {
        lang: 'painless',
        source: REPAIR_CONTRACT_CORRUPTION_SCRIPT,
        params: {
          ticketTypes: authoritative.ticketTypes.map((t) => ({
            ticketTypeId: t.ticketTypeId,
            name: t.name,
            totalQuantity: t.totalQuantity,
            remainingQuantity: t.remainingQuantity,
            inventoryVersion: t.inventoryVersion,
          })),
          eventTotalQuantity: authoritative.eventTotalQuantity,
          eventRemainingQuantity: authoritative.eventRemainingQuantity,
          eventInventoryVersion: authoritative.eventInventoryVersion,
        },
      },
    },
    refresh: true,
  });
  // script の atomic 再判定が全条件不成立で noop になった場合（読み取り後に version が進んだ等）
  // は上書きしていないため、applied を true と報告しない。
  report.applied = updateWasApplied(response);
  return report;
}

// updateWasApplied は OpenSearch update API の result から「実際に書き込んだか」を判定します。
// Painless script が ctx.op = 'noop' で終わると result は 'noop' になり、書き込みは発生して
// いない。想定外の result も「書き込んだ」とは主張しない（fail-closed な報告）。
export function updateWasApplied(response: {
  body?: { result?: unknown };
}): boolean {
  return response.body?.result === 'updated';
}

function emptyReport(
  mode: RepairMode,
  index: string,
  eventId: string,
  apply: boolean,
): RepairReport {
  return { mode, index, eventId, apply, refusals: [], diff: [], applied: false };
}

// existsInAuthoritative は正本（events / ticket_inventory）に event が存在するかを確認します。
// どちらかに 1 行でもあれば「正本に存在する」と保守的に判定する（誤削除を避ける方向へ倒す）。
async function existsInAuthoritative(
  sql: SqlClient,
  eventId: string,
): Promise<boolean> {
  const events = await sql.query<{ one: number }>(
    'SELECT 1 AS one FROM events WHERE id = $1::uuid',
    [eventId],
  );
  if (events.rows.length > 0) return true;
  const inventory = await sql.query<{ one: number }>(
    'SELECT 1 AS one FROM ticket_inventory WHERE event_id = $1::uuid',
    [eventId],
  );
  return inventory.rows.length > 0;
}

// ticketTypeBelongsToEventInAuthoritative は「ticket type が対象 event に正当に属しているか」を
// 正本（ticket_types / ticket_type_inventory）の (event_id, ticket_type_id) 複合で確認します。
// reconciliation の unexpected_ticket_type 判定（対象 event の authoritative Type 集合に対する
// per-event membership）と同じ基準に揃える: ticket_type_id 単体のグローバル存在確認にすると、
// 「別 event に正当に存在する Type が対象 event の document へ誤混入した」ケースを
// 検出できても除去できず、差分 0 へ収束しなくなる。
// 対象 event への帰属がどちらかの table に 1 行でもあれば「属している」と保守的に判定する
//（誤除去を避ける方向へ倒す）。
async function ticketTypeBelongsToEventInAuthoritative(
  sql: SqlClient,
  eventId: string,
  ticketTypeId: string,
): Promise<boolean> {
  const types = await sql.query<{ one: number }>(
    'SELECT 1 AS one FROM ticket_types WHERE event_id = $1::uuid AND id = $2::uuid',
    [eventId, ticketTypeId],
  );
  if (types.rows.length > 0) return true;
  const inventory = await sql.query<{ one: number }>(
    'SELECT 1 AS one FROM ticket_type_inventory WHERE event_id = $1::uuid AND ticket_type_id = $2::uuid',
    [eventId, ticketTypeId],
  );
  return inventory.rows.length > 0;
}

async function documentExists(
  opensearch: Client,
  index: string,
  eventId: string,
): Promise<boolean> {
  const response = await opensearch.exists({ index, id: eventId });
  return Boolean(response.body);
}

async function getProjectionDoc(
  opensearch: Client,
  index: string,
  eventId: string,
): Promise<Record<string, unknown> | null> {
  const response = await opensearch.mget({ index, body: { ids: [eventId] } });
  const docs = (response.body?.docs ?? []) as Array<{
    found?: boolean;
    _source?: Record<string, unknown>;
  }>;
  const doc = docs[0];
  return doc?.found && doc._source ? doc._source : null;
}

function documentContainsTicketType(
  doc: Record<string, unknown>,
  ticketTypeId: string,
): boolean {
  if (!Array.isArray(doc.ticket_types)) return false;
  return (doc.ticket_types as Array<Record<string, unknown>>).some(
    (t) => t != null && typeof t === 'object' && t.ticket_type_id === ticketTypeId,
  );
}

// asQuantityOrNull / asVersionOrNull は reconciliation と同じ境界チェックです
// （quantity は int4 範囲、version は safe integer 範囲）。範囲外は malformed として扱う。
function asQuantityOrNull(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= POSTGRES_INT4_MAX
    ? value
    : null;
}

function asVersionOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}
