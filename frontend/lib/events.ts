// ファイル概要:
// このファイルはイベント関連の型と、サーバーコンポーネント用の API fetch です（Issue #145）。
// SSR のサーバー側 fetch は API_BASE_URL（AWS では API の公開 FQDN、ローカルでは
// http://localhost:<port>）を直接呼びます。ブラウザ側の呼び出しは lib/api.ts を使います。

// EventSummary は backend の GET /events / /events/search が返すイベント概要です。
export interface EventSummary {
  eventId: string;
  title: string;
  eventType: string;
  startsAt: string;
  latitude: number | null;
  longitude: number | null;
  totalQuantity: number;
  remainingQuantity: number;
}

// apiBaseUrl は SSR のサーバー側 fetch が使う API の base URL です。
// 未設定はデプロイ構成の誤りなので、フォールバックせず明示的に失敗させます。
function apiBaseUrl(): string {
  const base = process.env.API_BASE_URL;
  if (!base) {
    throw new Error("API_BASE_URL is not set");
  }
  return base;
}

// fetchEvents はイベント一覧を取得します（SSR、毎回最新を取得）。
export async function fetchEvents(): Promise<EventSummary[]> {
  const response = await fetch(`${apiBaseUrl()}/events`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`GET /events failed (${response.status})`);
  }
  return (await response.json()) as EventSummary[];
}

// SearchQuery は GET /events/search の検索条件です（すべて任意）。
export interface SearchQuery {
  eventType?: string;
  date?: string;
  lat?: string;
  lon?: string;
  radiusKm?: string;
}

// searchEvents は検索 API を呼びます（SSR、毎回最新を取得）。
// AWS では OpenSearch、ローカル（OPENSEARCH_ENDPOINT なし）では DB フォールバックが使われます。
export async function searchEvents(query: SearchQuery): Promise<EventSummary[]> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) {
      params.set(key, value);
    }
  }
  const response = await fetch(
    `${apiBaseUrl()}/events/search?${params.toString()}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(`GET /events/search failed (${response.status})`);
  }
  return (await response.json()) as EventSummary[];
}

// findEvent は一覧からイベントを 1 件探します。
// backend に GET /events/:id が無いため、一覧取得 + 絞り込みで代用します（PoC 規模で許容）。
export async function findEvent(
  eventId: string,
): Promise<EventSummary | undefined> {
  const events = await fetchEvents();
  return events.find((event) => event.eventId === eventId);
}
