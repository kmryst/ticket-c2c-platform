// ファイル概要:
// このファイルは検索プロジェクションの OpenSearch 書き込み層です（Issue #377 / ADR-0031）。
// Worker と rebuild が共有する「atomic version guard 付き projection store」を提供します。
//
// 設計の要点:
// - version 比較は Node.js 側の read→compare→write ではなく、OpenSearch 側の
//   Painless scripted update（単一 atomic update）で行う。script へ ID や値を文字列連結せず、
//   すべて params で渡す。
// - Ticket Type 単位 version（inventory_version）と Event 集計 version
//   （event_inventory_version）を独立に比較する。別 Type の version を比較しない。
// - Ticket Type UUID を dynamic field 名にしない（mapping explosion 回避）。
//   ticket_types を明示 mapping された nested 配列で保持する。
// - ensureEventsIndex は未存在時に完全 mapping で作成し、存在時も idempotent な
//   additive putMapping を適用する。index 削除や破壊的変更はしない。
// - Worker と rebuild は同じ script（INVENTORY_VERSION_GUARD_SCRIPT）を共有する。

import type { Client } from '@opensearch-project/opensearch';
import type {
  ParsedInventoryChanged,
  VersionedInventoryChangedPayload,
} from '../messaging/inventory-event.contract';

// EVENTS_INDEX は Worker が書き込み、API が読む検索プロジェクションの index 名です。
export const EVENTS_INDEX = 'events';

// EVENTS_INDEX_PROPERTIES は events index の完全 mapping です。
// 既存 field（event_id / title / ... / remaining_quantity）に加えて、
// versioned Ticket Type 在庫（ticket_types nested）と Event 集計 version を明示 mapping します。
// OpenSearch client の mapping 型は複雑なため、mapping 定義は緩い型で保持し、
// create / putMapping 呼び出し時に client の期待する型へ委ねます。
export const EVENTS_INDEX_PROPERTIES: Record<string, Record<string, unknown>> = {
  // --- 既存 field（旧 Worker と search.service が使う。互換維持） ---
  event_id: { type: 'keyword' },
  title: { type: 'text' },
  event_type: { type: 'keyword' },
  starts_at: { type: 'date' },
  location: { type: 'geo_point' },
  total_quantity: { type: 'integer' },
  remaining_quantity: { type: 'integer' },

  // --- versioned Event 集計（Issue #377） ---
  event_total_quantity: { type: 'integer' },
  event_remaining_quantity: { type: 'integer' },
  // version は int を超え得るため long で明示 mapping する。
  event_inventory_version: { type: 'long' },

  // --- versioned Ticket Type 単位 state（Issue #377） ---
  // Ticket Type UUID を field 名にせず、nested 配列の要素として持つ（mapping explosion 回避）。
  ticket_types: {
    type: 'nested',
    properties: {
      ticket_type_id: { type: 'keyword' },
      name: { type: 'text' },
      total_quantity: { type: 'integer' },
      remaining_quantity: { type: 'integer' },
      inventory_version: { type: 'long' },
    },
  },
};

