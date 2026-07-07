// ファイル概要:
// このファイルは認証 API の HTTP 境界を担当する controller です（ADR-0010 Issue #133、ADR-0012 Issue #165）。
// POST /auth/signup、POST /auth/login、POST /auth/refresh、POST /auth/logout、GET /auth/me を受け取り、
// request body / Cookie / JWT payload を AuthService へ渡して結果を HTTP response に変換します。

// Body は request body を handler 引数へ渡す decorator です。
// Controller は class を HTTP controller として登録する decorator です。
// Get / Post は各 HTTP method の handler を定義する decorator です。
// HttpCode は成功時の HTTP status code を明示する decorator です。
// Req / Res は Fastify の request / response オブジェクトを受け取る decorator です。
// UseGuards は handler 実行前に Guard を適用する decorator です。
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
// FastifyReply は Set-Cookie header を書き込むための response オブジェクトです。
// FastifyRequest は Cookie / IP / User-Agent を読むための request オブジェクトです。
import { FastifyReply, FastifyRequest } from 'fastify';
// AuthService は signup / login / refresh / logout / me の認証ロジック本体です。
import { AuthService } from './auth.service';
// JwtPayload は Guard 検証済みトークンの claim 型、RefreshRequestBody は refresh の body 型です。
import { JwtPayload, RefreshRequestBody } from './auth.types';
// CurrentUser は request.user を handler 引数として受け取るデコレータです。
import { CurrentUser } from './current-user.decorator';
// JwtAuthGuard は Bearer トークンを検証する自作 Guard です。
import { JwtAuthGuard } from './jwt-auth.guard';
// Cookie helper: アクセストークン（Path=/）とリフレッシュトークン（Path=/api/auth）を分離して発行・破棄します。
import {
  clearAuthCookie,
  clearRefreshCookie,
  REFRESH_COOKIE_NAME,
  setAuthCookie,
  setRefreshCookie,
} from './auth-cookie';
// resolveClientIp は X-Forwarded-For を trusted-hops 方式で解決します（ADR-0012）。
import { resolveClientIp } from './client-ip';
// TokenClientMeta はリフレッシュトークン発行時に記録する調査用のクライアント情報です。
import { TokenClientMeta } from './refresh-tokens.service';
// AuthRateLimitService は signup / login / refresh の固定ウィンドウレート制限です（ADR-0012、Issue #167）。
// extractRetryAfterSeconds は 429 例外から Retry-After 用の待機秒数を取り出す共有 helper です。
import {
  AuthRateLimitService,
  extractRetryAfterSeconds,
  RateLimitedEndpoint,
  RateLimitSubject,
} from './rate-limit.service';
// createHash は refresh のレート制限キー（トークンの SHA-256）を作るために使います。
import { createHash } from 'node:crypto';

// CookieRequest は @fastify/cookie が parse した Cookie map つきの request 型です。
type CookieRequest = FastifyRequest & {
  cookies?: Record<string, string | undefined>;
};

// AuthController は認証リクエストを HTTP で受ける境界です。
// controller は薄く保ち、validation・hash・トークン発行・rotate の判断は AuthService に委譲します。
@Controller('auth')
export class AuthController {
  // constructor injection で AuthService とレート制限 service を受け取り、handler から呼び出します。
  constructor(
    private readonly authService: AuthService,
    private readonly rateLimit: AuthRateLimitService,
  ) {}

  // @Post('signup') は POST /auth/signup をこの method に対応させます。
  @Post('signup')
  // アカウントという資源を新規作成するため、成功時は 201 Created を返します。
  @HttpCode(201)
  // signup は HTTP request を service 呼び出しに変換するだけの薄い handler です。
  async signup(
    // body は JSON request body 全体を unknown として受け、service 側で validation します。
    @Body() body: unknown,
    // request からはリフレッシュトークン監査用のクライアント情報（IP / User-Agent）だけを読みます。
    @Req() request: FastifyRequest,
    // passthrough を付けることで、Set-Cookie だけ書き込み、response body は従来どおり
    // NestJS の戻り値シリアライズに任せられます。
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // レート制限（IP + メール単位）を最初に判定します。超過は 429 + Retry-After です（Issue #167）。
    await this.enforceRateLimit(
      'signup',
      { ip: resolveClientIp(request), secondary: extractBodyEmail(body) },
      reply,
    );
    // メール重複（409）や入力不正（400）は service が NestJS exception として投げます。
    const result = await this.authService.signup(body, clientMeta(request));
    // フロントエンド用に httpOnly Cookie でも同じトークンを発行します（ADR-0011 決定 3、ADR-0012）。
    // JSON body の accessToken / refreshToken は非ブラウザクライアント互換のため維持します。
    setAuthCookie(reply, result.accessToken);
    setRefreshCookie(reply, result.refreshToken);
    return result;
  }

  // @Post('login') は POST /auth/login をこの method に対応させます。
  @Post('login')
  // login は資源を作らないため、成功時は 200 に統一します。
  @HttpCode(200)
  // login も service へ委譲するだけの薄い handler です。
  async login(
    // body は unknown のまま service の validation へ渡します。
    @Body() body: unknown,
    // signup と同じくクライアント情報の読み取りにだけ request を使います。
    @Req() request: FastifyRequest,
    // signup と同じく Set-Cookie の書き込みにだけ reply を使います。
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // レート制限（IP + メール単位）を最初に判定します。credential stuffing / 総当たりの緩和です（Issue #167）。
    await this.enforceRateLimit(
      'login',
      { ip: resolveClientIp(request), secondary: extractBodyEmail(body) },
      reply,
    );
    // 資格情報不一致は service が 401 として投げます。
    const result = await this.authService.login(body, clientMeta(request));
    // httpOnly Cookie でも両トークンを発行します（ADR-0011 決定 3、ADR-0012）。
    setAuthCookie(reply, result.accessToken);
    setRefreshCookie(reply, result.refreshToken);
    return result;
  }

