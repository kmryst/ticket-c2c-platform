// ファイル概要:
// このファイルは NestJS API 全体のルートモジュール定義です。
// HealthController、PurchasesController、PurchasesService、DatabaseModule を登録し、
// アプリがどの入口と service で構成されるかを宣言します。

// Module は NestJS の DI コンテナへ controller / provider / module の関係を登録する decorator です。
import { Module } from '@nestjs/common';
// DatabaseModule は PostgreSQL へ接続する DatabaseService を提供します。
import { DatabaseModule } from './database/database.module';
// HealthController は PoC script が API 起動確認に使う /health エンドポイントです。
import { HealthController } from './health.controller';
// PurchasesController は購入リクエスト用 HTTP endpoint の入口です。
import { PurchasesController } from './purchases/purchases.controller';
// PurchasesService は在庫確認、在庫更新、購入履歴作成を担当する本体ロジックです。
import { PurchasesService } from './purchases/purchases.service';

// AppModule はこの PoC API のルートモジュールです。
// ここを見ると「どの controller と service がアプリに登録されているか」が分かります。
@Module({
  // imports には、他の module が提供する依存関係を読み込ませます。
  imports: [DatabaseModule],
  // controllers には、HTTP リクエストを受ける入口クラスを登録します。
  controllers: [HealthController, PurchasesController],
  // providers には、DI で注入される service クラスを登録します。
  providers: [PurchasesService],
})
// AppModule 自体には処理を書かず、アプリ構成の宣言だけを持たせます。
export class AppModule {}
