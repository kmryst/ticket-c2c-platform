// ファイル概要:
// writer mode 切替（ADR-0032 / Issue #378）の統合テストです。
// 実 PostgreSQL（TEST_DATABASE_URL）・実 Valkey（TEST_VALKEY_URL）・
// 実 OpenSearch（TEST_OPENSEARCH_URL）で、往復切替・差分注入 abort・lock 競合・
// 旧 writer 復活の fence 拒否・checker 不完全（Valkey 不達）・同一 mode 拒否・
// control row 欠損の fail closed を end-to-end で検証します。
//
// - 3 つの TEST_* が揃っていない場合は skip します（cutover-readiness.integration.spec
//   と同じ規則。CI は pr-check の focused step で実行する）。
// - test は一意 prefix の一時 DB（tt_switch_*）と一時 index（ticket-c2c-test-*）だけを
//   作成・削除します。

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import Redis from 'ioredis';
import { Client, Pool } from 'pg';
import { DataSource } from 'typeorm';
import {
  eventCounterKey,
  ticketTypeCounterKey,
  ticketTypeCounterRevisionKey,
} from '../cache/inventory-cache.keys';
import { createTestOpenSearchClient } from '../opensearch';
import { ensureEventsIndex } from '../search/events-projection.store';
import { rebuildInventoryProjection } from '../search/inventory-rebuild.service';
import {
  acquireSharedInventoryWriterBarrier,
  InventoryWriterMode,
} from '../database/inventory-writer-control';
import { parseTicketTypeCutoverEvidence } from './ticket-type-cutover-readiness';
import {
  executeWriterModeSwitch,
  runWriterModeSwitch,
} from './ticket-type-writer-mode-switch';
import { Baseline1751594400000 } from '../database/migrations/1751594400000-baseline';
import { AddUsers1783251707172 } from '../database/migrations/1783251707172-add-users';
import { AddPurchasesBuyerFk1783252676631 } from '../database/migrations/1783252676631-add-purchases-buyer-fk';
import { AddRefreshTokens1783307740648 } from '../database/migrations/1783307740648-add-refresh-tokens';
import { AddEventsCreatedBy1783342791808 } from '../database/migrations/1783342791808-add-events-created-by';
import { AddTicketTypeExpandSchema1785128190273 } from '../database/migrations/1785128190273-add-ticket-type-expand-schema';
import { AddTicketTypeCompatibilityWriter1785542400000 } from '../database/migrations/1785542400000-add-ticket-type-compatibility-writer';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_VALKEY_URL = process.env.TEST_VALKEY_URL;
const TEST_OPENSEARCH_URL = process.env.TEST_OPENSEARCH_URL;
const enabled = Boolean(TEST_DATABASE_URL && TEST_VALKEY_URL && TEST_OPENSEARCH_URL);
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

jest.setTimeout(180_000);

const TEST_INDEX_PREFIX = 'ticket-c2c-test-';
const INVENTORY_KEY_PATTERN = 'inventory:*';

// 統合テストは drain / lock 競合を意図的に作るため、既定 10s を待たない短い timeout を使う。
const TEST_TIMEOUTS = {
  lockTimeout: '500ms',
  statementTimeout: '30s',
  idleInTransactionTimeout: '30s',
};

interface HarnessCtx {
  dataSource: DataSource;
  pool: Pool;
  valkey: Redis;
  opensearch: OpenSearchClient;
  index: string;
  seedEvent: (total: number) => Promise<{ eventId: string; typeId: string }>;
  seedAllCounters: (eventId: string, typeId: string) => Promise<void>;
  rebuild: () => Promise<void>;
  currentMode: () => Promise<string>;
  runSwitch: (
    targetMode: InventoryWriterMode,
  ) => ReturnType<typeof runWriterModeSwitch>;
}

function assertLocalHost(rawUrl: string, label: string): void {
  const host = new URL(rawUrl).hostname;
  const isLocal =
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '::1' ||
    host === 'valkey' ||
    host === 'opensearch';
  if (!isLocal) {
    throw new Error(`${label} host must be local/test container, got ${host}`);
  }
}

