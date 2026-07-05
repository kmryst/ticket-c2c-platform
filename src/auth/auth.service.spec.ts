// ファイル概要:
// このファイルは AuthService の単体テストです（ADR-0010、Issue #133）。
// DB（UsersService）と JWT 署名（JwtService）はモックし、
// validation・bcrypt hash / 照合・例外変換（400 / 401 / 409）の分岐を検証します。
// bcrypt は本物を使い、hash がコストファクター 12 で生成されることも確認します。

import { hash } from 'bcrypt';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';
import { UserRow, UsersService } from '../users/users.service';

const USER_ID = '44444444-4444-4444-8444-444444444444';
const EMAIL = 'buyer@example.com';
const PASSWORD = 'correct horse battery staple';
const SIGNED_TOKEN = 'signed.jwt.token';
const CREATED_AT = new Date('2026-07-05T00:00:00Z');

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

  const service = new AuthService(users, jwtService);
  return { service, users, jwtService };
}

describe('AuthService.signup', () => {
  it('ユーザーを作成し、コストファクター 12 の bcrypt hash と JWT を返す', async () => {
    const { service, users, jwtService } = createService();

    const result = await service.signup({ email: EMAIL, password: PASSWORD });

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

    // response にはトークンと公開ユーザー情報だけが含まれる（password_hash は返さない）。
    expect(result.accessToken).toBe(SIGNED_TOKEN);
    expect(result.tokenType).toBe('Bearer');
    expect(result.expiresIn).toBe(3600);
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
      service.signup({ email: EMAIL, password: PASSWORD }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('email 形式不正は 400 を返し、DB に到達しない', async () => {
    const { service, users } = createService();

    await expect(
      service.signup({ email: 'not-an-email', password: PASSWORD }),
    ).rejects.toMatchObject({ status: 400 });
    expect(users.createUser).not.toHaveBeenCalled();
  });

  it.each([
    ['short', '7 文字以下'],
    ['あ'.repeat(25), '72 byte 超（マルチバイト）'],
  ])('パスワード "%s"（%s）は 400 を返す', async (password) => {
    const { service } = createService();

    await expect(
      service.signup({ email: EMAIL, password }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('object 以外の body は 400 を返す', async () => {
    const { service } = createService();

    await expect(service.signup(null)).rejects.toMatchObject({ status: 400 });
    await expect(service.signup([EMAIL])).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('AuthService.login', () => {
  it('正しい資格情報で JWT を返す', async () => {
    // 照合対象の hash はテスト高速化のためコストファクター 4 で作る（compare は cost に依存しない）。
    const passwordHash = await hash(PASSWORD, 4);
    const { service } = createService({
      findByEmail: jest.fn(async () => buildUserRow(passwordHash)),
    });

    const result = await service.login({ email: EMAIL, password: PASSWORD });

    expect(result.accessToken).toBe(SIGNED_TOKEN);
    expect(result.user.userId).toBe(USER_ID);
  });

  it('パスワード不一致は 401 を返す', async () => {
    const passwordHash = await hash(PASSWORD, 4);
    const { service } = createService({
      findByEmail: jest.fn(async () => buildUserRow(passwordHash)),
    });

    await expect(
      service.login({ email: EMAIL, password: 'wrong-password-123' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('存在しないメールも同じ 401 を返す（存在有無を区別しない）', async () => {
    const { service } = createService({
      findByEmail: jest.fn(async () => null),
    });

    await expect(
      service.login({ email: 'unknown@example.com', password: PASSWORD }),
    ).rejects.toMatchObject({ status: 401 });
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
