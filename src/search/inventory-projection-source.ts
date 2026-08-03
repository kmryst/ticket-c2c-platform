// ファイル概要:
// このファイルは Aurora PostgreSQL（在庫の正本）から検索 projection 用の
// authoritative snapshot を読む共有 reader です（Issue #377 / ADR-0031）。
// reconciliation（read-only 差分確認）と rebuild（reindex）が同じ読み取り規則を共有します。
//
// 要件:
// - bounded keyset pagination（events.id 昇順）で全件を無制限に memory へ載せない。
// - OpenSearch は在庫の正本ではないため、この reader は PostgreSQL からのみ読む。
// - 逆同期（OpenSearch → PostgreSQL）は行わない。

// SqlClient は pg の PoolClient / Client が満たす最小 query interface です。
export interface SqlClient {
  query<R extends Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

// AuthoritativeTicketType は Ticket Type 単位の正本 state です。
export interface AuthoritativeTicketType {
  ticketTypeId: string;
  name: string;
  totalQuantity: number;
  remainingQuantity: number;
  inventoryVersion: number;
}

// AuthoritativeEventInventory は 1 Event 分の正本 snapshot です。
export interface AuthoritativeEventInventory {
  eventId: string;
  eventTotalQuantity: number;
  eventRemainingQuantity: number;
  eventInventoryVersion: number;
  ticketTypes: AuthoritativeTicketType[];
}

// DEFAULT_PAGE_SIZE は 1 ページで読む event 数の既定です（bounded）。
export const DEFAULT_PAGE_SIZE = 200;

interface EventAggregateRow extends Record<string, unknown> {
  event_id: string;
  total_quantity: number;
  remaining_quantity: number;
  version: number;
}

interface TicketTypeRow extends Record<string, unknown> {
  event_id: string;
  ticket_type_id: string;
  name: string;
  total_quantity: number;
  remaining_quantity: number;
  version: number;
}

// iterateAuthoritativeInventory は keyset pagination で正本 snapshot を 1 Event ずつ yield します。
// 各ページは events.id 昇順で最大 pageSize 件を読み、そのページの Type 在庫をまとめて取得します。
export async function* iterateAuthoritativeInventory(
  client: SqlClient,
  pageSize: number = DEFAULT_PAGE_SIZE,
): AsyncGenerator<AuthoritativeEventInventory> {
  const boundedPageSize = Math.max(1, Math.min(pageSize, 1000));
  let lastEventId: string | null = null;

  for (;;) {
    // keyset pagination: 直前ページ末尾の event_id より大きい id を昇順に読む。
    const aggregates: { rows: EventAggregateRow[]; rowCount: number | null } =
      await client.query<EventAggregateRow>(
      `
        SELECT event_id, total_quantity, remaining_quantity, version
        FROM ticket_inventory
        WHERE ($1::uuid IS NULL OR event_id > $1::uuid)
        ORDER BY event_id ASC
        LIMIT $2
      `,
      [lastEventId, boundedPageSize],
    );

    if (aggregates.rows.length === 0) {
      return;
    }

    const eventIds: string[] = aggregates.rows.map((row) => row.event_id);

    // このページの Type 在庫をまとめて取得する（ページ内 bounded）。
    const types: { rows: TicketTypeRow[]; rowCount: number | null } =
      await client.query<TicketTypeRow>(
      `
        SELECT tti.event_id,
               tti.ticket_type_id,
               tt.name,
               tti.total_quantity,
               tti.remaining_quantity,
               tti.version
        FROM ticket_type_inventory tti
        JOIN ticket_types tt ON tt.id = tti.ticket_type_id
        WHERE tti.event_id = ANY($1::uuid[])
        ORDER BY tti.event_id ASC, tti.ticket_type_id ASC
      `,
      [eventIds],
    );

    const typesByEvent = new Map<string, AuthoritativeTicketType[]>();
    for (const row of types.rows) {
      const list = typesByEvent.get(row.event_id) ?? [];
      list.push({
        ticketTypeId: row.ticket_type_id,
        name: row.name,
        totalQuantity: row.total_quantity,
        remainingQuantity: row.remaining_quantity,
        inventoryVersion: row.version,
      });
      typesByEvent.set(row.event_id, list);
    }

    for (const aggregate of aggregates.rows) {
      yield {
        eventId: aggregate.event_id,
        eventTotalQuantity: aggregate.total_quantity,
        eventRemainingQuantity: aggregate.remaining_quantity,
        eventInventoryVersion: aggregate.version,
        ticketTypes: typesByEvent.get(aggregate.event_id) ?? [],
      };
    }

    lastEventId = eventIds[eventIds.length - 1];
    if (aggregates.rows.length < boundedPageSize) {
      return;
    }
  }
}

// beginReadOnlySnapshot は REPEATABLE READ READ ONLY transaction を開始します。
// cross-store snapshot は原子的ではないため、Gate B では queue drain 後に実行します
// （runbook 参照）。
export async function beginReadOnlySnapshot(client: SqlClient): Promise<void> {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
}

export async function endReadOnlySnapshot(client: SqlClient): Promise<void> {
  // read-only transaction は書き込まないため COMMIT / ROLLBACK いずれでも副作用はない。
  await client.query('ROLLBACK');
}
