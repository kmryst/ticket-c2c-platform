// ファイル概要:
// このファイルは認証 API の HTTP 境界を担当する controller です（ADR-0010、Issue #133）。
// POST /auth/signup、POST /auth/login、GET /auth/me を受け取り、
// request body / JWT payload を AuthService へ渡して結果を HTTP response に変換します。

// Body は request body を handler 引数へ渡す decorator です。
// Controller は class を HTTP controller として登録する decorator です。
// Get / Post は各 HTTP method の handler を定義する decorator です。
// HttpCode は成功時の HTTP status code を明示する decorator です。
// UseGuards は handler 実行前に Guard を適用する decorator です。
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
// AuthService は signup / login / me の認証ロジック本体です。
import { AuthService } from './auth.service';
// JwtPayload は Guard 検証済みトークンの claim 型です。
import { JwtPayload } from './auth.types';
// CurrentUser は request.user を handler 引数として受け取るデコレータです。
import { CurrentUser } from './current-user.decorator';
// JwtAuthGuard は Bearer トークンを検証する自作 Guard です。
import { JwtAuthGuard } from './jwt-auth.guard';

// AuthController は認証リクエストを HTTP で受ける境界です。
// controller は薄く保ち、validation・hash・トークン発行の判断は AuthService に委譲します。
@Controller('auth')
export class AuthController {
  // constructor injection で AuthService を受け取り、handler から呼び出します。
  constructor(private readonly authService: AuthService) {}

  // @Post('signup') は POST /auth/signup をこの method に対応させます。
  @Post('signup')
  // アカウントという資源を新規作成するため、成功時は 201 Created を返します。
  @HttpCode(201)
  // signup は HTTP request を service 呼び出しに変換するだけの薄い handler です。
  async signup(
    // body は JSON request body 全体を unknown として受け、service 側で validation します。
    @Body() body: unknown,
  ) {
    // メール重複（409）や入力不正（400）は service が NestJS exception として投げます。
    return this.authService.signup(body);
  }

  // @Post('login') は POST /auth/login をこの method に対応させます。
  @Post('login')
  // login は資源を作らないため、成功時は 200 に統一します。
  @HttpCode(200)
  // login も service へ委譲するだけの薄い handler です。
  async login(
    // body は unknown のまま service の validation へ渡します。
    @Body() body: unknown,
  ) {
    // 資格情報不一致は service が 401 として投げます。
    return this.authService.login(body);
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
}
