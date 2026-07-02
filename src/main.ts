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
// AppModule は controller / service / database module を束ねた、この API のルートモジュールです。
import { AppModule } from './app.module';
// applySchemaOnBoot は dev 環境向けに database/schema.sql を起動時適用する helper です。
import { applySchemaOnBoot } from './schema-on-boot';

async function bootstrap() {
  // RUN_SCHEMA_ON_BOOT=true の場合のみ、API 起動前に schema.sql を適用します。
  // ローカル PoC は従来どおり psql での手動適用を正とし、この処理は dev（Aurora）専用です。
  await applySchemaOnBoot();

  // bootstrap はローカル PC 上で NestJS API プロセスを起動する関数です。
  // PostgreSQL は Docker Compose 側、API はホスト側で動き、DATABASE_URL 経由で接続します。
  const app = await NestFactory.create<NestFastifyApplication>(
    // アプリ全体の依存関係は AppModule から読み込みます。
    AppModule,
    // HTTP サーバーとして Fastify を使うよう NestJS に指定します。
    new FastifyAdapter(),
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
