// ファイル概要:
// このファイルは認証機能（signup / login / me と JwtAuthGuard）を束ねる module です（ADR-0010、Issue #133）。
// JWT の署名設定（HS256 / 有効期限 15 分 / JWT_SECRET）はここで一元的に登録し、
// トークンの発行（AuthService）と検証（JwtAuthGuard）が必ず同じ設定を使うようにします。

// Module は NestJS の DI コンテナへ controller / provider / module の関係を登録する decorator です。
import { Module } from '@nestjs/common';
// JwtModule は @nestjs/jwt の JwtService を提供します（Passport は使いません。ADR-0010）。
import { JwtModule } from '@nestjs/jwt';
// getJwtConfig は JWT_SECRET と署名オプション（HS256 / 15 分）を config helper から読みます。
import { getJwtConfig } from '../config';
// UsersService は users テーブルへの raw SQL アクセス層です。
import { UsersService } from '../users/users.service';
// AuthController は /auth 配下の HTTP endpoint 入口です。
import { AuthController } from './auth.controller';
// AuthService は認証フローのビジネスロジック本体です。
import { AuthService } from './auth.service';
// JwtAuthGuard は Bearer トークンを検証する自作 Guard です。
import { JwtAuthGuard } from './jwt-auth.guard';
// RefreshTokensService はリフレッシュトークンの発行・rotate・失効の正本です（ADR-0012、Issue #165）。
import { RefreshTokensService } from './refresh-tokens.service';
// AuthRateLimitService は signup / login / refresh の固定ウィンドウレート制限です（ADR-0012、Issue #167）。
import { AuthRateLimitService } from './rate-limit.service';

// AuthModule は認証機能一式を AppModule へ提供します。
// DatabaseService は DatabaseModule が @Global() で公開しているため、ここでの import は不要です。
@Module({
  imports: [
    // registerAsync により、JWT_SECRET の読み込みをアプリ起動時（factory 実行時）まで遅延させます。
    // 未設定の場合は getJwtConfig が明確なメッセージで起動を失敗させます（fail fast）。
    JwtModule.registerAsync({
      useFactory: () => getJwtConfig(),
    }),
  ],
  // controllers には、HTTP リクエストを受ける入口クラスを登録します。
  controllers: [AuthController],
  // providers には、DI で注入される service / guard クラスを登録します。
  providers: [
    AuthService,
    UsersService,
    JwtAuthGuard,
    RefreshTokensService,
    AuthRateLimitService,
  ],
  // JwtAuthGuard と JwtService（JwtModule）を export し、
  // 他 module の controller（購入 API の認証必須化。Issue #135）からも同じ検証設定を使えるようにします。
  exports: [JwtAuthGuard, JwtModule],
})
// module クラス自体は設定の入れ物なので、メソッドや状態は持ちません。
export class AuthModule {}
