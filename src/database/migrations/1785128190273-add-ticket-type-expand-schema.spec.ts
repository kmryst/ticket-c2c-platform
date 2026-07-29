// ファイル概要:
// Issue #336 の expand migration を、populated な旧 PostgreSQL 16 database から検証します。
// TEST_DATABASE_URL がある場合だけ、一意な disposable database を test ごとに作成して実行します。

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { DataSource, MigrationInterface, QueryRunner } from 'typeorm';
import {
  checkTicketTypeExpandReadiness,
  hasTicketTypeExpandViolations,
} from '../ticket-type-expand-readiness';
import { Baseline1751594400000 } from './1751594400000-baseline';
import { AddUsers1783251707172 } from './1783251707172-add-users';
import { AddPurchasesBuyerFk1783252676631 } from './1783252676631-add-purchases-buyer-fk';
import { AddRefreshTokens1783307740648 } from './1783307740648-add-refresh-tokens';
import { AddEventsCreatedBy1783342791808 } from './1783342791808-add-events-created-by';
import { AddTicketTypeExpandSchema1785128190273 } from './1785128190273-add-ticket-type-expand-schema';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

const LEGACY_MIGRATIONS = [
  Baseline1751594400000,
  AddUsers1783251707172,
  AddPurchasesBuyerFk1783252676631,
  AddRefreshTokens1783307740648,
  AddEventsCreatedBy1783342791808,
];

interface LegacyFixture {
  buyerId: string;
  eventIds: [string, string];
  purchaseIds: [string, string];
}

interface LegacyInventorySnapshot {
  event_id: string;
  total_quantity: number;
  remaining_quantity: number;
  version: number;
  updated_at: Date;
}

interface LegacyPurchaseSnapshot {
  id: string;
  event_id: string;
  buyer_id: string;
  request_id: string | null;
  quantity: number;
  status: 'confirmed' | 'rejected';
  rejection_reason: string | null;
  remaining_quantity_after: number | null;
  created_at: Date;
}

interface CatalogState {
  ticket_types: string | null;
  ticket_type_inventory: string | null;
  purchase_ticket_type_column_count: number;
  bridge_trigger_count: number;
}

interface ExpandCatalogSignature {
  columns: Array<Record<string, unknown>>;
  constraints: Array<Record<string, unknown>>;
  indexes: Array<Record<string, unknown>>;
  triggers: Array<Record<string, unknown>>;
  functions: Array<Record<string, unknown>>;
}

jest.setTimeout(120_000);