describeIntegration(
  'writer mode 切替 CLI（実 PostgreSQL + 実 Valkey + 実 OpenSearch）',
  () => {
    let adminClient: Client;
    let databaseUrlTemplate: URL;
    let opensearch: OpenSearchClient;
    let valkey: Redis;

    beforeAll(async () => {
      if (!enabled) return;
      databaseUrlTemplate = new URL(TEST_DATABASE_URL as string);
      const adminUrl = new URL(databaseUrlTemplate);
      adminUrl.pathname = '/postgres';
      adminClient = new Client({ connectionString: adminUrl.toString() });
      await adminClient.connect();

      assertLocalHost(TEST_OPENSEARCH_URL as string, 'TEST_OPENSEARCH_URL');
      opensearch = createTestOpenSearchClient(TEST_OPENSEARCH_URL as string);
      await opensearch.cluster.health({ wait_for_status: 'yellow', timeout: '30s' });

      assertLocalHost(TEST_VALKEY_URL as string, 'TEST_VALKEY_URL');
      valkey = new Redis(TEST_VALKEY_URL as string, {
        maxRetriesPerRequest: 2,
        connectTimeout: 5000,
      });
      await valkey.ping();
    });

    afterAll(async () => {
      if (adminClient) await adminClient.end();
      if (opensearch) await opensearch.close();
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
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      const databaseName = ['tt_switch', process.pid, suffix].join('_');
      const quotedName = `"${databaseName}"`;
      const index = `${TEST_INDEX_PREFIX}${suffix}`;
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

      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        await dataSource.initialize();
        await dataSource.runMigrations({ transaction: 'each' });
        await ensureEventsIndex(opensearch, index);

        const seedEvent = async (
          total: number,
        ): Promise<{ eventId: string; typeId: string }> => {
          const eventId = randomUUID();
          await dataSource.query(
            `INSERT INTO events (id, title, event_type, starts_at)
             VALUES ($1, 'switch fixture', 'music', '2032-01-01T00:00:00Z')`,
            [eventId],
          );
          await dataSource.query(
            `INSERT INTO ticket_inventory (event_id, total_quantity, remaining_quantity)
             VALUES ($1, $2, $2)`,
            [eventId, total],
          );
          const rows = await dataSource.query<Array<{ id: string }>>(
            `SELECT id FROM ticket_types WHERE event_id = $1 AND is_default`,
            [eventId],
          );
          return { eventId, typeId: rows[0].id };
        };

        const seedAllCounters = async (
          eventId: string,
          typeId: string,
        ): Promise<void> => {
          const legacyRows = await dataSource.query<
            Array<{ remaining_quantity: number }>
          >(
            `SELECT remaining_quantity FROM ticket_inventory WHERE event_id = $1`,
            [eventId],
          );
          await valkey.set(
            eventCounterKey(eventId),
            String(legacyRows[0].remaining_quantity),
          );
          const typeRows = await dataSource.query<
            Array<{ remaining_quantity: number }>
          >(
            `SELECT remaining_quantity FROM ticket_type_inventory
             WHERE ticket_type_id = $1`,
            [typeId],
          );
          await valkey.set(
            ticketTypeCounterKey(eventId, typeId),
            String(typeRows[0].remaining_quantity),
          );
          await valkey.set(ticketTypeCounterRevisionKey(eventId, typeId), '1');
        };

        const rebuild = async (): Promise<void> => {
          const client = await pool.connect();
          try {
            await rebuildInventoryProjection(client, opensearch, { index });
          } finally {
            client.release();
          }
        };

        const currentMode = async (): Promise<string> => {
          const rows = await dataSource.query<Array<{ writer_mode: string }>>(
            `SELECT writer_mode FROM inventory_writer_control WHERE singleton`,
          );
          return rows[0]?.writer_mode;
        };

        const runSwitch = (targetMode: InventoryWriterMode) =>
          runWriterModeSwitch(
            { pool, valkey, opensearch },
            { targetMode, opensearchIndex: index, timeouts: TEST_TIMEOUTS },
          );

        const value = await run({
          dataSource,
          pool,
          valkey,
          opensearch,
          index,
          seedEvent,
          seedAllCounters,
          rebuild,
          currentMode,
          runSwitch,
        });
        outcome = { ok: true, value };
      } catch (error) {
        outcome = { ok: false, error };
      }

      const cleanupErrors: unknown[] = [];
      await runCleanupStep(cleanupErrors, async () => {
        if (!index.startsWith(TEST_INDEX_PREFIX)) {
          throw new Error(`refusing to delete non-test index ${index}`);
        }
        await opensearch.indices.delete({ index, ignore_unavailable: true } as never);
      });
      await runCleanupStep(cleanupErrors, () => flushInventoryCounterKeys());
      await runCleanupStep(cleanupErrors, () => pool.end());
      await runCleanupStep(cleanupErrors, async () => {
        if (dataSource.isInitialized) await dataSource.destroy();
      });
      await runCleanupStep(cleanupErrors, () =>
        dropDatabaseWhenIdle(adminClient, databaseName, quotedName),
      );

      if (!outcome.ok) {
        if (cleanupErrors.length > 0) {
          // eslint-disable-next-line no-console
          console.error('[harness cleanup] errors after test failure:', cleanupErrors);
        }
        throw outcome.error;
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, 'harness cleanup failed');
      }
      return outcome.value;
    }

    it('legacy → ticket_type → legacy → ticket_type の往復切替が成功し、各切替で preflight evidence が残る', async () => {
      await withHarness(
        async ({ seedEvent, seedAllCounters, rebuild, currentMode, runSwitch }) => {
          const { eventId, typeId } = await seedEvent(5);
          await seedAllCounters(eventId, typeId);
          await rebuild();

          const targets: InventoryWriterMode[] = [
            'ticket_type',
            'legacy',
            'ticket_type',
          ];
          for (const target of targets) {
            const outcome = await runSwitch(target);
            expect(outcome.status).toBe('switched');
            if (outcome.status !== 'switched') {
              throw new Error('unreachable');
            }
            expect(outcome.result.targetMode).toBe(target);
            expect(outcome.result.schemaRevision).toBe(
              'AddTicketTypeCompatibilityWriter1785542400000',
            );
            expect(await currentMode()).toBe(target);

            // preflight evidence は PR-1 parser でそのまま roundtrip できる。
            const parsed = parseTicketTypeCutoverEvidence(outcome.evidence);
            expect(parsed.checkPhase).toBe('preflight');
            expect(parsed.expectedWriterMode).toBe(
              target === 'ticket_type' ? 'legacy' : 'ticket_type',
            );
          }
        },
      );
    });

    it('DB 差分注入: preflight が violation を検出して切替 transaction を開始しない（mode 不変）', async () => {
      await withHarness(
        async ({
          dataSource,
          seedEvent,
          seedAllCounters,
          rebuild,
          currentMode,
          runSwitch,
        }) => {
          const { eventId, typeId } = await seedEvent(5);
          await seedAllCounters(eventId, typeId);
          await rebuild();

          // writer 経路外の破壊を模す（trigger を一時停止して legacy 集計だけ書き換える）。
          await dataSource.query('ALTER TABLE ticket_inventory DISABLE TRIGGER USER');
          try {
            await dataSource.query(
              `UPDATE ticket_inventory SET remaining_quantity = remaining_quantity - 1
               WHERE event_id = $1`,
              [eventId],
            );
          } finally {
            await dataSource.query('ALTER TABLE ticket_inventory ENABLE TRIGGER USER');
          }

          const outcome = await runSwitch('ticket_type');
          expect(outcome.status).toBe('preflight_violations');
          expect(await currentMode()).toBe('legacy');
          const parsed = parseTicketTypeCutoverEvidence(outcome.evidence);
          const mismatch = parsed.results.find(
            (r) => r.category === 'legacy_aggregate_remaining_mismatch',
          );
          expect(mismatch?.violationCount).toBe(1);
        },
      );
    });

    it('DB 差分注入: preflight 後の drift も切替 transaction 内の parity 検査が abort する（中間 state を永続化しない）', async () => {
      await withHarness(
        async ({ dataSource, pool, seedEvent, seedAllCounters, currentMode }) => {
          const { eventId, typeId } = await seedEvent(5);
          await seedAllCounters(eventId, typeId);

          // preflight を bypass して切替 transaction を直接実行する前に drift を注入する
          // （preflight green と切替の間に壊れた場合の再現）。
          await dataSource.query('ALTER TABLE ticket_inventory DISABLE TRIGGER USER');
          try {
            await dataSource.query(
              `UPDATE ticket_inventory SET remaining_quantity = remaining_quantity - 1
               WHERE event_id = $1`,
              [eventId],
            );
          } finally {
            await dataSource.query('ALTER TABLE ticket_inventory ENABLE TRIGGER USER');
          }

          const client = await pool.connect();
          try {
            await expect(
              executeWriterModeSwitch(client, 'ticket_type', {
                timeouts: TEST_TIMEOUTS,
              }),
            ).rejects.toThrow(/legacy_aggregate_remaining_mismatch=1/);
          } finally {
            client.release();
          }
          expect(await currentMode()).toBe('legacy');

          // abort 後に排他 barrier が解放されていることを実測する
          // （transaction-scoped lock の自動解放の確認）。
          const probe = await pool.connect();
          try {
            await probe.query('BEGIN');
            await probe.query("SET LOCAL lock_timeout = '1s'");
            await probe.query('SELECT pg_advisory_xact_lock(335, 376)');
            await probe.query('ROLLBACK');
          } finally {
            probe.release();
          }
        },
      );
    });

    it('lock 競合: shared barrier 保持中の in-flight writer がいると lock_timeout で失敗し、mode は変わらない', async () => {
      await withHarness(
        async ({ pool, seedEvent, seedAllCounters, currentMode }) => {
          const { eventId, typeId } = await seedEvent(5);
          await seedAllCounters(eventId, typeId);

          // in-flight writer を模す: 別 connection が shared barrier を保持したままにする。
          const writer = await pool.connect();
          await writer.query('BEGIN');
          await acquireSharedInventoryWriterBarrier(writer);
          try {
            const client = await pool.connect();
            try {
              await expect(
                executeWriterModeSwitch(client, 'ticket_type', {
                  timeouts: TEST_TIMEOUTS,
                }),
              ).rejects.toMatchObject({ code: '55P03' });
            } finally {
              client.release();
            }
            expect(await currentMode()).toBe('legacy');
          } finally {
            await writer.query('ROLLBACK').catch(() => undefined);
            writer.release();
          }

          // writer が commit（drain 完了）した後は切替が成功する。
          const client = await pool.connect();
          try {
            const result = await executeWriterModeSwitch(client, 'ticket_type', {
              timeouts: TEST_TIMEOUTS,
            });
            expect(result.targetMode).toBe('ticket_type');
          } finally {
            client.release();
          }
          expect(await currentMode()).toBe('ticket_type');
        },
      );
    });

    it('旧 writer 復活: activation 後の top-level legacy write は #376 fence が拒否する', async () => {
      await withHarness(
        async ({ dataSource, pool, seedEvent, seedAllCounters, currentMode }) => {
          const { eventId, typeId } = await seedEvent(5);
          await seedAllCounters(eventId, typeId);

          const client = await pool.connect();
          try {
            await executeWriterModeSwitch(client, 'ticket_type', {
              timeouts: TEST_TIMEOUTS,
            });
          } finally {
            client.release();
          }
          expect(await currentMode()).toBe('ticket_type');

          // 旧 binary / 直接 SQL の legacy 在庫更新は inactive writer として拒否される。
          await expect(
            dataSource.query(
              `UPDATE ticket_inventory SET remaining_quantity = remaining_quantity - 1
               WHERE event_id = $1`,
              [eventId],
            ),
          ).rejects.toThrow(/inactive inventory writer rejected/);
        },
      );
    });

    it('checker 不完全: Valkey へ到達できない場合は切替を試みず実行エラーで停止する', async () => {
      await withHarness(
        async ({ pool, opensearch, index, seedEvent, seedAllCounters, currentMode }) => {
          const { eventId, typeId } = await seedEvent(5);
          await seedAllCounters(eventId, typeId);

          const brokenValkey = {
            get: async (): Promise<string | null> => {
              throw new Error('valkey unreachable (injected)');
            },
            scan: async (): Promise<[string, string[]]> => {
              throw new Error('valkey unreachable (injected)');
            },
          };

          await expect(
            runWriterModeSwitch(
              { pool, valkey: brokenValkey, opensearch },
              {
                targetMode: 'ticket_type',
                opensearchIndex: index,
                timeouts: TEST_TIMEOUTS,
              },
            ),
          ).rejects.toThrow(/valkey unreachable/);
          expect(await currentMode()).toBe('legacy');
        },
      );
    });

    it('同一 mode への切替は暗黙 no-op にせず実行エラーで停止する', async () => {
      await withHarness(
        async ({ seedEvent, seedAllCounters, rebuild, currentMode, runSwitch }) => {
          const { eventId, typeId } = await seedEvent(5);
          await seedAllCounters(eventId, typeId);
          await rebuild();

          await expect(runSwitch('legacy')).rejects.toThrow(
            /already legacy; refusing implicit no-op switch/,
          );
          expect(await currentMode()).toBe('legacy');
        },
      );
    });

    it('control row 欠損: 切替 transaction は fail closed で停止する', async () => {
      await withHarness(async ({ dataSource, pool, seedEvent, seedAllCounters }) => {
        const { eventId, typeId } = await seedEvent(5);
        await seedAllCounters(eventId, typeId);

        await dataSource.query('DELETE FROM inventory_writer_control');
        const client = await pool.connect();
        try {
          await expect(
            executeWriterModeSwitch(client, 'ticket_type', {
              timeouts: TEST_TIMEOUTS,
            }),
          ).rejects.toThrow(/missing or invalid/);
        } finally {
          client.release();
        }

        // harness cleanup の整合のため control row を復旧する。
        await dataSource.query(
          `INSERT INTO inventory_writer_control (singleton, writer_mode)
           VALUES (true, 'legacy')`,
        );
      });
    });
  },
);

