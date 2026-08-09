// ファイル概要:
// Valkey 在庫 counter seed / reconcile CLI の統合テストです（Issue #378）。
// 実 PostgreSQL（TEST_DATABASE_URL）と実 Valkey（TEST_VALKEY_URL）を使い、
// - ticket-type seed 後に activation preflight の Valkey 検査が green になること
// - legacy seed 後に rollback preflight の Valkey 検査が green になること
// - active namespace への seed が refuse され、Valkey に何も書かれないこと（両方向）
// - reconcile の CAS（stale 値の補正・revision 不一致 skip・counter 不在時にキーを作らない）
// を end-to-end で検証します。
//
// - TEST_DATABASE_URL / TEST_VALKEY_URL が揃っていない場合は skip し、CI の focused step
//   （test:integration:cutover）と明示的な local 統合実行でだけ動かします。
// - test は一意 prefix の一時 DB（tt_valkey_seed_*）だけを作成・削除します。Valkey は
//   inventory counter namespace を harness 開始時に払い出します（local / test container で
//   あることを assert してから）。OpenSearch はこの CLI が触らないため使いません。

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { Client, Pool } from 'pg';
import { DataSource } from 'typeorm';
import {
  eventCounterKey,
  eventCounterVersionKey,
  ticketTypeCounterKey,
  ticketTypeCounterRevisionKey,
} from '../cache/inventory-cache.keys';
import {
  checkCutoverValkey,
  CutoverCheckPhase,
  TicketTypeCutoverReadinessCategory,
  TicketTypeCutoverReadinessResult,
} from './ticket-type-cutover-readiness';
import {
  runInventoryCounterReconcile,
  SeedNamespaceActiveError,
  ValkeyCounterClient,
} from './reconcile-inventory-counters';
import { Baseline1751594400000 } from '../database/migrations/1751594400000-baseline';
import { AddUsers1783251707172 } from '../database/migrations/1783251707172-add-users';
import { AddPurchasesBuyerFk1783252676631 } from '../database/migrations/1783252676631-add-purchases-buyer-fk';
import { AddRefreshTokens1783307740648 } from '../database/migrations/1783307740648-add-refresh-tokens';
import { AddEventsCreatedBy1783342791808 } from '../database/migrations/1783342791808-add-events-created-by';
import { AddTicketTypeExpandSchema1785128190273 } from '../database/migrations/1785128190273-add-ticket-type-expand-schema';
import { AddTicketTypeCompatibilityWriter1785542400000 } from '../database/migrations/1785542400000-add-ticket-type-compatibility-writer';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_VALKEY_URL = process.env.TEST_VALKEY_URL;
const enabled = Boolean(TEST_DATABASE_URL && TEST_VALKEY_URL);
const describeIntegration = enabled ? describe : describe.skip;

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

// この suite が払い出す在庫 counter namespace（ticket-type / legacy 両方）。
const INVENTORY_KEY_PATTERN = 'inventory:*';

interface HarnessCtx {
  dataSource: DataSource;
  pool: Pool;
  valkey: Redis;
  seedEvent: (perType: number[]) => Promise<{
    eventId: string;
    typeIds: string[];
  }>;
  switchMode: (mode: 'legacy' | 'ticket_type') => Promise<void>;
  runCli: (
    namespace: 'ticket-type' | 'legacy',
    mode: 'seed' | 'reconcile',
    valkeyOverride?: ValkeyCounterClient,
  ) => ReturnType<typeof runInventoryCounterReconcile>;
  runValkeyCheck: (
    expectedMode: 'legacy' | 'ticket_type',
    phase: CutoverCheckPhase,
  ) => Promise<TicketTypeCutoverReadinessResult[]>;
}

function assertLocalHost(rawUrl: string, label: string): void {
  const host = new URL(rawUrl).hostname;
  const isLocal =
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host === 'valkey';
  if (!isLocal) {
    throw new Error(`${label} host must be local/test container, got ${host}`);
  }
}

