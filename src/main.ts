// ファイル概要:
// このファイルは NestJS API プロセスの起動入口です。
// .env と NestJS の metadata を読み込み、AppModule を Fastify で起動し、
// Ctrl+C や SIGTERM 時に DB 接続 pool を閉じられるよう shutdown hook を有効化します。

// dotenv/config は .env の値を process.env に読み込むため、アプリ起動の最初に import します。
import 'dotenv/config';
// reflect-metadata は NestJS の decorator / DI が型メタデータを読むために必要です。
import 'reflect-metadata';
// NestFactory は NestJS アプリケーション本体を生成するための入口です。
import { NestFactory } from '@nestjs/core';
// FastifyAdapter は HTTP サーバーとして Fastify を使うためのアダプターです。
// NestFastifyApplication は作成したアプリが Fastify ベースであることを型で表します。
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
// fastifyCookie は Cookie の parse（request.cookies）と Set-Cookie（reply.setCookie）を提供する plugin です。
// httpOnly Cookie でのトークン発行・検証（ADR-0011 決定 3、Issue #142）に使います。
import fastifyCookie from '@fastify/cookie';
// stripApiPrefix は CloudFront 経由で届く /api/* パスを既存ルートへ写像します（ADR-0011 決定 2）。
import { stripApiPrefix } from './api-prefix';
// AppModule は controller / service / database module を束ねた、この API のルートモジュールです。
import { AppModule } from './app.module';

async function bootstrap() {
  // スキーマ適用は boot path から分離済みです（Issue #92）。
  // DDL は TypeORM versioned migrations（src/database/run-migrations.ts）を
  // db-migrate workflow / deploy-app の run_migrations 入力から明示的に実行します。
  // これにより API を複数タスクで同時起動しても DDL が競合しません。

  // bootstrap はローカル PC 上で NestJS API プロセスを起動する関数です。
  // PostgreSQL は Docker Compose 側、API はホスト側で動き、DATABASE_URL 経由で接続します。
  const app = await NestFactory.create<NestFastifyApplication>(
    // アプリ全体の依存関係は AppModule から読み込みます。
    AppModule,
    // HTTP サーバーとして Fastify を使うよう NestJS に指定します。
    // rewriteUrl はルーティング前に呼ばれるため、CloudFront のパスルーティングで
    // /api/* として届いたリクエストを既存ルート（プレフィックスなし）へ写像できます。
    new FastifyAdapter({
      rewriteUrl: (req: { url?: string }) => stripApiPrefix(req.url ?? '/'),
    }),
  );

  // Cookie plugin を登録し、request.cookies の parse と reply.setCookie を有効にします。
  // 署名付き Cookie は使わない（JWT 自体が署名済み）ため secret は渡しません。
  // cast は @nestjs/platform-fastify が fastify を exact pin（5.8.5）で同梱しており、
  // root の fastify（^5.9）と型の同一性が取れないための措置です（実行時は互換）。
  await app.register(
    fastifyCookie as unknown as Parameters<NestFastifyApplication['register']>[0],
  );
  // PORT 環境変数を API の待受ポートに変換します。
  const port = parsePort(process.env.PORT);

  // Ctrl+C や SIGTERM を受けたときに NestJS の終了処理を走らせます。
  // これにより DatabaseService の pg pool も安全に閉じられます。
  app.enableShutdownHooks();

  // 0.0.0.0 で待ち受けることで、ローカルホスト以外からのアクセスにも対応できます。
  await app.listen({ port, host: '0.0.0.0' });
}

// bootstrap は Promise を返すため、トップレベルでは void で実行開始だけを明示します。
void bootstrap();

function parsePort(value: string | undefined): number {
  // parsePort は文字列の環境変数を安全なポート番号へ変換する小さな helper です。
  // 空文字の PORT は未設定と同じ扱いにします。
  // Number('') は 0 になり、ランダムな空きポートで起動してしまうためです。
  if (!value) {
    // デフォルトでは PoC script が見に行く http://localhost:3000 に合わせます。
    return 3000;
  }

  // 環境変数は文字列なので、数値として解釈します。
  const port = Number(value);

  // 整数でない値、または TCP ポート範囲外の値は起動前に弾きます。
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    // ここで明示的に落とすことで、間違った PORT に気づきやすくします。
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  // 検証済みのポート番号を NestJS の listen に渡します。
  return port;
}
