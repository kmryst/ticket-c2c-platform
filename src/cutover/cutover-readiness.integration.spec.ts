// ファイル概要:
// Gate B cutover readiness checker の統合テストです（Issue #378）。
// 実 PostgreSQL（TEST_DATABASE_URL）・実 Valkey（TEST_VALKEY_URL）・
// 実 OpenSearch（TEST_OPENSEARCH_URL）を使い、DB / control state / Valkey / OpenSearch を
// 横断する検査と evidence の実挙動を end-to-end で検証します。
//
// - 3 つの TEST_* が揃っていない場合は skip し、CI の focused step と明示的な local
//   統合実行でだけ動かします（npm test 全体へは environment を渡さない）。
// - test は一意 prefix の一時 DB（tt_cutover_*）と一時 index（ticket-c2c-test-*）だけを
//   作成・削除します。Valkey は checker が SCAN する ticket-type counter namespace を
//   harness 開始時に払い出します（local / test container であることを assert してから）。

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
import { InventoryCacheService } from '../cache/inventory-cache.service';
import { DatabaseService } from '../database/database.service';
import { DomainEventsService } from '../messaging/domain-events.service';
import { PurchasesService } from '../purchases/purchases.service';
import { TicketTypeResolverService } from '../purchases/ticket-type-resolver.service';
import { createTestOpenSearchClient } from '../opensearch';
import { ensureEventsIndex } from '../search/events-projection.store';
import { rebuildInventoryProjection } from '../search/inventory-rebuild.service';
import {
  checkCutoverDatabase,
  checkCutoverOpenSearch,
  checkCutoverValkey,
  CutoverCheckPhase,
  hasTicketTypeCutoverViolations,
  parseTicketTypeCutoverEvidence,
  serializeTicketTypeCutoverEvidence,
  TicketTypeCutoverReadinessCategory,
  TicketTypeCutoverReadinessResult,
} from './ticket-type-cutover-readiness';
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

// 一時 index は必ずこの prefix を使う（cleanup 対象を一意に限定する）。
const TEST_INDEX_PREFIX = 'ticket-c2c-test-';
// checker が読む在庫 counter namespace（ticket-type counter と legacy Event counter の両方。
// harness 開始時に払い出す）。
const INVENTORY_KEY_PATTERN = 'inventory:*';

interface HarnessCtx {
  dataSource: DataSource;
  opensearch: OpenSearchClient;
  valkey: Redis;
  pgClient: () => Promise<import('pg').PoolClient>;
  index: string;
  seedEvent: (perType: number[]) => Promise<{
    eventId: string;
    typeIds: string[];
  }>;
  seedCounters: (eventId: string, typeIds: string[]) => Promise<void>;
  seedLegacyCounter: (eventId: string) => Promise<void>;
  // purchases / resolver / seedUser は「実際の購入 API で counter を更新してから
  // checker を走らせる」round-trip 検証に使う（#389 統合テストと同じ実 service 構成）。
  purchases: PurchasesService;
  resolver: TicketTypeResolverService;
  seedUser: () => Promise<string>;
  runAllChecks: (
    expectedMode: 'legacy' | 'ticket_type',
    phase?: CutoverCheckPhase,
  ) => Promise<{
    results: TicketTypeCutoverReadinessResult[];
    evidence: string;
    writerMode: 'legacy' | 'ticket_type' | null;
    schemaRevision: string;
  }>;
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
  'Gate B cutover readiness checker（実 PostgreSQL + 実 Valkey + 実 OpenSearch）',
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