// INVENTORY_VERSION_GUARD_SCRIPT は versioned InventoryChanged を atomic に反映する
// 共有 Painless script です。Worker（update API）と rebuild（bulk update）が共有します。
//
// Ticket Type state（ticketTypeId + inventoryVersion）:
//   incoming > stored          -> apply
//   incoming == stored & 同値   -> idempotent no-op
//   incoming == stored & 差異   -> contract corruption として throw
//   incoming < stored          -> stale no-op
// Event 集計（eventInventoryVersion）も独立に同じ規則で判定します。
//
// scripted_upsert=true とし、document 未存在（InventoryChanged 先着）でも upsert します。
//
// review 3: Ticket Type 側と Event 集計側のどちらかを実際に更新したかを `changed` で追跡し、
// 両方とも stale / 同値 duplicate で何も変更していない場合は ctx.op='noop' にする。
// これにより OpenSearch の update response.result が 'noop' となり、Worker は outcome を
// 'stale' として区別できる（同一 version で異なる値は throw して corruption を error にする）。
export const INVENTORY_VERSION_GUARD_SCRIPT = `
long asLong(def v) { return ((Number) v).longValue(); }

boolean changed = false;

if (ctx._source.ticket_types == null) { ctx._source.ticket_types = new ArrayList(); }
def types = ctx._source.ticket_types;
def target = null;
for (def t : types) {
  if (t.ticket_type_id == params.ticketTypeId) { target = t; break; }
}
if (target == null) {
  def nt = new HashMap();
  nt.ticket_type_id = params.ticketTypeId;
  nt.name = params.ticketTypeName;
  nt.total_quantity = params.ticketTypeTotalQuantity;
  nt.remaining_quantity = params.ticketTypeRemainingQuantity;
  nt.inventory_version = params.inventoryVersion;
  types.add(nt);
  changed = true;
} else {
  long stored = asLong(target.inventory_version);
  long incoming = asLong(params.inventoryVersion);
  if (incoming > stored) {
    target.name = params.ticketTypeName;
    target.total_quantity = params.ticketTypeTotalQuantity;
    target.remaining_quantity = params.ticketTypeRemainingQuantity;
    target.inventory_version = params.inventoryVersion;
    changed = true;
  } else if (incoming == stored) {
    if (asLong(target.total_quantity) != asLong(params.ticketTypeTotalQuantity)
        || asLong(target.remaining_quantity) != asLong(params.ticketTypeRemainingQuantity)) {
      throw new IllegalStateException("ticket type inventory contract corruption at version " + incoming);
    }
  }
}

if (ctx._source.event_inventory_version == null) {
  ctx._source.event_inventory_version = params.eventInventoryVersion;
  ctx._source.event_total_quantity = params.eventTotalQuantity;
  ctx._source.event_remaining_quantity = params.eventRemainingQuantity;
  ctx._source.total_quantity = params.eventTotalQuantity;
  ctx._source.remaining_quantity = params.eventRemainingQuantity;
  changed = true;
} else {
  long storedE = asLong(ctx._source.event_inventory_version);
  long incomingE = asLong(params.eventInventoryVersion);
  if (incomingE > storedE) {
    ctx._source.event_inventory_version = params.eventInventoryVersion;
    ctx._source.event_total_quantity = params.eventTotalQuantity;
    ctx._source.event_remaining_quantity = params.eventRemainingQuantity;
    ctx._source.total_quantity = params.eventTotalQuantity;
    ctx._source.remaining_quantity = params.eventRemainingQuantity;
    changed = true;
  } else if (incomingE == storedE) {
    if (asLong(ctx._source.event_total_quantity) != asLong(params.eventTotalQuantity)
        || asLong(ctx._source.event_remaining_quantity) != asLong(params.eventRemainingQuantity)) {
      throw new IllegalStateException("event aggregate inventory contract corruption at version " + incomingE);
    }
  }
}

if (changed) {
  ctx._source.event_id = params.eventId;
} else {
  // Ticket Type / Event ともに stale または同値 duplicate。version guard による no-op として
  // 明示的に noop 化する（response.result='noop' → Worker outcome=stale）。
  ctx.op = 'noop';
}
`.trim();

// LEGACY_INVENTORY_SCRIPT は version なし旧 InventoryChanged を反映する Painless script です。
// versioned state（event_inventory_version）が未作成のときだけ top-level 残数を更新し、
// versioned state 作成後は Event 集計を巻き戻しません。
//
// review 3: versioned state 作成前に legacy 値を反映した場合は applied、versioned state 作成後で
// 無視した場合は legacy_ignore として区別する。無視した場合は ctx.op='noop'（result='noop'）とし、
// Worker が outcome を legacy_ignore と判定できるようにする。
export const LEGACY_INVENTORY_SCRIPT = `
if (ctx._source.event_inventory_version == null) {
  ctx._source.remaining_quantity = params.remainingQuantity;
  ctx._source.event_id = params.eventId;
} else {
  ctx.op = 'noop';
}
`.trim();

