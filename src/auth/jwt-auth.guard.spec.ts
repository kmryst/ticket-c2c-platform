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

// createJwtService は本番と同じ HS256 / 15 分の署名設定でテスト用 JwtService を作ります。
function createJwtService(secret: string = TEST_SECRET): JwtService {
  return new JwtService({
    secret,
    signOptions: { algorithm: 'HS256', expiresIn: 900 },
  });
}

// createContext は Authorization header と Cookie だけを持つ最小の ExecutionContext を作ります。
// Guard が触るのは switchToHttp().getRequest() だけなので、それ以外は実装しません。
function createContext(
  authorization?: string,
  cookies?: Record<string, string | undefined>,
): {
  context: ExecutionContext;
  request: AuthenticatedRequest;
} {
  const request = {
    headers: authorization ? { authorization } : {},
    cookies,
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
    // exp が付与されている（expiresIn 15 分設定が効いている）ことも確認する。
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

  it('access_token Cookie の有効なトークンを通し、payload を request.user へ添付する', async () => {
    const jwtService = createJwtService();
    const guard = new JwtAuthGuard(jwtService);
    const token = await jwtService.signAsync({ sub: USER_ID, email: EMAIL });
    // Authorization header なし・Cookie のみ（フロントエンドの経路。ADR-0011 決定 3）。
    const { context, request } = createContext(undefined, {
      access_token: token,
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toMatchObject({ sub: USER_ID, email: EMAIL });
  });

  it('Authorization header と Cookie が両方ある場合は Bearer を優先する', async () => {
    const jwtService = createJwtService();
    const guard = new JwtAuthGuard(jwtService);
    const bearerToken = await jwtService.signAsync({
      sub: USER_ID,
      email: EMAIL,
    });
    // Cookie 側には不正なトークンを置き、Bearer が優先されることで通過するのを確認する。
    const { context, request } = createContext(`Bearer ${bearerToken}`, {
      access_token: 'not-a-jwt',
    });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toMatchObject({ sub: USER_ID });
  });

  it('Cookie の不正なトークンは 401 を投げる', async () => {
    const guard = new JwtAuthGuard(createJwtService());
    const { context } = createContext(undefined, {
      access_token: 'not-a-jwt',
    });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  describe('シークレットローテーション（current/previous フォールバック。ADR-0012 / Issue #168）', () => {
    const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
    const NEW_SECRET = 'rotated-new-secret';
    const OLD_SECRET = 'rotated-old-secret';

    afterEach(() => {
      if (ORIGINAL_JWT_SECRET === undefined) {
        delete process.env.JWT_SECRET;
      } else {
        process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
      }
    });

    it('previous で署名された（ローテーション前の）トークンはフォールバック検証で通る', async () => {
      // 環境は current=NEW / previous=OLD の移行期間状態。
      process.env.JWT_SECRET = JSON.stringify({
        current: NEW_SECRET,
        previous: OLD_SECRET,
      });
      // Guard の JwtService は current で構成される（AuthModule の getJwtConfig 相当）。
      const guard = new JwtAuthGuard(createJwtService(NEW_SECRET));

      // 旧シークレットで署名済みの発行済みトークン。
      const oldToken = await createJwtService(OLD_SECRET).signAsync({
        sub: USER_ID,
        email: EMAIL,
      });
      const { context, request } = createContext(`Bearer ${oldToken}`);

      await expect(guard.canActivate(context)).resolves.toBe(true);
      expect(request.user).toMatchObject({ sub: USER_ID, email: EMAIL });
    });

    it('previous 破棄後（ローテーション完了後）は旧シークレット署名トークンが 401 になる', async () => {
      process.env.JWT_SECRET = JSON.stringify({
        current: NEW_SECRET,
        previous: '',
      });
      const guard = new JwtAuthGuard(createJwtService(NEW_SECRET));

      const oldToken = await createJwtService(OLD_SECRET).signAsync({
        sub: USER_ID,
        email: EMAIL,
      });
      const { context } = createContext(`Bearer ${oldToken}`);

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('current でも previous でもないシークレットの偽造トークンは 401 のまま', async () => {
      process.env.JWT_SECRET = JSON.stringify({
        current: NEW_SECRET,
        previous: OLD_SECRET,
      });
      const guard = new JwtAuthGuard(createJwtService(NEW_SECRET));

      const forged = await createJwtService('attacker-secret').signAsync({
        sub: USER_ID,
        email: EMAIL,
      });
      const { context } = createContext(`Bearer ${forged}`);

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('previous で署名されていても期限切れなら 401（exp 検証はフォールバックでも有効）', async () => {
      process.env.JWT_SECRET = JSON.stringify({
        current: NEW_SECRET,
        previous: OLD_SECRET,
      });
      const guard = new JwtAuthGuard(createJwtService(NEW_SECRET));

      const expiredOldToken = await createJwtService(OLD_SECRET).signAsync(
        { sub: USER_ID, email: EMAIL },
        { expiresIn: -10 },
      );
      const { context } = createContext(`Bearer ${expiredOldToken}`);

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
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
