// ファイル概要:
// このファイルは Bearer トークン検証を行う自作 Guard です（ADR-0010、Issue #133）。
// Passport の strategy 抽象を使わず CanActivate を直接実装することで、
// 「リクエストが認証を通過する条件」をこの 1 ファイルで追えるようにします。

// CanActivate は Guard が実装する interface、ExecutionContext は処理中リクエストへの入口です。
// Injectable は Guard を NestJS の DI 対象として登録する decorator です。
// UnauthorizedException はトークン欠落・不正を 401 として返すために使います。
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
// JwtService は AuthModule の JwtModule 登録時設定（HS256 / JWT_SECRET）で検証します。
import { JwtService } from '@nestjs/jwt';
// FastifyRequest を使うのは、この API が Express ではなく Fastify アダプタで動いているためです（src/main.ts）。
import { FastifyRequest } from 'fastify';
// JwtPayload は検証後に request へ添付する claim の型です。
import { JwtPayload } from './auth.types';
// getJwtSecrets は current / previous のシークレット組を読みます（ADR-0012、Issue #168）。
import { getJwtSecrets } from '../config';

// AUTH_COOKIE_NAME は httpOnly Cookie でのトークン保持に使う Cookie 名です（ADR-0011、Issue #142）。
import { AUTH_COOKIE_NAME } from './auth-cookie';

// AuthenticatedRequest は JwtAuthGuard 通過後のリクエスト型です。
// Fastify の request オブジェクトへ user プロパティを後付けするため、交差型で表現します。
// cookies は @fastify/cookie（src/main.ts で登録）が parse した Cookie の map です。
export type AuthenticatedRequest = FastifyRequest & {
  user?: JwtPayload;
  cookies?: Record<string, string | undefined>;
};

// JwtAuthGuard を NestJS の DI に登録します（handler 単位の @UseGuards で使います）。
@Injectable()
// JwtAuthGuard は Authorization header の Bearer トークンを検証し、payload を request.user へ添付します。
export class JwtAuthGuard implements CanActivate {
  // constructor injection で JWT 検証 service を受け取ります。
  constructor(private readonly jwtService: JwtService) {}

  // canActivate が true を返した場合だけ、後続の handler が実行されます。
  async canActivate(context: ExecutionContext): Promise<boolean> {
    // HTTP レイヤの Fastify request を取り出します。
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();

    // Authorization header の Bearer トークンを優先し、無ければ httpOnly Cookie（ADR-0011 決定 3）を見ます。
    // Bearer 優先なのは、既存クライアント（k6 / smoke script）の明示的な指定を Cookie より尊重するためです。
    const token =
      extractBearerToken(request.headers.authorization) ??
      request.cookies?.[AUTH_COOKIE_NAME];

    // header にも Cookie にもトークンが無い場合は 401 です。
    if (!token) {
      throw new UnauthorizedException('missing bearer token or auth cookie');
    }

    try {
      // 署名（HS256 / current シークレット）と exp をまとめて検証します。
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      // 検証済み payload を request へ添付し、@CurrentUser() から参照できるようにします。
      request.user = payload;
      return true;
    } catch {
      // current で失敗した場合、ローテーション移行期間中は previous シークレットでフォールバック検証します
      // （ADR-0012、Issue #168）。previous 未設定なら従来どおり即 401 です。
      const previousPayload = await this.verifyWithPreviousSecret(token);
      if (previousPayload) {
        request.user = previousPayload;
        return true;
      }

      // 署名不正・期限切れ・形式不正の詳細は攻撃者へのヒントになるため、同じ 401 に丸めます。
      throw new UnauthorizedException('invalid or expired token');
    }
  }

  // verifyWithPreviousSecret は previous シークレットでの検証を試み、失敗時は null を返します。
  // これによりシークレットローテーション直後（最大アクセストークン TTL の間）も、
  // 旧シークレットで署名された発行済みトークンが即時無効にならず、無停止で切り替えられます。
  private async verifyWithPreviousSecret(
    token: string,
  ): Promise<JwtPayload | null> {
    let previous: string | undefined;
    try {
      previous = getJwtSecrets().previous;
    } catch {
      // JWT_SECRET の設定不備は起動時（getJwtConfig）に検出済みのはずなので、
      // 検証時の読み取り失敗は「previous なし」として current のみの判定に倒します。
      return null;
    }
    if (!previous) {
      return null;
    }

    try {
      // algorithms を HS256 に固定し、alg 混同（none / RS256 化）を防ぎます。
      return await this.jwtService.verifyAsync<JwtPayload>(token, {
        secret: previous,
        algorithms: ['HS256'],
      });
    } catch {
      return null;
    }
  }
}

// extractBearerToken は Authorization header から "Bearer <token>" のトークン部分を取り出します。
function extractBearerToken(
  // authorization は header 未指定の場合 undefined です。
  authorization: string | undefined,
): string | undefined {
  // header が無ければトークンもありません。
  if (!authorization) {
    return undefined;
  }

  // 先頭の空白 1 つで scheme と credentials に分割します（RFC 6750 の形式）。
  const [scheme, token] = authorization.split(' ');

  // scheme は大文字小文字を区別せず Bearer だけを受け付けます。Basic などは対象外です。
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return undefined;
  }

  return token;
}
