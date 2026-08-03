// ファイル概要:
// このファイルは versioned Ticket Type 検索 projection の focused 統合テストです（Issue #377）。
// 実 PostgreSQL（TEST_DATABASE_URL）と実 OpenSearch（TEST_OPENSEARCH_URL）を使い、
// mapping / Painless script / reconciliation / rebuild の実挙動を end-to-end で検証します。
//
// - TEST_DATABASE_URL / TEST_OPENSEARCH_URL 未設定時は skip し、CI の focused step と
//   明示的な local 統合実行でだけ動かします（npm test 全体へは environment を渡さない）。
// - test は一意 prefix の一時 DB（tt_projection_*）と一時 index（ticket-c2c-test-*）だけを
//   作成・削除します。shared resource は削除しません。
// - OpenSearch image は Terraform の OpenSearch_2.19 と互換な 2.19 系を exact pin で使います
//   （CI の service container / local container 側で pin）。

import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import { Client, Pool } from 'pg';
import { DataSource } from 'typeorm';
// review 8: test 専用の無署名 client 経路を使い、AWS runtime の trust 判断と混ぜない。
import { createTestOpenSearchClient } from '../opensearch';
import {
  applyEventMetadata,
  applyLegacyInventoryChanged,
  applyVersionedInventoryChanged,
  ensureEventsIndex,
} from './events-projection.store';
import { buildVersionedInventoryChangedDetail } from '../messaging/inventory-event.contract';
import {
  toEventInventoryVersion,
  toTicketTypeInventoryVersion,
} from '../messaging/inventory-version';
import { reconcileInventoryProjection } from './inventory-reconciliation.service';
import { rebuildInventoryProjection } from './inventory-rebuild.service';
import { Baseline1751594400000 } from '../database/migrations/1751594400000-baseline';
import { AddUsers1783251707172 } from '../database/migrations/1783251707172-add-users';
import { AddPurchasesBuyerFk1783252676631 } from '../database/migrations/1783252676631-add-purchases-buyer-fk';
import { AddRefreshTokens1783307740648 } from '../database/migrations/1783307740648-add-refresh-tokens';
import { AddEventsCreatedBy1783342791808 } from '../database/migrations/1783342791808-add-events-created-by';
import { AddTicketTypeExpandSchema1785128190273 } from '../database/migrations/1785128190273-add-ticket-type-expand-schema';
import { AddTicketTypeCompatibilityWriter1785542400000 } from '../database/migrations/1785542400000-add-ticket-type-compatibility-writer';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TEST_OPENSEARCH_URL = process.env.TEST_OPENSEARCH_URL;
const enabled = Boolean(TEST_DATABASE_URL && TEST_OPENSEARCH_URL);
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

interface HarnessCtx {
  dataSource: DataSource;
  opensearch: OpenSearchClient;
  pgClient: () => Promise<import('pg').PoolClient>;
  index: string;
  seedEvent: (perType: number[]) => Promise<{
    eventId: string;
    typeIds: string[];
  }>;
  getDoc: (eventId: string) => Promise<Record<string, unknown> | null>;
}

