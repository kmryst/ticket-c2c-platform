// ファイル概要:
// このファイルは rebuild service の単体テストです（Issue #377）。
// bulk API が HTTP 200 でも item error が 1 件でもあれば失敗させること、および rebuild が
// 各 bulk では refresh せず全 bulk 成功後に一度だけ refresh すること（review 10）を、
// fake OpenSearch client で固定します（実 store 収束は integration spec で検証）。

import { RebuildBulkItemError, rebuildInventoryProjection } from './inventory-rebuild.service';
import type { SqlClient } from './inventory-projection-source';

const TYPE_ID = '22222222-2222-2222-2222-222222222222';

// fakeSql は eventCount 件 / 各 1 Type の正本 snapshot を返す最小 SqlClient です。
function fakeSql(eventCount = 1): SqlClient {
  const eventIds = Array.from(
    { length: eventCount },
    (_, i) => `${String(i + 1).padStart(8, '0')}-1111-1111-1111-111111111111`,
  );
  return {
    query: jest.fn(async (text: string) => {
      if (text.includes('FROM ticket_inventory')) {
        return {
          rows: eventIds.map((id) => ({
            event_id: id,
            total_quantity: 100,
            remaining_quantity: 90,
            version: 2,
          })),
          rowCount: eventIds.length,
        };
      }
      if (text.includes('FROM ticket_type_inventory')) {
        return {
          rows: eventIds.map((id) => ({
            event_id: id,
            ticket_type_id: TYPE_ID,
            name: 'GA',
            total_quantity: 100,
            remaining_quantity: 90,
            version: 2,
          })),
          rowCount: eventIds.length,
        };
      }
      return { rows: [], rowCount: 0 };
    }) as unknown as SqlClient['query'],
  };
}

function fakeOpensearch(
  bulkResponse: unknown,
  opts: { refreshError?: boolean } = {},
) {
  const bulk = jest.fn(async () => ({ body: bulkResponse }));
  const refresh = jest.fn(async () => {
    if (opts.refreshError) {
      throw new Error('final refresh failed');
    }
    return {};
  });
  const os = {
    indices: {
      exists: jest.fn(async () => ({ body: true })),
      putMapping: jest.fn(async () => ({})),
      create: jest.fn(async () => ({})),
      refresh,
    },
    bulk,
  } as unknown as Parameters<typeof rebuildInventoryProjection>[1];
  return { os, bulk, refresh };
}

describe('rebuildInventoryProjection', () => {
  it('bulk が errors=false なら成功する', async () => {
    const { os } = fakeOpensearch({ errors: false, items: [] });
    const report = await rebuildInventoryProjection(fakeSql(), os);
    expect(report.processedEvents).toBe(1);
    expect(report.processedTicketTypes).toBe(1);
    expect(report.bulkRequests).toBe(1);
  });

  it('bulk が HTTP 200 でも item error があれば throw する（partial failure を成功扱いしない）', async () => {
    const { os } = fakeOpensearch({
      errors: true,
      items: [
        { update: { status: 400, error: { type: 'mapper_parsing_exception' } } },
      ],
    });
    await expect(rebuildInventoryProjection(fakeSql(), os)).rejects.toThrow(
      RebuildBulkItemError,
    );
  });

  // review 10: rebuild は各 bulk では refresh せず、全 bulk 成功後に一度だけ index を refresh する。
  it('bulkSize=1 で複数 bulk が発生しても refresh は最後に一度だけ（各 bulk では refresh しない）', async () => {
    const { os, bulk, refresh } = fakeOpensearch({ errors: false, items: [] });
    // 3 event / 各 1 Type、bulkSize=1 で 3 回の bulk request を発生させる。
    const report = await rebuildInventoryProjection(fakeSql(3), os, {
      bulkSize: 1,
    });
    expect(report.bulkRequests).toBe(3);
    // bulk request は refresh:true を持たない。
    for (const call of bulk.mock.calls) {
      expect((call[0] as { refresh?: unknown }).refresh).toBeUndefined();
    }
    // bulk 回数にかかわらず refresh は最後に一度だけ。
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('処理対象が 0 件なら refresh しない', async () => {
    const { os, refresh } = fakeOpensearch({ errors: false, items: [] });
    const report = await rebuildInventoryProjection(fakeSql(0), os);
    expect(report.bulkRequests).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('final refresh が失敗したら rebuild 成功として返さない（throw）', async () => {
    const { os } = fakeOpensearch(
      { errors: false, items: [] },
      { refreshError: true },
    );
    await expect(rebuildInventoryProjection(fakeSql(1), os)).rejects.toThrow(
      'final refresh failed',
    );
  });
});
