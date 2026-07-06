// ファイル概要:
// このファイルは RefreshTokensService の単体テストです（ADR-0012、Issue #165）。
// DB（DatabaseService / PoolClient）はモックし、rotate-on-use の状態遷移
// （正当な rotate / 不明トークン / reuse detection / logout 済み再提示 / 期限切れ）と
// transaction の張り方（BEGIN / FOR UPDATE / COMMIT / ROLLBACK）、
// 生トークンが SQL パラメータに乗らない（hash のみ保存される）ことを検証します。

import { DatabaseService } from '../database/database.service';
import {
  RefreshTokensService,
  REVOKE_REASON_LOGOUT,
  REVOKE_REASON_REUSE,
} from './refresh-tokens.service';

const USER_ID = '44444444-4444-4444-8444-444444444444';
const FAMILY_ID = '55555555-5555-4555-8555-555555555555';
const TOKEN_ROW_ID = '66666666-6666-4666-8666-666666666666';
const NEW_TOKEN_ROW_ID = '77777777-7777-4777-8777-777777777777';
const META = { ip: '203.0.113.10', userAgent: 'jest-test' };

// SHA-256 hex は 64 文字です。hash 保存の検証に使います。
const SHA256_HEX = /^[0-9a-f]{64}$/;

// buildTokenRow は SELECT ... FOR UPDATE が返す row を組み立てる helper です。
function buildTokenRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: TOKEN_ROW_ID,
    user_id: USER_ID,
    family_id: FAMILY_ID,
    expires_at: new Date(Date.now() + 60_000),
    used_at: null,
    revoked_at: null,
    replaced_by_token_id: null,
    ...overrides,
  };
}

// createService は「SQL 文字列で分岐するモック client」で RefreshTokensService を組み立てます。
// selectedRow が undefined の場合、FOR UPDATE SELECT は 0 rows を返します。
function createService(selectedRow?: Record<string, unknown>) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('FOR UPDATE')) {
      return { rows: selectedRow ? [selectedRow] : [] };
    }
    if (sql.includes('RETURNING id')) {
      return { rows: [{ id: NEW_TOKEN_ROW_ID }] };
    }
    // BEGIN / COMMIT / ROLLBACK / UPDATE / INSERT（issue）はここに落ちます。
    return { rows: [] };
  });
  const release = jest.fn();
  const database = {
    connect: jest.fn(async () => ({ query, release })),
  } as unknown as DatabaseService;

  return { service: new RefreshTokensService(database), query, release };
}

// sqlCalls はモック client へ発行された SQL 文（正規化済み）の一覧を返します。
function sqlCalls(query: jest.Mock): string[] {
  return query.mock.calls.map((call) =>
    (call[0] as string).replace(/\s+/g, ' ').trim(),
  );
}

describe('RefreshTokensService.issue', () => {
  it('生トークンではなく SHA-256 hash を INSERT し、生トークンを返す', async () => {
    const { service, query } = createService();

    const issued = await service.issue(USER_ID, META);

    // 生トークンは base64url 43 文字（256bit）で返る。
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.expiresIn).toBe(14 * 24 * 60 * 60);

    // INSERT のパラメータには hash（hex 64 文字）だけが乗り、生トークンは乗らない。
    const insertCall = query.mock.calls.find((call) =>
      (call[0] as string).includes('INSERT INTO refresh_tokens'),
    );
    expect(insertCall).toBeDefined();
    const params = insertCall?.[1] as unknown[];
    expect(params).toContain(USER_ID);
    expect(params).toContain(META.ip);
    expect(params).toContain(META.userAgent);
    expect(params.some((p) => typeof p === 'string' && SHA256_HEX.test(p))).toBe(
      true,
    );
    expect(params).not.toContain(issued.token);
  });
});

