// ファイル概要:
// このファイルは Ticket Type 単位 Valkey 前段フィルタ（Issue #389）の focused 統合テストです。
// 実 PostgreSQL（TEST_DATABASE_URL）と実 Valkey（TEST_VALKEY_URL）を使い、
// PurchasesService の Ticket Type 経路を end-to-end で検証します。
//
// - 同一 Event の Type A/B への並行購入が相互の counter を消費しない
// - PostgreSQL 最終在庫の超過が 0 件
// - 補償・replay 後の Type 別 DB/Valkey 差分が 0 件
//
// TEST_DATABASE_URL 未設定時は skip し、CI と明示的な local 統合テストで実行します。
// 既存 CI の PostgreSQL / Valkey service container をそのまま使い、新規 workflow は追加しません。
// npm test（jest）から実行されます。

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Client, Pool } from 'pg';
import { DataSource } from 'typeorm';
import { InventoryCacheService } from '../cache/inventory-cache.service';
import { DatabaseService } from '../database/database.service';
import { DomainEventsService } from '../messaging/domain-events.service';
import { PurchasesService } from './purchases.service';
import { TicketTypeResolverService } from './ticket-type-resolver.service';
import { Baseline1751594400000 } from '../database/migrations/1751594400000-baseline';
import { AddUsers1783251707172 } from '../database/migrations/1783251707172-add-users';
import { AddPurchasesBuyerFk1783252676631 } from '../database/migrations/1783252676631-add-purchases-buyer-fk';
import { AddRefreshTokens1783307740648 } from '../database/migrations/1783307740648-add-refresh-tokens';
import { AddEventsCreatedBy1783342791808 } from '../database/migrations/1783342791808-add-events-created-by';
import { AddTicketTypeExpandSchema1785128190273 } from '../database/migrations/1785128190273-add-ticket-type-expand-schema';
import { AddTicketTypeCompatibilityWriter1785542400000 } from '../database/migrations/1785542400000-add-ticket-type-compatibility-writer';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_VALKEY_URL = process.env.TEST_VALKEY_URL ?? 'redis://127.0.0.1:6379';
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

const MIGRATIONS = [
  Baseline1751594400000,
  AddUsers1783251707172,
  AddPurchasesBuyerFk1783252676631,
  AddRefreshTokens1783307740648,
  AddEventsCreatedBy1783342791808,
  AddTicketTypeExpandSchema1785128190273,
  AddTicketTypeCompatibilityWriter1785542400000,
];

jest.setTimeout(120_000);

const ttKey = (eventId: string, ticketTypeId: string) =>
  `inventory:ticket-type:{${eventId}:${ticketTypeId}}:remaining`;

