// Issue #376 compatibility writer を disposable PostgreSQL 16 database で検証する。
// TEST_DATABASE_URL 未設定時はskipし、CIと明示的なlocal migration testで実行する。

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, Pool } from 'pg';
import { DataSource, MigrationInterface } from 'typeorm';
import { InventoryCacheService } from '../../cache/inventory-cache.service';
import { DatabaseService } from '../database.service';
import { DomainEventsService } from '../../messaging/domain-events.service';
import { PurchasesService } from '../../purchases/purchases.service';
import { EventsService } from '../../events/events.service';
import { SearchService } from '../../search/search.service';
import { checkTicketTypeExpandReadiness } from '../ticket-type-expand-readiness';
import { Baseline1751594400000 } from './1751594400000-baseline';
import { AddUsers1783251707172 } from './1783251707172-add-users';
import { AddPurchasesBuyerFk1783252676631 } from './1783252676631-add-purchases-buyer-fk';
import { AddRefreshTokens1783307740648 } from './1783307740648-add-refresh-tokens';
import { AddEventsCreatedBy1783342791808 } from './1783342791808-add-events-created-by';
import { AddTicketTypeExpandSchema1785128190273 } from './1785128190273-add-ticket-type-expand-schema';
import { AddTicketTypeCompatibilityWriter1785542400000 } from './1785542400000-add-ticket-type-compatibility-writer';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

const EXPANDED_MIGRATIONS = [
  Baseline1751594400000,
  AddUsers1783251707172,
  AddPurchasesBuyerFk1783252676631,
  AddRefreshTokens1783307740648,
  AddEventsCreatedBy1783342791808,
  AddTicketTypeExpandSchema1785128190273,
];

interface EventFixture {
  eventId: string;
  defaultTicketTypeId: string;
}

jest.setTimeout(120_000);

