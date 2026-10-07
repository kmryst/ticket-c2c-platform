// ファイル概要:
// このファイルは api 内の refresh_tokens クリーンアップ定期実行（Issue #542 / ADR-0041）の統合テストです。
// 実 PostgreSQL（TEST_DATABASE_URL）上に一時 database を作って migration を適用し、次を確認します。
// - 2 つの api（RefreshTokenCleanupService のインスタンス 2 つ、それぞれ専用接続）が同時刻に実行しても、
//   advisory lock で削除は 1 回だけになる（繰り返し確認する）。
// - 期限切れ（猶予超過）のファミリーだけが消え、有効なファミリーは残る。
// - 削除中の例外や接続の切断（Aurora のフェイルオーバーと同じ状況）の後に advisory lock が残らない。
// TEST_DATABASE_URL 未設定時は skip します（CI では focused step で実行します）。

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { Baseline1751594400000 } from './migrations/1751594400000-baseline';
import { AddUsers1783251707172 } from './migrations/1783251707172-add-users';
import { AddPurchasesBuyerFk1783252676631 } from './migrations/1783252676631-add-purchases-buyer-fk';
import { AddRefreshTokens1783307740648 } from './migrations/1783307740648-add-refresh-tokens';
import { AddRefreshTokensLineageIndexes1791365426295 } from './migrations/1791365426295-add-refresh-tokens-lineage-indexes';
import {
  CLEANUP_SQL,
  REFRESH_TOKEN_CLEANUP_ADVISORY_LOCK_KEY,
} from './refresh-token-cleanup';
import {
  CleanupClient,
  RefreshTokenCleanupRunResult,
  RefreshTokenCleanupService,
} from './refresh-token-cleanup.service';

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describeWithPostgres = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(120_000);

// 同時実行を繰り返す回数です。
const CONCURRENT_ROUNDS = 20;

