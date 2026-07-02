// ファイル概要:
// このファイルはイベント登録・一覧・検索 API の型定義です。

// CreateEventBody は POST /events の request body（検証前）です。
export interface CreateEventBody {
  title?: unknown;
  eventType?: unknown;
  startsAt?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  totalQuantity?: unknown;
}

// ParsedCreateEventInput は検証を通過した登録入力です。
export interface ParsedCreateEventInput {
  title: string;
  eventType: string;
  startsAt: string;
  latitude: number | null;
  longitude: number | null;
  totalQuantity: number;
}

// EventSummary は一覧・登録応答で返すイベント概要です。
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