  // @Post('refresh') は POST /auth/refresh をこの method に対応させます（ADR-0012、Issue #165）。
  // リフレッシュトークン自体が資格情報なので、JwtAuthGuard（アクセストークン検証）は要求しません。
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    // 非ブラウザクライアントは body の refreshToken、ブラウザは httpOnly Cookie を使います。
    @Body() body: unknown,
    @Req() request: CookieRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // body 優先なのは、既存クライアント（smoke script 等）の明示指定を Cookie より尊重するためです
    // （JwtAuthGuard の Bearer 優先と同じ方針）。
    const rawToken =
      extractBodyRefreshToken(body) ?? request.cookies?.[REFRESH_COOKIE_NAME];

    // レート制限（IP + トークン単位）を最初に判定します（Issue #167）。
    // refresh の request にはメールが含まれないため、第 2 系統はトークンの SHA-256 を使います。
    // 生トークンをキーに載せない（Valkey の SCAN 等から漏れない）ためのハッシュ化です。
    await this.enforceRateLimit(
      'refresh',
      {
        ip: resolveClientIp(request),
        secondary: rawToken
          ? createHash('sha256').update(rawToken).digest('hex')
          : undefined,
      },
      reply,
    );

    try {
      // rotate-on-use と reuse detection は service / RefreshTokensService が行います。
      const result = await this.authService.refresh(
        rawToken,
        clientMeta(request),
      );
      // 新しい世代のトークンで両 Cookie を貼り替えます。
      setAuthCookie(reply, result.accessToken);
      setRefreshCookie(reply, result.refreshToken);
      return result;
    } catch (error) {
      // refresh に失敗したブラウザが無効な Cookie を送り続けないよう、両 Cookie を破棄します。
      // （reuse 検知でファミリー失効した場合も、以降のリトライを DB まで到達させない効果があります。）
      clearAuthCookie(reply);
      clearRefreshCookie(reply);
      throw error;
    }
  }

  // @Post('logout') は POST /auth/logout をこの method に対応させます。
  // Cookie 破棄とリフレッシュトークンファミリーの失効を行います（ADR-0012 で失効を追加）。
  @Post('logout')
  @HttpCode(204)
  async logout(
    // 非ブラウザクライアント向けに body の refreshToken も受け付けます。
    @Body() body: unknown,
    @Req() request: CookieRequest,
    // Set-Cookie（破棄）だけを書き込みます。
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const rawToken =
      extractBodyRefreshToken(body) ?? request.cookies?.[REFRESH_COOKIE_NAME];

    // リフレッシュトークンのファミリーを失効させます（トークン不明でも logout 自体は成功します）。
    // JWT アクセストークンは即時失効できない（ADR-0010 のトレードオフ）ため、
    // 寿命短縮（ADR-0012）と Cookie 破棄で漏洩窓を最小化します。
    await this.authService.logout(rawToken);
    clearAuthCookie(reply);
    clearRefreshCookie(reply);
  }

  // @Get('me') は GET /auth/me をこの method に対応させます。
  @Get('me')
  // JwtAuthGuard により、有効な Bearer トークンがないリクエストは handler 到達前に 401 になります。
  @UseGuards(JwtAuthGuard)
  // me は検証済み payload から現在のユーザー情報を返します。
  async me(
    // user は JwtAuthGuard が request へ添付した検証済み JWT payload です。
    @CurrentUser() user: JwtPayload,
  ) {
    // トークン発行後のユーザー削除に備え、DB を正として最新情報を返します。
    return this.authService.getMe(user);
  }

  // enforceRateLimit はレート制限を判定し、超過時は Retry-After header を付けて 429 を投げます。
  private async enforceRateLimit(
    endpoint: RateLimitedEndpoint,
    subject: RateLimitSubject,
    reply: FastifyReply,
  ): Promise<void> {
    try {
      await this.rateLimit.enforce(endpoint, subject);
    } catch (error) {
      // 429 の場合、service が body に入れた retryAfterSeconds を標準の Retry-After header にも反映します。
      const retryAfter = extractRetryAfterSeconds(error);
      if (retryAfter !== undefined) {
        reply.header('Retry-After', String(retryAfter));
      }
      throw error;
    }
  }
}

// extractBodyEmail はレート制限のメール系統キー用に body から email を安全に取り出します。
// validation 前の値なので string 以外は「無し」として扱い、大文字小文字の揺れは lower で吸収します。
function extractBodyEmail(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }

  const email = (body as { email?: unknown }).email;
  return typeof email === 'string' && email.length > 0
    ? email.toLowerCase()
    : undefined;
}

// clientMeta は request からリフレッシュトークン監査用のクライアント情報を取り出します。
function clientMeta(request: FastifyRequest): TokenClientMeta {
  const userAgent = request.headers['user-agent'];
  return {
    // IP は X-Forwarded-For の trusted-hops 解決（偽装対策。ADR-0012）を通した値です。
    ip: resolveClientIp(request),
    userAgent: typeof userAgent === 'string' ? userAgent : undefined,
  };
}

// extractBodyRefreshToken は refresh / logout の body から refreshToken を安全に取り出します。
// body は信用できない外部入力なので、string 以外は「無し」として扱います。
function extractBodyRefreshToken(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }

  const requestBody = body as RefreshRequestBody;
  return typeof requestBody.refreshToken === 'string' &&
    requestBody.refreshToken.length > 0
    ? requestBody.refreshToken
    : undefined;
}