// EVENT_METADATA_SCRIPT は EventListed / EventUpdated の metadata だけを merge する
// Painless script です。Ticket Type 在庫と version を削除・上書きしません。
// InventoryChanged が先着していても upsert でき、EventListed 後着で metadata を補完します。
// top-level total/remaining は「まだ在庫 event が反映されていない」ときだけ seed します。
//
// review 5: location 更新は set / clear / preserve の三値として扱う。
// - locationAction='set'     : lat/lon を設定する
// - locationAction='clear'   : ctx._source.remove('location') で削除する（online 開催化など）
// - locationAction='preserve': field 省略。既存 location を触らない（旧 payload 互換）
// 「field 省略」と「明示 null」を混同しないため、判定は applyEventMetadata 側で行う。
export const EVENT_METADATA_SCRIPT = `
ctx._source.event_id = params.eventId;
ctx._source.title = params.title;
ctx._source.event_type = params.eventType;
ctx._source.starts_at = params.startsAt;
if (params.locationAction == 'set') {
  def loc = new HashMap();
  loc.lat = params.lat;
  loc.lon = params.lon;
  ctx._source.location = loc;
} else if (params.locationAction == 'clear') {
  ctx._source.remove('location');
}
if (ctx._source.event_inventory_version == null && ctx._source.remaining_quantity == null) {
  ctx._source.total_quantity = params.totalQuantity;
  ctx._source.remaining_quantity = params.remainingQuantity;
}
`.trim();

// EventMetadataContractError は EventListed / EventUpdated の metadata contract 違反
// （不正な部分 location など）を検出したときに投げるエラーです（review 5）。
// Worker で握り潰さず throw させ、SQS message を ack させません（retry / DLQ へ進める）。
export class EventMetadataContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventMetadataContractError';
  }
}

// LocationDirective は location 更新の三値です。
type LocationDirective =
  | { action: 'set'; lat: number; lon: number }
  | { action: 'clear' }
  | { action: 'preserve' };

// resolveLocationDirective は latitude / longitude の組み合わせを set / clear / preserve に
// 分類します。旧 payload 互換のため「field 省略（undefined）」と「明示 null」を混同しません。
// 片方だけ存在 / 片方だけ null / NaN / Infinity など不整合は contract error とします（review 5）。
export function resolveLocationDirective(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): LocationDirective {
  const latAbsent = latitude === undefined;
  const lonAbsent = longitude === undefined;
  if (latAbsent && lonAbsent) {
    return { action: 'preserve' };
  }
  if (latitude === null && longitude === null) {
    return { action: 'clear' };
  }
  if (
    typeof latitude === 'number' &&
    Number.isFinite(latitude) &&
    typeof longitude === 'number' &&
    Number.isFinite(longitude)
  ) {
    return { action: 'set', lat: latitude, lon: longitude };
  }
  throw new EventMetadataContractError(
    'event metadata has invalid partial location: latitude and longitude must both be finite numbers, both explicit null, or both absent',
  );
}

// buildVersionedInventoryScriptParams は versioned payload から script params を組み立てます。
// script へ ID や値を文字列連結せず、すべて params 経由で渡すための単一箇所です。
export function buildVersionedInventoryScriptParams(
  payload: VersionedInventoryChangedPayload,
): Record<string, unknown> {
  return {
    eventId: payload.eventId,
    ticketTypeId: payload.ticketTypeId,
    ticketTypeName: payload.ticketTypeName,
    ticketTypeTotalQuantity: payload.ticketTypeTotalQuantity,
    ticketTypeRemainingQuantity: payload.ticketTypeRemainingQuantity,
    inventoryVersion: payload.inventoryVersion,
    eventTotalQuantity: payload.eventTotalQuantity,
    eventRemainingQuantity: payload.eventRemainingQuantity,
    eventInventoryVersion: payload.eventInventoryVersion,
  };
}

