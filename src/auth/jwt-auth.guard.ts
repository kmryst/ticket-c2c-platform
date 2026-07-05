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

// AuthenticatedRequest は JwtAuthGuard 通過後のリクエスト型です。
// Fastify の request オブジェクトへ user プロパティを後付けするため、交差型で表現します。
export type AuthenticatedRequest = FastifyRequest & { user?: JwtPayload };

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

    // Authorization header から Bearer トークン部分だけを取り出します。
    const token = extractBearerToken(request.headers.authorization);

    // トークンがそもそも無い場合は 401 です。
    if (!token) {
      throw new UnauthorizedException('missing bearer token');
    }

    try {
      // 署名（HS256 / JWT_SECRET）と exp をまとめて検証します。
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
      // 検証済み payload を request へ添付し、@CurrentUser() から参照できるようにします。
      request.user = payload;
      return true;
    } catch {
      // 署名不正・期限切れ・形式不正の詳細は攻撃者へのヒントになるため、同じ 401 に丸めます。
      throw new UnauthorizedException('invalid or expired token');
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
