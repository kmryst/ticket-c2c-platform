// PostgreSQL 在庫 writer の共有 control state と advisory lock を扱います。
// Issue #376 の application writer は、table へ触る前に必ず同じ shared barrier を取得します。

import type { PoolClient } from 'pg';

export type InventoryWriterMode = 'legacy' | 'ticket_type';

// #378 の activation transaction は同じ 2-key advisory lock を exclusive で取得します
// （acquireExclusiveInventoryWriterBarrier / ADR-0032）。
// requestId lock は bigint key-space を使うため、この 2-key barrier と衝突しません。
export const INVENTORY_WRITER_BARRIER_KEYS = [335, 376] as const;

// INVENTORY_WRITER_TABLE_LOCK_SQL は既知 writer 入口を閉じる決定的な table lock 順です。
// #336 / #376 migration の LOCK_WRITER_TABLES_SQL と同一文字列を共有の正とし、
// 一致は単体テスト（ticket-type-writer-mode-switch.spec.ts）で強制します
// （適用済み migration の up() 本体には手を入れない）。
export const INVENTORY_WRITER_TABLE_LOCK_SQL = `
-- 旧 writer の入口である events を先に gate とし、既存 transaction を drain する。
-- 後段 table に想定外の直接 writer がいれば、events を保持したまま待たず rollback する。
LOCK TABLE events IN EXCLUSIVE MODE;
LOCK TABLE purchases IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE ticket_types IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE ticket_inventory IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE ticket_type_inventory IN SHARE ROW EXCLUSIVE MODE NOWAIT;
`;

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

// acquireExclusiveInventoryWriterBarrier は shared barrier と同じ固定 key を
// exclusive で取得します（Issue #378 / ADR-0032 の writer mode 切替 transaction 専用）。
// shared 保持中の in-flight writer transaction の commit / abort を待つことで自然に
// drain し、新規 writer は barrier 取得段階で block されます。transaction-scoped の
// ため、失敗・crash 時は transaction 終了とともに自動解放されます。
export async function acquireExclusiveInventoryWriterBarrier(
  client: QueryClient,
): Promise<void> {
  await client.query(
    `
      SELECT pg_advisory_xact_lock(
        $1::integer,
        $2::integer
      )
    `,
    [...INVENTORY_WRITER_BARRIER_KEYS],
  );
}

// updateInventoryWriterMode は control singleton row の writer_mode を更新します。
// exclusive barrier とtable lockを取得した切替 transaction 内からだけ呼び出します
// （ADR-0032）。row が無い場合は fail closed で停止します。
export async function updateInventoryWriterMode(
  client: QueryClient,
  mode: InventoryWriterMode,
): Promise<void> {
  const result = await client.query(
    `
      UPDATE inventory_writer_control
      SET writer_mode = $1,
          updated_at = now()
      WHERE singleton
    `,
    [mode],
  );
  if (result.rowCount !== 1) {
    throw new Error('inventory writer control state is missing or invalid');
  }
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
