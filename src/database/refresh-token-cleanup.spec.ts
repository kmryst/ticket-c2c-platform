// ファイル概要:
// このファイルは refresh_tokens クリーンアップ（L-9 残課題、Issue #195）の単体テストです。
// - fake client での引数・戻り値・入力検証（常に実行）
// - 実 PostgreSQL（Docker Compose）での削除条件の実挙動（TEST_DATABASE_URL 設定時のみ実行。
//   CI の Backend Build ジョブは PostgreSQL service を持たないためスキップされ、
//   ローカルでは TEST_DATABASE_URL を設定して実行する）
// を検証します。rotate-on-use / reuse detection のロジックには触れません。

import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import {
  cleanupExpiredRefreshTokenFamilies,
  CLEANUP_SQL,
  DEFAULT_RETENTION_DAYS,
} from './refresh-token-cleanup';

describe('cleanupExpiredRefreshTokenFamilies（fake client）', () => {
  it('猶予日数をパラメータとして渡し、削除件数を返す', async () => {
    const query = jest.fn(async () => ({ rowCount: 3 }));
    const deleted = await cleanupExpiredRefreshTokenFamilies({ query }, 30);

    expect(deleted).toBe(3);
    expect(query).toHaveBeenCalledWith(CLEANUP_SQL, [30]);
  });

  it('猶予日数を省略すると既定値（30 日）が使われる', async () => {
    const query = jest.fn(async () => ({ rowCount: 0 }));
    await cleanupExpiredRefreshTokenFamilies({ query });

    expect(query).toHaveBeenCalledWith(CLEANUP_SQL, [DEFAULT_RETENTION_DAYS]);
  });

  it('負数・非整数の猶予日数は拒否する（SQL は実行しない）', async () => {
    const query = jest.fn(async () => ({ rowCount: 0 }));

    await expect(
      cleanupExpiredRefreshTokenFamilies({ query }, -1),
    ).rejects.toThrow('retentionDays');
    await expect(
      cleanupExpiredRefreshTokenFamilies({ query }, 1.5),
    ).rejects.toThrow('retentionDays');
    expect(query).not.toHaveBeenCalled();
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
    const deleted = await cleanupExpiredRefreshTokenFamilies(client, 30);

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