describeWithPostgres(
  'AddTicketTypeCompatibilityWriter1785542400000（実 PostgreSQL）',
  () => {
    let adminClient: Client;
    let databaseUrlTemplate: URL;

    beforeAll(async () => {
      if (!TEST_DATABASE_URL) return;
      databaseUrlTemplate = new URL(TEST_DATABASE_URL);
      const adminUrl = new URL(databaseUrlTemplate);
      adminUrl.pathname = '/postgres';
      adminClient = new Client({ connectionString: adminUrl.toString() });
      await adminClient.connect();
    });

    afterAll(async () => {
      if (adminClient) await adminClient.end();
    });

    async function withExpandedDatabase<T>(
      run: (dataSource: DataSource, databaseUrl: string) => Promise<T>,
    ): Promise<T> {
      const databaseName = [
        'ticket_type_compat',
        process.pid,
        randomUUID().replaceAll('-', '').slice(0, 12),
      ].join('_');
      const quotedName = quoteIdentifier(databaseName);
      await adminClient.query(
        `CREATE DATABASE ${quotedName} TEMPLATE template0`,
      );

      const databaseUrl = new URL(databaseUrlTemplate);
      databaseUrl.pathname = `/${databaseName}`;
      const dataSource = new DataSource({
        type: 'postgres',
        url: databaseUrl.toString(),
        entities: [],
        migrations: EXPANDED_MIGRATIONS,
        migrationsTableName: 'typeorm_migrations',
      });

      try {
        await dataSource.initialize();
        await dataSource.runMigrations({ transaction: 'each' });
        return await run(dataSource, databaseUrl.toString());
      } finally {
        if (dataSource.isInitialized) await dataSource.destroy();
        await adminClient.query(`DROP DATABASE ${quotedName} WITH (FORCE)`);
      }
    }

    it('legacy初期値、既存bridge、inactive guard、統合冪等性index、safe downを保つ', async () => {
      await withExpandedDatabase(async (dataSource) => {
        const buyerId = await seedUser(dataSource);
        const event = await seedEvent(dataSource, 10);
        const migration = new AddTicketTypeCompatibilityWriter1785542400000();
        await applyMigration(dataSource, migration, 'up');

        const control = await dataSource.query<Array<{ writer_mode: string }>>(
          'SELECT writer_mode FROM inventory_writer_control WHERE singleton',
        );
        expect(control).toEqual([{ writer_mode: 'legacy' }]);

        // #336 checkerの厳密な既存function/trigger要件を初期modeで壊さない。
        const readiness = await checkTicketTypeExpandReadiness(dataSource);
        expect(
          readiness.every(({ violationCount }) => violationCount === 0),
        ).toBe(true);

        await dataSource.query(
          `
            UPDATE ticket_inventory
            SET remaining_quantity = remaining_quantity - 2,
                version = version + 1,
                updated_at = now()
            WHERE event_id = $1
          `,
          [event.eventId],
        );
        const updated = await readLegacyAggregate(dataSource, event.eventId);
        expect(updated).toMatchObject({ remaining_quantity: 8, version: 1 });

        const shadow = await dataSource.query<
          Array<{ remaining_quantity: number; version: number }>
        >(
          `
            SELECT remaining_quantity, version
            FROM ticket_type_inventory
            WHERE ticket_type_id = $1
          `,
          [event.defaultTicketTypeId],
        );
        expect(shadow).toEqual([{ remaining_quantity: 8, version: 1 }]);

        await expectPgError(
          dataSource.query(
            `
              UPDATE ticket_type_inventory
              SET remaining_quantity = remaining_quantity - 1
              WHERE ticket_type_id = $1
            `,
            [event.defaultTicketTypeId],
          ),
          '55000',
        );

        // row-level triggerだけでは見落とす0-row statementもinactive fenceで拒否する。
        await expectPgError(
          dataSource.query(
            `
              UPDATE ticket_type_inventory
              SET remaining_quantity = remaining_quantity
              WHERE ticket_type_id = $1
            `,
            [randomUUID()],
          ),
          '55000',
        );
        await expectPgError(
          dataSource.query(
            `
              INSERT INTO ticket_type_inventory (
                ticket_type_id, event_id, total_quantity, remaining_quantity
              )
              SELECT $1, $2, 1, 1
              WHERE false
            `,
            [randomUUID(), event.eventId],
          ),
          '55000',
        );
        await expectPgError(
          dataSource.query('TRUNCATE ticket_type_inventory'),
          '55000',
        );

        // clientがcustom GUCを偽装してもtop-level inactive writeは許可しない。
        const spoofRunner = dataSource.createQueryRunner();
        await spoofRunner.connect();
        await spoofRunner.startTransaction();
        try {
          await spoofRunner.query(
            `SELECT set_config('ticket_c2c.inventory_mirror_origin', 'legacy', true)`,
          );
          await expectPgError(
            spoofRunner.query(
              `
                UPDATE ticket_type_inventory
                SET remaining_quantity = remaining_quantity - 1
                WHERE ticket_type_id = $1
              `,
              [event.defaultTicketTypeId],
            ),
            '55000',
          );
        } finally {
          if (spoofRunner.isTransactionActive) {
            await spoofRunner.rollbackTransaction();
          }
          await spoofRunner.release();
        }

        await insertPurchase(dataSource, {
          buyerId,
          event,
          requestId: 'one-outcome-only',
          status: 'confirmed',
          quantity: 1,
        });
        await expectPgError(
          insertPurchase(dataSource, {
            buyerId,
            event,
            requestId: 'one-outcome-only',
            status: 'rejected',
            quantity: 1,
          }),
          '23505',
        );

        await applyMigration(dataSource, migration, 'down');
        const catalog = await dataSource.query<
          Array<{
            control_table: string | null;
            confirmed_index: string | null;
            rejected_index: string | null;
          }>
        >(
          `
            SELECT
              to_regclass('public.inventory_writer_control')::text AS control_table,
              to_regclass('public.purchases_request_id_uq')::text AS confirmed_index,
              to_regclass('public.purchases_rejected_request_id_uq')::text AS rejected_index
          `,
        );
        expect(catalog).toEqual([
          {
            control_table: null,
            confirmed_index: 'purchases_request_id_uq',
            rejected_index: 'purchases_rejected_request_id_uq',
          },
        ]);
      });
    });

    it('confirmed/rejected横断の既存key重複を自動修復せずmigration全体をrollbackする', async () => {
      await withExpandedDatabase(async (dataSource) => {
        const buyerId = await seedUser(dataSource);
        const event = await seedEvent(dataSource, 2);
        await insertPurchase(dataSource, {
          buyerId,
          event,
          requestId: 'ambiguous-existing-key',
          status: 'confirmed',
          quantity: 1,
        });
        await insertPurchase(dataSource, {
          buyerId,
          event,
          requestId: 'ambiguous-existing-key',
          status: 'rejected',
          quantity: 1,
        });

        await expect(
          applyMigration(
            dataSource,
            new AddTicketTypeCompatibilityWriter1785542400000(),
            'up',
          ),
        ).rejects.toThrow(
          'duplicate requestId exists across purchase statuses',
        );

        const state = await dataSource.query<
          Array<{
            control_table: string | null;
            confirmed_index: string | null;
            rejected_index: string | null;
          }>
        >(
          `
            SELECT
              to_regclass('public.inventory_writer_control')::text AS control_table,
              to_regclass('public.purchases_request_id_uq')::text AS confirmed_index,
              to_regclass('public.purchases_rejected_request_id_uq')::text AS rejected_index
          `,
        );
        expect(state[0]).toEqual({
          control_table: null,
          confirmed_index: 'purchases_request_id_uq',
          rejected_index: 'purchases_rejected_request_id_uq',
        });
      });
    });

    it('shared writer barrierとexclusive activation barrierを実lock waitで相互排他にする', async () => {
      await withExpandedDatabase(async (dataSource, databaseUrl) => {
        await applyMigration(
          dataSource,
          new AddTicketTypeCompatibilityWriter1785542400000(),
          'up',
        );

        const shared = new Client({ connectionString: databaseUrl });
        const exclusive = new Client({ connectionString: databaseUrl });
        const trailingShared = new Client({ connectionString: databaseUrl });
        await Promise.all([
          shared.connect(),
          exclusive.connect(),
          trailingShared.connect(),
        ]);
        try {
          await shared.query('BEGIN');
          await shared.query('SELECT pg_advisory_xact_lock_shared(335, 376)');

          await exclusive.query('BEGIN');
          const exclusivePid = await readBackendPid(exclusive);
          const exclusiveLock = exclusive.query(
            'SELECT pg_advisory_xact_lock(335, 376)',
          );
          await waitForBackendLock(adminClient, exclusivePid);

          await shared.query('COMMIT');
          await exclusiveLock;

          await trailingShared.query('BEGIN');
          const trailingSharedPid = await readBackendPid(trailingShared);
          const trailingSharedLock = trailingShared.query(
            'SELECT pg_advisory_xact_lock_shared(335, 376)',
          );
          await waitForBackendLock(adminClient, trailingSharedPid);

          await exclusive.query('COMMIT');
          await trailingSharedLock;
          await trailingShared.query('COMMIT');
        } finally {
          await Promise.all([
            shared.query('ROLLBACK').catch(() => undefined),
            exclusive.query('ROLLBACK').catch(() => undefined),
            trailingShared.query('ROLLBACK').catch(() => undefined),
          ]);
          await Promise.all([
            shared.end(),
            exclusive.end(),
            trailingShared.end(),
          ]);
        }
      });
    });

    it('schema.sqlとversioned migrationで#376 control・index・function・trigger catalogが一致する', async () => {
      const schemaSql = readFileSync(
        resolve(process.cwd(), 'database/schema.sql'),
        'utf8',
      );

      const versionedSignature = await withExpandedDatabase(
        async (dataSource) => {
          await seedEvent(dataSource, 3);
          await applyMigration(
            dataSource,
            new AddTicketTypeCompatibilityWriter1785542400000(),
            'up',
          );
          const beforeReapply =
            await selectCompatibilityCatalogSignature(dataSource);
          await dataSource.query(schemaSql);
          expect(await selectCompatibilityCatalogSignature(dataSource)).toEqual(
            beforeReapply,
          );
          return beforeReapply;
        },
      );

      const schemaSignature = await withExpandedDatabase(async (dataSource) => {
        await seedEvent(dataSource, 3);
        await dataSource.query(schemaSql);
        return selectCompatibilityCatalogSignature(dataSource);
      });

      expect(schemaSignature).toEqual(versionedSignature);
    });

    it('ticket_type modeでType合計を直列mirrorし、inactive legacy writeとunsafe downを拒否する', async () => {
      await withExpandedDatabase(async (dataSource, databaseUrl) => {
        const event = await seedEvent(dataSource, 10);
        const cascadeEvent = await seedEvent(dataSource, 1);
        const migration = new AddTicketTypeCompatibilityWriter1785542400000();
        await applyMigration(dataSource, migration, 'up');
        await switchWriterMode(dataSource, 'ticket_type');

        const vipTypeId = randomUUID();
        await dataSource.query(
          `
            INSERT INTO ticket_types (id, event_id, name, is_default)
            VALUES ($1, $2, 'VIP', false)
          `,
          [vipTypeId, event.eventId],
        );
        await dataSource.query(
          `
            INSERT INTO ticket_type_inventory (
              ticket_type_id, event_id, total_quantity, remaining_quantity
            )
            VALUES ($1, $2, 5, 5)
          `,
          [vipTypeId, event.eventId],
        );

        await expectPgError(
          dataSource.query(
            `
              UPDATE ticket_inventory
              SET remaining_quantity = remaining_quantity - 1
              WHERE event_id = $1
            `,
            [event.eventId],
          ),
          '55000',
        );
        await expectPgError(
          dataSource.query(
            `
              UPDATE ticket_inventory
              SET remaining_quantity = remaining_quantity
              WHERE event_id = $1
            `,
            [randomUUID()],
          ),
          '55000',
        );

        // active/inactiveを問わずinventoryの直接DELETEとTRUNCATEはfail closedにする。
        await expectPgError(
          dataSource.query(
            'DELETE FROM ticket_type_inventory WHERE ticket_type_id = $1',
            [vipTypeId],
          ),
          '55000',
        );
        await expectPgError(
          dataSource.query('DELETE FROM ticket_inventory WHERE event_id = $1', [
            event.eventId,
          ]),
          '55000',
        );
        await expectPgError(
          dataSource.query('DELETE FROM ticket_types WHERE id = $1', [
            vipTypeId,
          ]),
          '55000',
        );
        await expectPgError(
          dataSource.query('TRUNCATE ticket_inventory'),
          '55000',
        );
        await expectPgError(
          dataSource.query('TRUNCATE ticket_types CASCADE'),
          '55000',
        );

        // Event削除から始まる既知のFK cascadeだけは全互換rowを同時に消せる。
        await dataSource.query('DELETE FROM events WHERE id = $1', [
          cascadeEvent.eventId,
        ]);
        expect(
          await countEventCompatibilityRows(dataSource, cascadeEvent.eventId),
        ).toEqual({ legacy: 0, ticketTypes: 0, typeInventory: 0 });

        await dataSource.query(
          `
            UPDATE ticket_type_inventory
            SET remaining_quantity = remaining_quantity - 2,
                version = version + 1,
                updated_at = now()
            WHERE ticket_type_id = $1
          `,
          [event.defaultTicketTypeId],
        );
        await dataSource.query(
          `
            UPDATE ticket_type_inventory
            SET remaining_quantity = remaining_quantity - 3,
                version = version + 1,
                updated_at = now()
            WHERE ticket_type_id = $1
          `,
          [vipTypeId],
        );

        expect(
          await readLegacyAggregate(dataSource, event.eventId),
        ).toMatchObject({
          total_quantity: 15,
          remaining_quantity: 10,
        });

        // 異なるTypeを並行更新しても、legacy mutex待ち後のfresh snapshotで両方を集計する。
        const first = new Client({ connectionString: databaseUrl });
        const second = new Client({ connectionString: databaseUrl });
        await Promise.all([first.connect(), second.connect()]);
        try {
          await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
          await first.query(
            `
              UPDATE ticket_type_inventory
              SET remaining_quantity = remaining_quantity - 1,
                  version = version + 1,
                  updated_at = now()
              WHERE ticket_type_id = $1
            `,
            [event.defaultTicketTypeId],
          );
          const secondPid = await readBackendPid(second);
          const secondUpdate = second.query(
            `
              UPDATE ticket_type_inventory
              SET remaining_quantity = remaining_quantity - 1,
                  version = version + 1,
                  updated_at = now()
              WHERE ticket_type_id = $1
            `,
            [vipTypeId],
          );
          await waitForBackendLock(adminClient, secondPid);
          await first.query('COMMIT');
          await secondUpdate;
          await second.query('COMMIT');
        } finally {
          await Promise.all([first.end(), second.end()]);
        }

        expect(
          await readLegacyAggregate(dataSource, event.eventId),
        ).toMatchObject({
          total_quantity: 15,
          remaining_quantity: 8,
        });

        const beforeSchemaReapply = await selectCompatibilityData(
          dataSource,
          event.eventId,
        );
        const schemaSql = readFileSync(
          resolve(process.cwd(), 'database/schema.sql'),
          'utf8',
        );
        await dataSource.query(schemaSql);
        expect(
          await selectCompatibilityData(dataSource, event.eventId),
        ).toEqual(beforeSchemaReapply);

        await expect(
          applyMigration(dataSource, migration, 'down'),
        ).rejects.toThrow('writer mode must be legacy');
        await switchWriterMode(dataSource, 'legacy');
        await expect(
          applyMigration(dataSource, migration, 'down'),
        ).rejects.toThrow('legacy representation is not lossless');
      });
    });

    it('実serviceの同時購入・同一key replay・payload衝突で過剰販売と二重更新を防ぐ', async () => {
      await withExpandedDatabase(async (dataSource, databaseUrl) => {
        const buyerA = await seedUser(dataSource);
        const buyerB = await seedUser(dataSource);
        const oversellEvent = await seedEvent(dataSource, 3);
        const replayEvent = await seedEvent(dataSource, 5);
        const rejectedEvent = await seedEvent(dataSource, 0);
        const lookupFirstEvent = await seedEvent(dataSource, 5);
        const multiTypeEvent = await seedEvent(dataSource, 4);
        const otherEvent = await seedEvent(dataSource, 1);

        await applyMigration(
          dataSource,
          new AddTicketTypeCompatibilityWriter1785542400000(),
          'up',
        );
        await switchWriterMode(dataSource, 'ticket_type');

        const vipTypeId = randomUUID();
        await dataSource.query(
          `
            INSERT INTO ticket_types (id, event_id, name, is_default)
            VALUES ($1, $2, 'VIP', false)
          `,
          [vipTypeId, multiTypeEvent.eventId],
        );
        await dataSource.query(
          `
            INSERT INTO ticket_type_inventory (
              ticket_type_id, event_id, total_quantity, remaining_quantity
            )
            VALUES ($1, $2, 2, 2)
          `,
          [vipTypeId, multiTypeEvent.eventId],
        );

        const pool = new Pool({ connectionString: databaseUrl, max: 10 });
        const publish = jest.fn(async () => undefined);
        const service = new PurchasesService(
          { connect: () => pool.connect() } as unknown as DatabaseService,
          {
            reserve: jest.fn(async () => 'unknown'),
            release: jest.fn(async () => undefined),
            getCounterVersion: jest.fn(async () => null),
            syncCounter: jest.fn(async () => false),
            markRequestSeen: jest.fn(async () => undefined),
            wasRequestSeen: jest.fn(async () => true),
          } as unknown as InventoryCacheService,
          { publish } as unknown as DomainEventsService,
        );

        const eventsService = new EventsService(
          { connect: () => pool.connect() } as unknown as DatabaseService,
          {
            initCounter: jest.fn(async () => undefined),
          } as unknown as InventoryCacheService,
          { publish } as unknown as DomainEventsService,
          { search: jest.fn(async () => null) } as unknown as SearchService,
        );

        try {
          const lookupFirstResult = await service.createPurchase(
            lookupFirstEvent.eventId,
            buyerA,
            { quantity: 1, requestId: 'lookup-before-type-resolution' },
          );
          const lookupFirstExtraTypeId = randomUUID();
          await dataSource.query(
            `
              INSERT INTO ticket_types (id, event_id, name, is_default)
              VALUES ($1, $2, 'Late VIP', false)
            `,
            [lookupFirstExtraTypeId, lookupFirstEvent.eventId],
          );
          await dataSource.query(
            `
              INSERT INTO ticket_type_inventory (
                ticket_type_id, event_id, total_quantity, remaining_quantity
              )
              VALUES ($1, $2, 1, 1)
            `,
            [lookupFirstExtraTypeId, lookupFirstEvent.eventId],
          );
          await expect(
            service.createPurchase(lookupFirstEvent.eventId, buyerA, {
              quantity: 1,
              requestId: 'lookup-before-type-resolution',
            }),
          ).resolves.toEqual(lookupFirstResult);

          const createdInTicketTypeMode = await eventsService.createEvent(
            {
              title: 'Ticket Type mode event',
              eventType: 'music',
              startsAt: '2031-01-01T00:00:00Z',
              totalQuantity: 7,
            },
            buyerA,
          );
          expect(
            await readLegacyAggregate(
              dataSource,
              createdInTicketTypeMode.eventId,
            ),
          ).toMatchObject({ total_quantity: 7, remaining_quantity: 7 });
          const createdTypeCount = await dataSource.query<
            Array<{ count: number }>
          >(
            `
              SELECT count(*)::int AS count
              FROM ticket_type_inventory
              WHERE event_id = $1
            `,
            [createdInTicketTypeMode.eventId],
          );
          expect(createdTypeCount[0].count).toBe(1);

          const oversellResults = await Promise.all([
            service.createPurchase(oversellEvent.eventId, buyerA, {
              quantity: 2,
            }),
            service.createPurchase(oversellEvent.eventId, buyerB, {
              quantity: 2,
            }),
          ]);
          expect(
            oversellResults.filter(({ status }) => status === 'confirmed'),
          ).toHaveLength(1);
          expect(
            oversellResults.filter(({ status }) => status === 'rejected'),
          ).toHaveLength(1);
          expect(
            await readTypeInventory(
              dataSource,
              oversellEvent.defaultTicketTypeId,
            ),
          ).toMatchObject({ remaining_quantity: 1, version: 1 });

          publish.mockClear();
          const replayResults = await Promise.all([
            service.createPurchase(replayEvent.eventId, buyerA, {
              quantity: 2,
              requestId: 'same-payload-race',
            }),
            service.createPurchase(replayEvent.eventId, buyerA, {
              quantity: 2,
              requestId: 'same-payload-race',
            }),
          ]);
          expect(replayResults[0]).toEqual(replayResults[1]);
          expect(publish).toHaveBeenCalledTimes(2);
          expect(await countPurchases(dataSource, 'same-payload-race')).toBe(1);
          expect(
            await readTypeInventory(
              dataSource,
              replayEvent.defaultTicketTypeId,
            ),
          ).toMatchObject({ remaining_quantity: 3, version: 1 });

          const quantityConflict = await Promise.allSettled([
            service.createPurchase(replayEvent.eventId, buyerB, {
              quantity: 1,
              requestId: 'different-quantity-race',
            }),
            service.createPurchase(replayEvent.eventId, buyerB, {
              quantity: 2,
              requestId: 'different-quantity-race',
            }),
          ]);
          expect(
            quantityConflict.filter(({ status }) => status === 'fulfilled'),
          ).toHaveLength(1);
          expectConflictResult(quantityConflict);
          expect(
            await countPurchases(dataSource, 'different-quantity-race'),
          ).toBe(1);

          const rejectedReplay = await Promise.all([
            service.createPurchase(rejectedEvent.eventId, buyerA, {
              quantity: 1,
              requestId: 'rejected-replay-race',
            }),
            service.createPurchase(rejectedEvent.eventId, buyerA, {
              quantity: 1,
              requestId: 'rejected-replay-race',
            }),
          ]);
          expect(rejectedReplay[0]).toEqual(rejectedReplay[1]);
          expect(rejectedReplay[0].status).toBe('rejected');
          expect(await countPurchases(dataSource, 'rejected-replay-race')).toBe(
            1,
          );

          await expect(
            service.createPurchase(multiTypeEvent.eventId, buyerA, {
              quantity: 1,
            }),
          ).rejects.toMatchObject({ status: 400 });

          const typeConflict = await Promise.allSettled([
            service.createPurchase(
              multiTypeEvent.eventId,
              buyerA,
              { quantity: 1, requestId: 'different-type-race' },
              { ticketTypeId: multiTypeEvent.defaultTicketTypeId },
            ),
            service.createPurchase(
              multiTypeEvent.eventId,
              buyerA,
              { quantity: 1, requestId: 'different-type-race' },
              { ticketTypeId: vipTypeId },
            ),
          ]);
          expect(
            typeConflict.filter(({ status }) => status === 'fulfilled'),
          ).toHaveLength(1);
          expectConflictResult(typeConflict);
          expect(await countPurchases(dataSource, 'different-type-race')).toBe(
            1,
          );

          await expect(
            service.createPurchase(
              otherEvent.eventId,
              buyerA,
              { quantity: 1 },
              { ticketTypeId: vipTypeId },
            ),
          ).rejects.toMatchObject({ status: 404 });
        } finally {
          await pool.end();
        }
      });
    });
  },
);