describeWithPostgres(
  'AddTicketTypeExpandSchema1785128190273（実 PostgreSQL）',
  () => {
    let adminClient: Client;
    let databaseUrlTemplate: URL;

    beforeAll(async () => {
      if (!TEST_DATABASE_URL) {
        return;
      }

      databaseUrlTemplate = new URL(TEST_DATABASE_URL);
      const adminUrl = new URL(databaseUrlTemplate);
      adminUrl.pathname = '/postgres';
      adminClient = new Client({ connectionString: adminUrl.toString() });
      await adminClient.connect();
    });

    afterAll(async () => {
      if (adminClient) {
        await adminClient.end();
      }
    });

    async function withLegacyDatabase<T>(
      run: (dataSource: DataSource, databaseUrl: string) => Promise<T>,
    ): Promise<T> {
      const databaseName = [
        'ticket_type_expand',
        process.pid,
        randomUUID().replaceAll('-', '').slice(0, 12),
      ].join('_');
      const quotedDatabaseName = quoteIdentifier(databaseName);

      await adminClient.query(
        `CREATE DATABASE ${quotedDatabaseName} TEMPLATE template0`,
      );

      const databaseUrl = new URL(databaseUrlTemplate);
      databaseUrl.pathname = `/${databaseName}`;
      const dataSource = new DataSource({
        type: 'postgres',
        url: databaseUrl.toString(),
        entities: [],
        migrations: LEGACY_MIGRATIONS,
        migrationsTableName: 'typeorm_migrations',
      });

      try {
        await dataSource.initialize();
        await dataSource.runMigrations({ transaction: 'each' });
        return await run(dataSource, databaseUrl.toString());
      } finally {
        if (dataSource.isInitialized) {
          await dataSource.destroy();
        }
        await adminClient.query(
          `DROP DATABASE ${quotedDatabaseName} WITH (FORCE)`,
        );
      }
    }

    it('populated legacy dataを欠損なくbackfillし、名前・既定Type・複合FK制約を強制する', async () => {
      await withLegacyDatabase(async (dataSource) => {
        const fixture = await seedPopulatedLegacyData(dataSource);
        const inventoryBefore =
          await selectLegacyInventorySnapshot(dataSource);
        const purchasesBefore = await selectLegacyPurchaseSnapshot(dataSource);

        await applyMigration(
          dataSource,
          new AddTicketTypeExpandSchema1785128190273(),
          'up',
        );

        // expand 後も旧 table の全値と件数は変化しません。
        expect(await selectLegacyInventorySnapshot(dataSource)).toEqual(
          inventoryBefore,
        );
        expect(await selectLegacyPurchaseSnapshot(dataSource)).toEqual(
          purchasesBefore,
        );

        const defaultTypes = await dataSource.query<
          Array<{
            id: string;
            event_id: string;
            name: string;
            is_default: boolean;
          }>
        >(
          `
            SELECT id, event_id, name, is_default
            FROM ticket_types
            ORDER BY event_id
          `,
        );
        expect(defaultTypes).toHaveLength(fixture.eventIds.length);
        expect(
          defaultTypes.map(({ event_id, name, is_default }) => ({
            event_id,
            name,
            is_default,
          })),
        ).toEqual(
          [...fixture.eventIds].sort().map((eventId) => ({
            event_id: eventId,
            name: 'General Admission',
            is_default: true,
          })),
        );

        const shadowInventory = await dataSource.query<
          LegacyInventorySnapshot[]
        >(
          `
            SELECT
              shadow.event_id,
              shadow.total_quantity,
              shadow.remaining_quantity,
              shadow.version,
              shadow.updated_at
            FROM ticket_type_inventory shadow
            JOIN ticket_types type
              ON type.event_id = shadow.event_id
             AND type.id = shadow.ticket_type_id
            WHERE type.is_default
            ORDER BY shadow.event_id
          `,
        );
        expect(shadowInventory).toEqual(inventoryBefore);

        const linkedPurchases = await dataSource.query<
          Array<{
            purchase_id: string;
            purchase_event_id: string;
            ticket_type_event_id: string;
            is_default: boolean;
          }>
        >(
          `
            SELECT
              purchase.id AS purchase_id,
              purchase.event_id AS purchase_event_id,
              type.event_id AS ticket_type_event_id,
              type.is_default
            FROM purchases purchase
            JOIN ticket_types type
              ON type.event_id = purchase.event_id
             AND type.id = purchase.ticket_type_id
            ORDER BY purchase.id
          `,
        );
        expect(linkedPurchases).toEqual(
          [...fixture.purchaseIds].sort().map((purchaseId, index) => {
            const purchase = purchasesBefore.find(
              ({ id }) => id === purchaseId,
            );
            if (!purchase) {
              throw new Error(`legacy purchase fixture not found: ${index}`);
            }
            return {
              purchase_id: purchaseId,
              purchase_event_id: purchase.event_id,
              ticket_type_event_id: purchase.event_id,
              is_default: true,
            };
          }),
        );

        const [firstEventId, secondEventId] = fixture.eventIds;
        const firstDefault = defaultTypes.find(
          ({ event_id }) => event_id === firstEventId,
        );
        const secondDefault = defaultTypes.find(
          ({ event_id }) => event_id === secondEventId,
        );
        if (!firstDefault || !secondDefault) {
          throw new Error('default Ticket Type backfill fixture not found');
        }

        // lower(name) の functional unique index は大文字小文字違いも重複として拒否します。
        const insertedVip = await dataSource.query<Array<{ id: string }>>(
          `
            INSERT INTO ticket_types (event_id, name, is_default)
            VALUES ($1, 'VIP', false)
            RETURNING id
          `,
          [firstEventId],
        );
        const vipTicketTypeId = insertedVip[0].id;
        await expect(
          dataSource.query(
            `
              INSERT INTO ticket_types (event_id, name, is_default)
              VALUES ($1, 'vip', false)
            `,
            [firstEventId],
          ),
        ).rejects.toMatchObject({ code: '23505' });

        // name は前後空白を保存できず、既定 Type は Event ごとに最大 1 件です。
        await expect(
          dataSource.query(
            `
              INSERT INTO ticket_types (event_id, name, is_default)
              VALUES ($1, ' Premium ', false)
            `,
            [firstEventId],
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          dataSource.query(
            `
              INSERT INTO ticket_types (event_id, name, is_default)
              VALUES ($1, 'Premium', true)
            `,
            [firstEventId],
          ),
        ).rejects.toMatchObject({ code: '23505' });

        // purchases と shadow inventory は、同じ Event に属する Ticket Type だけを参照できます。
        await expect(
          dataSource.query(
            `
              INSERT INTO purchases (
                event_id,
                buyer_id,
                request_id,
                quantity,
                status,
                rejection_reason,
                remaining_quantity_after,
                ticket_type_id
              )
              VALUES ($1, $2, $3, 1, 'confirmed', NULL, 0, $4)
            `,
            [
              firstEventId,
              fixture.buyerId,
              `cross-event-${randomUUID()}`,
              secondDefault.id,
            ],
          ),
        ).rejects.toMatchObject({ code: '23503' });

        await expect(
          dataSource.query(
            `
              INSERT INTO ticket_type_inventory (
                event_id,
                ticket_type_id,
                total_quantity,
                remaining_quantity,
                version
              )
              VALUES ($1, $2, 1, 1, 0)
            `,
            [secondEventId, vipTicketTypeId],
          ),
        ).rejects.toMatchObject({ code: '23503' });

        const ticketTypeForeignKeys = await dataSource.query<
          Array<{ table_name: string; convalidated: boolean }>
        >(
          `
            SELECT
              constraint_table.relname AS table_name,
              database_constraint.convalidated
            FROM pg_constraint database_constraint
            JOIN pg_class constraint_table
              ON constraint_table.oid = database_constraint.conrelid
            WHERE database_constraint.contype = 'f'
              AND database_constraint.confrelid = 'ticket_types'::regclass
            ORDER BY constraint_table.relname
          `,
        );
        expect(ticketTypeForeignKeys).toEqual([
          { table_name: 'purchases', convalidated: true },
          { table_name: 'ticket_type_inventory', convalidated: true },
        ]);
      });
    });

    it('production data-sourceの登録済みmigrationをpopulated DBへ適用し、履歴と再実行no-opを保証する', async () => {
      await withLegacyDatabase(async (legacyDataSource, databaseUrl) => {
        await seedPopulatedLegacyData(legacyDataSource);

        const previousDatabaseUrl = process.env.DATABASE_URL;
        const previousDatabaseSsl = process.env.DB_SSL;
        let productionDataSource: DataSource | undefined;

        try {
          process.env.DATABASE_URL = databaseUrl;
          process.env.DB_SSL = 'false';
          jest.resetModules();

          const productionModule = jest.requireActual<{
            dataSource: DataSource;
          }>('../data-source');
          const initializedDataSource = productionModule.dataSource;
          productionDataSource = initializedDataSource;
          await initializedDataSource.initialize();

          // data-source.ts の明示列挙から migration が抜けると、この検査と履歴検査が失敗します。
          expect(
            initializedDataSource.migrations.map(
              (migration) => migration.name,
            ),
          ).toContain('AddTicketTypeExpandSchema1785128190273');

          const firstRun = await initializedDataSource.runMigrations({
            transaction: 'each',
          });
          expect(firstRun.map((migration) => migration.name)).toEqual([
            'AddTicketTypeExpandSchema1785128190273',
          ]);

          const history = await initializedDataSource.query<
            Array<{ name: string }>
          >(
            `
              SELECT name
              FROM typeorm_migrations
              ORDER BY id
            `,
          );
          expect(history.map(({ name }) => name)).toEqual([
            'Baseline1751594400000',
            'AddUsers1783251707172',
            'AddPurchasesBuyerFk1783252676631',
            'AddRefreshTokens1783307740648',
            'AddEventsCreatedBy1783342791808',
            'AddTicketTypeExpandSchema1785128190273',
          ]);

          const secondRun = await initializedDataSource.runMigrations({
            transaction: 'each',
          });
          expect(secondRun).toEqual([]);

          const readiness =
            await checkTicketTypeExpandReadiness(initializedDataSource);
          expect(hasTicketTypeExpandViolations(readiness)).toBe(false);
        } finally {
          if (productionDataSource?.isInitialized) {
            await productionDataSource.destroy();
          }
          restoreEnvironmentVariable('DATABASE_URL', previousDatabaseUrl);
          restoreEnvironmentVariable('DB_SSL', previousDatabaseSsl);
          jest.resetModules();
        }
      });
    });

    it('旧EventsServiceとPurchasesServiceのSQL shapeを変えずにlive writeをshadowへ収束させる', async () => {
      await withLegacyDatabase(async (dataSource) => {
        await applyMigration(
          dataSource,
          new AddTicketTypeExpandSchema1785128190273(),
          'up',
        );

        const buyerId = randomUUID();
        await dataSource.query(
          `
            INSERT INTO users (id, email, password_hash)
            VALUES ($1, $2, 'test-password-hash')
          `,
          [buyerId, `mixed-binary-${randomUUID()}@example.com`],
        );

        const eventWriter = dataSource.createQueryRunner();
        await eventWriter.connect();
        await eventWriter.startTransaction();
        let eventId: string;
        try {
          const inserted = await eventWriter.query(
            `
              INSERT INTO events (
                title,
                event_type,
                starts_at,
                location_latitude,
                location_longitude,
                created_by
              )
              VALUES ($1, $2, $3, $4, $5, $6)
              RETURNING id, created_at
            `,
            [
              'Mixed binary event',
              'music',
              '2031-04-05T10:00:00.000Z',
              '35.681236',
              '139.767125',
              buyerId,
            ],
          );
          eventId = (inserted as Array<{ id: string }>)[0].id;

          await eventWriter.query(
            `
              INSERT INTO ticket_inventory (
                event_id,
                total_quantity,
                remaining_quantity
              )
              VALUES ($1, $2, $2)
            `,
            [eventId, 25],
          );
          await eventWriter.commitTransaction();
        } catch (error) {
          await eventWriter.rollbackTransaction();
          throw error;
        } finally {
          await eventWriter.release();
        }

        // 旧 Event 一覧の join はそのまま動き、bridge は同一 transaction で shadow を作ります。
        const oldEventList = await dataSource.query<
          Array<{
            id: string;
            total_quantity: number;
            remaining_quantity: number;
          }>
        >(
          `
            SELECT
              event.id,
              inventory.total_quantity,
              inventory.remaining_quantity
            FROM events event
            JOIN ticket_inventory inventory ON inventory.event_id = event.id
            WHERE event.id = $1
          `,
          [eventId],
        );
        expect(oldEventList).toEqual([
          {
            id: eventId,
            total_quantity: 25,
            remaining_quantity: 25,
          },
        ]);

        const purchaseWriter = dataSource.createQueryRunner();
        await purchaseWriter.connect();
        await purchaseWriter.startTransaction();
        let purchaseId: string;
        try {
          await purchaseWriter.query(
            'SELECT id FROM events WHERE id = $1 FOR SHARE',
            [eventId],
          );
          const inventoryUpdate = await purchaseWriter.query(
            `
              UPDATE ticket_inventory
              SET
                remaining_quantity = remaining_quantity - $2,
                version = version + 1,
                updated_at = now()
              WHERE event_id = $1
                AND remaining_quantity >= $2
              RETURNING remaining_quantity
            `,
            [eventId, 3],
          );
          const remainingQuantity = (
            inventoryUpdate as Array<{ remaining_quantity: number }>
          )[0].remaining_quantity;

          const purchase = await purchaseWriter.query(
            `
              INSERT INTO purchases (
                event_id,
                buyer_id,
                request_id,
                quantity,
                status,
                rejection_reason,
                remaining_quantity_after
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7)
              RETURNING id
            `,
            [
              eventId,
              buyerId,
              `mixed-binary-${randomUUID()}`,
              3,
              'confirmed',
              null,
              remainingQuantity,
            ],
          );
          purchaseId = (purchase as Array<{ id: string }>)[0].id;
          await purchaseWriter.commitTransaction();
        } catch (error) {
          await purchaseWriter.rollbackTransaction();
          throw error;
        } finally {
          await purchaseWriter.release();
        }

        const converged = await dataSource.query<
          Array<{
            event_id: string;
            total_quantity: number;
            legacy_remaining: number;
            shadow_remaining: number;
            legacy_version: number;
            shadow_version: number;
            purchase_ticket_type_id: string;
            default_ticket_type_id: string;
          }>
        >(
          `
            SELECT
              legacy.event_id,
              legacy.total_quantity,
              legacy.remaining_quantity AS legacy_remaining,
              shadow.remaining_quantity AS shadow_remaining,
              legacy.version AS legacy_version,
              shadow.version AS shadow_version,
              purchase.ticket_type_id AS purchase_ticket_type_id,
              type.id AS default_ticket_type_id
            FROM ticket_inventory legacy
            JOIN ticket_types type
              ON type.event_id = legacy.event_id
             AND type.is_default
            JOIN ticket_type_inventory shadow
              ON shadow.event_id = type.event_id
             AND shadow.ticket_type_id = type.id
            JOIN purchases purchase
              ON purchase.event_id = type.event_id
             AND purchase.id = $2
            WHERE legacy.event_id = $1
          `,
          [eventId, purchaseId],
        );
        expect(converged).toEqual([
          {
            event_id: eventId,
            total_quantity: 25,
            legacy_remaining: 22,
            shadow_remaining: 22,
            legacy_version: 1,
            shadow_version: 1,
            purchase_ticket_type_id: converged[0].default_ticket_type_id,
            default_ticket_type_id: converged[0].default_ticket_type_id,
          },
        ]);
      });
    });

    it('旧purchase transactionの完了をevents lockで待ち、deadlockせずbackfillへ取り込む', async () => {
      await withLegacyDatabase(async (dataSource) => {
        const fixture = await seedPopulatedLegacyData(dataSource);
        const [eventId] = fixture.eventIds;
        const oldPurchaseWriter = dataSource.createQueryRunner();
        const migrationRunner = dataSource.createQueryRunner();
        let migrationOutcomePromise:
          | Promise<{ error: unknown | undefined }>
          | undefined;
        let purchaseId: string | undefined;

        await oldPurchaseWriter.connect();
        await migrationRunner.connect();
        await oldPurchaseWriter.startTransaction();

        try {
          // 現行 PurchasesService と同じ events FOR SHARE と purchases read を先に保持します。
          await oldPurchaseWriter.query("SET LOCAL statement_timeout = '5s'");
          await oldPurchaseWriter.query(
            'SELECT id FROM events WHERE id = $1 FOR SHARE',
            [eventId],
          );
          await oldPurchaseWriter.query(
            'SELECT id FROM purchases WHERE event_id = $1 LIMIT 1',
            [eventId],
          );

          await migrationRunner.startTransaction();
          const migrationBackend = await migrationRunner.query(
            'SELECT pg_backend_pid()::int AS pid',
          );
          const migrationBackendPid = (
            migrationBackend as Array<{ pid: number }>
          )[0].pid;
          migrationOutcomePromise = runMigrationInStartedTransaction(
            migrationRunner,
            new AddTicketTypeExpandSchema1785128190273(),
          );

          // 固定 sleep ではなく、events の EXCLUSIVE lock が旧 writer を待つ状態を観測します。
          await waitForMigrationEventLockWait(
            dataSource,
            migrationBackendPid,
          );

          const inventoryUpdate = await oldPurchaseWriter.query(
            `
              UPDATE ticket_inventory
              SET
                remaining_quantity = remaining_quantity - $2,
                version = version + 1,
                updated_at = now()
              WHERE event_id = $1
                AND remaining_quantity >= $2
              RETURNING remaining_quantity
            `,
            [eventId, 2],
          );
          const remainingQuantity = (
            inventoryUpdate as Array<{ remaining_quantity: number }>
          )[0].remaining_quantity;

          const insertedPurchase = await oldPurchaseWriter.query(
            `
              INSERT INTO purchases (
                event_id,
                buyer_id,
                request_id,
                quantity,
                status,
                rejection_reason,
                remaining_quantity_after
              )
              VALUES ($1, $2, $3, 2, 'confirmed', NULL, $4)
              RETURNING id
            `,
            [
              eventId,
              fixture.buyerId,
              `lock-order-${randomUUID()}`,
              remainingQuantity,
            ],
          );
          purchaseId = (insertedPurchase as Array<{ id: string }>)[0].id;
          await oldPurchaseWriter.commitTransaction();

          const migrationOutcome = await migrationOutcomePromise;
          if (migrationOutcome.error) {
            throw migrationOutcome.error;
          }

          const convergedRows = await dataSource.query<
            Array<{
              purchase_id: string;
              purchase_ticket_type_id: string;
              default_ticket_type_id: string;
              legacy_remaining: number;
              shadow_remaining: number;
            }>
          >(
            `
              SELECT
                purchase.id AS purchase_id,
                purchase.ticket_type_id AS purchase_ticket_type_id,
                type.id AS default_ticket_type_id,
                legacy.remaining_quantity AS legacy_remaining,
                shadow.remaining_quantity AS shadow_remaining
              FROM purchases purchase
              JOIN ticket_types type
                ON type.event_id = purchase.event_id
               AND type.id = purchase.ticket_type_id
               AND type.is_default
              JOIN ticket_inventory legacy
                ON legacy.event_id = purchase.event_id
              JOIN ticket_type_inventory shadow
                ON shadow.event_id = type.event_id
               AND shadow.ticket_type_id = type.id
              WHERE purchase.id = $1
            `,
            [purchaseId],
          );
          expect(convergedRows).toEqual([
            {
              purchase_id: purchaseId,
              purchase_ticket_type_id:
                convergedRows[0].default_ticket_type_id,
              default_ticket_type_id: convergedRows[0].default_ticket_type_id,
              legacy_remaining: 71,
              shadow_remaining: 71,
            },
          ]);
        } finally {
          if (oldPurchaseWriter.isTransactionActive) {
            await oldPurchaseWriter.rollbackTransaction();
          }
          await oldPurchaseWriter.release();

          // writer の lock を必ず解放してから migration の完了を待ち、接続を残しません。
          if (migrationOutcomePromise) {
            await migrationOutcomePromise;
          }
          if (migrationRunner.isTransactionActive) {
            await migrationRunner.rollbackTransaction();
          }
          await migrationRunner.release();
        }
      });
    });

    it('PoC型の後段lock先取では55P03でfail-fastし、PoC完了後のretryに成功する', async () => {
      await withLegacyDatabase(async (dataSource) => {
        const fixture = await seedPopulatedLegacyData(dataSource);
        const eventId = randomUUID();
        const pocInventoryWriter = dataSource.createQueryRunner();
        const migrationRunner = dataSource.createQueryRunner();
        let pocInsertOutcomePromise:
          | Promise<{ error: unknown | undefined }>
          | undefined;

        // PoC script と同じく Event INSERT は先に autocommit します。
        await dataSource.query(
          `
            INSERT INTO events (
              id,
              title,
              event_type,
              starts_at,
              created_by
            )
            VALUES (
              $1,
              'PoC split autocommit event',
              'music',
              '2032-01-01T00:00:00Z',
              $2
            )
          `,
          [eventId, fixture.buyerId],
        );

        await pocInventoryWriter.connect();
        await migrationRunner.connect();

        try {
          await migrationRunner.startTransaction();
          await migrationRunner.query(
            'LOCK TABLE events IN EXCLUSIVE MODE',
          );
          const migrationBackend = await migrationRunner.query(
            'SELECT pg_backend_pid()::int AS pid',
          );
          const migrationBackendPid = (
            migrationBackend as Array<{ pid: number }>
          )[0].pid;
          const pocBackend = await pocInventoryWriter.query(
            'SELECT pg_backend_pid()::int AS pid',
          );
          const pocBackendPid = (pocBackend as Array<{ pid: number }>)[0].pid;

          // Event gate を取得済みの境界から、PoC の別 autocommit inventory INSERT を開始します。
          // INSERT は target table の RowExclusiveLock を得てから FK 検査で events を待ちます。
          pocInsertOutcomePromise = settleDatabaseOperation(
            pocInventoryWriter.query(
              `
                INSERT INTO ticket_inventory (
                  event_id,
                  total_quantity,
                  remaining_quantity
                )
                VALUES ($1, 10, 10)
              `,
              [eventId],
            ),
          );

          await waitForPocEventLockWait(dataSource, pocBackendPid);

          // events gate と PoC INSERT の inventory lock が同時に存在し、
          // PoC 側は FK 検査で events を待つ循環前提を実 catalog で確認します。
          const competingLocks = await dataSource.query<
            Array<{
              migration_event_gate_granted: boolean;
              poc_inventory_lock_granted: boolean;
            }>
          >(
            `
              SELECT
                EXISTS (
                  SELECT 1
                  FROM pg_locks database_lock
                  JOIN pg_class relation
                    ON relation.oid = database_lock.relation
                  JOIN pg_namespace relation_namespace
                    ON relation_namespace.oid = relation.relnamespace
                  WHERE database_lock.pid = $1
                    AND relation_namespace.nspname = 'public'
                    AND relation.relname = 'events'
                    AND database_lock.mode = 'ExclusiveLock'
                    AND database_lock.granted
                ) AS migration_event_gate_granted,
                EXISTS (
                  SELECT 1
                  FROM pg_locks database_lock
                  JOIN pg_class relation
                    ON relation.oid = database_lock.relation
                  JOIN pg_namespace relation_namespace
                    ON relation_namespace.oid = relation.relnamespace
                  WHERE database_lock.pid = $2
                    AND relation_namespace.nspname = 'public'
                    AND relation.relname = 'ticket_inventory'
                    AND database_lock.mode = 'RowExclusiveLock'
                    AND database_lock.granted
                ) AS poc_inventory_lock_granted
            `,
            [migrationBackendPid, pocBackendPid],
          );
          expect(competingLocks).toEqual([
            {
              migration_event_gate_granted: true,
              poc_inventory_lock_granted: true,
            },
          ]);

          let migrationError: unknown;
          try {
            await new AddTicketTypeExpandSchema1785128190273().up(
              migrationRunner,
            );
          } catch (error) {
            migrationError = error;
          }
          expect(migrationError).toMatchObject({ code: '55P03' });

          // migration が相手を待たず rollback すると events gate が外れ、PoC INSERT が完了します。
          if (migrationRunner.isTransactionActive) {
            await migrationRunner.rollbackTransaction();
          }
          const pocInsertOutcome = await pocInsertOutcomePromise;
          expect(pocInsertOutcome.error).toBeUndefined();

          const insertedInventory = await dataSource.query<
            Array<{
              event_id: string;
              total_quantity: number;
              remaining_quantity: number;
            }>
          >(
            `
              SELECT event_id, total_quantity, remaining_quantity
              FROM ticket_inventory
              WHERE event_id = $1
            `,
            [eventId],
          );
          expect(insertedInventory).toEqual([
            {
              event_id: eventId,
              total_quantity: 10,
              remaining_quantity: 10,
            },
          ]);

          await applyMigration(
            dataSource,
            new AddTicketTypeExpandSchema1785128190273(),
            'up',
          );
          const readiness = await checkTicketTypeExpandReadiness(dataSource);
          expect(hasTicketTypeExpandViolations(readiness)).toBe(false);
        } finally {
          if (migrationRunner.isTransactionActive) {
            await migrationRunner.rollbackTransaction();
          }
          if (pocInsertOutcomePromise) {
            await pocInsertOutcomePromise;
          }
          await migrationRunner.release();
          await pocInventoryWriter.release();
        }
      });
    });

    it('legacy inventoryがないEventを検出するとup全体をrollbackする', async () => {
      await withLegacyDatabase(async (dataSource) => {
        const eventId = randomUUID();
        await dataSource.query(
          `
            INSERT INTO events (id, title, event_type, starts_at)
            VALUES ($1, 'Missing inventory', 'music', '2031-01-01T00:00:00Z')
          `,
          [eventId],
        );

        await expect(
          applyMigration(
            dataSource,
            new AddTicketTypeExpandSchema1785128190273(),
            'up',
          ),
        ).rejects.toThrow(
          'ticket type expand migration aborted: legacy event without ticket_inventory',
        );

        const tableState = await dataSource.query<
          Array<{
            ticket_types: string | null;
            ticket_type_inventory: string | null;
            ticket_type_column_count: number;
          }>
        >(
          `
            SELECT
              to_regclass('public.ticket_types')::text AS ticket_types,
              to_regclass('public.ticket_type_inventory')::text
                AS ticket_type_inventory,
              (
                SELECT count(*)::int
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'purchases'
                  AND column_name = 'ticket_type_id'
              ) AS ticket_type_column_count
          `,
        );
        expect(tableState).toEqual([
          {
            ticket_types: null,
            ticket_type_inventory: null,
            ticket_type_column_count: 0,
          },
        ]);

        const legacyEventCount = await dataSource.query<
          Array<{ count: number }>
        >('SELECT count(*)::int AS count FROM events WHERE id = $1', [eventId]);
        expect(legacyEventCount[0].count).toBe(1);
      });
    });

    it('DDLとbackfill後の意図的な関数衝突を全rollbackし、衝突解消後に再試行できる', async () => {
      await withLegacyDatabase(async (dataSource) => {
        await seedPopulatedLegacyData(dataSource);
        const inventoryBefore =
          await selectLegacyInventorySnapshot(dataSource);
        const purchasesBefore = await selectLegacyPurchaseSnapshot(dataSource);

        // CREATE TABLE / backfill の後に実行される bridge 関数作成だけを衝突させます。
        await dataSource.query(
          `
            CREATE FUNCTION ticket_type_expand_create_default_ticket_type()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$
            BEGIN
              RETURN NEW;
            END
            $$
          `,
        );

        await expect(
          applyMigration(
            dataSource,
            new AddTicketTypeExpandSchema1785128190273(),
            'up',
          ),
        ).rejects.toMatchObject({ code: '42723' });

        expect(await selectCatalogState(dataSource)).toEqual({
          ticket_types: null,
          ticket_type_inventory: null,
          purchase_ticket_type_column_count: 0,
          bridge_trigger_count: 0,
        });
        expect(await selectLegacyInventorySnapshot(dataSource)).toEqual(
          inventoryBefore,
        );
        expect(await selectLegacyPurchaseSnapshot(dataSource)).toEqual(
          purchasesBefore,
        );

        const conflictingFunction = await dataSource.query<
          Array<{ function_name: string | null }>
        >(
          `
            SELECT
              to_regprocedure(
                'ticket_type_expand_create_default_ticket_type()'
              )::text AS function_name
          `,
        );
        expect(conflictingFunction[0].function_name).toBe(
          'ticket_type_expand_create_default_ticket_type()',
        );

        await dataSource.query(
          'DROP FUNCTION ticket_type_expand_create_default_ticket_type()',
        );
        await applyMigration(
          dataSource,
          new AddTicketTypeExpandSchema1785128190273(),
          'up',
        );

        expect(await selectCatalogState(dataSource)).toEqual({
          ticket_types: 'ticket_types',
          ticket_type_inventory: 'ticket_type_inventory',
          purchase_ticket_type_column_count: 1,
          bridge_trigger_count: 3,
        });
        const readiness = await checkTicketTypeExpandReadiness(dataSource);
        expect(hasTicketTypeExpandViolations(readiness)).toBe(false);
      });
    });

    it('無効化されたbridge triggerと、その後のlegacy/shadow差分をfail closedで検出する', async () => {
      await withLegacyDatabase(async (dataSource) => {
        const fixture = await seedPopulatedLegacyData(dataSource);
        await applyMigration(
          dataSource,
          new AddTicketTypeExpandSchema1785128190273(),
          'up',
        );

        const healthy = await checkTicketTypeExpandReadiness(dataSource);
        expect(hasTicketTypeExpandViolations(healthy)).toBe(false);

        await dataSource.query(
          `
            ALTER TABLE ticket_inventory
              DISABLE TRIGGER ticket_inventory_ticket_type_expand_sync_trg
          `,
        );
        const disabledTrigger =
          await checkTicketTypeExpandReadiness(dataSource);
        const disabledCounts = new Map(
          disabledTrigger.map(({ category, violationCount }) => [
            category,
            violationCount,
          ]),
        );
        expect(
          disabledCounts.get('required_bridge_trigger_missing_or_disabled'),
        ).toBe(1);
        expect(hasTicketTypeExpandViolations(disabledTrigger)).toBe(true);

        await dataSource.query(
          `
            UPDATE ticket_inventory
            SET
              total_quantity = total_quantity + 1,
              remaining_quantity = remaining_quantity - 1,
              version = version + 1,
              updated_at = now()
            WHERE event_id = $1
          `,
          [fixture.eventIds[0]],
        );

        const drifted = await checkTicketTypeExpandReadiness(dataSource);
        const driftedCounts = new Map(
          drifted.map(({ category, violationCount }) => [
            category,
            violationCount,
          ]),
        );
        expect(
          driftedCounts.get('required_bridge_trigger_missing_or_disabled'),
        ).toBe(1);
        expect(driftedCounts.get('legacy_shadow_total_mismatch')).toBe(1);
        expect(driftedCounts.get('legacy_shadow_remaining_mismatch')).toBe(1);
        expect(driftedCounts.get('legacy_shadow_version_mismatch')).toBe(1);
        expect(driftedCounts.get('legacy_shadow_updated_at_mismatch')).toBe(1);
        expect(hasTicketTypeExpandViolations(drifted)).toBe(true);
      });
    });

    it('同名objectの列・即時性・function本文・index式driftとNOT NULL欠落を検出する', async () => {
      await withLegacyDatabase(async (dataSource) => {
        await seedPopulatedLegacyData(dataSource);
        await applyMigration(
          dataSource,
          new AddTicketTypeExpandSchema1785128190273(),
          'up',
        );

        // 名前・対象table・参照先tableが同じでも、Event所有関係を守らないFKへ差し替えます。
        await dataSource.query(`
          ALTER TABLE purchases
            DROP CONSTRAINT purchases_event_ticket_type_fkey;
          ALTER TABLE purchases
            ADD CONSTRAINT purchases_event_ticket_type_fkey
            FOREIGN KEY (ticket_type_id)
            REFERENCES ticket_types(id)
            ON DELETE RESTRICT;
        `);

        // 同じevent・function・tgtypeでも、遅延constraint triggerは同一transaction内の
        // 即時同期を保証しません。
        await dataSource.query(`
          DROP TRIGGER events_ticket_type_expand_default_trg ON events;
          CREATE CONSTRAINT TRIGGER events_ticket_type_expand_default_trg
          AFTER INSERT ON events
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW
          EXECUTE FUNCTION ticket_type_expand_create_default_ticket_type();
        `);

        // tgtypeが同じでも、UPDATE OFで対象列を狭めたtriggerは全更新を同期しません。
        await dataSource.query(`
          DROP TRIGGER ticket_inventory_ticket_type_expand_sync_trg
            ON ticket_inventory;
          CREATE TRIGGER ticket_inventory_ticket_type_expand_sync_trg
          AFTER INSERT OR UPDATE OF version ON ticket_inventory
          FOR EACH ROW
          EXECUTE FUNCTION ticket_type_expand_sync_inventory();
        `);

        // CREATE OR REPLACEはfunction OIDを維持するため、tgfoid照合だけではno-op化を検出できません。
        await dataSource.query(`
          CREATE OR REPLACE FUNCTION
            ticket_type_expand_set_purchase_ticket_type()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog, public, pg_temp
          AS $$
          BEGIN
            RETURN NEW;
          END
          $$;
        `);

        // unique/valid/readyで同じ名前でも、lower(name)を守らない式へ差し替えます。
        await dataSource.query(`
          DROP INDEX ticket_types_event_normalized_name_uq;
          CREATE UNIQUE INDEX ticket_types_event_normalized_name_uq
            ON ticket_types (id);
        `);
        await dataSource.query(`
          ALTER TABLE ticket_types
            ALTER COLUMN event_id DROP NOT NULL;
        `);

        const drifted = await checkTicketTypeExpandReadiness(dataSource);
        const driftedCounts = new Map(
          drifted.map(({ category, violationCount }) => [
            category,
            violationCount,
          ]),
        );
        expect(
          driftedCounts.get('required_ticket_type_fk_missing_or_unvalidated'),
        ).toBe(1);
        expect(
          driftedCounts.get('required_bridge_trigger_missing_or_disabled'),
        ).toBe(3);
        expect(
          driftedCounts.get('required_unique_index_missing_or_invalid'),
        ).toBe(1);
        expect(
          driftedCounts.get('required_ticket_type_not_null_missing'),
        ).toBe(1);
        expect(hasTicketTypeExpandViolations(drifted)).toBe(true);
      });
    });

    it('legacyで表現可能なexpand状態はデータを変えずdownし、再expandできる', async () => {
      await withLegacyDatabase(async (dataSource) => {
        await seedPopulatedLegacyData(dataSource);
        const inventoryBefore =
          await selectLegacyInventorySnapshot(dataSource);
        const purchasesBefore = await selectLegacyPurchaseSnapshot(dataSource);

        await applyMigration(
          dataSource,
          new AddTicketTypeExpandSchema1785128190273(),
          'up',
        );
        await applyMigration(
          dataSource,
          new AddTicketTypeExpandSchema1785128190273(),
          'down',
        );

        expect(await selectCatalogState(dataSource)).toEqual({
          ticket_types: null,
          ticket_type_inventory: null,
          purchase_ticket_type_column_count: 0,
          bridge_trigger_count: 0,
        });
        expect(await selectLegacyInventorySnapshot(dataSource)).toEqual(
          inventoryBefore,
        );
        expect(await selectLegacyPurchaseSnapshot(dataSource)).toEqual(
          purchasesBefore,
        );

        await applyMigration(
          dataSource,
          new AddTicketTypeExpandSchema1785128190273(),
          'up',
        );
        const readiness = await checkTicketTypeExpandReadiness(dataSource);
        expect(hasTicketTypeExpandViolations(readiness)).toBe(false);
      });
    });

    it('legacyとshadowの在庫差分がある場合はdownをDDLより先に停止する', async () => {
      await withLegacyDatabase(async (dataSource) => {
        const fixture = await seedPopulatedLegacyData(dataSource);
        await applyMigration(
          dataSource,
          new AddTicketTypeExpandSchema1785128190273(),
          'up',
        );

        await dataSource.query(
          `
            UPDATE ticket_type_inventory
            SET version = version + 1
            WHERE event_id = $1
          `,
          [fixture.eventIds[0]],
        );
        const stateBefore = await selectCatalogState(dataSource);

        await expect(
          applyMigration(
            dataSource,
            new AddTicketTypeExpandSchema1785128190273(),
            'down',
          ),
        ).rejects.toThrow(
          'ticket type expand rollback blocked: ticket type inventory does not match legacy inventory',
        );

        // guard失敗後もexpand table・column・bridge triggerを削除しない。
        expect(await selectCatalogState(dataSource)).toEqual(stateBefore);
        const versionDrift = await dataSource.query<
          Array<{ difference: number }>
        >(
          `
            SELECT shadow.version - legacy.version AS difference
            FROM ticket_type_inventory AS shadow
            JOIN ticket_inventory AS legacy
              ON legacy.event_id = shadow.event_id
            WHERE shadow.event_id = $1
          `,
          [fixture.eventIds[0]],
        );
        expect(versionDrift).toEqual([{ difference: 1 }]);
      });
    });

    it('2つ目のTicket Typeがある場合はdownをDDLより先に停止する', async () => {
      await withLegacyDatabase(async (dataSource) => {
        const fixture = await seedPopulatedLegacyData(dataSource);
        await applyMigration(
          dataSource,
          new AddTicketTypeExpandSchema1785128190273(),
          'up',
        );

        await dataSource.query(
          `
            INSERT INTO ticket_types (event_id, name, is_default)
            VALUES ($1, 'VIP', false)
          `,
          [fixture.eventIds[0]],
        );
        const stateBefore = await selectCatalogState(dataSource);

        await expect(
          applyMigration(
            dataSource,
            new AddTicketTypeExpandSchema1785128190273(),
            'down',
          ),
        ).rejects.toThrow('ticket type expand rollback blocked');

        // guard失敗後もtable・column・3つのbridge triggerが残り、DDLが確定していません。
        expect(await selectCatalogState(dataSource)).toEqual(stateBefore);
        expect(stateBefore).toEqual({
          ticket_types: 'ticket_types',
          ticket_type_inventory: 'ticket_type_inventory',
          purchase_ticket_type_column_count: 1,
          bridge_trigger_count: 3,
        });
        const ticketTypeCount = await dataSource.query<
          Array<{ count: number }>
        >(
          'SELECT count(*)::int AS count FROM ticket_types WHERE event_id = $1',
          [fixture.eventIds[0]],
        );
        expect(ticketTypeCount[0].count).toBe(2);
      });
    });

    it('schema.sqlを旧schemaへ再適用でき、versioned migrationと同じexpand構造・readinessになる', async () => {
      const migrationSignature = await withLegacyDatabase(
        async (dataSource) => {
          await seedPopulatedLegacyData(dataSource);
          await applyMigration(
            dataSource,
            new AddTicketTypeExpandSchema1785128190273(),
            'up',
          );
          return selectExpandCatalogSignature(dataSource);
        },
      );

      const schemaSignature = await withLegacyDatabase(async (dataSource) => {
        await seedPopulatedLegacyData(dataSource);
        const schemaSql = readFileSync(
          resolve(process.cwd(), 'database/schema.sql'),
          'utf8',
        );

        // 旧schemaへの初回適用と、expand済みschemaへの再適用を同じfixtureで検証します。
        await dataSource.query(schemaSql);
        await dataSource.query(schemaSql);

        const readiness = await checkTicketTypeExpandReadiness(dataSource);
        expect(hasTicketTypeExpandViolations(readiness)).toBe(false);
        expect(
          readiness.every(({ violationCount }) => violationCount === 0),
        ).toBe(true);

        return selectExpandCatalogSignature(dataSource);
      });

      expect(schemaSignature).toEqual(migrationSignature);
    });
  },
);

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function restoreEnvironmentVariable(
  name: string,
  previousValue: string | undefined,
): void {
  if (previousValue === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previousValue;
}

async function runMigrationInStartedTransaction(
  queryRunner: QueryRunner,
  migration: MigrationInterface,
): Promise<{ error: unknown | undefined }> {
  try {
    await migration.up(queryRunner);
    await queryRunner.commitTransaction();
    return { error: undefined };
  } catch (error) {
    if (queryRunner.isTransactionActive) {
      await queryRunner.rollbackTransaction();
    }
    return { error };
  }
}

async function settleDatabaseOperation(
  operation: Promise<unknown>,
): Promise<{ error: unknown | undefined }> {
  try {
    await operation;
    return { error: undefined };
  } catch (error) {
    return { error };
  }
}

async function waitForMigrationEventLockWait(
  dataSource: DataSource,
  migrationBackendPid: number,
): Promise<void> {
  await waitForDatabaseCondition(
    dataSource,
    'migration backend to wait for events ExclusiveLock',
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_locks database_lock
        JOIN pg_class relation
          ON relation.oid = database_lock.relation
        JOIN pg_namespace relation_namespace
          ON relation_namespace.oid = relation.relnamespace
        JOIN pg_stat_activity activity
          ON activity.pid = database_lock.pid
        WHERE database_lock.pid = $1
          AND relation_namespace.nspname = 'public'
          AND relation.relname = 'events'
          AND database_lock.mode = 'ExclusiveLock'
          AND NOT database_lock.granted
          AND activity.wait_event_type = 'Lock'
      ) AS ready
    `,
    [migrationBackendPid],
  );
}

async function waitForPocEventLockWait(
  dataSource: DataSource,
  pocBackendPid: number,
): Promise<void> {
  await waitForDatabaseCondition(
    dataSource,
    'PoC inventory INSERT to wait for the migration events gate',
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity activity
        WHERE activity.pid = $1
          AND activity.wait_event_type = 'Lock'
          AND EXISTS (
            SELECT 1
            FROM pg_locks event_lock
            JOIN pg_class relation
              ON relation.oid = event_lock.relation
            JOIN pg_namespace relation_namespace
              ON relation_namespace.oid = relation.relnamespace
            WHERE event_lock.pid = activity.pid
              AND relation_namespace.nspname = 'public'
              AND relation.relname = 'events'
              AND NOT event_lock.granted
          )
          AND EXISTS (
            SELECT 1
            FROM pg_locks inventory_lock
            JOIN pg_class relation
              ON relation.oid = inventory_lock.relation
            JOIN pg_namespace relation_namespace
              ON relation_namespace.oid = relation.relnamespace
            WHERE inventory_lock.pid = activity.pid
              AND relation_namespace.nspname = 'public'
              AND relation.relname = 'ticket_inventory'
              AND inventory_lock.mode = 'RowExclusiveLock'
              AND inventory_lock.granted
          )
      ) AS ready
    `,
    [pocBackendPid],
  );
}

async function waitForDatabaseCondition(
  dataSource: DataSource,
  description: string,
  sql: string,
  parameters: unknown[],
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastRows: Array<{ ready: boolean }> = [];

  while (Date.now() < deadline) {
    lastRows = await dataSource.query<Array<{ ready: boolean }>>(
      sql,
      parameters,
    );
    if (lastRows[0]?.ready) {
      return;
    }
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, 20);
    });
  }

  throw new Error(
    `timed out waiting for ${description}: ${JSON.stringify(lastRows)}`,
  );
}

