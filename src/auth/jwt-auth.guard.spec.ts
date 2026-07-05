// ファイル概要:
// このファイルは JwtAuthGuard の単体テストです（ADR-0010、Issue #133）。
// JwtService は本物（テスト用シークレット）を使い、署名検証・有効期限・
// Authorization header の形式判定という Guard の実挙動を検証します。

import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthenticatedRequest, JwtAuthGuard } from './jwt-auth.guard';

const TEST_SECRET = 'unit-test-jwt-secret';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const EMAIL = 'buyer@example.com';

// createJwtService は本番と同じ HS256 / 1h の署名設定でテスト用 JwtService を作ります。
function createJwtService(secret: string = TEST_SECRET): JwtService {
  return new JwtService({
    secret,
    signOptions: { algorithm: 'HS256', expiresIn: 3600 },
  });
}

// createContext は Authorization header だけを持つ最小の ExecutionContext を作ります。
// Guard が触るのは switchToHttp().getRequest() だけなので、それ以外は実装しません。
function createContext(authorization?: string): {
  context: ExecutionContext;
  request: AuthenticatedRequest;
} {
  const request = {
    headers: authorization ? { authorization } : {},
  } as AuthenticatedRequest;

  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  return { context, request };
}

describe('JwtAuthGuard', () => {
  it('有効な Bearer トークンを通し、payload を request.user へ添付する', async () => {
    const jwtService = createJwtService();
    const guard = new JwtAuthGuard(jwtService);
    const token = await jwtService.signAsync({ sub: USER_ID, email: EMAIL });
    const { context, request } = createContext(`Bearer ${token}`);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toMatchObject({ sub: USER_ID, email: EMAIL });
    // exp が付与されている（expiresIn 1h 設定が効いている）ことも確認する。
    expect(typeof request.user?.exp).toBe('number');
  });

  it('Authorization header が無い場合は 401 を投げる', async () => {
    const guard = new JwtAuthGuard(createJwtService());
    const { context } = createContext();

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('Bearer 以外の scheme（Basic 等）は 401 を投げる', async () => {
    const guard = new JwtAuthGuard(createJwtService());
    const { context } = createContext('Basic dXNlcjpwYXNz');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('トークンとして解釈できない文字列は 401 を投げる', async () => {
    const guard = new JwtAuthGuard(createJwtService());
    const { context } = createContext('Bearer not-a-jwt');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('別のシークレットで署名されたトークンは 401 を投げる', async () => {
    const guard = new JwtAuthGuard(createJwtService());
    const forged = await createJwtService('attacker-secret').signAsync({
      sub: USER_ID,
      email: EMAIL,
    });
    const { context, request } = createContext(`Bearer ${forged}`);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    // 検証に失敗したリクエストへ user が添付されないことも確認する。
    expect(request.user).toBeUndefined();
  });

  it('期限切れトークンは 401 を投げる', async () => {
    const jwtService = createJwtService();
    const guard = new JwtAuthGuard(jwtService);
    // expiresIn を負値で上書きし、発行時点で失効済みのトークンを作る。
    const expired = await jwtService.signAsync(
      { sub: USER_ID, email: EMAIL },
      { expiresIn: -10 },
    );
    const { context } = createContext(`Bearer ${expired}`);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