async function applyMigration(
  dataSource: DataSource,
  migration: MigrationInterface,
  direction: 'up' | 'down',
): Promise<void> {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  try {
    await migration[direction](runner);
    await runner.commitTransaction();
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
  }
}

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
        SET writer_mode = $1,
            updated_at = now()
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

async function seedUser(dataSource: DataSource): Promise<string> {
  const userId = randomUUID();
  await dataSource.query(
    `
      INSERT INTO users (id, email, password_hash)
      VALUES ($1, $2, 'test-password-hash')
    `,
    [userId, `compat-${randomUUID()}@example.com`],
  );
  return userId;
}

async function seedEvent(
  dataSource: DataSource,
  totalQuantity: number,
): Promise<EventFixture> {
  const eventId = randomUUID();
  await dataSource.query(
    `
      INSERT INTO events (id, title, event_type, starts_at)
      VALUES ($1, 'Compatibility fixture', 'music', '2030-01-01T00:00:00Z')
    `,
    [eventId],
  );
  await dataSource.query(
    `
      INSERT INTO ticket_inventory (
        event_id, total_quantity, remaining_quantity
      )
      VALUES ($1, $2, $2)
    `,
    [eventId, totalQuantity],
  );
  const types = await dataSource.query<Array<{ id: string }>>(
    `
      SELECT id
      FROM ticket_types
      WHERE event_id = $1
        AND is_default
    `,
    [eventId],
  );
  return { eventId, defaultTicketTypeId: types[0].id };
}

