// ファイル概要:
// このファイルは refresh_tokens クリーンアップ（L-9 残課題、Issue #195）の単体テストです。
// - fake client での引数・戻り値・入力検証、バッチの繰り返し、advisory lock の取得・解放（常に実行）
// - 実 PostgreSQL（Docker Compose）での削除条件の実挙動（TEST_DATABASE_URL 設定時のみ実行。
//   CI の Backend Build ジョブは PostgreSQL service を持たないためスキップされ、
//   ローカルでは TEST_DATABASE_URL を設定して実行する）
// を検証します。rotate-on-use / reuse detection のロジックには触れません。

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  cleanupExpiredRefreshTokenFamilies,
  CLEANUP_SQL,
  DEFAULT_BATCH_SIZE,
  DEFAULT_RETENTION_DAYS,
  REFRESH_TOKEN_CLEANUP_ADVISORY_LOCK_KEY,
  runRefreshTokenCleanupWithLock,
  TRY_LOCK_SQL,
  UNLOCK_SQL,
} from './refresh-token-cleanup';

// fakeDeleteResponse は CLEANUP_SQL の応答（削除 row 数・ファミリー数の 1 行）を作ります。
function fakeDeleteResponse(rows: number, families: number) {
  return {
    rowCount: 1,
    rows: [{ deleted_rows: rows, deleted_families: families }],
  };
}

describe('cleanupExpiredRefreshTokenFamilies（fake client）', () => {
  it('猶予日数とバッチ上限をパラメータとして渡し、削除件数を返す', async () => {
    const query = jest.fn(async () => fakeDeleteResponse(3, 2));
    const result = await cleanupExpiredRefreshTokenFamilies({ query }, 30);

    expect(result).toEqual({
      deletedRows: 3,
      deletedFamilies: 2,
      batches: 1,
      reachedMaxBatches: false,
    });
    expect(query).toHaveBeenCalledWith(CLEANUP_SQL, [30, DEFAULT_BATCH_SIZE]);
  });

  it('猶予日数を省略すると既定値（30 日）が使われる', async () => {
    const query = jest.fn(async () => fakeDeleteResponse(0, 0));
    await cleanupExpiredRefreshTokenFamilies({ query });

    expect(query).toHaveBeenCalledWith(CLEANUP_SQL, [
      DEFAULT_RETENTION_DAYS,
      DEFAULT_BATCH_SIZE,
    ]);
  });

  it('上限ちょうどのファミリーを消した間は statement を繰り返し、上限未満で止まる', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(fakeDeleteResponse(10, 2))
      .mockResolvedValueOnce(fakeDeleteResponse(7, 2))
      .mockResolvedValueOnce(fakeDeleteResponse(1, 1));
    const result = await cleanupExpiredRefreshTokenFamilies({ query }, 30, {
      batchSize: 2,
    });

    expect(query).toHaveBeenCalledTimes(3);
    expect(result).toEqual({
      deletedRows: 18,
      deletedFamilies: 5,
      batches: 3,
      reachedMaxBatches: false,
    });
  });

  it('maxBatches に達したら打ち切り、reachedMaxBatches を返す', async () => {
    const query = jest.fn(async () => fakeDeleteResponse(4, 2));
    const result = await cleanupExpiredRefreshTokenFamilies({ query }, 30, {
      batchSize: 2,
      maxBatches: 3,
    });

    expect(query).toHaveBeenCalledTimes(3);
    expect(result.reachedMaxBatches).toBe(true);
    expect(result.deletedRows).toBe(12);
  });

  it('負数・非整数の猶予日数や不正なバッチ上限は拒否する（SQL は実行しない）', async () => {
    const query = jest.fn(async () => fakeDeleteResponse(0, 0));

    await expect(
      cleanupExpiredRefreshTokenFamilies({ query }, -1),
    ).rejects.toThrow('retentionDays');
    await expect(
      cleanupExpiredRefreshTokenFamilies({ query }, 1.5),
    ).rejects.toThrow('retentionDays');
    await expect(
      cleanupExpiredRefreshTokenFamilies({ query }, 30, { batchSize: 0 }),
    ).rejects.toThrow('batchSize');
    await expect(
      cleanupExpiredRefreshTokenFamilies({ query }, 30, { maxBatches: 0 }),
    ).rejects.toThrow('maxBatches');
    expect(query).not.toHaveBeenCalled();
  });
});

