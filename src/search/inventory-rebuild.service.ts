// ファイル概要:
// このファイルは Aurora PostgreSQL（正本）から OpenSearch projection を再構築する
// rebuild / reindex primitive です（Issue #377 / ADR-0031）。
//
// 要件:
// - 在庫（versioned Ticket Type / Event 集計）に加えて、events table が正本として持つ
//   metadata（title / event_type / starts_at / location）も復元する。
// - bounded keyset pagination + bounded bulk size。restart 可能・idempotent。
// - Worker と同じ atomic version guard（INVENTORY_VERSION_GUARD_SCRIPT）を bulk update で共有。
// - index 全削除や破壊的 recreate をしない（ensureEventsIndex は additive）。
// - bulk API が HTTP 200 でも item error が 1 件でもあれば失敗させる。
// - snapshot version N の処理前 / 途中 / 後に event N+1 が届いても N+1 を巻き戻さない
//   （version guard が stale payload を no-op にする）。
// - DB と OpenSearch 双方へ接続できる既存 API artifact から command override で実行する。
//   このファイルは AWS 上で自動実行しない（scheduler / 常駐 service を追加しない）。

import type { Client } from '@opensearch-project/opensearch';
import { buildVersionedInventoryChangedDetail } from '../messaging/inventory-event.contract';
import {
  buildEventMetadataBulkOps,
  buildVersionedInventoryBulkOps,
  ensureEventsIndex,
  EVENTS_INDEX,
} from './events-projection.store';
import {
  DEFAULT_PAGE_SIZE,
  iterateAuthoritativeInventory,
  SqlClient,
} from './inventory-projection-source';

// DEFAULT_BULK_SIZE は 1 bulk request で送る update 操作数の上限（bounded）です。
export const DEFAULT_BULK_SIZE = 200;

export interface RebuildOptions {
  index?: string;
  pageSize?: number;
  bulkSize?: number;
}

export interface RebuildReport {
  index: string;
  processedEvents: number;
  processedTicketTypes: number;
  bulkRequests: number;
}

// RebuildBulkItemError は bulk item error を握り潰さず表面化させるためのエラーです。
export class RebuildBulkItemError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RebuildBulkItemError';
  }
}

// rebuildInventoryProjection は正本 snapshot を bulk update で projection へ反映します。
// version guard により、既に新しい event が反映済みの Type / Event 集計は巻き戻しません。
export async function rebuildInventoryProjection(
  sql: SqlClient,
  opensearch: Client,
  options: RebuildOptions = {},
): Promise<RebuildReport> {
  const index = options.index ?? EVENTS_INDEX;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const bulkSize = Math.max(1, Math.min(options.bulkSize ?? DEFAULT_BULK_SIZE, 1000));

  // rebuild 前に mapping を additive に保証する（破壊的 recreate はしない）。
  await ensureEventsIndex(opensearch, index);

  let processedEvents = 0;
  let processedTicketTypes = 0;
  let bulkRequests = 0;
  let ops: Record<string, unknown>[] = [];

  const flush = async (): Promise<void> => {
    if (ops.length === 0) return;
    // review 10: 各 bulk request では refresh しない（毎 batch の同期 segment refresh を避け、
    // rebuild の MTTR と OpenSearch への indexing pressure を下げる）。
    await sendBulk(opensearch, ops);
    bulkRequests += 1;
    ops = [];
  };

  // pushOps は bulk update 1 操作（2 行）を積み、bulk size（update 操作数）で bound する。
  const pushOps = async (
    op: [Record<string, unknown>, Record<string, unknown>],
  ): Promise<void> => {
    ops.push(op[0], op[1]);
    if (ops.length >= bulkSize * 2) {
      await flush();
    }
  };

  for await (const authoritative of iterateAuthoritativeInventory(sql, pageSize)) {
    processedEvents += 1;
    // title / event_type / starts_at / location は events table（正本）に保存されているため、
    // rebuild は在庫だけでなく metadata も復元する。EVENT_METADATA_SCRIPT を共有するので
    // versioned 在庫 field は削除・上書きしない（在庫は version guard script が所有する）。
    // location は正本に無ければ clear（明示 null ペア）で stale な location を残さない。
    await pushOps(
      buildEventMetadataBulkOps(index, {
        eventId: authoritative.eventId,
        title: authoritative.metadata.title,
        eventType: authoritative.metadata.eventType,
        startsAt: authoritative.metadata.startsAt,
        latitude: authoritative.metadata.latitude,
        longitude: authoritative.metadata.longitude,
        totalQuantity: authoritative.eventTotalQuantity,
        remainingQuantity: authoritative.eventRemainingQuantity,
      }),
    );
    for (const type of authoritative.ticketTypes) {
      const payload = buildVersionedInventoryChangedDetail({
        eventId: authoritative.eventId,
        ticketTypeId: type.ticketTypeId,
        ticketTypeName: type.name,
        ticketTypeTotalQuantity: type.totalQuantity,
        ticketTypeRemainingQuantity: type.remainingQuantity,
        inventoryVersion: type.inventoryVersion,
        eventTotalQuantity: authoritative.eventTotalQuantity,
        eventRemainingQuantity: authoritative.eventRemainingQuantity,
        eventInventoryVersion: authoritative.eventInventoryVersion,
      });
      await pushOps(buildVersionedInventoryBulkOps(index, payload));
      processedTicketTypes += 1;
    }
  }
  await flush();

  // review 10: 全 bulk が成功した後、対象 index を一度だけ明示 refresh する。
  // - final refresh が失敗した場合は rebuild 成功として返さない（throw）。
  // - 処理対象が 0 件（bulk を 1 度も送っていない）なら不要な refresh をしない。
  // これにより service return 直後の reconciliation が最新 projection を確実に読める。
  if (bulkRequests > 0) {
    await opensearch.indices.refresh({ index });
  }

  return {
    index,
    processedEvents,
    processedTicketTypes,
    bulkRequests,
  };
}

// sendBulk は bulk request を送り、HTTP 200 でも item error があれば throw します。
// refresh は rebuild 完了後に index 全体で一度だけ行う（毎 batch では refresh しない。review 10）。
async function sendBulk(
  opensearch: Client,
  ops: Record<string, unknown>[],
): Promise<void> {
  const response = await opensearch.bulk({ body: ops });
  const body = response.body as {
    errors?: boolean;
    items?: Array<Record<string, { status?: number; error?: unknown }>>;
  };
  if (!body?.errors) {
    return;
  }
  // errors=true の場合、最初の item error を特定して throw する（partial failure を成功扱いしない）。
  for (const item of body.items ?? []) {
    const op = Object.values(item)[0];
    if (op?.error) {
      throw new RebuildBulkItemError(
        `rebuild bulk item failed with status ${String(op.status)}`,
      );
    }
  }
  // errors=true だが個別 error を特定できない場合も安全側で失敗させる。
  throw new RebuildBulkItemError('rebuild bulk reported errors');
}