describe('RefreshTokensService.rotate', () => {
  it('有効なトークンは行ロック付き transaction で消費され、新世代トークンが返る', async () => {
    const { service, query, release } = createService(buildTokenRow());

    const rotated = await service.rotate('presented-raw-token', META);

    expect(rotated.userId).toBe(USER_ID);
    expect(rotated.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const sqls = sqlCalls(query);
    // BEGIN → FOR UPDATE SELECT → 新トークン INSERT → 旧トークン消費 UPDATE → COMMIT の順で発行される。
    expect(sqls[0]).toBe('BEGIN');
    expect(sqls[1]).toContain('FOR UPDATE');
    expect(sqls[2]).toContain('INSERT INTO refresh_tokens');
    expect(sqls[3]).toContain('SET used_at = now(), replaced_by_token_id');
    expect(sqls[4]).toBe('COMMIT');

    // 新トークン INSERT は同一ファミリー・parent 系譜つきで行われる。
    const insertParams = query.mock.calls[2][1] as unknown[];
    expect(insertParams).toContain(FAMILY_ID);
    expect(insertParams).toContain(TOKEN_ROW_ID);
    // 旧トークンの UPDATE は置換先 id を記録する。
    expect(query.mock.calls[3][1]).toEqual([TOKEN_ROW_ID, NEW_TOKEN_ROW_ID]);

    // 生トークン（新旧とも）は SQL パラメータに乗らない。
    for (const call of query.mock.calls) {
      const params = (call[1] ?? []) as unknown[];
      expect(params).not.toContain('presented-raw-token');
      expect(params).not.toContain(rotated.token);
    }

    expect(release).toHaveBeenCalled();
  });

  it('hash が一致しない不明トークンは 401 になり、ファミリー失効は起きない', async () => {
    const { service, query } = createService(undefined);

    await expect(
      service.rotate('unknown-raw-token', META),
    ).rejects.toMatchObject({ status: 401 });

    const sqls = sqlCalls(query);
    expect(sqls.some((sql) => sql.includes('revoked_reason'))).toBe(false);
    // 未確定 transaction は ROLLBACK される。
    expect(sqls).toContain('ROLLBACK');
  });

  it('使用済み（rotate 済み）トークンの再提示は reuse としてファミリー全体を失効させる', async () => {
    const { service, query } = createService(
      buildTokenRow({
        used_at: new Date(),
        replaced_by_token_id: NEW_TOKEN_ROW_ID,
      }),
    );

    await expect(
      service.rotate('reused-raw-token', META),
    ).rejects.toMatchObject({ status: 401 });

    // ファミリー失効の UPDATE が reuse_detected 理由で発行され、COMMIT で確定する。
    const revokeCall = query.mock.calls.find((call) =>
      (call[0] as string).includes('revoked_reason'),
    );
    expect(revokeCall).toBeDefined();
    expect(revokeCall?.[1]).toEqual([FAMILY_ID, REVOKE_REASON_REUSE]);
    expect(sqlCalls(query)).toContain('COMMIT');
  });

  it('logout 済みトークンの再提示も reuse 扱いで 401 になる（失効済み row の理由は上書きしない設計）', async () => {
    const { service, query } = createService(
      buildTokenRow({
        revoked_at: new Date(),
      }),
    );

    await expect(
      service.rotate('logged-out-raw-token', META),
    ).rejects.toMatchObject({ status: 401 });

    // ファミリー失効 UPDATE は WHERE revoked_at IS NULL 付きなので、
    // logout で失効済みの row の revoked_reason は 'logout' のまま保たれる。
    const revokeCall = query.mock.calls.find((call) =>
      (call[0] as string).includes('revoked_reason'),
    );
    expect(revokeCall).toBeDefined();
    expect((revokeCall?.[0] as string).replace(/\s+/g, ' ')).toContain(
      'revoked_at IS NULL',
    );
  });

  it('単純な期限切れトークンは 401 のみでファミリー失効しない（盗用兆候ではない）', async () => {
    const { service, query } = createService(
      buildTokenRow({
        expires_at: new Date(Date.now() - 1_000),
      }),
    );

    await expect(
      service.rotate('expired-raw-token', META),
    ).rejects.toMatchObject({ status: 401 });

    const sqls = sqlCalls(query);
    // reuse とは違い、失効 UPDATE も新トークン INSERT も発行されない。
    expect(sqls.some((sql) => sql.includes('revoked_reason'))).toBe(false);
    expect(sqls.some((sql) => sql.includes('INSERT INTO'))).toBe(false);
    expect(sqls).toContain('ROLLBACK');
  });
});

describe('RefreshTokensService.revokeFamilyByToken', () => {
  it('token hash からファミリーを引き、有効な row だけを指定理由で失効させる', async () => {
    const { service, query } = createService();

    await service.revokeFamilyByToken('presented-raw-token', REVOKE_REASON_LOGOUT);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql.replace(/\s+/g, ' ')).toContain(
      'SET revoked_at = now(), revoked_reason = $2',
    );
    expect(sql.replace(/\s+/g, ' ')).toContain('revoked_at IS NULL');
    // パラメータは hash と理由のみで、生トークンは乗らない。
    expect(params[1]).toBe(REVOKE_REASON_LOGOUT);
    expect(typeof params[0]).toBe('string');
    expect(params[0]).not.toBe('presented-raw-token');
    expect(SHA256_HEX.test(params[0] as string)).toBe(true);
  });
});
