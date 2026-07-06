// ファイル概要:
// このファイルは AuthService の単体テストです（ADR-0010 Issue #133、ADR-0012 Issue #165）。
// DB（UsersService）・JWT 署名（JwtService）・リフレッシュトークン（RefreshTokensService）はモックし、
// validation・bcrypt hash / 照合・例外変換（400 / 401 / 409）・refresh / logout の分岐を検証します。
// bcrypt は本物を使い、hash がコストファクター 12 で生成されることも確認します。

import { hash } from 'bcrypt';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';
import { UserRow, UsersService } from '../users/users.service';
import {
  RefreshTokensService,
  REVOKE_REASON_LOGOUT,
  TokenClientMeta,
} from './refresh-tokens.service';

const USER_ID = '44444444-4444-4444-8444-444444444444';
const EMAIL = 'buyer@example.com';
const PASSWORD = 'correct horse battery staple';
const SIGNED_TOKEN = 'signed.jwt.token';
const REFRESH_TOKEN = 'issued-refresh-token';
const ROTATED_REFRESH_TOKEN = 'rotated-refresh-token';
const REFRESH_EXPIRES_IN = 14 * 24 * 60 * 60;
const CREATED_AT = new Date('2026-07-05T00:00:00Z');

// META はリフレッシュトークン発行に渡す監査用クライアント情報のダミーです。
const META: TokenClientMeta = { ip: '203.0.113.10', userAgent: 'jest-test' };

// buildUserRow はテスト用の users row を組み立てる helper です。
function buildUserRow(passwordHash: string): UserRow {
  return {
    id: USER_ID,
    email: EMAIL,
    password_hash: passwordHash,
    created_at: CREATED_AT,
  };
}

// createService はモック依存で AuthService を組み立てる helper です。
function createService(overrides?: {
  createUser?: jest.Mock;
  findByEmail?: jest.Mock;
  findById?: jest.Mock;
  rotate?: jest.Mock;
}) {
  const users = {
    createUser:
      overrides?.createUser ??
      jest.fn(async (email: string, passwordHash: string) => ({
        ...buildUserRow(passwordHash),
        email,
      })),
    findByEmail: overrides?.findByEmail ?? jest.fn(async () => null),
    findById: overrides?.findById ?? jest.fn(async () => null),
  } as unknown as UsersService;

  const jwtService = {
    signAsync: jest.fn(async () => SIGNED_TOKEN),
  } as unknown as JwtService;

  // refreshTokens は issue / rotate / revokeFamilyByToken の呼び出しだけを検証するモックです。
  // rotate の transaction・reuse detection 本体は refresh-tokens.service.spec.ts で検証します。
  const refreshTokens = {
    issue: jest.fn(async () => ({
      token: REFRESH_TOKEN,
      expiresIn: REFRESH_EXPIRES_IN,
    })),
    rotate:
      overrides?.rotate ??
      jest.fn(async () => ({
        userId: USER_ID,
        token: ROTATED_REFRESH_TOKEN,
        expiresIn: REFRESH_EXPIRES_IN,
      })),
    revokeFamilyByToken: jest.fn(async () => undefined),
  } as unknown as RefreshTokensService;

  const service = new AuthService(users, jwtService, refreshTokens);
  return { service, users, jwtService, refreshTokens };
}

