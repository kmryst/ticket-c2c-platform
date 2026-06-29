// ファイル概要:
// このファイルは PostgreSQL 接続 service を NestJS の DI に公開する module です。
// DatabaseService を global provider として登録し、購入処理などの feature から
// 同じ DB 接続管理役を注入できるようにします。

// Global は、この module の provider をアプリ全体から注入可能にする decorator です。
import { Global, Module } from '@nestjs/common';
// DatabaseService は node-postgres の Pool を管理する共有 service です。
import { DatabaseService } from './database.service';

// DatabaseModule は PostgreSQL 接続を NestJS の DI に登録するための module です。
// PoC では複数機能から DB に触る可能性があるため、global module として公開しています。
@Global()
@Module({
  // providers に登録した DatabaseService は NestJS がインスタンス化して管理します。
  providers: [DatabaseService],
  // exports に含めることで、他の module / service から DatabaseService を注入できます。
  exports: [DatabaseService],
})
// module クラス自体は設定の入れ物なので、メソッドや状態は持ちません。
export class DatabaseModule {}