// fakeLockClient は advisory lock の取得結果と、削除・unlock の応答を返す fake client です。
function fakeLockClient(options: {
  locked: boolean;
  deleteError?: Error;
  unlockError?: Error;
}) {
  const query = jest.fn(async (text: string) => {
    if (text === TRY_LOCK_SQL) {
      return { rowCount: 1, rows: [{ locked: options.locked }] };
    }
    if (text === UNLOCK_SQL) {
      if (options.unlockError) throw options.unlockError;
      return { rowCount: 1, rows: [{ unlocked: true }] };
    }
    if (text === CLEANUP_SQL) {
      if (options.deleteError) throw options.deleteError;
      return fakeDeleteResponse(5, 2);
    }
    throw new Error(`unexpected SQL: ${text}`);
  });
  const executed = () => query.mock.calls.map((call) => call[0] as string);
  return { query, executed };
}

describe('runRefreshTokenCleanupWithLock（fake client）', () => {
  it('lock を取れたときだけ削除 SQL を実行し、最後に同じ接続で unlock する', async () => {
    const client = fakeLockClient({ locked: true });
    const result = await runRefreshTokenCleanupWithLock(client, {
      retentionDays: 30,
    });

    expect(result).toEqual({
      status: 'completed',
      deletedRows: 5,
      deletedFamilies: 2,
      batches: 1,
      reachedMaxBatches: false,
    });
    expect(client.executed()).toEqual([TRY_LOCK_SQL, CLEANUP_SQL, UNLOCK_SQL]);
    expect(client.query).toHaveBeenCalledWith(TRY_LOCK_SQL, [
      REFRESH_TOKEN_CLEANUP_ADVISORY_LOCK_KEY,
    ]);
    expect(client.query).toHaveBeenLastCalledWith(UNLOCK_SQL, [
      REFRESH_TOKEN_CLEANUP_ADVISORY_LOCK_KEY,
    ]);
  });

  it('lock を取れなかったときは削除も unlock もせず skipped を返す', async () => {
    const client = fakeLockClient({ locked: false });
    const result = await runRefreshTokenCleanupWithLock(client);

    expect(result).toEqual({ status: 'skipped' });
    expect(client.executed()).toEqual([TRY_LOCK_SQL]);
  });

  it('削除で例外が出ても unlock してから例外を返す（lock を残さない）', async () => {
    const client = fakeLockClient({
      locked: true,
      deleteError: new Error('canceling statement due to statement timeout'),
    });

    await expect(runRefreshTokenCleanupWithLock(client)).rejects.toThrow(
      'statement timeout',
    );
    expect(client.executed()).toEqual([TRY_LOCK_SQL, CLEANUP_SQL, UNLOCK_SQL]);
  });

  it('unlock の失敗は onUnlockError に渡し、結果は返す（接続を閉じれば解放される）', async () => {
    const unlockError = new Error('Connection terminated');
    const client = fakeLockClient({ locked: true, unlockError });
    const onUnlockError = jest.fn();

    const result = await runRefreshTokenCleanupWithLock(client, {
      onUnlockError,
    });

    expect(result.status).toBe('completed');
    expect(onUnlockError).toHaveBeenCalledWith(unlockError);
  });

  it('削除が minLockHoldMs より早く終わったら、残り時間だけ待ってから unlock する', async () => {
    const client = fakeLockClient({ locked: true });
    const order: string[] = [];
    let clock = 1_000;
    const sleep = jest.fn(async (ms: number) => {
      order.push(`sleep:${ms}`);
    });
    client.query.mockImplementation(async (text: string) => {
      order.push(text === UNLOCK_SQL ? 'unlock' : text === TRY_LOCK_SQL ? 'lock' : 'delete');
      if (text === TRY_LOCK_SQL) return { rowCount: 1, rows: [{ locked: true }] };
      if (text === CLEANUP_SQL) {
        clock += 200; // 削除に 200ms かかったことにする
        return fakeDeleteResponse(0, 0);
      }
      return { rowCount: 1, rows: [{ unlocked: true }] };
    });

    await runRefreshTokenCleanupWithLock(client, {
      minLockHoldMs: 1_000,
      sleep,
      now: () => clock,
    });

    expect(order).toEqual(['lock', 'delete', 'sleep:800', 'unlock']);
  });
});

