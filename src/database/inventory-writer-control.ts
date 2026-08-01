// PostgreSQL 在庫 writer の共有 control state と advisory lock を扱います。
// Issue #376 の application writer は、table へ触る前に必ず同じ shared barrier を取得します。

import type { PoolClient } from 'pg';

export type InventoryWriterMode = 'legacy' | 'ticket_type';

// #378 の activation transaction は同じ 2-key advisory lock を exclusive で取得します。
// requestId lock は bigint key-space を使うため、この 2-key barrier と衝突しません。
export const INVENTORY_WRITER_BARRIER_KEYS = [335, 376] as const;

type QueryClient = Pick<PoolClient, 'query'>;

export async function acquireSharedInventoryWriterBarrier(
  client: QueryClient,
): Promise<void> {
  await client.query(
    `
      SELECT pg_advisory_xact_lock_shared(
        $1::integer,
        $2::integer
      )
    `,
    [...INVENTORY_WRITER_BARRIER_KEYS],
  );
}

export async function acquirePurchaseRequestLock(
  client: QueryClient,
  buyerId: string,
  eventId: string,
  requestId: string,
): Promise<void> {
  // payload は key に含めない。同じ idempotency key の異なる payload も同じ lock で
  // 直列化し、在庫更新前に既存 row と比較できるようにする。
  const scope = `${buyerId}\u001f${eventId}\u001f${requestId}`;
  await client.query(
    `
      SELECT pg_advisory_xact_lock(
        hashtextextended($1::text, $2::bigint)
      )
    `,
    [scope, 376],
  );
}

export async function readInventoryWriterMode(
  client: QueryClient,
): Promise<InventoryWriterMode> {
  const result = await client.query<{ writer_mode: string }>(
    `
      SELECT writer_mode
      FROM inventory_writer_control
      WHERE singleton
    `,
  );
  const mode = result.rows[0]?.writer_mode;
  if (result.rowCount !== 1 || (mode !== 'legacy' && mode !== 'ticket_type')) {
    throw new Error('inventory writer control state is missing or invalid');
  }
  return mode;
}