describe('AuthService.signup', () => {
  it('ユーザーを作成し、コストファクター 12 の bcrypt hash と JWT・リフレッシュトークンを返す', async () => {
    const { service, users, jwtService, refreshTokens } = createService();

    const result = await service.signup(
      { email: EMAIL, password: PASSWORD },
      META,
    );

    // createUser へは平文ではなく bcrypt hash が渡される。
    const [passedEmail, passedHash] = (users.createUser as jest.Mock).mock
      .calls[0] as [string, string];
    expect(passedEmail).toBe(EMAIL);
    // $2b$12$ プレフィックスでコストファクター 12 を確認する（ADR-0010）。
    expect(passedHash).toMatch(/^\$2[aby]\$12\$/);
    expect(passedHash).not.toContain(PASSWORD);

    // JWT payload は sub（users.id）と email に絞られる。
    expect(jwtService.signAsync).toHaveBeenCalledWith({
      sub: USER_ID,
      email: EMAIL,
    });

    // リフレッシュトークンは監査用メタ情報つきで新規ファミリーとして発行される（ADR-0012）。
    expect(refreshTokens.issue).toHaveBeenCalledWith(USER_ID, META);

    // response にはトークンと公開ユーザー情報だけが含まれる（password_hash は返さない）。
    expect(result.accessToken).toBe(SIGNED_TOKEN);
    expect(result.tokenType).toBe('Bearer');
    expect(result.expiresIn).toBe(3600);
    expect(result.refreshToken).toBe(REFRESH_TOKEN);
    expect(result.refreshExpiresIn).toBe(REFRESH_EXPIRES_IN);
    expect(result.user).toEqual({
      userId: USER_ID,
      email: EMAIL,
      createdAt: CREATED_AT.toISOString(),
    });
  });

  it('メール重複（users_email_uq の unique violation）は 409 に変換する', async () => {
    const uniqueViolation = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'users_email_uq',
    });
    const { service } = createService({
      createUser: jest.fn(async () => {
        throw uniqueViolation;
      }),
    });

    await expect(
      service.signup({ email: EMAIL, password: PASSWORD }, META),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('email 形式不正は 400 を返し、DB に到達しない', async () => {
    const { service, users } = createService();

    await expect(
      service.signup({ email: 'not-an-email', password: PASSWORD }, META),
    ).rejects.toMatchObject({ status: 400 });
    expect(users.createUser).not.toHaveBeenCalled();
  });

  it.each([
    ['short', '7 文字以下'],
    ['あ'.repeat(25), '72 byte 超（マルチバイト）'],
  ])('パスワード "%s"（%s）は 400 を返す', async (password) => {
    const { service } = createService();

    await expect(
      service.signup({ email: EMAIL, password }, META),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('object 以外の body は 400 を返す', async () => {
    const { service } = createService();

    await expect(service.signup(null, META)).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.signup([EMAIL], META)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('AuthService.login', () => {
  it('正しい資格情報で JWT とリフレッシュトークンを返す', async () => {
    // 照合対象の hash はテスト高速化のためコストファクター 4 で作る（compare は cost に依存しない）。
    const passwordHash = await hash(PASSWORD, 4);
    const { service, refreshTokens } = createService({
      findByEmail: jest.fn(async () => buildUserRow(passwordHash)),
    });

    const result = await service.login(
      { email: EMAIL, password: PASSWORD },
      META,
    );

    expect(result.accessToken).toBe(SIGNED_TOKEN);
    expect(result.refreshToken).toBe(REFRESH_TOKEN);
    expect(result.user.userId).toBe(USER_ID);
    expect(refreshTokens.issue).toHaveBeenCalledWith(USER_ID, META);
  });

  it('パスワード不一致は 401 を返し、リフレッシュトークンを発行しない', async () => {
    const passwordHash = await hash(PASSWORD, 4);
    const { service, refreshTokens } = createService({
      findByEmail: jest.fn(async () => buildUserRow(passwordHash)),
    });

    await expect(
      service.login({ email: EMAIL, password: 'wrong-password-123' }, META),
    ).rejects.toMatchObject({ status: 401 });
    expect(refreshTokens.issue).not.toHaveBeenCalled();
  });

  it('存在しないメールも同じ 401 を返す（存在有無を区別しない）', async () => {
    const { service } = createService({
      findByEmail: jest.fn(async () => null),
    });

    await expect(
      service.login({ email: 'unknown@example.com', password: PASSWORD }, META),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('AuthService.refresh', () => {
  it('rotate 成功で新しいアクセストークンと新リフレッシュトークンを返す', async () => {
    const passwordHash = await hash(PASSWORD, 4);
    const { service, refreshTokens, jwtService } = createService({
      findById: jest.fn(async () => buildUserRow(passwordHash)),
    });

    const result = await service.refresh('presented-refresh-token', META);

    // rotate には提示された生トークンと監査メタ情報がそのまま渡される。
    expect(refreshTokens.rotate).toHaveBeenCalledWith(
      'presented-refresh-token',
      META,
    );
    // アクセストークンは rotate されたユーザーに対して新規署名される。
    expect(jwtService.signAsync).toHaveBeenCalledWith({
      sub: USER_ID,
      email: EMAIL,
    });
    expect(result.accessToken).toBe(SIGNED_TOKEN);
    expect(result.refreshToken).toBe(ROTATED_REFRESH_TOKEN);
  });

  it('トークン未提示（Cookie も body も無し）は 401 を返し、DB に到達しない', async () => {
    const { service, refreshTokens } = createService();

    await expect(service.refresh(undefined, META)).rejects.toMatchObject({
      status: 401,
    });
    expect(refreshTokens.rotate).not.toHaveBeenCalled();
  });

  it('rotate 後にユーザーが消えていた場合は 401 を返す', async () => {
    const { service } = createService({
      findById: jest.fn(async () => null),
    });

    await expect(
      service.refresh('presented-refresh-token', META),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('rotate の 401（無効・reuse・期限切れ）はそのまま伝播する', async () => {
    const { service } = createService({
      rotate: jest.fn(async () => {
        const error = new Error('invalid or expired refresh token');
        throw Object.assign(error, { status: 401 });
      }),
    });

    await expect(
      service.refresh('stolen-refresh-token', META),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('AuthService.logout', () => {
  it('提示されたリフレッシュトークンのファミリーを logout 理由で失効させる', async () => {
    const { service, refreshTokens } = createService();

    await service.logout('presented-refresh-token');

    expect(refreshTokens.revokeFamilyByToken).toHaveBeenCalledWith(
      'presented-refresh-token',
      REVOKE_REASON_LOGOUT,
    );
  });

  it('トークン未提示の logout は何もせず成功する（冪等）', async () => {
    const { service, refreshTokens } = createService();

    await expect(service.logout(undefined)).resolves.toBeUndefined();
    expect(refreshTokens.revokeFamilyByToken).not.toHaveBeenCalled();
  });
});

describe('AuthService.getMe', () => {
  it('payload の sub からユーザーを引き、公開情報だけを返す', async () => {
    const passwordHash = await hash(PASSWORD, 4);
    const findById = jest.fn(async () => buildUserRow(passwordHash));
    const { service } = createService({ findById });

    const result = await service.getMe({ sub: USER_ID, email: EMAIL });

    expect(findById).toHaveBeenCalledWith(USER_ID);
    expect(result).toEqual({
      userId: USER_ID,
      email: EMAIL,
      createdAt: CREATED_AT.toISOString(),
    });
    // password_hash がレスポンスへ漏れないことを明示的に確認する。
    expect(result).not.toHaveProperty('password_hash');
  });

  it('トークン発行後にユーザーが消えていた場合は 401 を返す', async () => {
    const { service } = createService({ findById: jest.fn(async () => null) });

    await expect(
      service.getMe({ sub: USER_ID, email: EMAIL }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
