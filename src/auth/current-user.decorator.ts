// ファイル概要:
// このファイルは JwtAuthGuard が request へ添付した認証済みユーザー（JWT payload）を
// handler の引数として受け取るためのパラメータデコレータです（ADR-0010、Issue #133）。

// createParamDecorator はカスタムのパラメータデコレータを定義する factory です。
// ExecutionContext は処理中リクエストへの入口です。
// UnauthorizedException は Guard を通っていない handler での誤用を 401 として顕在化させます。
import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
// AuthenticatedRequest は user プロパティ付きの Fastify request 型です。
import { AuthenticatedRequest } from './jwt-auth.guard';
// JwtPayload はデコレータが返す値の型です。
import { JwtPayload } from './auth.types';

// CurrentUser は @CurrentUser() として handler 引数に付けて使います。
// 必ず @UseGuards(JwtAuthGuard) と併用してください。Guard なしで使った場合は
// 黙って undefined を返すのではなく 401 を投げ、実装ミスに早く気づけるようにします。
export const CurrentUser = createParamDecorator(
  // data はデコレータ引数（未使用）、context から request を取り出します。
  (data: unknown, context: ExecutionContext): JwtPayload => {
    // Guard と同じ経路で Fastify request を取り出します。
    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest>();

    // JwtAuthGuard が通過していれば user が必ず入っています。
    if (!request.user) {
      // Guard の付け忘れは認可漏れなので、成功応答にせず 401 で止めます。
      throw new UnauthorizedException('request is not authenticated');
    }

    return request.user;
  },
);