// 実 DB での削除条件の検証。TEST_DATABASE_URL 未設定（CI の Backend Build）ではスキップします。
const describeWithDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeWithDb('cleanupExpiredRefreshTokenFamilies（実 PostgreSQL）', () => {
  let client: Client;
  let userId: string;
  // このテストが作った family だけを検証・後始末するための ID 集合です。
  const familyIds: Record<string, string> = {
    expiredFamily: randomUUID(),
    mixedFamily: randomUUID(),
    activeFamily: randomUUID(),
    revokedButInGraceFamily: randomUUID(),
  };

  // insertToken は検証用の refresh_tokens row を相対日数指定で INSERT します。
  async function insertToken(options: {
    familyId: string;
    expiresAtDaysAgo: number;
    parentTokenId?: string;
    revokedDaysAgo?: number;
  }): Promise<string> {
    const result = await client.query(
      `
        INSERT INTO refresh_tokens
          (user_id, family_id, token_hash, parent_token_id, issued_at, expires_at, revoked_at, revoked_reason)
        VALUES
          ($1, $2, $3, $4,
           now() - make_interval(days => $5) - interval '14 days',
           now() - make_interval(days => $5),
           CASE WHEN $6::int IS NULL THEN NULL ELSE now() - make_interval(days => $6::int) END,
           CASE WHEN $6::int IS NULL THEN NULL ELSE 'logout' END)
        RETURNING id
      `,
      [
        userId,
        options.familyId,
        // token_hash は unique のためランダム値で埋めます（照合はしないので中身は任意）。
        randomUUID().replace(/-/g, '').padEnd(64, '0'),
        options.parentTokenId ?? null,
        options.expiresAtDaysAgo,
        options.revokedDaysAgo ?? null,
      ],
    );
    return (result.rows as { id: string }[])[0].id;
  }

  async function countFamily(familyId: string): Promise<number> {
    const result = await client.query(
      'SELECT count(*)::int AS n FROM refresh_tokens WHERE family_id = $1',
      [familyId],
    );
    return (result.rows as { n: number }[])[0].n;
  }

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await client.connect();

    // FK（user_id）を満たすテスト専用ユーザーを作ります。
    const user = await client.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
      [`cleanup-spec-${randomUUID()}@example.com`],
    );
    userId = (user.rows as { id: string }[])[0].id;

    // 1. expiredFamily: 親も子も猶予（30 日）超過 → ファミリーごと削除される。
    //    親→子の自己参照 FK を持たせ、単一 statement でも安全に消えることを検証する。
    const expiredParent = await insertToken({
      familyId: familyIds.expiredFamily,
      expiresAtDaysAgo: 60,
    });
    await insertToken({
      familyId: familyIds.expiredFamily,
      expiresAtDaysAgo: 45,
      parentTokenId: expiredParent,
    });

    // 2. mixedFamily: 親は猶予超過（40 日前）だが、子はまだ猶予内（10 日前）
    //    → ファミリー単位判定により親も含めて残る（FK 違反も起きない）。
    const mixedParent = await insertToken({
      familyId: familyIds.mixedFamily,
      expiresAtDaysAgo: 40,
    });
    await insertToken({
      familyId: familyIds.mixedFamily,
      expiresAtDaysAgo: 10,
      parentTokenId: mixedParent,
    });

    // 3. activeFamily: 有効期限が未来（-7 = 7 日後）→ 残る。
    await insertToken({
      familyId: familyIds.activeFamily,
      expiresAtDaysAgo: -7,
    });

    // 4. revokedButInGraceFamily: 40 日前に失効（revoked）済みだが、期限切れは 20 日前で猶予内
    //    → revoked による早期削除はしない設計のため残る。
    await insertToken({
      familyId: familyIds.revokedButInGraceFamily,
      expiresAtDaysAgo: 20,
      revokedDaysAgo: 40,
    });
  });

  afterAll(async () => {
    // 後始末: このテストが作った row とユーザーを消します（他テストへの影響を残さない）。
    await client.query('DELETE FROM refresh_tokens WHERE user_id = $1', [
      userId,
    ]);
    await client.query('DELETE FROM users WHERE id = $1', [userId]);
    await client.end();
  });

  it('猶予超過ファミリーは全世代削除され、猶予内・有効・失効済み（猶予内）ファミリーは残る', async () => {
    // batchSize=1 にして、ファミリーごとに statement を繰り返す経路も実 DB で通します。
    const result = await cleanupExpiredRefreshTokenFamilies(client, 30, {
      batchSize: 1,
    });
    const deleted = result.deletedRows;

    // expiredFamily の 2 row 以上が消えている（他の残置データが同時に消えることは許容する）。
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await countFamily(familyIds.expiredFamily)).toBe(0);
    expect(await countFamily(familyIds.mixedFamily)).toBe(2);
    expect(await countFamily(familyIds.activeFamily)).toBe(1);
    expect(await countFamily(familyIds.revokedButInGraceFamily)).toBe(1);
  });

  it('再実行しても対象がなければ 0 件で成功する（冪等）', async () => {
    await cleanupExpiredRefreshTokenFamilies(client, 30);
    expect(await countFamily(familyIds.mixedFamily)).toBe(2);
  });
});
