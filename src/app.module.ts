// ファイル概要:
// このファイルは NestJS API 全体のルートモジュール定義です。
// health / events / purchases の各機能と、DB・キャッシュ・メッセージング・検索の
// 共有 module を束ね、アプリがどの入口と service で構成されるかを宣言します。

// Module は NestJS の DI コンテナへ controller / provider / module の関係を登録する decorator です。
import { Module } from '@nestjs/common';
// DatabaseModule は PostgreSQL へ接続する DatabaseService を提供します。
import { DatabaseModule } from './database/database.module';
// CacheModule は Valkey 前段フィルタの InventoryCacheService を提供します。
import { CacheModule } from './cache/cache.module';
// MessagingModule は EventBridge へのドメインイベント発行を提供します。
import { MessagingModule } from './messaging/messaging.module';
// SearchModule は OpenSearch 検索クライアントを提供します。
import { SearchModule } from './search/search.module';
// EventsModule はイベント登録・一覧・検索 API を提供します。
import { EventsModule } from './events/events.module';
// HealthController は /health, /healthz, /readyz の health check endpoint です。
import { HealthController } from './health.controller';
// PurchasesController は購入リクエスト用 HTTP endpoint の入口です。
import { PurchasesController } from './purchases/purchases.controller';
// PurchasesService は在庫確認、在庫更新、購入履歴作成を担当する本体ロジックです。
import { PurchasesService } from './purchases/purchases.service';

// AppModule はこの API のルートモジュールです。
// ここを見ると「どの controller と service がアプリに登録されているか」が分かります。
@Module({
  // imports には、他の module が提供する依存関係を読み込ませます。
  imports: [
    DatabaseModule,
    CacheModule,
    MessagingModule,
    SearchModule,
    EventsModule,
  ],
  // controllers には、HTTP リクエストを受ける入口クラスを登録します。
  controllers: [HealthController, PurchasesController],
  // providers には、DI で注入される service クラスを登録します。
  providers: [PurchasesService],
})
// AppModule 自体には処理を書かず、アプリ構成の宣言だけを持たせます。
export class AppModule {}
