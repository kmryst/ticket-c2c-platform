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
export const EVENTS_INDEX = 'events';

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

    const response = await this.client.search({
      index: EVENTS_INDEX,
      body: {
        size: 20,
        query: { bool: { filter: filters } },
        sort: [{ starts_at: { order: 'asc' } }],
      },
    });

    const hits = response.body.hits.hits as unknown as Array<{
      _source: {
        event_id: string;
        title: string;
        event_type: string;
        starts_at: string;
        location: { lat: number; lon: number } | null;
        remaining_quantity: number | null;
      };
    }>;

    return hits.map((hit) => ({
      eventId: hit._source.event_id,
      title: hit._source.title,
      eventType: hit._source.event_type,
      startsAt: hit._source.starts_at,
      latitude: hit._source.location?.lat ?? null,
      longitude: hit._source.location?.lon ?? null,
      remainingQuantity: hit._source.remaining_quantity,
    }));
  }
}