async function applyMigration(
  dataSource: DataSource,
  migration: MigrationInterface,
  direction: 'up' | 'down',
): Promise<void> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction();

  try {
    await migration[direction](queryRunner);
    await queryRunner.commitTransaction();
  } catch (error) {
    await queryRunner.rollbackTransaction();
    throw error;
  } finally {
    await queryRunner.release();
  }
}

async function seedPopulatedLegacyData(
  dataSource: DataSource,
): Promise<LegacyFixture> {
  const buyerId = randomUUID();
  const eventIds: [string, string] = [randomUUID(), randomUUID()];
  const purchaseIds: [string, string] = [randomUUID(), randomUUID()];

  await dataSource.query(
    `
      INSERT INTO users (id, email, password_hash)
      VALUES ($1, $2, 'test-password-hash')
    `,
    [buyerId, `migration-fixture-${randomUUID()}@example.com`],
  );
  await dataSource.query(
    `
      INSERT INTO events (id, title, event_type, starts_at, created_at)
      VALUES
        ($1, 'Legacy music event', 'music', '2030-01-01T10:00:00Z',
         '2029-01-01T01:02:03Z'),
        ($2, 'Legacy sports event', 'sports', '2030-02-02T11:00:00Z',
         '2029-02-02T02:03:04Z')
    `,
    eventIds,
  );
  await dataSource.query(
    `
      INSERT INTO ticket_inventory (
        event_id,
        total_quantity,
        remaining_quantity,
        version,
        updated_at
      )
      VALUES
        ($1, 100, 73, 27, '2029-03-03T03:04:05Z'),
        ($2, 40, 0, 40, '2029-04-04T04:05:06Z')
    `,
    eventIds,
  );
  await dataSource.query(
    `
      INSERT INTO purchases (
        id,
        event_id,
        buyer_id,
        request_id,
        quantity,
        status,
        rejection_reason,
        remaining_quantity_after,
        created_at
      )
      VALUES
        ($1, $3, $5, 'legacy-confirmed-request', 2, 'confirmed', NULL, 73,
         '2029-05-05T05:06:07Z'),
        ($2, $4, $5, 'legacy-rejected-request', 1, 'rejected',
         'insufficient_inventory', NULL, '2029-06-06T06:07:08Z')
    `,
    [...purchaseIds, ...eventIds, buyerId],
  );

  return { buyerId, eventIds, purchaseIds };
}