      // round-trip 検証で使う実 PurchasesService（InventoryCacheService）は
      // VALKEY_URL を環境変数から読むため、test 用 endpoint を指しておく。
      process.env.VALKEY_URL = TEST_VALKEY_URL;
    });

    afterAll(async () => {
      if (adminClient) await adminClient.end();
      if (opensearch) await opensearch.close();
      if (valkey) valkey.disconnect();
    });

    // checker の SCAN は Valkey 全体の ticket-type counter namespace を見るため、
    // 前の test / suite の残存キーを未紐付け違反と誤検出しないよう harness 開始時に払い出す。
    // legacy Event counter（inventory:<eventId>）もこの suite が seed するため一緒に払い出す。
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
      const databaseName = ['tt_cutover', process.pid, suffix].join('_');
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
      // 実 PurchasesService 構成（#389 統合テストと同じ配線）。checker 検証の前提となる
      // counter 更新を、seed ヘルパーではなく実際の購入経路で発生させるために使う。
      const cache = new InventoryCacheService();

      let outcome: { ok: true; value: T } | { ok: false; error: unknown };
      try {
        await dataSource.initialize();
        await dataSource.runMigrations({ transaction: 'each' });
        await ensureEventsIndex(opensearch, index);

        const database = {
          connect: () => pool.connect(),
        } as unknown as DatabaseService;
        const resolver = new TicketTypeResolverService(database);
        const purchases = new PurchasesService(
          database,
          cache,
          { publish: jest.fn(async () => undefined) } as unknown as DomainEventsService,
          resolver,
        );

        const seedUser = async (): Promise<string> => {
          const userId = randomUUID();
          await dataSource.query(
            `INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'hash')`,
            [userId, `cutover-${randomUUID()}@example.com`],
          );
          return userId;
        };

        const seedEvent = async (
          perType: number[],
        ): Promise<{ eventId: string; typeIds: string[] }> => {
          const eventId = randomUUID();
          const total = perType.reduce((a, b) => a + b, 0);
          await switchWriterMode(dataSource, 'legacy');
          await dataSource.query(
            `INSERT INTO events (id, title, event_type, starts_at)
             VALUES ($1, 'cutover fixture', 'music', '2032-01-01T00:00:00Z')`,
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
            await switchWriterMode(dataSource, 'ticket_type');
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
            await switchWriterMode(dataSource, 'legacy');
          }
          return { eventId, typeIds };
        };

        const seedCounters = async (
          eventId: string,
          typeIds: string[],
        ): Promise<void> => {
          const rows = await dataSource.query<
            Array<{ ticket_type_id: string; remaining_quantity: number }>
          >(
            `SELECT ticket_type_id, remaining_quantity
             FROM ticket_type_inventory WHERE event_id = $1`,
            [eventId],
          );
          for (const typeId of typeIds) {
            const row = rows.find((r) => r.ticket_type_id === typeId);
            if (!row) throw new Error(`no inventory row for ${typeId}`);
            await valkey.set(
              ticketTypeCounterKey(eventId, typeId),
              String(row.remaining_quantity),
            );
            await valkey.set(ticketTypeCounterRevisionKey(eventId, typeId), '1');
          }
        };

        // seedLegacyCounter は legacy Event counter を ticket_inventory の remaining と
        // 一致する値で seed する（version キー不在は '0' 扱いの正常状態なので作らない）。
        const seedLegacyCounter = async (eventId: string): Promise<void> => {
          const rows = await dataSource.query<
            Array<{ remaining_quantity: number }>
          >(
            `SELECT remaining_quantity FROM ticket_inventory WHERE event_id = $1`,
            [eventId],
          );
          if (rows.length !== 1) {
            throw new Error(`no legacy inventory row for ${eventId}`);
          }
          await valkey.set(
            eventCounterKey(eventId),
            String(rows[0].remaining_quantity),
          );
        };

        const runAllChecks = async (
          expectedMode: 'legacy' | 'ticket_type',
          phase: CutoverCheckPhase = 'preflight',
        ) => {
          const snapshotClient = await pool.connect();
          let databaseCheck: Awaited<ReturnType<typeof checkCutoverDatabase>>;
          let valkeyResults: TicketTypeCutoverReadinessResult[];
          try {
            // CLI と同じ read-only snapshot 規則で実行する。
            await snapshotClient.query(
              'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
            );
            await snapshotClient.query("SET LOCAL statement_timeout = '60s'");
            await snapshotClient.query("SET LOCAL lock_timeout = '5s'");
            await snapshotClient.query(
              "SET LOCAL idle_in_transaction_session_timeout = '60s'",
            );
            databaseCheck = await checkCutoverDatabase(snapshotClient, expectedMode);
            valkeyResults = await checkCutoverValkey(
              snapshotClient,
              valkey,
              expectedMode,
              phase,
              { pageSize: 2 },
            );
            await snapshotClient.query('COMMIT');
          } catch (error) {
            await snapshotClient.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            snapshotClient.release();
          }

          const projectionClient = await pool.connect();
          let opensearchCheck: Awaited<ReturnType<typeof checkCutoverOpenSearch>>;
          try {
            opensearchCheck = await checkCutoverOpenSearch(
              projectionClient,
              opensearch,
              { index, pageSize: 2 },
            );
          } finally {
            projectionClient.release();
          }

          const results = [
            ...databaseCheck.results,
            ...valkeyResults,
            opensearchCheck.result,
          ];
          const evidence =
            databaseCheck.writerMode === null
              ? ''
              : serializeTicketTypeCutoverEvidence({
                  expectedWriterMode: expectedMode,
                  checkPhase: phase,
                  writerMode: databaseCheck.writerMode,
                  schemaRevision: databaseCheck.schemaRevision,
                  opensearchIndex: index,
                  results,
                  opensearchReport: opensearchCheck.report,
                });
          return {
            results,
            evidence,
            writerMode: databaseCheck.writerMode,
            schemaRevision: databaseCheck.schemaRevision,
          };
        };

        const value = await run({
          dataSource,
          opensearch,
          valkey,
          pgClient: () => pool.connect(),
          index,
          seedEvent,
          seedCounters,
          seedLegacyCounter,
          purchases,
          resolver,
          seedUser,
          runAllChecks,
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
      await runCleanupStep(cleanupErrors, () => cache.onModuleDestroy());
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

    function count(
      results: readonly TicketTypeCutoverReadinessResult[],
      category: TicketTypeCutoverReadinessCategory,
    ): number {
      const entry = results.find((r) => r.category === category);
      if (!entry) throw new Error(`category not reported: ${category}`);
      return entry.violationCount;
    }

    it('legacy mode の健全な状態（両 namespace の counter seed 済み）で全 21 category が violation 0 になり、evidence が roundtrip する', async () => {
      await withHarness(
        async ({
          pgClient,
          seedEvent,
          seedCounters,
          seedLegacyCounter,
          runAllChecks,
          index,
        }) => {
          // 健全な activation 直前 preflight の状態を正しく作る:
          // legacy Event counter は DB と一致する値で seed 済み、切替先の
          // ticket_type counter も全件事前 seed 済み（未 seed は violation になる）。
          const first = await seedEvent([5]);
          const second = await seedEvent([7]);
          for (const { eventId, typeIds } of [first, second]) {
            await seedLegacyCounter(eventId);
            await seedCounters(eventId, typeIds);
          }
          const client = await pgClient();
          try {
            await rebuildInventoryProjection(client, opensearch, { index });
          } finally {
            client.release();
          }

          const { results, evidence, writerMode, schemaRevision } =
            await runAllChecks('legacy');
          expect(results).toHaveLength(21);
          expect(hasTicketTypeCutoverViolations(results)).toBe(false);
          expect(writerMode).toBe('legacy');
          expect(schemaRevision).toBe('AddTicketTypeCompatibilityWriter1785542400000');

          const parsed = parseTicketTypeCutoverEvidence(evidence);
          expect(parsed.complete).toBe(true);
          expect(parsed.categoryCount).toBe(21);
          expect(parsed.opensearchReport.checkedEvents).toBe(2);
          expect(parsed.opensearchReport.totalDiffs).toBe(0);
        },
      );
    });

    it('ticket_type mode で counter を seed すれば violation 0、未 seed なら missing になる', async () => {
      await withHarness(async ({ dataSource, pgClient, seedEvent, seedCounters, runAllChecks, index }) => {
        const { eventId, typeIds } = await seedEvent([5, 3]);
        const client = await pgClient();
        try {
          await rebuildInventoryProjection(client, opensearch, { index });
        } finally {
          client.release();
        }
        await switchWriterMode(dataSource, 'ticket_type');

        // 未 seed: default + 追加 Type の 2 counter が missing。
        const before = await runAllChecks('ticket_type');
        expect(count(before.results, 'valkey_counter_missing')).toBe(2);
        expect(hasTicketTypeCutoverViolations(before.results)).toBe(true);

        // seed 後: 全 category 0。
        await seedCounters(eventId, typeIds);
        const after = await runAllChecks('ticket_type');
        expect(hasTicketTypeCutoverViolations(after.results)).toBe(false);
        expect(after.writerMode).toBe('ticket_type');
      });
    });

    it('control state と expect-mode の不一致を writer_control_mode_mismatch として検出する', async () => {
      await withHarness(async ({ pgClient, seedEvent, runAllChecks, index }) => {
        await seedEvent([5]);
        const client = await pgClient();
        try {
          await rebuildInventoryProjection(client, opensearch, { index });
        } finally {
          client.release();
        }
        // control は legacy のまま ticket_type を期待する（activation 前の誤操作を模す）。
        const { results, writerMode } = await runAllChecks('ticket_type');
        expect(count(results, 'writer_control_mode_mismatch')).toBe(1);
        expect(writerMode).toBe('legacy');
        expect(hasTicketTypeCutoverViolations(results)).toBe(true);
      });
    });

    it('DB 差分注入: writer 経路外の legacy 集計破壊を Type 合計との乖離として検出する', async () => {
      await withHarness(async ({ dataSource, pgClient, seedEvent, runAllChecks, index }) => {
        const { eventId } = await seedEvent([5]);
        const client = await pgClient();
        try {
          await rebuildInventoryProjection(client, opensearch, { index });
        } finally {
          client.release();
        }

        // #376 の compatibility trigger は writer 経路内の乖離を防ぐ（reverse mirror が
        // legacy 集計を同期する）ため、乖離は trigger を経由しない破壊としてしか起きない。
        // それを模して user trigger を一時停止し、legacy 集計だけを書き換える。
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

        const { results } = await runAllChecks('legacy');
        expect(count(results, 'legacy_aggregate_remaining_mismatch')).toBe(1);
        expect(count(results, 'legacy_aggregate_total_mismatch')).toBe(0);
        expect(hasTicketTypeCutoverViolations(results)).toBe(true);
      });
    });

    it('legacy mode の検査は非 default Type の在庫行残存を violation にする', async () => {
      await withHarness(async ({ pgClient, seedEvent, runAllChecks, index }) => {
        // seedEvent は追加 Type を ticket_type mode で作った後 legacy へ戻す
        // （rollback 後に非 default Type が残った状態を模す）。
        await seedEvent([5, 3]);
        const client = await pgClient();
        try {
          await rebuildInventoryProjection(client, opensearch, { index });
        } finally {
          client.release();
        }
        const { results } = await runAllChecks('legacy');
        expect(
          count(results, 'non_default_ticket_type_inventory_in_legacy_mode'),
        ).toBe(1);
        // 集計 parity 自体は保たれている（reverse mirror が同期済み）。
        expect(count(results, 'legacy_aggregate_total_mismatch')).toBe(0);
        expect(count(results, 'legacy_aggregate_remaining_mismatch')).toBe(0);
      });
    });

    it('legacy mode preflight: stale な legacy counter と未 seed の ticket_type counter を violation にする', async () => {
      await withHarness(
        async ({ valkey, pgClient, seedEvent, seedLegacyCounter, runAllChecks, index }) => {
          const { eventId } = await seedEvent([5]);
          const client = await pgClient();
          try {
            await rebuildInventoryProjection(client, opensearch, { index });
          } finally {
            client.release();
          }

          // rollback 後に legacy counter が 0 のまま残った状態を模す
          // （DB の remaining は 5。counter 0 のままだと購入 API が sold_out で誤拒否する）。
          await seedLegacyCounter(eventId);
          await valkey.set(eventCounterKey(eventId), '0');

          const { results } = await runAllChecks('legacy');
          expect(count(results, 'valkey_legacy_counter_remaining_mismatch')).toBe(1);
          expect(count(results, 'valkey_legacy_counter_value_invalid')).toBe(0);
          // 切替先 ticket_type counter の未 seed も legacy mode preflight で violation になる。
          expect(count(results, 'valkey_counter_missing')).toBe(1);
          expect(hasTicketTypeCutoverViolations(results)).toBe(true);
        },
      );
    });

    it('DB 差分注入: 在庫行の無い非 default Ticket Type を ticket_type_without_ticket_type_inventory として検出する', async () => {
      await withHarness(async ({ dataSource, pgClient, seedEvent, runAllChecks, index }) => {
        const { eventId } = await seedEvent([5]);
        const client = await pgClient();
        try {
          await rebuildInventoryProjection(client, opensearch, { index });
        } finally {
          client.release();
        }

        // ticket_types 定義だけ追加し、対応する ticket_type_inventory 行を作らない
        // （この Type への購入は在庫行 UPDATE 0 件で API 500 になる）。
        await dataSource.query(
          `INSERT INTO ticket_types (id, event_id, name, is_default)
           VALUES ($1, $2, 'orphan-type', false)`,
          [randomUUID(), eventId],
        );

        const { results } = await runAllChecks('legacy');
        expect(count(results, 'ticket_type_without_ticket_type_inventory')).toBe(1);
        expect(hasTicketTypeCutoverViolations(results)).toBe(true);
      });
    });

    it('schema 差分注入: 無効化された compatibility trigger と改変された requestId index を検出する', async () => {
      await withHarness(async ({ dataSource, pgClient, seedEvent, runAllChecks, index }) => {
        await seedEvent([5]);
        const client = await pgClient();
        try {
          await rebuildInventoryProjection(client, opensearch, { index });
        } finally {
          client.release();
        }

        // migration 履歴上は適用済みのまま、writer guard trigger を後から無効化し、
        // 統合 requestId unique index を #376 以前の status 付き partial index に戻す
        // （schemaRevision だけでは検出できない drift を模す）。
        await dataSource.query(
          `ALTER TABLE ticket_inventory
           DISABLE TRIGGER inventory_compatibility_guard_legacy_write_trg`,
        );
        await dataSource.query('DROP INDEX purchases_request_id_uq');
        await dataSource.query(
          `CREATE UNIQUE INDEX purchases_request_id_uq
           ON purchases (buyer_id, event_id, request_id)
           WHERE request_id IS NOT NULL AND status = 'confirmed'`,
        );

        const { results } = await runAllChecks('legacy');
        expect(count(results, 'compatibility_object_missing_or_invalid')).toBe(2);
        expect(hasTicketTypeCutoverViolations(results)).toBe(true);
      });
    });

    it('schema 差分注入: 同名 trigger の関数本体 no-op 差し替えと狭められた requestId index predicate を検出する', async () => {
      await withHarness(async ({ dataSource, pgClient, seedEvent, runAllChecks, index }) => {
        await seedEvent([5]);
        const client = await pgClient();
        try {
          await rebuildInventoryProjection(client, opensearch, { index });
        } finally {
          client.release();
        }

        // 1) trigger の名前・対象 table・tgenabled はそのままに、関数本体だけを no-op に
        //    差し替える（配線検査だけでは PASS してしまう false-green の温床。
        //    ADR-0029 の「function 本文を exact hash で識別する」契約の検証）。
        await dataSource.query(`
          CREATE OR REPLACE FUNCTION inventory_compatibility_guard_legacy_write()
          RETURNS trigger
          LANGUAGE plpgsql
          SET search_path = pg_catalog, public, pg_temp
          AS $$
          BEGIN
            RETURN NEW;
          END
          $$
        `);
        // 2) requestId unique index を「#376 の predicate を部分文字列として含む」狭い
        //    predicate に差し替える（LIKE 比較では素通りする形。実質 index が効かない）。
        await dataSource.query('DROP INDEX purchases_request_id_uq');
        await dataSource.query(`
          CREATE UNIQUE INDEX purchases_request_id_uq
          ON purchases (buyer_id, event_id, request_id)
          WHERE request_id IS NOT NULL AND false
        `);

        const { results } = await runAllChecks('legacy');
        expect(count(results, 'compatibility_object_missing_or_invalid')).toBe(2);
        expect(hasTicketTypeCutoverViolations(results)).toBe(true);
      });
    });

    it('activation → rollback の往復: 実購入 API で counter を更新した後、postflight は緩和規則で green になり preflight は stale を fail closed に検出する', async () => {
      await withHarness(
        async ({
          dataSource,
          valkey,
          pgClient,
          purchases,
          resolver,
          seedUser,
          seedEvent,
          seedCounters,
          seedLegacyCounter,
          runAllChecks,
          index,
        }) => {
          const buyer = await seedUser();
          const first = await seedEvent([5]);
          const second = await seedEvent([3]);
          for (const { eventId, typeIds } of [first, second]) {
            await seedLegacyCounter(eventId);
            await seedCounters(eventId, typeIds);
          }
          const rebuild = async (): Promise<void> => {
            const client = await pgClient();
            try {
              await rebuildInventoryProjection(client, opensearch, { index });
            } finally {
              client.release();
            }
          };
          const legacyDbRemaining = async (): Promise<number> => {
            const rows = await dataSource.query<
              Array<{ remaining_quantity: number }>
            >(
              `SELECT remaining_quantity FROM ticket_inventory WHERE event_id = $1`,
              [first.eventId],
            );
            return rows[0].remaining_quantity;
          };
          await rebuild();

          // activation preflight（legacy 稼働中・両 namespace seed 済み）: green。
          const activationPre = await runAllChecks('legacy', 'preflight');
          expect(hasTicketTypeCutoverViolations(activationPre.results)).toBe(false);

          // activation → 実購入 smoke: ticket_type 経路は Ticket Type counter と DB を
          // 進めるが、legacy Event counter は更新しない。
          await switchWriterMode(dataSource, 'ticket_type');
          resolver.invalidate(first.eventId);
          const activationSmoke = await purchases.createPurchase(
            first.eventId,
            buyer,
            { quantity: 2 },
          );
          expect(activationSmoke.status).toBe('confirmed');
          await rebuild();

          // 前提を実測で固定: DB は 3 まで進み、legacy counter は 5 のまま stale。
          expect(await legacyDbRemaining()).toBe(3);
          expect(await valkey.get(eventCounterKey(first.eventId))).toBe('5');

          // activation postflight: stale legacy counter を許容して green。
          const activationPost = await runAllChecks('ticket_type', 'postflight');
          expect(hasTicketTypeCutoverViolations(activationPost.results)).toBe(false);
          const parsedPost = parseTicketTypeCutoverEvidence(activationPost.evidence);
          expect(parsedPost.checkPhase).toBe('postflight');
          expect(parsedPost.writerMode).toBe('ticket_type');

          // rollback preflight は同じ状態を fail closed に検出する
          // （stale legacy counter の削除/再 seed を強制する）。
          const rollbackPre = await runAllChecks('ticket_type', 'preflight');
          expect(
            count(rollbackPre.results, 'valkey_legacy_counter_remaining_mismatch'),
          ).toBe(1);
          expect(hasTicketTypeCutoverViolations(rollbackPre.results)).toBe(true);

          // runbook どおり legacy counter を DB 値で再 seed すると rollback preflight は green。
          await seedLegacyCounter(first.eventId);
          const rollbackPreReseeded = await runAllChecks('ticket_type', 'preflight');
          expect(hasTicketTypeCutoverViolations(rollbackPreReseeded.results)).toBe(false);

          // rollback → 実購入 smoke: legacy 経路は Event counter と DB を進めるが、
          // Ticket Type counter は更新しない。second Event の Ticket Type counter は
          // rollback 時の削除を模して消しておく（不在許容の検証）。
          await switchWriterMode(dataSource, 'legacy');
          resolver.invalidate(first.eventId);
          await valkey.del(
            ticketTypeCounterKey(second.eventId, second.typeIds[0]),
            ticketTypeCounterRevisionKey(second.eventId, second.typeIds[0]),
          );
          const rollbackSmoke = await purchases.createPurchase(
            first.eventId,
            buyer,
            { quantity: 1 },
          );
          expect(rollbackSmoke.status).toBe('confirmed');
          await rebuild();

          // 前提を実測で固定: DB は 2 まで進み、first の Ticket Type counter は
          // 3 のまま stale で残る（forward bridge は DB 行だけを進める）。
          expect(await legacyDbRemaining()).toBe(2);
          expect(
            await valkey.get(
              ticketTypeCounterKey(first.eventId, first.typeIds[0]),
            ),
          ).toBe('3');

          // rollback postflight: Ticket Type counter の不在（second）と stale（first）を
          // 許容して green（legacy counter は sync 済みで DB と一致している）。
          const rollbackPost = await runAllChecks('legacy', 'postflight');
          expect(hasTicketTypeCutoverViolations(rollbackPost.results)).toBe(false);
          expect(
            parseTicketTypeCutoverEvidence(rollbackPost.evidence).checkPhase,
          ).toBe('postflight');

          // 次の activation preflight は stale（first）と未 seed（second）の
          // Ticket Type counter を fail closed に検出する（再 seed を強制する）。
          const nextActivationPre = await runAllChecks('legacy', 'preflight');
          expect(
            count(nextActivationPre.results, 'valkey_counter_remaining_mismatch'),
          ).toBe(1);
          expect(count(nextActivationPre.results, 'valkey_counter_missing')).toBe(1);
          expect(hasTicketTypeCutoverViolations(nextActivationPre.results)).toBe(true);
        },
      );
    });

    it('Valkey 差分注入: 未紐付け counter / 値 mismatch / 不正値 / revision 欠落を検出する', async () => {
      await withHarness(async ({ dataSource, valkey, pgClient, seedEvent, seedCounters, runAllChecks, index }) => {
        const { eventId, typeIds } = await seedEvent([5, 3]);
        const client = await pgClient();
        try {
          await rebuildInventoryProjection(client, opensearch, { index });
        } finally {
          client.release();
        }
        await switchWriterMode(dataSource, 'ticket_type');
        await seedCounters(eventId, typeIds);

        // 1) DB に無い counter キー（seed の消し忘れ・別環境の残骸を模す）。
        await valkey.set(ticketTypeCounterKey(randomUUID(), randomUUID()), '9');
        // 2) default Type counter の値を DB とずらす。
        await valkey.set(ticketTypeCounterKey(eventId, typeIds[0]), '4');
        // 3) 追加 Type counter を構造的に不正な値にし、revision も消す。
        await valkey.set(ticketTypeCounterKey(eventId, typeIds[1]), 'not-a-number');
        await valkey.del(ticketTypeCounterRevisionKey(eventId, typeIds[1]));

        const { results } = await runAllChecks('ticket_type');
        expect(count(results, 'valkey_counter_without_inventory_row')).toBe(1);
        expect(count(results, 'valkey_counter_remaining_mismatch')).toBe(1);
        expect(count(results, 'valkey_counter_value_invalid')).toBe(1);
        expect(count(results, 'valkey_revision_missing_or_invalid')).toBe(1);
        expect(count(results, 'valkey_counter_missing')).toBe(0);
      });
    });

    it('OpenSearch 差分は #377 reconciliation の totalDiffs として 1 category へ集約される', async () => {
      await withHarness(async ({ pgClient, seedEvent, runAllChecks, index }) => {
        const { eventId } = await seedEvent([5]);
        const client = await pgClient();
        try {
          await rebuildInventoryProjection(client, opensearch, { index });
        } finally {
          client.release();
        }
        // projection document を削除する（PG は変更しない）。
        await opensearch.delete({ index, id: eventId, refresh: true });

        const { results, evidence } = await runAllChecks('legacy');
        expect(count(results, 'opensearch_projection_diff')).toBeGreaterThanOrEqual(1);
        const parsed = parseTicketTypeCutoverEvidence(evidence);
        expect(parsed.opensearchReport.counts.missing_event_document).toBe(1);
        expect(parsed.opensearchReport.totalDiffs).toBe(
          count(results, 'opensearch_projection_diff'),
        );
        expect(hasTicketTypeCutoverViolations(results)).toBe(true);
      });
    });

    it('実 evidence を改竄（category 除去）すると parser が fail closed に拒否する', async () => {
      await withHarness(async ({ pgClient, seedEvent, runAllChecks, index }) => {
        await seedEvent([5]);
        const client = await pgClient();
        try {
          await rebuildInventoryProjection(client, opensearch, { index });
        } finally {
          client.release();
        }
        const { evidence } = await runAllChecks('legacy');
        const tampered = JSON.parse(evidence) as {
          results: TicketTypeCutoverReadinessResult[];
        } & Record<string, unknown>;
        tampered.results = tampered.results.filter(
          (r) => r.category !== 'writer_control_mode_mismatch',
        );
        expect(() =>
          parseTicketTypeCutoverEvidence(JSON.stringify(tampered)),
        ).toThrow();
        // 正規の evidence はそのまま受理される。
        expect(() => parseTicketTypeCutoverEvidence(evidence)).not.toThrow();
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

// #394 の決定的な一時 DB cleanup（session 0 を待ってから plain DROP、WITH (FORCE) は使わない）を踏襲する。
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

// projection.integration.spec.ts と同じ手順で control state を切り替える
// （#376 の shared barrier を exclusive で取得してから UPDATE する）。
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
}