async function insertPurchase(
  dataSource: DataSource,
  input: {
    buyerId: string;
    event: EventFixture;
    requestId: string;
    status: 'confirmed' | 'rejected';
    quantity: number;
  },
): Promise<void> {
  await dataSource.query(
    `
      INSERT INTO purchases (
        event_id,
        ticket_type_id,
        buyer_id,
        request_id,
        quantity,
        status,
        rejection_reason,
        remaining_quantity_after
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      input.event.eventId,
      input.event.defaultTicketTypeId,
      input.buyerId,
      input.requestId,
      input.quantity,
      input.status,
      input.status === 'rejected' ? 'insufficient_inventory' : null,
      input.status === 'confirmed' ? 0 : null,
    ],
  );
}

async function readLegacyAggregate(dataSource: DataSource, eventId: string) {
  const rows = await dataSource.query<
    Array<{
      total_quantity: number;
      remaining_quantity: number;
      version: number;
    }>
  >(
    `
      SELECT total_quantity, remaining_quantity, version
      FROM ticket_inventory
      WHERE event_id = $1
    `,
    [eventId],
  );
  return rows[0];
}

async function readTypeInventory(dataSource: DataSource, ticketTypeId: string) {
  const rows = await dataSource.query<
    Array<{ remaining_quantity: number; version: number }>
  >(
    `
      SELECT remaining_quantity, version
      FROM ticket_type_inventory
      WHERE ticket_type_id = $1
    `,
    [ticketTypeId],
  );
  return rows[0];
}

async function countPurchases(
  dataSource: DataSource,
  requestId: string,
): Promise<number> {
  const rows = await dataSource.query<Array<{ count: number }>>(
    `SELECT count(*)::int AS count FROM purchases WHERE request_id = $1`,
    [requestId],
  );
  return rows[0].count;
}

async function selectCompatibilityData(
  dataSource: DataSource,
  eventId: string,
) {
  return dataSource.query<Array<Record<string, unknown>>>(
    `
      SELECT
        control.writer_mode,
        legacy.total_quantity AS legacy_total,
        legacy.remaining_quantity AS legacy_remaining,
        type.name,
        inventory.total_quantity AS type_total,
        inventory.remaining_quantity AS type_remaining,
        inventory.version AS type_version
      FROM inventory_writer_control control
      CROSS JOIN ticket_inventory legacy
      JOIN ticket_type_inventory inventory
        ON inventory.event_id = legacy.event_id
      JOIN ticket_types type
        ON type.event_id = inventory.event_id
       AND type.id = inventory.ticket_type_id
      WHERE control.singleton
        AND legacy.event_id = $1
      ORDER BY type.name
    `,
    [eventId],
  );
}

async function selectCompatibilityCatalogSignature(dataSource: DataSource) {
  const columns = await dataSource.query<Array<Record<string, unknown>>>(
    `
      SELECT
        column_name,
        ordinal_position,
        data_type,
        is_nullable,
        column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'inventory_writer_control'
      ORDER BY ordinal_position
    `,
  );
  const constraints = await dataSource.query<Array<Record<string, unknown>>>(
    `
      SELECT
        database_constraint.conname AS constraint_name,
        database_constraint.contype AS constraint_type,
        database_constraint.convalidated,
        pg_get_constraintdef(database_constraint.oid) AS definition
      FROM pg_constraint database_constraint
      WHERE database_constraint.conrelid =
              'public.inventory_writer_control'::regclass
      ORDER BY constraint_name
    `,
  );
  const indexes = await dataSource.query<Array<Record<string, unknown>>>(
    `
      SELECT indexname AS index_name, indexdef
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN (
          'purchases_request_id_uq',
          'purchases_rejected_request_id_uq'
        )
      ORDER BY index_name
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
      JOIN pg_namespace trigger_namespace
        ON trigger_namespace.oid = trigger_table.relnamespace
      WHERE trigger_namespace.nspname = 'public'
        AND NOT database_trigger.tgisinternal
        AND database_trigger.tgname LIKE 'inventory_compatibility_%'
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
        AND (
          database_function.proname LIKE 'inventory_compatibility_%'
          OR database_function.proname = 'ticket_type_expand_sync_inventory'
        )
      ORDER BY function_name
    `,
  );

  return { columns, constraints, indexes, triggers, functions };
}

async function countEventCompatibilityRows(
  dataSource: DataSource,
  eventId: string,
): Promise<{ legacy: number; ticketTypes: number; typeInventory: number }> {
  const rows = await dataSource.query<
    Array<{ legacy: number; ticket_types: number; type_inventory: number }>
  >(
    `
      SELECT
        (SELECT count(*)::int FROM ticket_inventory WHERE event_id = $1)
          AS legacy,
        (SELECT count(*)::int FROM ticket_types WHERE event_id = $1)
          AS ticket_types,
        (SELECT count(*)::int FROM ticket_type_inventory WHERE event_id = $1)
          AS type_inventory
    `,
    [eventId],
  );
  return {
    legacy: rows[0].legacy,
    ticketTypes: rows[0].ticket_types,
    typeInventory: rows[0].type_inventory,
  };
}

async function readBackendPid(client: Client): Promise<number> {
  const result = await client.query<{ pid: number }>(
    'SELECT pg_backend_pid()::int AS pid',
  );
  return result.rows[0].pid;
}

async function waitForBackendLock(client: Client, backendPid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await client.query<{
      wait_event_type: string | null;
      wait_event: string | null;
    }>(
      `
        SELECT wait_event_type, wait_event
        FROM pg_stat_activity
        WHERE pid = $1
      `,
      [backendPid],
    );
    if (result.rows[0]?.wait_event_type === 'Lock') return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`backend ${backendPid} did not enter a PostgreSQL lock wait`);
}

function expectConflictResult(results: PromiseSettledResult<unknown>[]): void {
  const rejected = results.find(({ status }) => status === 'rejected');
  expect(rejected).toBeDefined();
  if (rejected?.status === 'rejected') {
    expect(rejected.reason).toMatchObject({ status: 409 });
  }
}

async function expectPgError(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`expected PostgreSQL error ${code}`);
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`unsafe PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}