async function runCleanupStep(
  errors: unknown[],
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    errors.push(error);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// #394 の決定的な一時 DB cleanup（session 0 を待ってから plain DROP）を踏襲する。
async function dropDatabaseWhenIdle(
  adminClient: Client,
  databaseName: string,
  quotedName: string,
): Promise<void> {
  const deadlineMs = 5_000;
  const intervalMs = 50;
  const startedAt = Date.now();

  for (;;) {
    const { rows } = await adminClient.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`,
      [databaseName],
    );
    if (rows[0].n === 0) break;
    if (Date.now() - startedAt >= deadlineMs) {
      const diagnostics = await adminClient.query(
        `SELECT pid, state, wait_event_type, wait_event, left(query, 120) AS query
           FROM pg_stat_activity WHERE datname = $1`,
        [databaseName],
      );
      try {
        await adminClient.query(`DROP DATABASE ${quotedName} WITH (FORCE)`);
      } catch {
        // best-effort。
      }
      throw new Error(
        `一時 DB ${databaseName} の残存 session が ${deadlineMs}ms 以内に 0 になりませんでした: ${JSON.stringify(diagnostics.rows)}`,
      );
    }
    await delay(intervalMs);
  }

  await adminClient.query(`DROP DATABASE ${quotedName}`);
}
