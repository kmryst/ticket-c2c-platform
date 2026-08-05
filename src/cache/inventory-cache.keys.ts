// ファイル概要:
// このファイルは Valkey 在庫キャッシュのキー定義です（Issue #378 で
// InventoryCacheService から pure 関数として抽出。キー文字列は変更しない）。
// InventoryCacheService（書き込み側）と Gate B cutover checker（読み取り側）が
// 同じキー生成規則を共有し、checker がキー文字列を重複定義して乖離することを防ぎます。

// eventCounterKey は Event 単位在庫カウンタのキーです（legacy namespace）。
export function eventCounterKey(eventId: string): string {
  return `inventory:${eventId}`;
}

// eventCounterVersionKey はカウンタ変更回数を数える version キーです。
// syncCounter の CAS ガードに使います。
export function eventCounterVersionKey(eventId: string): string {
  return `inventory:${eventId}:v`;
}

// ticketTypeCounterKey / ticketTypeCounterRevisionKey は Ticket Type 単位 namespace の
// キーです（Issue #389）。hash tag `{<eventId>:<ticketTypeId>}` を共有し、counter と
// revision を Redis Cluster でも同じ hash slot に置きます（同一 Lua script で両方に触れるため）。
export function ticketTypeCounterKey(
  eventId: string,
  ticketTypeId: string,
): string {
  return `inventory:ticket-type:{${eventId}:${ticketTypeId}}:remaining`;
}

export function ticketTypeCounterRevisionKey(
  eventId: string,
  ticketTypeId: string,
): string {
  return `inventory:ticket-type:{${eventId}:${ticketTypeId}}:revision`;
}

// purchaseRequestSeenKey は確定済み requestId マーカーのキーです。
// requestId は buyer + event の scope で idempotency key になる（DB の unique 制約と
// 同じ scope）ため、キーにも同じ 3 つ組を使います。
export function purchaseRequestSeenKey(
  buyerId: string,
  eventId: string,
  requestId: string,
): string {
  return `purchase-request:${buyerId}:${eventId}:${requestId}`;
}

// TICKET_TYPE_COUNTER_SCAN_PATTERN は Ticket Type counter キーの SCAN パターンです。
// Gate B checker が「DB に紐付かない counter キー」を検出するために使います。
export const TICKET_TYPE_COUNTER_SCAN_PATTERN =
  'inventory:ticket-type:*:remaining';

// UUID_PATTERN は canonical な UUID 文字列表現です（DB の uuid 列と同じ形）。
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TICKET_TYPE_COUNTER_KEY_PATTERN =
  /^inventory:ticket-type:\{([0-9a-fA-F-]{36}):([0-9a-fA-F-]{36})\}:remaining$/;

export interface TicketTypeCounterKeyParts {
  eventId: string;
  ticketTypeId: string;
}

// parseTicketTypeCounterKey は SCAN で得た counter キーを (eventId, ticketTypeId) へ
// 分解します。ticketTypeCounterKey の逆関数であり、UUID として妥当でない断片を含む
// キーは null を返します（呼び出し側で「DB に紐付かないキー」として扱う）。
export function parseTicketTypeCounterKey(
  key: string,
): TicketTypeCounterKeyParts | null {
  const match = TICKET_TYPE_COUNTER_KEY_PATTERN.exec(key);
  if (!match) {
    return null;
  }
  const [, eventId, ticketTypeId] = match;
  if (!UUID_PATTERN.test(eventId) || !UUID_PATTERN.test(ticketTypeId)) {
    return null;
  }
  return { eventId, ticketTypeId };
}
