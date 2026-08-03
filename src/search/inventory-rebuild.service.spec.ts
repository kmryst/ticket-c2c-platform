// ファイル概要:
// このファイルは rebuild service の単体テストです（Issue #377）。
// bulk API が HTTP 200 でも item error が 1 件でもあれば失敗させることを、
// fake OpenSearch client で固定します（実 store 収束は integration spec で検証）。

import { RebuildBulkItemError, rebuildInventoryProjection } from './inventory-rebuild.service';
import type { SqlClient } from './inventory-projection-source';

const EVENT_ID = '11111111-1111-1111-1111-111111111111';
const TYPE_ID = '22222222-2222-2222-2222-222222222222';

// fakeSql は 1 Event / 1 Type の正本 snapshot を返す最小 SqlClient です。
function fakeSql(): SqlClient {
  return {
    query: jest.fn(async (text: string) => {
      if (text.includes('FROM ticket_inventory')) {
        return {
          rows: [
            {
              event_id: EVENT_ID,
              total_quantity: 100,
              remaining_quantity: 90,
              version: 2,
            },
          ],
          rowCount: 1,
        };
      }
      if (text.includes('FROM ticket_type_inventory')) {
        return {
          rows: [
            {
              event_id: EVENT_ID,
              ticket_type_id: TYPE_ID,
              name: 'GA',
              total_quantity: 100,
              remaining_quantity: 90,
              version: 2,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }) as unknown as SqlClient['query'],
  };
}

function fakeOpensearch(bulkResponse: unknown) {
  return {
    indices: {
      exists: jest.fn(async () => ({ body: true })),
      putMapping: jest.fn(async () => ({})),
      create: jest.fn(async () => ({})),
    },
    bulk: jest.fn(async () => ({ body: bulkResponse })),
  } as unknown as Parameters<typeof rebuildInventoryProjection>[1];
}

describe('rebuildInventoryProjection', () => {
  it('bulk が errors=false なら成功する', async () => {
    const os = fakeOpensearch({ errors: false, items: [] });
    const report = await rebuildInventoryProjection(fakeSql(), os);
    expect(report.processedEvents).toBe(1);
    expect(report.processedTicketTypes).toBe(1);
    expect(report.bulkRequests).toBe(1);
  });

  it('bulk が HTTP 200 でも item error があれば throw する（partial failure を成功扱いしない）', async () => {
    const os = fakeOpensearch({
      errors: true,
      items: [
        { update: { status: 400, error: { type: 'mapper_parsing_exception' } } },
      ],
    });
    await expect(rebuildInventoryProjection(fakeSql(), os)).rejects.toThrow(
      RebuildBulkItemError,
    );
  });
});