async function selectLegacyInventorySnapshot(
  dataSource: DataSource,
): Promise<LegacyInventorySnapshot[]> {
  return dataSource.query<LegacyInventorySnapshot[]>(
    `
      SELECT
        event_id,
        total_quantity,
        remaining_quantity,
        version,
        updated_at
      FROM ticket_inventory
      ORDER BY event_id
    `,
  );
}

async function selectLegacyPurchaseSnapshot(
  dataSource: DataSource,
): Promise<LegacyPurchaseSnapshot[]> {
  return dataSource.query<LegacyPurchaseSnapshot[]>(
    `
      SELECT
        id,
        event_id,
        buyer_id,
        request_id,
        quantity,
        status,
        rejection_reason,
        remaining_quantity_after,
        created_at
      FROM purchases
      ORDER BY id
    `,
  );
}

async function selectCatalogState(
  dataSource: DataSource,
): Promise<CatalogState> {
  const rows = await dataSource.query<CatalogState[]>(
    `
      SELECT
        to_regclass('public.ticket_types')::text AS ticket_types,
        to_regclass('public.ticket_type_inventory')::text
          AS ticket_type_inventory,
        (
          SELECT count(*)::int
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'purchases'
            AND column_name = 'ticket_type_id'
        ) AS purchase_ticket_type_column_count,
        (
          SELECT count(*)::int
          FROM pg_trigger
          WHERE NOT tgisinternal
            AND tgname IN (
              'events_ticket_type_expand_default_trg',
              'ticket_inventory_ticket_type_expand_sync_trg',
              'purchases_ticket_type_expand_default_trg'
            )
        ) AS bridge_trigger_count
    `,
  );
  return rows[0];
}