describeIntegration(
  'versioned Ticket Type 検索 projection（実 PostgreSQL + 実 OpenSearch）',
  () => {
    let adminClient: Client;
    let databaseUrlTemplate: URL;
    let opensearch: OpenSearchClient;

    beforeAll(async () => {
      if (!enabled) return;
      databaseUrlTemplate = new URL(TEST_DATABASE_URL as string);
      const adminUrl = new URL(databaseUrlTemplate);
      adminUrl.pathname = '/postgres';
      adminClient = new Client({ connectionString: adminUrl.toString() });
      await adminClient.connect();

      // cleanup 前に接続先が local / test container であることを assert する。
      const url = new URL(TEST_OPENSEARCH_URL as string);
      const host = url.hostname;
      const isLocal =
        host === '127.0.0.1' ||
        host === 'localhost' ||
        host === '::1' ||
        host === 'opensearch';
      if (!isLocal) {
        throw new Error(
          `TEST_OPENSEARCH_URL host must be local/test container, got ${host}`,
        );
      }
      opensearch = createTestOpenSearchClient(TEST_OPENSEARCH_URL as string);
      await opensearch.cluster.health({ wait_for_status: 'yellow', timeout: '30s' });
    });

    afterAll(async () => {
      if (adminClient) await adminClient.end();
      if (opensearch) await opensearch.close();
    });

    async function withHarness<T>(
      run: (ctx: HarnessCtx) => Promise<T>,
    ): Promise<T> {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      const databaseName = ['tt_projection', process.pid, suffix].join('_');
      const quotedName = `"${databaseName}"`;
      const index = `${TEST_INDEX_PREFIX}${suffix}`;
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
          perType: number[],
        ): Promise<{ eventId: string; typeIds: string[] }> => {
          const eventId = randomUUID();
          const total = perType.reduce((a, b) => a + b, 0);
          await switchWriterMode(dataSource, 'legacy');
          await dataSource.query(
            `INSERT INTO events (id, title, event_type, starts_at)
             VALUES ($1, 'projection fixture', 'music', '2032-01-01T00:00:00Z')`,
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
          return { eventId, typeIds };
        };

        const getDoc = async (
          eventId: string,
        ): Promise<Record<string, unknown> | null> => {
          try {
            const res = await opensearch.get({ index, id: eventId });
            return res.body._source as Record<string, unknown>;
          } catch {
            return null;
          }
        };

        const value = await run({
          dataSource,
          opensearch,
          pgClient: () => pool.connect(),
          index,
          seedEvent,
          getDoc,
        });
        outcome = { ok: true, value };
      } catch (error) {
        outcome = { ok: false, error };
      }

      const cleanupErrors: unknown[] = [];
      // 一時 index は prefix を再確認してから削除する（shared index を消さない）。
      await runCleanupStep(cleanupErrors, async () => {
        if (!index.startsWith(TEST_INDEX_PREFIX)) {
          throw new Error(`refusing to delete non-test index ${index}`);
        }
        await opensearch.indices.delete({ index, ignore_unavailable: true } as never);
      });
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

    // versioned payload を作る helper（値は任意指定）。
    function versioned(
      eventId: string,
      typeId: string,
      opts: {
        typeTotal: number;
        typeRemaining: number;
        typeVersion: number;
        eventTotal: number;
        eventRemaining: number;
        eventVersion: number;
        name?: string;
      },
    ) {
      return buildVersionedInventoryChangedDetail({
        eventId,
        ticketTypeId: typeId,
        ticketTypeName: opts.name ?? 'GA',
        ticketTypeTotalQuantity: opts.typeTotal,
        ticketTypeRemainingQuantity: opts.typeRemaining,
        inventoryVersion: toTicketTypeInventoryVersion(opts.typeVersion),
        eventTotalQuantity: opts.eventTotal,
        eventRemainingQuantity: opts.eventRemaining,
        eventInventoryVersion: toEventInventoryVersion(opts.eventVersion),
      });
    }

    function findType(
      doc: Record<string, unknown> | null,
      typeId: string,
    ): Record<string, unknown> | undefined {
      const types = (doc?.ticket_types ?? []) as Array<Record<string, unknown>>;
      return types.find((t) => t.ticket_type_id === typeId);
    }

    it('新規 index を完全 mapping で作成し、既存 index へ additive putMapping する', async () => {
      await withHarness(async ({ index }) => {
        const mapping = await opensearch.indices.getMapping({ index });
        const props = (mapping.body as Record<string, { mappings: { properties: Record<string, unknown> } }>)[
          index
        ].mappings.properties;
        expect(props).toHaveProperty('ticket_types');
        expect(props).toHaveProperty('event_inventory_version');
        expect((props.ticket_types as { type: string }).type).toBe('nested');
        // 再度 ensureEventsIndex は idempotent（additive putMapping）で失敗しない。
        await ensureEventsIndex(opensearch, index);
      });
    });

    it('既存 legacy index（旧 mapping）へ additive に versioned field を足す', async () => {
      await withHarness(async () => {
        const legacyIndex = `${TEST_INDEX_PREFIX}legacy-${randomUUID().slice(0, 8)}`;
        try {
          await opensearch.indices.create({
            index: legacyIndex,
            body: {
              mappings: {
                properties: {
                  event_id: { type: 'keyword' },
                  remaining_quantity: { type: 'integer' },
                },
              },
            },
          });
          await ensureEventsIndex(opensearch, legacyIndex);
          const mapping = await opensearch.indices.getMapping({ index: legacyIndex });
          const props = (mapping.body as Record<string, { mappings: { properties: Record<string, unknown> } }>)[
            legacyIndex
          ].mappings.properties;
          expect(props).toHaveProperty('ticket_types');
          expect(props).toHaveProperty('event_inventory_version');
        } finally {
          await opensearch.indices.delete({ index: legacyIndex, ignore_unavailable: true } as never);
        }
      });
    });

    it('正順 → duplicate → stale の各段階で不変条件が保たれる', async () => {
      await withHarness(async ({ index, getDoc }) => {
        const eventId = randomUUID();
        const typeId = randomUUID();
        const base = { typeTotal: 10, eventTotal: 10 };

        // v1 apply。
        await applyVersionedInventoryChanged(opensearch, index,
          versioned(eventId, typeId, { ...base, typeRemaining: 9, typeVersion: 1, eventRemaining: 9, eventVersion: 1 }));
        expect(findType(await getDoc(eventId), typeId)?.remaining_quantity).toBe(9);

        // v2 apply。
        await applyVersionedInventoryChanged(opensearch, index,
          versioned(eventId, typeId, { ...base, typeRemaining: 7, typeVersion: 2, eventRemaining: 7, eventVersion: 2 }));
        expect(findType(await getDoc(eventId), typeId)?.remaining_quantity).toBe(7);

        // duplicate v2（同値）: idempotent no-op。
        await applyVersionedInventoryChanged(opensearch, index,
          versioned(eventId, typeId, { ...base, typeRemaining: 7, typeVersion: 2, eventRemaining: 7, eventVersion: 2 }));
        expect(findType(await getDoc(eventId), typeId)?.remaining_quantity).toBe(7);

        // stale v1: no-op（巻き戻らない）。
        await applyVersionedInventoryChanged(opensearch, index,
          versioned(eventId, typeId, { ...base, typeRemaining: 9, typeVersion: 1, eventRemaining: 9, eventVersion: 1 }));
        const doc = await getDoc(eventId);
        expect(findType(doc, typeId)?.remaining_quantity).toBe(7);
        expect(doc?.event_remaining_quantity).toBe(7);
      });
    });

    it('Type A/B の version は独立に比較され、相互に上書きしない', async () => {
      await withHarness(async ({ index, getDoc }) => {
        const eventId = randomUUID();
        const typeA = randomUUID();
        const typeB = randomUUID();

        // Type A を v5 まで進める。
        await applyVersionedInventoryChanged(opensearch, index,
          versioned(eventId, typeA, { typeTotal: 10, typeRemaining: 2, typeVersion: 5, eventTotal: 20, eventRemaining: 12, eventVersion: 5, name: 'A' }));
        // Type B は v1（A の高い version に影響されず apply される）。
        await applyVersionedInventoryChanged(opensearch, index,
          versioned(eventId, typeB, { typeTotal: 10, typeRemaining: 8, typeVersion: 1, eventTotal: 20, eventRemaining: 10, eventVersion: 6, name: 'B' }));

        const doc = await getDoc(eventId);
        expect(findType(doc, typeA)?.remaining_quantity).toBe(2);
        expect(findType(doc, typeA)?.inventory_version).toBe(5);
        expect(findType(doc, typeB)?.remaining_quantity).toBe(8);
        expect(findType(doc, typeB)?.inventory_version).toBe(1);
      });
    });

    it('Event 集計 version は Type version と独立に判定される', async () => {
      await withHarness(async ({ index, getDoc }) => {
        const eventId = randomUUID();
        const typeA = randomUUID();
        // Event version は 6 まで進むが Type A version は 5。
        await applyVersionedInventoryChanged(opensearch, index,
          versioned(eventId, typeA, { typeTotal: 10, typeRemaining: 3, typeVersion: 5, eventTotal: 20, eventRemaining: 6, eventVersion: 6 }));
        const doc = await getDoc(eventId);
        expect(doc?.event_inventory_version).toBe(6);
        expect(findType(doc, typeA)?.inventory_version).toBe(5);
      });
    });

    it('同一 version で値が異なる payload は contract corruption として throw する', async () => {
      await withHarness(async ({ index }) => {
        const eventId = randomUUID();
        const typeId = randomUUID();
        await applyVersionedInventoryChanged(opensearch, index,
          versioned(eventId, typeId, { typeTotal: 10, typeRemaining: 5, typeVersion: 2, eventTotal: 10, eventRemaining: 5, eventVersion: 2 }));
        await expect(
          applyVersionedInventoryChanged(opensearch, index,
            versioned(eventId, typeId, { typeTotal: 10, typeRemaining: 4, typeVersion: 2, eventTotal: 10, eventRemaining: 4, eventVersion: 2 })),
        ).rejects.toThrow();
      });
    });

    it('legacy 先着 → versioned で versioned が上書き、versioned 後は legacy が巻き戻さない', async () => {
      await withHarness(async ({ index, getDoc }) => {
        const eventId = randomUUID();
        const typeId = randomUUID();
        // legacy 先着（version なし）。
        await applyLegacyInventoryChanged(opensearch, index, { eventId, remainingQuantity: 50 });
        expect((await getDoc(eventId))?.remaining_quantity).toBe(50);
        // versioned 反映。
        await applyVersionedInventoryChanged(opensearch, index,
          versioned(eventId, typeId, { typeTotal: 100, typeRemaining: 40, typeVersion: 1, eventTotal: 100, eventRemaining: 40, eventVersion: 1 }));
        expect((await getDoc(eventId))?.remaining_quantity).toBe(40);
        // versioned 後に legacy 後着 → Event 集計を巻き戻さない。
        await applyLegacyInventoryChanged(opensearch, index, { eventId, remainingQuantity: 99 });
        const doc = await getDoc(eventId);
        expect(doc?.remaining_quantity).toBe(40);
        expect(doc?.event_remaining_quantity).toBe(40);
      });
    });

    it('InventoryChanged 先着 → EventListed 後着で metadata を補完し在庫を消さない', async () => {
      await withHarness(async ({ index, getDoc }) => {
        const eventId = randomUUID();
        const typeId = randomUUID();
        await applyVersionedInventoryChanged(opensearch, index,
          versioned(eventId, typeId, { typeTotal: 100, typeRemaining: 60, typeVersion: 2, eventTotal: 100, eventRemaining: 60, eventVersion: 2 }));
        await applyEventMetadata(opensearch, index, {
          eventId,
          title: 'Late Metadata',
          eventType: 'music',
          startsAt: '2032-01-01T00:00:00Z',
          latitude: 35.6,
          longitude: 139.7,
          totalQuantity: 100,
          remainingQuantity: 100,
        });
        const doc = await getDoc(eventId);
        expect(doc?.title).toBe('Late Metadata');
        // Ticket Type 在庫と Event 集計は EventListed で消えない・巻き戻らない。
        expect(findType(doc, typeId)?.remaining_quantity).toBe(60);
        expect(doc?.event_remaining_quantity).toBe(60);
        expect(doc?.remaining_quantity).toBe(60);
      });
    });

    it('EventListed 先着 → InventoryChanged 後着で在庫を反映する', async () => {
      await withHarness(async ({ index, getDoc }) => {
        const eventId = randomUUID();
        const typeId = randomUUID();
        await applyEventMetadata(opensearch, index, {
          eventId,
          title: 'Early Metadata',
          eventType: 'music',
          startsAt: '2032-01-01T00:00:00Z',
          totalQuantity: 100,
          remainingQuantity: 100,
        });
        expect((await getDoc(eventId))?.remaining_quantity).toBe(100);
        await applyVersionedInventoryChanged(opensearch, index,
          versioned(eventId, typeId, { typeTotal: 100, typeRemaining: 70, typeVersion: 1, eventTotal: 100, eventRemaining: 70, eventVersion: 1 }));
        const doc = await getDoc(eventId);
        expect(doc?.title).toBe('Early Metadata');
        expect(doc?.remaining_quantity).toBe(70);
        expect(findType(doc, typeId)?.remaining_quantity).toBe(70);
      });
    });

    it('concurrent scripted update で最終状態が最高 version へ収束する', async () => {
      await withHarness(async ({ index, getDoc }) => {
        const eventId = randomUUID();
        const typeId = randomUUID();
        const versions = [1, 2, 3, 4, 5, 6, 7, 8];
        await Promise.all(
          versions.map((v) =>
            applyVersionedInventoryChanged(opensearch, index,
              versioned(eventId, typeId, {
                typeTotal: 100, typeRemaining: 100 - v, typeVersion: v,
                eventTotal: 100, eventRemaining: 100 - v, eventVersion: v,
              })),
          ),
        );
        const doc = await getDoc(eventId);
        expect(findType(doc, typeId)?.inventory_version).toBe(8);
        expect(findType(doc, typeId)?.remaining_quantity).toBe(92);
        expect(doc?.event_inventory_version).toBe(8);
      });
    });

    it('rebuild が PostgreSQL 正本から projection を作り、reconciliation 差分が 0 になる', async () => {
      await withHarness(async ({ dataSource, index, pgClient, seedEvent }) => {
        await seedEvent([5, 3]);
        await seedEvent([10]);
        const client = await pgClient();
        try {
          const rebuild = await rebuildInventoryProjection(client, opensearch, { index });
          expect(rebuild.processedEvents).toBe(2);
          const report = await reconcileInventoryProjection(client, opensearch, { index });
          expect(report.totalDiffs).toBe(0);
          expect(report.hasDiff).toBe(false);
          expect(report.checkedEvents).toBe(2);
        } finally {
          client.release();
        }
        void dataSource;
      });
    });

    it('意図的な missing / mismatch を検出し、rebuild 後に差分 0 へ収束する', async () => {
      await withHarness(async ({ index, pgClient, seedEvent, getDoc }) => {
        const { eventId } = await seedEvent([5]);
        const client = await pgClient();
        try {
          await rebuildInventoryProjection(client, opensearch, { index });
          expect((await reconcileInventoryProjection(client, opensearch, { index })).totalDiffs).toBe(0);

          // missing: OS document を削除する（PG は変更しない）。
          await opensearch.delete({ index, id: eventId, refresh: true });
          const missing = await reconcileInventoryProjection(client, opensearch, { index });
          expect(missing.counts.missing_event_document).toBe(1);
          expect(missing.hasDiff).toBe(true);

          // rebuild で収束。
          await rebuildInventoryProjection(client, opensearch, { index });
          expect((await reconcileInventoryProjection(client, opensearch, { index })).totalDiffs).toBe(0);

          // mismatch: OS を PG より新しい version へ進める（正本には無い状態）。
          const doc = await getDoc(eventId);
          const existingType = (doc?.ticket_types as Array<{ ticket_type_id: string }>)[0]
            .ticket_type_id;
          await applyVersionedInventoryChanged(opensearch, index,
            versioned(eventId, existingType, { typeTotal: 5, typeRemaining: 1, typeVersion: 99, eventTotal: 5, eventRemaining: 1, eventVersion: 99 }));
          const mismatch = await reconcileInventoryProjection(client, opensearch, { index });
          expect(mismatch.hasDiff).toBe(true);
        } finally {
          client.release();
        }
      });
    });

    it('snapshot version N の rebuild は既に届いた event N+1 を巻き戻さない', async () => {
      await withHarness(async ({ index, pgClient, seedEvent, getDoc }) => {
        const { eventId, typeIds } = await seedEvent([5]);
        const client = await pgClient();
        try {
          // PG snapshot は version 0（seed 直後）。先に event N+1（高 version）が OS へ届く。
          await applyVersionedInventoryChanged(opensearch, index,
            versioned(eventId, typeIds[0], { typeTotal: 5, typeRemaining: 1, typeVersion: 10, eventTotal: 5, eventRemaining: 1, eventVersion: 10 }));
          // rebuild（古い snapshot version 0）を流しても N+1 を巻き戻さない。
          await rebuildInventoryProjection(client, opensearch, { index });
          const doc = await getDoc(eventId);
          expect(findType(doc, typeIds[0])?.inventory_version).toBe(10);
          expect(findType(doc, typeIds[0])?.remaining_quantity).toBe(1);
        } finally {
          client.release();
        }
      });
    });

    it('malformed projection document を reconciliation が検出する', async () => {
      await withHarness(async ({ index, pgClient, seedEvent }) => {
        const { eventId } = await seedEvent([5]);
        const client = await pgClient();
        try {
          // 正本にある event の projection を壊れた形（inventory field 欠落）で書く。
          await opensearch.index({
            index,
            id: eventId,
            body: { event_id: eventId },
            refresh: true,
          });
          const report = await reconcileInventoryProjection(client, opensearch, { index });
          expect(report.counts.malformed_projection).toBeGreaterThanOrEqual(1);
          expect(report.hasDiff).toBe(true);
        } finally {
          client.release();
        }
      });
    });

    it('unexpected な event document を reconciliation が検出する', async () => {
      await withHarness(async ({ index, pgClient, seedEvent }) => {
        await seedEvent([5]);
        const orphan = randomUUID();
        await opensearch.index({
          index,
          id: orphan,
          body: {
            event_id: orphan,
            event_total_quantity: 1,
            event_remaining_quantity: 1,
            event_inventory_version: 1,
            ticket_types: [],
          },
          refresh: true,
        });
        const client = await pgClient();
        try {
          await rebuildInventoryProjection(client, opensearch, { index });
          const report = await reconcileInventoryProjection(client, opensearch, { index });
          expect(report.counts.unexpected_event_document).toBe(1);
        } finally {
          client.release();
        }
      });
    });

    // review 3: applied / stale / legacy_ignore / corruption を実 OpenSearch 2.19.1 の
    // response.result を基に区別する。
    describe('version guard outcome の区別（review 3）', () => {
      it('new version は applied、lower stale と equal/same-value duplicate は stale', async () => {
        await withHarness(async ({ index }) => {
          const eventId = randomUUID();
          const typeId = randomUUID();
          const base = { typeTotal: 10, eventTotal: 10 };

          const v1 = await applyVersionedInventoryChanged(opensearch, index,
            versioned(eventId, typeId, { ...base, typeRemaining: 9, typeVersion: 1, eventRemaining: 9, eventVersion: 1 }));
          expect(v1).toBe('applied');

          const v2 = await applyVersionedInventoryChanged(opensearch, index,
            versioned(eventId, typeId, { ...base, typeRemaining: 7, typeVersion: 2, eventRemaining: 7, eventVersion: 2 }));
          expect(v2).toBe('applied');

          // equal/same-value duplicate は version guard による no-op → stale。
          const dup = await applyVersionedInventoryChanged(opensearch, index,
            versioned(eventId, typeId, { ...base, typeRemaining: 7, typeVersion: 2, eventRemaining: 7, eventVersion: 2 }));
          expect(dup).toBe('stale');

          // lower stale version → stale。
          const stale = await applyVersionedInventoryChanged(opensearch, index,
            versioned(eventId, typeId, { ...base, typeRemaining: 9, typeVersion: 1, eventRemaining: 9, eventVersion: 1 }));
          expect(stale).toBe('stale');
        });
      });

      it('equal/different-value は contract corruption として throw する', async () => {
        await withHarness(async ({ index }) => {
          const eventId = randomUUID();
          const typeId = randomUUID();
          await applyVersionedInventoryChanged(opensearch, index,
            versioned(eventId, typeId, { typeTotal: 10, typeRemaining: 5, typeVersion: 2, eventTotal: 10, eventRemaining: 5, eventVersion: 2 }));
          await expect(
            applyVersionedInventoryChanged(opensearch, index,
              versioned(eventId, typeId, { typeTotal: 10, typeRemaining: 4, typeVersion: 2, eventTotal: 10, eventRemaining: 4, eventVersion: 2 })),
          ).rejects.toThrow();
        });
      });

      it('Type stale + Event new、Type new + Event stale はどちらも applied', async () => {
        await withHarness(async ({ index }) => {
          const eventId = randomUUID();
          const typeId = randomUUID();
          // 基準: Type v5 / Event v5。
          await applyVersionedInventoryChanged(opensearch, index,
            versioned(eventId, typeId, { typeTotal: 20, typeRemaining: 10, typeVersion: 5, eventTotal: 20, eventRemaining: 10, eventVersion: 5 }));

          // Type stale（v3）+ Event new（v6）→ Event を更新したので applied。
          const a = await applyVersionedInventoryChanged(opensearch, index,
            versioned(eventId, typeId, { typeTotal: 20, typeRemaining: 12, typeVersion: 3, eventTotal: 20, eventRemaining: 8, eventVersion: 6 }));
          expect(a).toBe('applied');

          // Type new（v7）+ Event stale（v4）→ Type を更新したので applied。
          const b = await applyVersionedInventoryChanged(opensearch, index,
            versioned(eventId, typeId, { typeTotal: 20, typeRemaining: 6, typeVersion: 7, eventTotal: 20, eventRemaining: 8, eventVersion: 4 }));
          expect(b).toBe('applied');
        });
      });

      it('legacy は versioned state 前なら applied、versioned state 後なら legacy_ignore', async () => {
        await withHarness(async ({ index }) => {
          const eventId = randomUUID();
          const typeId = randomUUID();
          // versioned state 前の legacy → applied。
          const before = await applyLegacyInventoryChanged(opensearch, index, { eventId, remainingQuantity: 50 });
          expect(before).toBe('applied');
          // versioned 反映。
          await applyVersionedInventoryChanged(opensearch, index,
            versioned(eventId, typeId, { typeTotal: 100, typeRemaining: 40, typeVersion: 1, eventTotal: 100, eventRemaining: 40, eventVersion: 1 }));
          // versioned state 後の legacy → 無視（legacy_ignore）。
          const after = await applyLegacyInventoryChanged(opensearch, index, { eventId, remainingQuantity: 99 });
          expect(after).toBe('legacy_ignore');
        });
      });
    });

    // review 5: location は set / preserve / clear の三値。
    describe('EventListed の location set / preserve / clear（review 5）', () => {
      const meta = (eventId: string, extra: Record<string, unknown>) => ({
        eventId,
        title: 'Loc Event',
        eventType: 'music',
        startsAt: '2032-01-01T00:00:00Z',
        totalQuantity: 100,
        remainingQuantity: 100,
        ...extra,
      });

      async function geoHitCount(index: string, eventId: string): Promise<number> {
        const res = await opensearch.search({
          index,
          body: {
            query: {
              bool: {
                filter: [
                  { term: { event_id: eventId } },
                  { geo_distance: { distance: '50km', location: { lat: 35.6, lon: 139.7 } } },
                ],
              },
            },
          },
        });
        const total = (res.body?.hits?.total ?? 0) as unknown as
          | number
          | { value: number };
        return typeof total === 'number' ? total : total.value;
      }

      it('set 後に field 省略の metadata 更新を受けても location は維持される（preserve）', async () => {
        await withHarness(async ({ index, getDoc }) => {
          const eventId = randomUUID();
          await applyEventMetadata(opensearch, index, meta(eventId, { latitude: 35.6, longitude: 139.7 }));
          await opensearch.indices.refresh({ index });
          expect(await geoHitCount(index, eventId)).toBe(1);
          // latitude / longitude を渡さない（field 省略）→ preserve。
          await applyEventMetadata(opensearch, index, meta(eventId, { title: 'Updated' }));
          await opensearch.indices.refresh({ index });
          const doc = await getDoc(eventId);
          expect(doc?.title).toBe('Updated');
          expect(doc?.location).toBeDefined();
          expect(await geoHitCount(index, eventId)).toBe(1);
        });
      });

      it('set 後に null/null を受けると location field が削除され、geo 検索に残らない（clear）', async () => {
        await withHarness(async ({ index, getDoc }) => {
          const eventId = randomUUID();
          const typeId = randomUUID();
          await applyEventMetadata(opensearch, index, meta(eventId, { latitude: 35.6, longitude: 139.7 }));
          // Ticket Type inventory と両 version を先に反映しておく。
          await applyVersionedInventoryChanged(opensearch, index,
            versioned(eventId, typeId, { typeTotal: 100, typeRemaining: 60, typeVersion: 3, eventTotal: 100, eventRemaining: 60, eventVersion: 4 }));
          await opensearch.indices.refresh({ index });
          expect(await geoHitCount(index, eventId)).toBe(1);

          // null/null → clear。
          await applyEventMetadata(opensearch, index, meta(eventId, { latitude: null, longitude: null }));
          await opensearch.indices.refresh({ index });
          const doc = await getDoc(eventId);
          expect(doc?.location).toBeUndefined();
          expect(await geoHitCount(index, eventId)).toBe(0);
          // clear 後も Ticket Type inventory と両 version は不変。
          expect(findType(doc, typeId)?.remaining_quantity).toBe(60);
          expect(findType(doc, typeId)?.inventory_version).toBe(3);
          expect(doc?.event_inventory_version).toBe(4);
          expect(doc?.event_remaining_quantity).toBe(60);
        });
      });

      it('片側だけ指定など不正な部分 location は error になる（message を ack しない）', async () => {
        await withHarness(async ({ index }) => {
          const eventId = randomUUID();
          await expect(
            applyEventMetadata(opensearch, index, meta(eventId, { latitude: 35.6, longitude: null })),
          ).rejects.toThrow();
          await expect(
            applyEventMetadata(opensearch, index, meta(eventId, { latitude: Number.NaN, longitude: 139.7 })),
          ).rejects.toThrow();
        });
      });
    });

    // review 2: unversioned / malformed / missing_ticket_type を区別する。
    describe('reconciliation の unversioned / malformed 区別（review 2）', () => {
      it('EventListed-only の未購入 Event は unversioned=1、malformed=0、hasDiff=true', async () => {
        await withHarness(async ({ index, pgClient, seedEvent }) => {
          const { eventId } = await seedEvent([5]);
          // 購入前の EventListed だけを反映する（versioned inventory field を作らない）。
          await applyEventMetadata(opensearch, index, {
            eventId,
            title: 'Unpurchased',
            eventType: 'music',
            startsAt: '2032-01-01T00:00:00Z',
            totalQuantity: 5,
            remainingQuantity: 5,
          });
          await opensearch.indices.refresh({ index });
          const client = await pgClient();
          try {
            const report = await reconcileInventoryProjection(client, opensearch, { index });
            expect(report.counts.unversioned_projection).toBe(1);
            expect(report.counts.malformed_projection).toBe(0);
            expect(report.hasDiff).toBe(true);
            // rebuild 後は全 category 0。
            await rebuildInventoryProjection(client, opensearch, { index });
            expect((await reconcileInventoryProjection(client, opensearch, { index })).totalDiffs).toBe(0);
          } finally {
            client.release();
          }
        });
      });

      it('versioned field の部分欠損は malformed、event_id だけの document も malformed', async () => {
        await withHarness(async ({ index, pgClient, seedEvent }) => {
          const { eventId } = await seedEvent([5]);
          // 部分的に versioned field を持つ（event_inventory_version だけ）壊れた document。
          await opensearch.index({
            index,
            id: eventId,
            body: { event_id: eventId, event_inventory_version: 3 },
            refresh: true,
          });
          const client = await pgClient();
          try {
            const partial = await reconcileInventoryProjection(client, opensearch, { index });
            expect(partial.counts.malformed_projection).toBeGreaterThanOrEqual(1);
            expect(partial.counts.unversioned_projection).toBe(0);

            // event_id だけの document は legacy document として成立しない → malformed。
            await opensearch.index({ index, id: eventId, body: { event_id: eventId }, refresh: true });
            const onlyId = await reconcileInventoryProjection(client, opensearch, { index });
            expect(onlyId.counts.malformed_projection).toBeGreaterThanOrEqual(1);
            expect(onlyId.counts.unversioned_projection).toBe(0);
          } finally {
            client.release();
          }
        });
      });

      it('特定 Type だけ欠落した正しい versioned document は missing_ticket_type', async () => {
        await withHarness(async ({ index, pgClient, seedEvent }) => {
          const { eventId, typeIds } = await seedEvent([5, 3]);
          const client = await pgClient();
          try {
            await rebuildInventoryProjection(client, opensearch, { index });
            expect((await reconcileInventoryProjection(client, opensearch, { index })).totalDiffs).toBe(0);
            // 正しい versioned document から 1 Type だけを取り除く。
            await opensearch.update({
              index,
              id: eventId,
              body: {
                script: {
                  lang: 'painless',
                  source:
                    "ctx._source.ticket_types.removeIf(t -> t.ticket_type_id == params.tid);",
                  params: { tid: typeIds[1] },
                },
              },
              refresh: true,
            } as never);
            const report = await reconcileInventoryProjection(client, opensearch, { index });
            expect(report.counts.missing_ticket_type).toBe(1);
            expect(report.counts.malformed_projection).toBe(0);
            expect(report.counts.unversioned_projection).toBe(0);
          } finally {
            client.release();
          }
        });
      });
    });

    // review 10: rebuild は各 batch では refresh せず、return 直後に reconciliation 差分 0 を確認できる。
    it('rebuild service return 直後の reconciliation が差分 0（final refresh の可視性）', async () => {
      await withHarness(async ({ index, pgClient, seedEvent }) => {
        await seedEvent([7, 4, 2]);
        await seedEvent([9]);
        const client = await pgClient();
        try {
          // bulkSize=1 で複数 bulk を発生させても、return 直後に差分 0（final refresh 済み）。
          await rebuildInventoryProjection(client, opensearch, { index, bulkSize: 1 });
          const report = await reconcileInventoryProjection(client, opensearch, { index });
          expect(report.totalDiffs).toBe(0);
          expect(report.hasDiff).toBe(false);
        } finally {
          client.release();
        }
      });
    });

    // 反復・競合テスト（section D）: rebuild と並行 update の競合を 30 iteration。
    it('rebuild と並行 versioned update の競合を 30 iteration（各回で不変条件を assert）', async () => {
      await withHarness(async ({ index, pgClient, seedEvent, getDoc }) => {
        const { eventId, typeIds } = await seedEvent([100]);
        const typeId = typeIds[0];
        const client = await pgClient();
        try {
          const iterations = 30;
          let applied = 0;
          for (let i = 1; i <= iterations; i += 1) {
            const version = i + 1; // seed 後 version 0 を超える単調増加
            const remaining = 100 - i;
            // rebuild（古い snapshot）と新しい versioned event を並行実行する。
            await Promise.all([
              rebuildInventoryProjection(client, opensearch, { index }),
              applyVersionedInventoryChanged(opensearch, index,
                versioned(eventId, typeId, {
                  typeTotal: 100, typeRemaining: remaining, typeVersion: version,
                  eventTotal: 100, eventRemaining: remaining, eventVersion: version,
                })),
            ]);
            // 不変条件: version は単調非減少で、決して巻き戻らない。
            const doc = await getDoc(eventId);
            const storedVersion = findType(doc, typeId)?.inventory_version as number;
            expect(storedVersion).toBeGreaterThanOrEqual(version);
            applied += 1;
          }
          expect(applied).toBe(iterations);
          // 最終 reconciliation: OS が PG（version 0）より進んでいるため差分は version mismatch のみ。
          const finalDoc = await getDoc(eventId);
          expect(findType(finalDoc, typeId)?.inventory_version).toBeGreaterThanOrEqual(iterations + 1);
        } finally {
          client.release();
        }
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