describeWithPostgres(
  'Ticket Type 単位 Valkey 前段フィルタ（実 PostgreSQL + 実 Valkey）',
  () => {
    let adminClient: Client;
    let databaseUrlTemplate: URL;
    let inspector: Redis;

    beforeAll(async () => {
      if (!TEST_DATABASE_URL) return;
      databaseUrlTemplate = new URL(TEST_DATABASE_URL);
      const adminUrl = new URL(databaseUrlTemplate);
      adminUrl.pathname = '/postgres';
      adminClient = new Client({ connectionString: adminUrl.toString() });
      await adminClient.connect();
      process.env.VALKEY_URL = TEST_VALKEY_URL;
      inspector = new Redis(TEST_VALKEY_URL, { maxRetriesPerRequest: 1 });
      await inspector.ping();
    });

    afterAll(async () => {
      if (adminClient) await adminClient.end();
      if (inspector) inspector.disconnect();
    });

    async function withHarness<T>(
      run: (ctx: {
        dataSource: DataSource;
        service: PurchasesService;
        cache: InventoryCacheService;
        resolver: TicketTypeResolverService;
        seedEvent: (perType: number[]) => Promise<{
          eventId: string;
          typeIds: string[];
        }>;
        seedUser: () => Promise<string>;
        dbRemaining: (ticketTypeId: string) => Promise<number>;
        valkeyRemaining: (
          eventId: string,
          ticketTypeId: string,
        ) => Promise<number | null>;
        setWriterMode: (mode: 'legacy' | 'ticket_type') => Promise<void>;
      }) => Promise<T>,
    ): Promise<T> {
      const databaseName = [
        'tt_valkey',
        process.pid,
        randomUUID().replaceAll('-', '').slice(0, 12),
      ].join('_');
      const quotedName = `"${databaseName}"`;
      await adminClient.query(
        `CREATE DATABASE ${quotedName} TEMPLATE template0`,
      );
      const databaseUrl = new URL(databaseUrlTemplate);
      databaseUrl.pathname = `/${databaseName}`;

      const dataSource = new DataSource({
        type: 'postgres',
        url: databaseUrl.toString(),
        entities: [],
        migrations: MIGRATIONS,
        migrationsTableName: 'typeorm_migrations',
      });
      const pool = new Pool({ connectionString: databaseUrl.toString(), max: 10 });
      const cache = new InventoryCacheService();
      const createdTtKeys: string[] = [];

      try {
        await dataSource.initialize();
        await dataSource.runMigrations({ transaction: 'each' });

        const database = {
          connect: () => pool.connect(),
        } as unknown as DatabaseService;
        const resolver = new TicketTypeResolverService(database);
        const service = new PurchasesService(
          database,
          cache,
          { publish: jest.fn(async () => undefined) } as unknown as DomainEventsService,
          resolver,
        );

        const seedUser = async (): Promise<string> => {
          const userId = randomUUID();
          await dataSource.query(
            `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')`,
            [userId, `tt-${randomUUID()}@example.com`],
          );
          return userId;
        };

        // seedEvent は default Type + 追加 Type を作り、DB と Valkey の Type 在庫を
        // 同値で seed する（#378 seed の analog）。perType[0] が default Type の在庫。
        // ticket_inventory は active writer である legacy mode でしか直接 insert できず、
        // 追加 Type 在庫は active writer である ticket_type mode でしか insert できないため、
        // base 作成は legacy、Type 調整は ticket_type と mode を切り替えて seed する。
        const seedEvent = async (
          perType: number[],
        ): Promise<{ eventId: string; typeIds: string[] }> => {
          const eventId = randomUUID();
          const total = perType.reduce((a, b) => a + b, 0);
          await switchWriterMode(dataSource, 'legacy');
          await dataSource.query(
            `
              INSERT INTO events (id, title, event_type, starts_at)
              VALUES ($1, 'tt fixture', 'music', '2032-01-01T00:00:00Z')
            `,
            [eventId],
          );
          // legacy 互換 row（Event 集計）。#336 bridge が default Type 在庫へ mirror する。
          await dataSource.query(
            `
              INSERT INTO ticket_inventory (event_id, total_quantity, remaining_quantity)
              VALUES ($1, $2, $2)
            `,
            [eventId, total],
          );
          const defaultRows = await dataSource.query<Array<{ id: string }>>(
            `SELECT id FROM ticket_types WHERE event_id = $1 AND is_default`,
            [eventId],
          );
          const typeIds = [defaultRows[0].id];

          // ここから Type 在庫を扱うため ticket_type mode へ切り替える。
          await switchWriterMode(dataSource, 'ticket_type');
          // default Type の在庫を perType[0] に合わせる（bridge が total で作った値を補正）。
          await dataSource.query(
            `
              UPDATE ticket_type_inventory
              SET total_quantity = $2, remaining_quantity = $2
              WHERE ticket_type_id = $1
            `,
            [typeIds[0], perType[0]],
          );
          for (let i = 1; i < perType.length; i += 1) {
            const extraTypeId = randomUUID();
            await dataSource.query(
              `
                INSERT INTO ticket_types (id, event_id, name, is_default)
                VALUES ($1, $2, $3, false)
              `,
              [extraTypeId, eventId, `Type-${i}`],
            );
            await dataSource.query(
              `
                INSERT INTO ticket_type_inventory (
                  ticket_type_id, event_id, total_quantity, remaining_quantity
                )
                VALUES ($1, $2, $3, $3)
              `,
              [extraTypeId, eventId, perType[i]],
            );
            typeIds.push(extraTypeId);
          }
          // Valkey Type counter を DB と同値で seed する。
          for (let i = 0; i < typeIds.length; i += 1) {
            await cache.initTicketTypeCounter(eventId, typeIds[i], perType[i]);
            createdTtKeys.push(ttKey(eventId, typeIds[i]));
          }
          return { eventId, typeIds };
        };

        const dbRemaining = async (ticketTypeId: string): Promise<number> => {
          const rows = await dataSource.query<
            Array<{ remaining_quantity: number }>
          >(
            `SELECT remaining_quantity FROM ticket_type_inventory WHERE ticket_type_id = $1`,
            [ticketTypeId],
          );
          return rows[0].remaining_quantity;
        };

        const valkeyRemaining = async (
          eventId: string,
          ticketTypeId: string,
        ): Promise<number | null> => {
          const value = await inspector.get(ttKey(eventId, ticketTypeId));
          return value === null ? null : Number(value);
        };

        return await run({
          dataSource,
          service,
          cache,
          resolver,
          seedEvent,
          seedUser,
          dbRemaining,
          valkeyRemaining,
          setWriterMode: (mode) => switchWriterMode(dataSource, mode),
        });
      } finally {
        await cache.onModuleDestroy();
        if (createdTtKeys.length > 0) {
          const revKeys = createdTtKeys.map((k) =>
            k.replace(/:remaining$/, ':revision'),
          );
          await inspector.del(...createdTtKeys, ...revKeys);
        }
        await pool.end();
        if (dataSource.isInitialized) await dataSource.destroy();
        await adminClient.query(`DROP DATABASE ${quotedName} WITH (FORCE)`);
      }
    }

    it('同一 Event の Type A/B への並行購入が相互の counter を消費しない', async () => {
      await withHarness(
        async ({ service, seedEvent, seedUser, dbRemaining, valkeyRemaining }) => {
          const buyer = await seedUser();
          const { eventId, typeIds } = await seedEvent([5, 5]);
          const [typeA, typeB] = typeIds;

          const results = await Promise.all([
            service.createPurchase(
              eventId,
              buyer,
              { quantity: 2 },
              { ticketTypeId: typeA },
            ),
            service.createPurchase(
              eventId,
              buyer,
              { quantity: 3 },
              { ticketTypeId: typeB },
            ),
          ]);

          expect(results.every((r) => r.status === 'confirmed')).toBe(true);

          // Type 別 DB 残数は各 Type の購入分だけ減る（相互に消費しない）。
          expect(await dbRemaining(typeA)).toBe(3);
          expect(await dbRemaining(typeB)).toBe(2);
          // Valkey 差分 0: Type 別 DB/Valkey が一致する。
          expect(await valkeyRemaining(eventId, typeA)).toBe(3);
          expect(await valkeyRemaining(eventId, typeB)).toBe(2);
        },
      );
    });

    it('過剰購入は前段拒否され、PostgreSQL 最終在庫の超過が 0 件', async () => {
      await withHarness(
        async ({ service, seedEvent, seedUser, dbRemaining, valkeyRemaining }) => {
          const { eventId, typeIds } = await seedEvent([3]);
          const [typeA] = typeIds;

          const buyers = await Promise.all([
            seedUser(),
            seedUser(),
            seedUser(),
            seedUser(),
            seedUser(),
          ]);
          const results = await Promise.all(
            buyers.map((buyer) =>
              service.createPurchase(
                eventId,
                buyer,
                { quantity: 1 },
                { ticketTypeId: typeA },
              ),
            ),
          );

          const confirmed = results.filter((r) => r.status === 'confirmed');
          expect(confirmed).toHaveLength(3);
          // 最終在庫は 0 で、負の超過在庫は発生しない。
          expect(await dbRemaining(typeA)).toBe(0);
          expect(await valkeyRemaining(eventId, typeA)).toBe(0);
        },
      );
    });

    it('replay 後も Type 別 DB/Valkey 差分が 0 件（reserve 分を同じ Type へ戻す）', async () => {
      await withHarness(
        async ({ service, seedEvent, seedUser, dbRemaining, valkeyRemaining }) => {
          const buyer = await seedUser();
          const { eventId, typeIds } = await seedEvent([5]);
          const [typeA] = typeIds;

          const first = await service.createPurchase(
            eventId,
            buyer,
            { quantity: 2, requestId: 'replay-key' },
            { ticketTypeId: typeA },
          );
          const second = await service.createPurchase(
            eventId,
            buyer,
            { quantity: 2, requestId: 'replay-key' },
            { ticketTypeId: typeA },
          );

          expect(second).toEqual(first);
          // 購入は 1 回だけ成立。DB 残数は 5 - 2 = 3。
          expect(await dbRemaining(typeA)).toBe(3);
          // 2 回目の reserve は replay 補償で戻るため、Valkey も DB と一致する。
          expect(await valkeyRemaining(eventId, typeA)).toBe(3);
        },
      );
    });

    it('requestId 付き sold-out の DB rejected 後も Type 別 DB/Valkey 差分が 0 件', async () => {
      await withHarness(
        async ({ service, seedEvent, seedUser, dbRemaining, valkeyRemaining }) => {
          const buyer = await seedUser();
          const { eventId, typeIds } = await seedEvent([1]);
          const [typeA] = typeIds;

          // 在庫 1 を確定購入で使い切る。
          await service.createPurchase(
            eventId,
            buyer,
            { quantity: 1 },
            { ticketTypeId: typeA },
          );
          expect(await dbRemaining(typeA)).toBe(0);
          expect(await valkeyRemaining(eventId, typeA)).toBe(0);

          // sold-out 後、requestId 付き request は DB へ進み rejected を永続化する。
          const buyer2 = await seedUser();
          const rejected = await service.createPurchase(
            eventId,
            buyer2,
            { quantity: 1, requestId: 'sold-out-db' },
            { ticketTypeId: typeA },
          );
          expect(rejected.status).toBe('rejected');
          // 在庫消費は成立していないため、Type 別 DB/Valkey はともに 0 のまま一致する。
          expect(await dbRemaining(typeA)).toBe(0);
          expect(await valkeyRemaining(eventId, typeA)).toBe(0);
        },
      );
    });

    it('writer mode drift（reserve 後に legacy へ切替）で rejected は exact release し reserve 前後の Type counter 差分 0', async () => {
      await withHarness(
        async ({
          service,
          cache,
          resolver,
          seedEvent,
          seedUser,
          valkeyRemaining,
          setWriterMode,
        }) => {
          const buyer = await seedUser();
          const { eventId, typeIds } = await seedEvent([0]);
          const [typeA] = typeIds;

          // Valkey Type counter を 1 に上書き（DB legacy 在庫 0 と drift させる）。
          // prefilter は ticket_type で reserve できるが、transaction は legacy で在庫不足。
          await cache.initTicketTypeCounter(eventId, typeA, 1);
          const before = await valkeyRemaining(eventId, typeA);
          expect(before).toBe(1);

          // resolver に ticket_type plan を prime してから DB を legacy へ切り替える。
          resolver.prime(eventId, {
            writerMode: 'ticket_type',
            scope: { kind: 'single', ticketTypeId: typeA },
          });
          await setWriterMode('legacy');

          const result = await service.createPurchase(
            eventId,
            buyer,
            { quantity: 1 },
            { ticketTypeId: typeA },
          );

          // transaction は legacy 在庫 0 で rejected。reserve は exact release され、
          // legacy aggregate は Ticket Type key へ sync されない。
          expect(result.status).toBe('rejected');
          expect(await valkeyRemaining(eventId, typeA)).toBe(before);
        },
      );
    });

    it('writer mode drift で confirmed は reserve が実消費に対応し二重補償しない', async () => {
      await withHarness(
        async ({
          service,
          resolver,
          seedEvent,
          seedUser,
          dbRemaining,
          valkeyRemaining,
          setWriterMode,
        }) => {
          const buyer = await seedUser();
          const { eventId, typeIds } = await seedEvent([3]);
          const [typeA] = typeIds;
          const beforeValkey = await valkeyRemaining(eventId, typeA);
          expect(beforeValkey).toBe(3);

          resolver.prime(eventId, {
            writerMode: 'ticket_type',
            scope: { kind: 'single', ticketTypeId: typeA },
          });
          await setWriterMode('legacy');

          const result = await service.createPurchase(
            eventId,
            buyer,
            { quantity: 1 },
            { ticketTypeId: typeA },
          );

          expect(result.status).toBe('confirmed');
          // reserve が同一論理在庫の消費に対応するため release / sync しない。
          // Valkey は reserve 後の値、legacy mirror 後の default Type DB 残数と一致する（差分 0）。
          expect(await valkeyRemaining(eventId, typeA)).toBe(2);
          expect(await dbRemaining(typeA)).toBe(2);
        },
      );
    });
  },
);

async function switchWriterMode(
  dataSource: DataSource,
  mode: 'legacy' | 'ticket_type',
): Promise<void> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    await runner.query('SELECT pg_advisory_xact_lock(335, 376)');
    await runner.query(
      `
        UPDATE inventory_writer_control
        SET writer_mode = $1, updated_at = now()
        WHERE singleton
      `,
      [mode],
    );
    await runner.commitTransaction();
  } catch (error) {
    await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}
