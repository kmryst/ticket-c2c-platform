// ファイル概要:
// このファイルは OpenSearch の events index を検索する service です。
// 検索経路（読み取り）を購入経路（書き込み）から分離するため、API は OpenSearch のみを見ます。
// OPENSEARCH_ENDPOINT 未設定時は null を返し、呼び出し側（EventsService）が DB フォールバックします。

import { Injectable } from '@nestjs/common';
import { Client } from '@opensearch-project/opensearch';
import { getOptionalEnv } from '../config';
// createOpenSearchClient は AWS 上では SigV4 署名付きクライアントを返します（production-readiness M-3）。
import { createOpenSearchClient } from '../opensearch';

// EVENTS_INDEX は Worker が書き込み、API が読む検索プロジェクションの index 名です。
// projection store（events-projection.store.ts）を単一の正本とし、ここから再輸出します。
export { EVENTS_INDEX } from './events-projection.store';
import { EVENTS_INDEX } from './events-projection.store';

// SearchParams はイベント検索の条件です。system-requirements.md の検索 3 条件に対応します。
export interface SearchParams {
  eventType?: string;
  // date は YYYY-MM-DD。指定日の 0:00 から翌日 0:00 未満を対象にします。
  date?: string;
  latitude?: number;
  longitude?: number;
  radiusKm?: number;
}

// SearchedEvent は検索結果として返すイベント概要です。
export interface SearchedEvent {
  eventId: string;
  title: string;
  eventType: string;
  startsAt: string;
  latitude: number | null;
  longitude: number | null;
  remainingQuantity: number | null;
}

// EventSearchSource は events index の _source のうち、検索結果の組み立てに使う field です。
export interface EventSearchSource {
  event_id: string;
  title: string;
  event_type: string;
  starts_at: string;
  location: { lat: number; lon: number } | null;
  remaining_quantity?: number | null;
  // versioned Event 集計（Issue #377 / ADR-0031）。version guard script が所有する。
  event_remaining_quantity?: number | null;
  event_inventory_version?: number | null;
}

// resolveRemainingQuantity は検索結果として返す残数を決めます。
//
// top-level `remaining_quantity` は version guard を持たない旧 Worker が `doc_as_upsert` で
// 無条件に巻き戻し得るのに対し、`event_remaining_quantity` は version guard script だけが
// 書き込みます。reconciliation / rebuild も versioned field だけを比較・修復するため、
// top-level だけが drift した状態は検知・修復されません（reconciliation blind spot）。
// したがって versioned state 作成済みの event では versioned field を正として読みます。
//
// 判定キーは `event_remaining_quantity != null` ではなく `event_inventory_version != null` に
// します（LEGACY_INVENTORY_SCRIPT / EVENT_METADATA_SCRIPT / reconciliation が
// 「versioned state 作成済みか」を event_inventory_version で判定する不変条件と整合させる）。
// versioned state 未作成（legacy 期間）の event だけ top-level へ fallback します。
export function resolveRemainingQuantity(
  source: EventSearchSource,
): number | null {
  if (source.event_inventory_version != null) {
    return source.event_remaining_quantity ?? null;
  }
  return source.remaining_quantity ?? null;
}

// toSearchedEvent は _source を API の検索結果 1 件へ変換します。
export function toSearchedEvent(source: EventSearchSource): SearchedEvent {
  return {
    eventId: source.event_id,
    title: source.title,
    eventType: source.event_type,
    startsAt: source.starts_at,
    latitude: source.location?.lat ?? null,
    longitude: source.location?.lon ?? null,
    remainingQuantity: resolveRemainingQuantity(source),
  };
}

// searchEvents は検索条件を OpenSearch の bool query に変換して実行します。
// SearchService から client / index を分離した形で、統合テストが一時 index に対して
// 本番と同じ query / _source 読み替えを検証できるようにしています。
export async function searchEvents(
  client: Client,
  index: string,
  params: SearchParams,
): Promise<SearchedEvent[]> {
  const filters: Record<string, unknown>[] = [];

  if (params.eventType) {
    filters.push({ term: { event_type: params.eventType } });
  }
  if (params.date) {
    filters.push({
      range: {
        starts_at: { gte: params.date, lt: `${params.date}||+1d` },
      },
    });
  }
  if (params.latitude !== undefined && params.longitude !== undefined) {
    filters.push({
      geo_distance: {
        distance: `${params.radiusKm ?? 50}km`,
        location: { lat: params.latitude, lon: params.longitude },
      },
    });
  }

  const response = await client.search({
    index,
    body: {
      size: 20,
      query: { bool: { filter: filters } },
      sort: [{ starts_at: { order: 'asc' } }],
    },
  });

  const hits = response.body.hits.hits as unknown as Array<{
    _source: EventSearchSource;
  }>;

  return hits.map((hit) => toSearchedEvent(hit._source));
}

@Injectable()
export class SearchService {
  private readonly client: Client | null;

  constructor() {
    const endpoint = getOptionalEnv('OPENSEARCH_ENDPOINT');
    this.client = endpoint ? createOpenSearchClient(endpoint) : null;
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  // search は検索条件を OpenSearch の bool query に変換して実行します。
  // 無効時は null を返し、判断は呼び出し側に委ねます。
  async search(params: SearchParams): Promise<SearchedEvent[] | null> {
    if (!this.client) {
      return null;
    }
    return searchEvents(this.client, EVENTS_INDEX, params);
  }
}