describeWithPostgres('refresh token cleanup の定期実行（実 PostgreSQL）', () => {
  let adminClient: Client;
  let inspector: Client;
  let databaseName: string;
  let databaseUrl: string;
  let userId: string;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeAll(async () => {
    const template = new URL(TEST_DATABASE_URL as string);
    const adminUrl = new URL(template);
    adminUrl.pathname = '/postgres';
    adminClient = new Client({ connectionString: adminUrl.toString() });
    await adminClient.connect();

    databaseName = [
      'rt_cleanup',
      process.pid,
      randomUUID().replaceAll('-', '').slice(0, 12),
    ].join('_');
    await adminClient.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`);
    const url = new URL(template);
    url.pathname = `/${databaseName}`;
    databaseUrl = url.toString();

    const dataSource = new DataSource({
      type: 'postgres',
      url: databaseUrl,
      entities: [],
      migrations: [
        Baseline1751594400000,
        AddUsers1783251707172,
        AddPurchasesBuyerFk1783252676631,
        AddRefreshTokens1783307740648,
        AddRefreshTokensLineageIndexes1791365426295,
      ],
      migrationsTableName: 'typeorm_migrations',
    });
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'each' });
    await dataSource.destroy();

    inspector = new Client({ connectionString: databaseUrl });
    await inspector.connect();
    const user = await inspector.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`cleanup-it-${randomUUID()}@example.com`],
    );
    userId = (user.rows as { id: string }[])[0].id;
  });

  afterAll(async () => {
    if (inspector) await inspector.end();
    if (adminClient) {
      await adminClient.query(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
      await adminClient.end();
    }
  });

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // insertFamily は 1 ファミリー（親 → 子の 2 世代）を、子の期限切れからの経過日数で作ります。
  async function insertFamily(expiresAtDaysAgo: number): Promise<string> {
    const familyId = randomUUID();
    const insert = async (daysAgo: number, parentId: string | null) => {
      const result = await inspector.query(
        `
          INSERT INTO refresh_tokens
            (user_id, family_id, token_hash, parent_token_id, issued_at, expires_at)
          VALUES
            ($1, $2, $3, $4,
             now() - make_interval(days => $5) - interval '14 days',
             now() - make_interval(days => $5))
          RETURNING id
        `,
        [
          userId,
          familyId,
          randomUUID().replace(/-/g, '').padEnd(64, '0'),
          parentId,
          daysAgo,
        ],
      );
      return (result.rows as { id: string }[])[0].id;
    };
    const parent = await insert(expiresAtDaysAgo + 5, null);
    await insert(expiresAtDaysAgo, parent);
    return familyId;
  }

  async function countFamily(familyId: string): Promise<number> {
    const result = await inspector.query(
      'SELECT count(*)::int AS n FROM refresh_tokens WHERE family_id = $1',
      [familyId],
    );
    return (result.rows as { n: number }[])[0].n;
  }

  // advisoryLockHolders はこのテストの lock キーを持っている session の数です。
  async function advisoryLockHolders(): Promise<number> {
    const result = await inspector.query(
      `
        SELECT count(*)::int AS n
        FROM pg_locks
        WHERE locktype = 'advisory' AND granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid = 0 AND objid = $1 AND objsubid = 1
      `,
      [REFRESH_TOKEN_CLEANUP_ADVISORY_LOCK_KEY],
    );
    return (result.rows as { n: number }[])[0].n;
  }

  // createApi は 1 つの api タスクに相当する service を作ります。接続は実行のたびに新しく作ります。
  function createApi(
    minLockHoldMs: number,
    wrap: (client: Client) => CleanupClient = (client) => client,
  ): RefreshTokenCleanupService {
    return new RefreshTokenCleanupService(
      undefined,
      () => wrap(new Client({ connectionString: databaseUrl })),
      minLockHoldMs,
    );
  }

  it(`2 つの api が同時刻に実行しても削除は 1 回だけ（${CONCURRENT_ROUNDS} 回繰り返す）`, async () => {
    const activeFamily = await insertFamily(-7);
    const inGraceFamily = await insertFamily(10);
    const apiA = createApi(300);
    const apiB = createApi(300);

    const completedBy = { a: 0, b: 0 };
    for (let round = 0; round < CONCURRENT_ROUNDS; round += 1) {
      const expiredFamily = await insertFamily(45);

      const [resultA, resultB] = await Promise.all([
        apiA.runOnce(),
        apiB.runOnce(),
      ]);

      const statuses = [resultA.status, resultB.status].sort();
      expect(statuses).toEqual(['completed', 'skipped']);
      const completed = [resultA, resultB].find(
        (r): r is Extract<RefreshTokenCleanupRunResult, { status: 'completed' }> =>
          r.status === 'completed',
      );
      expect(completed?.deletedFamilies).toBe(1);
      expect(completed?.deletedRows).toBe(2);
      if (resultA.status === 'completed') completedBy.a += 1;
      else completedBy.b += 1;

      expect(await countFamily(expiredFamily)).toBe(0);
      expect(await countFamily(activeFamily)).toBe(2);
      expect(await countFamily(inGraceFamily)).toBe(2);
      expect(await advisoryLockHolders()).toBe(0);
    }
    // どちらが lock を取ったかを記録として残す（偏りは許容する）。
    console.info(`completed by api A: ${completedBy.a}, api B: ${completedBy.b}`);
  });

  it('lock 保持中（minLockHoldMs）に遅れて実行した api は何もしない', async () => {
    const apiA = createApi(1_500);
    const apiB = createApi(0);

    const runningA = apiA.runOnce();
    // A が lock を取って削除を終え、保持の待機に入るまで待つ。
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await advisoryLockHolders()).toBe(1);

    const resultB = await apiB.runOnce();
    expect(resultB).toEqual({ status: 'skipped' });

    await expect(runningA).resolves.toMatchObject({ status: 'completed' });
    expect(await advisoryLockHolders()).toBe(0);
  });

  it('削除中に例外が出ても lock は残らず、次の実行は lock を取れる', async () => {
    const expiredFamily = await insertFamily(45);
    const failing = createApi(0, (client) => {
      const original = client.query.bind(client) as CleanupClient['query'];
      return Object.assign(client, {
        query: async (text: string, values?: unknown[]) => {
          if (text === CLEANUP_SQL) {
            throw new Error('injected failure during DELETE');
          }
          return original(text, values);
        },
      }) as unknown as CleanupClient;
    });

    await expect(failing.runOnce()).resolves.toEqual({ status: 'failed' });
    expect(await advisoryLockHolders()).toBe(0);
    expect(await countFamily(expiredFamily)).toBe(2);

    await expect(createApi(0).runOnce()).resolves.toMatchObject({
      status: 'completed',
    });
    expect(await countFamily(expiredFamily)).toBe(0);
  });

  it('lock 保持中に接続が切れても（フェイルオーバー相当）api は落ちず、lock も残らない', async () => {
    const apiA = createApi(2_000);
    const runningA = apiA.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await advisoryLockHolders()).toBe(1);

    // lock を持っている backend を強制終了する（Aurora のフェイルオーバーで接続が切れるのと同じ状況）。
    await inspector.query(
      `
        SELECT pg_terminate_backend(pid)
        FROM pg_locks
        WHERE locktype = 'advisory' AND granted
          AND classid = 0 AND objid = $1 AND objsubid = 1
      `,
      [REFRESH_TOKEN_CLEANUP_ADVISORY_LOCK_KEY],
    );

    // session が終わった時点で lock は解放され、他の api が取れる。
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await advisoryLockHolders()).toBe(0);
    await expect(createApi(0).runOnce()).resolves.toMatchObject({
      status: 'completed',
    });

    // 切断された側も例外を投げずに終わる（unlock の失敗はログに残る）。
    const resultA = await runningA;
    expect(['completed', 'failed']).toContain(resultA.status);
    expect(await advisoryLockHolders()).toBe(0);
  });
});