async function selectExpandCatalogSignature(
  dataSource: DataSource,
): Promise<ExpandCatalogSignature> {
  const columns = await dataSource.query<Array<Record<string, unknown>>>(
    `
      SELECT
        table_name,
        column_name,
        ordinal_position,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          table_name IN ('ticket_types', 'ticket_type_inventory')
          OR (table_name = 'purchases' AND column_name = 'ticket_type_id')
        )
      ORDER BY table_name, ordinal_position
    `,
  );
  const constraints = await dataSource.query<Array<Record<string, unknown>>>(
    `
      SELECT
        constraint_table.relname AS table_name,
        database_constraint.conname AS constraint_name,
        database_constraint.contype AS constraint_type,
        database_constraint.convalidated,
        pg_get_constraintdef(database_constraint.oid) AS definition
      FROM pg_constraint database_constraint
      JOIN pg_class constraint_table
        ON constraint_table.oid = database_constraint.conrelid
      WHERE constraint_table.relname IN (
        'ticket_types',
        'ticket_type_inventory'
      )
         OR database_constraint.conname = 'purchases_event_ticket_type_fkey'
      ORDER BY table_name, constraint_name
    `,
  );
  const indexes = await dataSource.query<Array<Record<string, unknown>>>(
    `
      SELECT tablename AS table_name, indexname AS index_name, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND (
          tablename IN ('ticket_types', 'ticket_type_inventory')
          OR indexname = 'purchases_event_ticket_type_created_at_idx'
        )
      ORDER BY table_name, index_name
    `,
  );
  const triggers = await dataSource.query<Array<Record<string, unknown>>>(
    `
      SELECT
        trigger_table.relname AS table_name,
        database_trigger.tgname AS trigger_name,
        pg_get_triggerdef(database_trigger.oid) AS definition
      FROM pg_trigger database_trigger
      JOIN pg_class trigger_table
        ON trigger_table.oid = database_trigger.tgrelid
      WHERE NOT database_trigger.tgisinternal
        AND database_trigger.tgname LIKE '%ticket_type_expand%'
      ORDER BY table_name, trigger_name
    `,
  );
  const functions = await dataSource.query<Array<Record<string, unknown>>>(
    `
      SELECT
        database_function.proname AS function_name,
        function_language.lanname AS language,
        database_function.proconfig,
        database_function.prosecdef,
        database_function.provolatile,
        database_function.proparallel,
        database_function.prosrc AS function_body
      FROM pg_proc database_function
      JOIN pg_namespace function_namespace
        ON function_namespace.oid = database_function.pronamespace
      JOIN pg_language function_language
        ON function_language.oid = database_function.prolang
      WHERE function_namespace.nspname = 'public'
        AND database_function.proname LIKE 'ticket_type_expand_%'
      ORDER BY function_name
    `,
  );

  return { columns, constraints, indexes, triggers, functions };
}