describeIntegration(
  'Valkey 在庫 counter seed / reconcile CLI（実 PostgreSQL + 実 Valkey）',
  () => {
    let adminClient: Client;
    let databaseUrlTemplate: URL;
    let valkey: Redis;

    beforeAll(async () => {
      if (!enabled) return;
      databaseUrlTemplate = new URL(TEST_DATABASE_URL as string);
      const adminUrl = new URL(databaseUrlTemplate);
      adminUrl.pathname = '/postgres';
      adminClient = new Client({ connectionString: adminUrl.toString() });
      await adminClient.connect();

      assertLocalHost(TEST_VALKEY_URL as string, 'TEST_VALKEY_URL');
      valkey = new Redis(TEST_VALKEY_URL as string, {
        maxRetriesPerRequest: 2,
        connectTimeout: 5000,
      });
      await valkey.ping();
    });

    afterAll(async () => {
      if (adminClient) await adminClient.end();
      if (valkey) valkey.disconnect();
    });

    async function flushInventoryCounterKeys(): Promise<void> {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await valkey.scan(
          cursor,
          'MATCH',
          INVENTORY_KEY_PATTERN,
          'COUNT',
          500,
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          await valkey.del(...keys);
        }
      } while (cursor !== '0');
    }

    async function withHarness<T>(
      run: (ctx: HarnessCtx) => Promise<T>,
    ): Promise<T> {
      const databaseName = [
        'tt_valkey_seed',
        process.pid,
        randomUUID().replaceAll('-', '').slice(0, 12),
      ].join('_');
      const quotedName = `"${databaseName}"`;
      await flushInventoryCounterKeys();
      await adminClient.query(`CREATE DATABASE ${quotedName} TEMPLATE template0`);
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

      try {
        await dataSource.initialize();
        await dataSource.runMigrations({ transaction: 'each' });

        const switchMode = async (
          mode: 'legacy' | 'ticket_type',
        ): Promise<void> => {
          const runner = dataSource.createQueryRunner();
          await runner.connect();
          await runner.startTransaction();
          try {
            await runner.query('SELECT pg_advisory_xact_lock(335, 376)');
            await runner.query(
              `UPDATE inventory_writer_control SET writer_mode = $1, updated_at = now() WHERE singleton`,
              [mode],
            );
            await runner.commitTransaction();
          } catch (error) {
            await runner.rollbackTransaction();
            throw error;
          } finally {
            await runner.release();
          }
        };

        // seedEvent は legacy mode で Event と legacy 在庫を作り（forward bridge が
        // default Type と shadow 行を同期）、perType が複数なら ticket_type mode で
        // 追加 Type を作ってから legacy mode へ戻す（cutover 統合 spec と同じ手順）。
        const seedEvent = async (
          perType: number[],
        ): Promise<{ eventId: string; typeIds: string[] }> => {
          const eventId = randomUUID();
          const total = perType.reduce((a, b) => a + b, 0);
          await switchMode('legacy');
          await dataSource.query(
            `INSERT INTO events (id, title, event_type, starts_at)
             VALUES ($1, 'valkey seed fixture', 'music', '2032-01-01T00:00:00Z')`,
            [eventId],
          );
          await dataSource.query(
            `INSERT INTO ticket_inventory (event_id, total_quantity, remaining_quantity)
             VALUES ($1, $2, $2)`,
            [eventId, total],
          );
          const defaultRows = await dataSource.query<Array<{ id: string }>>(
            `SELECT id FROM ticket_types WHERE event_id = $1 AND is_default`,
            [eventId],
          );
          const typeIds = [defaultRows[0].id];

          if (perType.length > 1) {
            await switchMode('ticket_type');
            await dataSource.query(
              `UPDATE ticket_type_inventory
               SET total_quantity = $2, remaining_quantity = $2
               WHERE ticket_type_id = $1`,
              [typeIds[0], perType[0]],
            );
            for (let i = 1; i < perType.length; i += 1) {
              const extraTypeId = randomUUID();
              await dataSource.query(
                `INSERT INTO ticket_types (id, event_id, name, is_default)
                 VALUES ($1, $2, $3, false)`,
                [extraTypeId, eventId, `Type-${i}`],
              );
              await dataSource.query(
                `INSERT INTO ticket_type_inventory (ticket_type_id, event_id, total_quantity, remaining_quantity)
                 VALUES ($1, $2, $3, $3)`,
                [extraTypeId, eventId, perType[i]],
              );
              typeIds.push(extraTypeId);
            }
            await switchMode('legacy');
          }
          return { eventId, typeIds };
        };

        const runCli = (
          namespace: 'ticket-type' | 'legacy',
          mode: 'seed' | 'reconcile',
          valkeyOverride?: ValkeyCounterClient,
        ) =>
          runInventoryCounterReconcile(
            { pool, valkey: valkeyOverride ?? valkey },
            // pageSize 1 で keyset pagination の複数ページ経路も常に通す。
            { namespace, mode, pageSize: 1 },
          );

        const runValkeyCheck = async (
          expectedMode: 'legacy' | 'ticket_type',
          phase: CutoverCheckPhase,
        ): Promise<TicketTypeCutoverReadinessResult[]> => {
          const snapshotClient = await pool.connect();
          try {
            await snapshotClient.query(
              'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
            );
            const results = await checkCutoverValkey(
              snapshotClient,
              valkey,
              expectedMode,
              phase,
              { pageSize: 2 },
            );
            await snapshotClient.query('COMMIT');
            return results;
          } catch (error) {
            await snapshotClient.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            snapshotClient.release();
          }
        };

        return await run({
          dataSource,
          pool,
          valkey,
          seedEvent,
          switchMode,
          runCli,
          runValkeyCheck,
        });
      } finally {
        await flushInventoryCounterKeys();
        await pool.end();
        if (dataSource.isInitialized) await dataSource.destroy();
        await adminClient.query(`DROP DATABASE ${quotedName} WITH (FORCE)`);
      }
    }

    function count(
      results: readonly TicketTypeCutoverReadinessResult[],
      category: TicketTypeCutoverReadinessCategory,
    ): number {
      const entry = results.find((r) => r.category === category);
      if (!entry) throw new Error(`category not reported: ${category}`);
      return entry.violationCount;
    }

    it('ticket-type seed が counter+revision を対に初期化し、activation preflight の Valkey 検査が green になる', async () => {
      await withHarness(
        async ({ valkey, seedEvent, runCli, runValkeyCheck }) => {
          const first = await seedEvent([5, 3]);
          const second = await seedEvent([7]);

          // legacy preflight（activation 直前）は切替先 ticket-type namespace を厳密検査
          // するため、seed 前は counter missing（3 Type 分）で violation になる。
          const before = await runValkeyCheck('legacy', 'preflight');
          expect(count(before, 'valkey_counter_missing')).toBe(3);

          const outcome = await runCli('ticket-type', 'seed');
          expect(outcome.writerMode).toBe('legacy');
          expect(outcome.counts).toEqual({
            processed: 3,
            initialized: 3,
            synced: 0,
            skipped: 0,
          });

          // counter と revision が対で作られている（revision は INIT の INCR で '1'）。
          expect(
            await valkey.get(ticketTypeCounterKey(first.eventId, first.typeIds[0])),
          ).toBe('5');
          expect(
            await valkey.get(
              ticketTypeCounterRevisionKey(first.eventId, first.typeIds[0]),
            ),
          ).toBe('1');
          expect(
            await valkey.get(
              ticketTypeCounterKey(second.eventId, second.typeIds[0]),
            ),
          ).toBe('7');

          // seed 後は activation preflight の Valkey 検査が全 category 0 になる。
          const after = await runValkeyCheck('legacy', 'preflight');
          for (const result of after) {
            expect(result).toEqual(
              expect.objectContaining({ violationCount: 0 }),
            );
          }
        },
      );
    });

    it('legacy seed（ticket_type mode）が rollback preflight の Valkey 検査を green にする', async () => {
      await withHarness(
        async ({ valkey, seedEvent, switchMode, runCli, runValkeyCheck }) => {
          const first = await seedEvent([5]);
          const second = await seedEvent([3]);

          // activation 側の前提を作る: legacy mode で ticket-type namespace を seed
          // してから ticket_type mode へ切り替える。
          await runCli('ticket-type', 'seed');
          await switchMode('ticket_type');

          // rollback preflight は legacy counter の不在を violation にする。
          const before = await runValkeyCheck('ticket_type', 'preflight');
          expect(count(before, 'valkey_legacy_counter_missing')).toBe(2);

          // rollback session の必須 step: legacy namespace の再 seed。
          const outcome = await runCli('legacy', 'seed');
          expect(outcome.writerMode).toBe('ticket_type');
          expect(outcome.counts).toEqual({
            processed: 2,
            initialized: 2,
            synced: 0,
            skipped: 0,
          });
          expect(await valkey.get(eventCounterKey(first.eventId))).toBe('5');
          expect(await valkey.get(eventCounterVersionKey(first.eventId))).toBe('1');
          expect(await valkey.get(eventCounterKey(second.eventId))).toBe('3');

          const after = await runValkeyCheck('ticket_type', 'preflight');
          for (const result of after) {
            expect(result).toEqual(
              expect.objectContaining({ violationCount: 0 }),
            );
          }
        },
      );
    });

    it('active namespace への seed は両方向とも refuse され、Valkey に何も書かれない', async () => {
      await withHarness(async ({ valkey, seedEvent, switchMode, runCli }) => {
        await seedEvent([5]);

        const keysBefore = await valkey.keys(INVENTORY_KEY_PATTERN);
        expect(keysBefore).toEqual([]);

        // legacy mode で legacy namespace（active 側）への seed は refuse。
        await expect(runCli('legacy', 'seed')).rejects.toBeInstanceOf(
          SeedNamespaceActiveError,
        );
        // ticket_type mode で ticket-type namespace（active 側）への seed も refuse。
        await switchMode('ticket_type');
        await expect(runCli('ticket-type', 'seed')).rejects.toBeInstanceOf(
          SeedNamespaceActiveError,
        );

        // どちらの refuse でも Valkey にキーが作られていない。
        expect(await valkey.keys(INVENTORY_KEY_PATTERN)).toEqual([]);
      });
    });

    it('reconcile は stale counter を DB 値へ CAS 補正し、revision が進んだ行は skip する', async () => {
      await withHarness(async ({ dataSource, valkey, seedEvent, runCli }) => {
        const { eventId } = await seedEvent([5]);
        // legacy counter を手で seed する（version '1' 相当の状態。legacy mode では
        // CLI seed が refuse されるため、稼働中 namespace の実態に合わせ直接置く）。
        await valkey.set(eventCounterKey(eventId), '5');
        await valkey.set(eventCounterVersionKey(eventId), '1');

        // legacy write pattern で DB 残数を 3 まで進める（counter は 5 のまま stale）。
        await dataSource.query(
          `UPDATE ticket_inventory
           SET remaining_quantity = remaining_quantity - 2,
               version = version + 1,
               updated_at = now()
           WHERE event_id = $1`,
          [eventId],
        );

        // 補正: counter 5 → 3、version は CAS の INCR で進む。
        const synced = await runCli('legacy', 'reconcile');
        expect(synced.counts).toEqual({
          processed: 1,
          initialized: 0,
          synced: 1,
          skipped: 0,
        });
        expect(await valkey.get(eventCounterKey(eventId))).toBe('3');
        expect(await valkey.get(eventCounterVersionKey(eventId))).toBe('2');

        // revision 取得と sync の間に並行 writer が割り込んだ状況を再現する:
        // get が revision を返した直後に version を進める（counter も変更する）。
        await valkey.set(eventCounterKey(eventId), '5');
        const racingValkey: ValkeyCounterClient = {
          get: async (key) => {
            const value = await valkey.get(key);
            if (key === eventCounterVersionKey(eventId)) {
              await valkey.incr(eventCounterVersionKey(eventId));
              await valkey.set(eventCounterKey(eventId), '4');
            }
            return value;
          },
          eval: (script, numKeys, ...args) =>
            valkey.eval(script, numKeys, ...args) as Promise<unknown>,
        };
        const skipped = await runCli('legacy', 'reconcile', racingValkey);
        expect(skipped.counts).toEqual({
          processed: 1,
          initialized: 0,
          synced: 0,
          skipped: 1,
        });
        // 並行 writer の値（4）が古い DB 値（3）で上書きされていない。
        expect(await valkey.get(eventCounterKey(eventId))).toBe('4');
      });
    });

    it('reconcile は counter 不在時にキーを作らない（legacy の EXISTS ガード付き script / ticket-type の既存 script）', async () => {
      await withHarness(async ({ valkey, seedEvent, runCli }) => {
        const { eventId, typeIds } = await seedEvent([5]);

        // legacy: counter 不在 + version 不在（'0' 扱い）でも skip し、キーを捏造しない
        // （service の SYNC_SCRIPT はこの入力でキーを新規作成してしまう。CLI 専用の
        // EXISTS ガード付き script がそれを防ぐことの実測）。
        const legacyOutcome = await runCli('legacy', 'reconcile');
        expect(legacyOutcome.counts).toEqual({
          processed: 1,
          initialized: 0,
          synced: 0,
          skipped: 1,
        });
        expect(await valkey.exists(eventCounterKey(eventId))).toBe(0);
        expect(await valkey.exists(eventCounterVersionKey(eventId))).toBe(0);

        // ticket-type: 既存 TICKET_TYPE_SYNC_SCRIPT の EXISTS ガードで同様に skip。
        const ticketTypeOutcome = await runCli('ticket-type', 'reconcile');
        expect(ticketTypeOutcome.counts).toEqual({
          processed: 1,
          initialized: 0,
          synced: 0,
          skipped: 1,
        });
        expect(
          await valkey.exists(ticketTypeCounterKey(eventId, typeIds[0])),
        ).toBe(0);
      });
    });
  },
);