// isVersionConflict は OpenSearch の楽観ロック競合（HTTP 409）を判定します。
function isVersionConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const statusCode = (error as { statusCode?: number }).statusCode;
  const body = (error as { body?: { error?: { type?: string } } }).body;
  return (
    statusCode === 409 ||
    body?.error?.type === 'version_conflict_engine_exception'
  );
}

const MAX_CONFLICT_RETRIES = 5;

// updateResultOf は OpenSearch update response から result 文字列（'noop' / 'updated' /
// 'created' 等）を取り出します。ctx.op='noop' を設定した scripted update は 'noop' を返します。
function updateResultOf(response: unknown): string | undefined {
  const body = (response as { body?: { result?: unknown } })?.body;
  return typeof body?.result === 'string' ? body.result : undefined;
}

// applyVersionedInventoryChanged は versioned InventoryChanged を単一 atomic scripted update で
// 反映します。document 競合（409）は有限回 retry し、解消しなければ throw して
// SQS message を削除させません。
//
// review 3: OpenSearch の実 response.result を基に、実際に Ticket Type / Event 集計の
// いずれかを更新したか（'applied'）、両方 stale / 同値 duplicate で no-op だったか（'stale'）を返す。
// 同一 version で異なる値（contract corruption）は script が throw するため、ここには到達しない。
export async function applyVersionedInventoryChanged(
  client: Client,
  index: string,
  payload: VersionedInventoryChangedPayload,
): Promise<'applied' | 'stale'> {
  const response = await runWithConflictRetry(() =>
    client.update({
      index,
      id: payload.eventId,
      // retry_on_conflict は OpenSearch 側の内部 retry。加えて呼び出し側でも有限 retry する。
      retry_on_conflict: MAX_CONFLICT_RETRIES,
      body: {
        scripted_upsert: true,
        script: {
          lang: 'painless',
          source: INVENTORY_VERSION_GUARD_SCRIPT,
          params: buildVersionedInventoryScriptParams(payload),
        },
        upsert: {},
      },
      refresh: true,
    }),
  );
  return updateResultOf(response) === 'noop' ? 'stale' : 'applied';
}

// applyLegacyInventoryChanged は version なし旧 InventoryChanged を反映します。
// review 3: versioned state 作成前に legacy 値を反映した場合は 'applied'、versioned state 作成後で
// 無視した場合は 'legacy_ignore' を返す（script が ctx.op='noop' → result='noop'）。
export async function applyLegacyInventoryChanged(
  client: Client,
  index: string,
  input: { eventId: string; remainingQuantity: number },
): Promise<'applied' | 'legacy_ignore'> {
  const response = await runWithConflictRetry(() =>
    client.update({
      index,
      id: input.eventId,
      retry_on_conflict: MAX_CONFLICT_RETRIES,
      body: {
        scripted_upsert: true,
        script: {
          lang: 'painless',
          source: LEGACY_INVENTORY_SCRIPT,
          params: {
            eventId: input.eventId,
            remainingQuantity: input.remainingQuantity,
          },
        },
        upsert: {},
      },
      refresh: true,
    }),
  );
  return updateResultOf(response) === 'noop' ? 'legacy_ignore' : 'applied';
}

// EventMetadata は EventListed / EventUpdated から反映する metadata です。
export interface EventMetadata {
  eventId: string;
  title: unknown;
  eventType: unknown;
  startsAt: unknown;
  latitude?: number | null;
  longitude?: number | null;
  totalQuantity?: number | null;
  remainingQuantity?: number | null;
}

// applyEventMetadata は EventListed / EventUpdated の metadata だけを merge します。
export async function applyEventMetadata(
  client: Client,
  index: string,
  metadata: EventMetadata,
): Promise<void> {
  // location は set / clear / preserve の三値へ分類する（review 5）。不正な部分 location は
  // ここで throw し、Worker が message を ack しない（EventMetadataContractError）。
  const location = resolveLocationDirective(
    metadata.latitude,
    metadata.longitude,
  );
  await runWithConflictRetry(() =>
    client.update({
      index,
      id: metadata.eventId,
      retry_on_conflict: MAX_CONFLICT_RETRIES,
      body: {
        scripted_upsert: true,
        script: {
          lang: 'painless',
          source: EVENT_METADATA_SCRIPT,
          params: {
            eventId: metadata.eventId,
            title: metadata.title ?? null,
            eventType: metadata.eventType ?? null,
            startsAt: metadata.startsAt ?? null,
            locationAction: location.action,
            lat: location.action === 'set' ? location.lat : null,
            lon: location.action === 'set' ? location.lon : null,
            totalQuantity: metadata.totalQuantity ?? null,
            remainingQuantity: metadata.remainingQuantity ?? null,
          },
        },
        upsert: {},
      },
      refresh: true,
    }),
  );
}

