// ファイル概要:
// このファイルはイベント登録・一覧・検索のロジック本体です。
// 登録は Aurora（正本）へ書き、Valkey カウンタ初期化と EventListed 発行で読み取り系へ伝搬します。
// 検索は OpenSearch を読み、未設定時（ローカル）は DB フォールバックします。

import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { InventoryCacheService } from '../cache/inventory-cache.service';
import { DomainEventsService } from '../messaging/domain-events.service';
import {
  SearchService,
  SearchParams,
  SearchedEvent,
} from '../search/search.service';
import {
  CreateEventBody,
  EventSummary,
  ParsedCreateEventInput,
} from './event.types';

const POSTGRES_INT4_MAX = 2_147_483_647;

interface EventInsertRow {
  id: string;
  created_at: string;
}

interface EventListRow {
  id: string;
  title: string;
  event_type: string;
  starts_at: string;
  location_latitude: string | null;
  location_longitude: string | null;
  total_quantity: number;
  remaining_quantity: number;
}

@Injectable()
export class EventsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly inventoryCache: InventoryCacheService,
    private readonly domainEvents: DomainEventsService,
    private readonly searchService: SearchService,
  ) {}

  // createEvent はイベントと初期在庫を 1 transaction で作成します。
  // createdBy は JwtAuthGuard 検証済みトークンの sub claim（users.id）です（L-10、Issue #194）。
  // body 由来の値は parseCreateEventInput が定義済みフィールドだけを取り出すため、
  // クライアントが作成者 ID 系のフィールドを body に混ぜても created_by には影響しません。
  async createEvent(body: unknown, createdBy: string): Promise<EventSummary> {
    const input = parseCreateEventInput(body);
    const client = await this.database.connect();

    let eventId: string;
    try {
      await client.query('BEGIN');

      const inserted = await client.query<EventInsertRow>(
        `
          INSERT INTO events (title, event_type, starts_at, location_latitude, location_longitude, created_by)
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id, created_at
        `,
        [
          input.title,
          input.eventType,
          input.startsAt,
          input.latitude,
          input.longitude,
          createdBy,
        ],
      );
      eventId = inserted.rows[0].id;

      await client.query(
        `
          INSERT INTO ticket_inventory (event_id, total_quantity, remaining_quantity)
          VALUES ($1, $2, $2)
        `,
        [eventId, input.totalQuantity],
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    // 正本（Aurora）確定後に、前段フィルタと検索プロジェクションへ伝搬します。
    await this.inventoryCache.initCounter(eventId, input.totalQuantity);
    await this.domainEvents.publish('EventListed', {
      eventId,
      title: input.title,
      eventType: input.eventType,
      startsAt: input.startsAt,
      latitude: input.latitude,
      longitude: input.longitude,
      totalQuantity: input.totalQuantity,
      remainingQuantity: input.totalQuantity,
    });

    return {
      eventId,
      title: input.title,
      eventType: input.eventType,
      startsAt: input.startsAt,
      latitude: input.latitude,
      longitude: input.longitude,
      totalQuantity: input.totalQuantity,
      remainingQuantity: input.totalQuantity,
    };
  }

  // listEvents は開催日順のイベント一覧を正本 DB から返します。
  async listEvents(): Promise<EventSummary[]> {
    const client = await this.database.connect();
    try {
      const result = await client.query<EventListRow>(
        `
          SELECT
            e.id, e.title, e.event_type, e.starts_at,
            e.location_latitude, e.location_longitude,
            i.total_quantity, i.remaining_quantity
          FROM events e
          JOIN ticket_inventory i ON i.event_id = e.id
          ORDER BY e.starts_at ASC
          LIMIT 50
        `,
      );
      return result.rows.map(toEventSummary);
    } finally {
      client.release();
    }
  }

  // searchEvents は OpenSearch を優先し、未設定時は DB へフォールバックします。
  // DB フォールバックは位置情報検索に対応しない（OpenSearch 前提の機能のため）。
  async searchEvents(params: SearchParams): Promise<SearchedEvent[]> {
    const fromSearch = await this.searchService.search(params);
    if (fromSearch !== null) {
      return fromSearch;
    }

    const client = await this.database.connect();
    try {
      const conditions: string[] = [];
      const values: unknown[] = [];

      if (params.eventType) {
        values.push(params.eventType);
        conditions.push(`e.event_type = $${values.length}`);
      }
      if (params.date) {
        values.push(params.date);
        conditions.push(
          `e.starts_at >= $${values.length}::date AND e.starts_at < ($${values.length}::date + INTERVAL '1 day')`,
        );
      }

      const where = conditions.length
        ? `WHERE ${conditions.join(' AND ')}`
        : '';
      const result = await client.query<EventListRow>(
        `
          SELECT
            e.id, e.title, e.event_type, e.starts_at,
            e.location_latitude, e.location_longitude,
            i.total_quantity, i.remaining_quantity
          FROM events e
          JOIN ticket_inventory i ON i.event_id = e.id
          ${where}
          ORDER BY e.starts_at ASC
          LIMIT 20
        `,
        values,
      );
      return result.rows.map((row) => ({
        eventId: row.id,
        title: row.title,
        eventType: row.event_type,
        startsAt: row.starts_at,
        latitude: row.location_latitude ? Number(row.location_latitude) : null,
        longitude: row.location_longitude
          ? Number(row.location_longitude)
          : null,
        remainingQuantity: row.remaining_quantity,
      }));
    } finally {
      client.release();
    }
  }
}

function toEventSummary(row: EventListRow): EventSummary {
  return {
    eventId: row.id,
    title: row.title,
    eventType: row.event_type,
    startsAt: row.starts_at,
    latitude: row.location_latitude ? Number(row.location_latitude) : null,
    longitude: row.location_longitude ? Number(row.location_longitude) : null,
    totalQuantity: row.total_quantity,
    remainingQuantity: row.remaining_quantity,
  };
}

// parseCreateEventInput は外部入力を検証し、信用できる登録入力へ変換します。
function parseCreateEventInput(body: unknown): ParsedCreateEventInput {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('request body must be an object');
  }
  const requestBody = body as CreateEventBody;

  if (
    typeof requestBody.title !== 'string' ||
    requestBody.title.length === 0 ||
    requestBody.title.length > 200
  ) {
    throw new BadRequestException('title must be a non-empty string (max 200)');
  }

  if (
    typeof requestBody.eventType !== 'string' ||
    requestBody.eventType.length === 0 ||
    requestBody.eventType.length > 50
  ) {
    throw new BadRequestException(
      'eventType must be a non-empty string (max 50)',
    );
  }

  if (
    typeof requestBody.startsAt !== 'string' ||
    Number.isNaN(Date.parse(requestBody.startsAt))
  ) {
    throw new BadRequestException('startsAt must be an ISO 8601 datetime');
  }

  const latitude = parseOptionalCoordinate(requestBody.latitude, 90, 'latitude');
  const longitude = parseOptionalCoordinate(
    requestBody.longitude,
    180,
    'longitude',
  );
  // 位置情報は緯度・経度セットでのみ意味を持つため、片方だけの指定は拒否します。
  if ((latitude === null) !== (longitude === null)) {
    throw new BadRequestException(
      'latitude and longitude must be provided together',
    );
  }

  if (
    typeof requestBody.totalQuantity !== 'number' ||
    !Number.isInteger(requestBody.totalQuantity) ||
    requestBody.totalQuantity <= 0 ||
    requestBody.totalQuantity > POSTGRES_INT4_MAX
  ) {
    throw new BadRequestException(
      'totalQuantity must be a positive integer up to 2147483647',
    );
  }

  return {
    title: requestBody.title,
    eventType: requestBody.eventType,
    startsAt: new Date(requestBody.startsAt).toISOString(),
    latitude,
    longitude,
    totalQuantity: requestBody.totalQuantity,
  };
}

function parseOptionalCoordinate(
  value: unknown,
  absMax: number,
  name: string,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || Math.abs(value) > absMax) {
    throw new BadRequestException(`${name} must be a number within ±${absMax}`);
  }
  return value;
}