// buildVersionedInventoryBulkOps は rebuild 用に bulk update の 2 行（action + body）を返します。
// Worker と同じ INVENTORY_VERSION_GUARD_SCRIPT を使い、version guard を共有します。
export function buildVersionedInventoryBulkOps(
  index: string,
  payload: VersionedInventoryChangedPayload,
): [Record<string, unknown>, Record<string, unknown>] {
  return [
    { update: { _index: index, _id: payload.eventId, retry_on_conflict: MAX_CONFLICT_RETRIES } },
    {
      scripted_upsert: true,
      script: {
        lang: 'painless',
        source: INVENTORY_VERSION_GUARD_SCRIPT,
        params: buildVersionedInventoryScriptParams(payload),
      },
      upsert: {},
    },
  ];
}

async function runWithConflictRetry<T>(op: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
    try {
      return await op();
    } catch (error) {
      if (!isVersionConflict(error)) {
        throw error;
      }
      lastError = error;
    }
  }
  // 有限 retry を使い切っても解消しなければ throw する（SQS message を削除させない）。
  throw lastError;
}

// ensureEventsIndex は index の存在を保証し、mapping を additive に適用します。
// - 未存在: 完全 mapping で作成
// - 存在: idempotent な additive putMapping（既存 field は破壊しない）
// mapping 適用に失敗した場合は throw し、呼び出し側は message consumption を開始しません。
export async function ensureEventsIndex(
  client: Client,
  index: string = EVENTS_INDEX,
): Promise<void> {
  const exists = await client.indices.exists({ index });
  // mapping properties は OpenSearch client の Property 型へそのまま渡す（型は client に委ねる）。
  const properties = EVENTS_INDEX_PROPERTIES as unknown as Record<string, never>;
  if (!exists.body) {
    await client.indices.create({
      index,
      body: { mappings: { properties } },
    });
    return;
  }
  // 既存 index にも additive に mapping を適用する。putMapping は additive であり、
  // 既存 field 型の破壊的変更や field 削除は行わない（OpenSearch が拒否する）。
  await client.indices.putMapping({
    index,
    body: { properties },
  });
}

// ProjectionDocument は reconciliation / rebuild が OpenSearch から読む document 形です。
export interface ProjectionTicketType {
  ticket_type_id: string;
  name: string;
  total_quantity: number;
  remaining_quantity: number;
  inventory_version: number;
}

export interface ProjectionDocument {
  event_id: string;
  event_total_quantity?: number | null;
  event_remaining_quantity?: number | null;
  event_inventory_version?: number | null;
  ticket_types?: ProjectionTicketType[] | null;
}

// applyParsedInventoryChanged は parser 結果をそのまま反映する Worker 向け helper です。
// review 3: OpenSearch の実 response を基に、Worker が emit する outcome を直接返す。
// - versioned apply       -> 'applied'
// - versioned stale/dup    -> 'stale'
// - legacy（versioned 前）  -> 'applied'
// - legacy（versioned 後）  -> 'legacy_ignore'
export async function applyParsedInventoryChanged(
  client: Client,
  index: string,
  parsed: ParsedInventoryChanged,
): Promise<'applied' | 'stale' | 'legacy_ignore'> {
  if (parsed.kind === 'versioned') {
    return applyVersionedInventoryChanged(client, index, parsed);
  }
  return applyLegacyInventoryChanged(client, index, parsed);
}
