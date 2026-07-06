// ファイル概要:
// このファイルはイベント登録・一覧・検索 API の NestJS module です。

import { Module } from '@nestjs/common';
// AuthModule は JwtAuthGuard と JwtService を提供します（イベント登録の認証必須化。L-10、Issue #194）。
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { CacheModule } from '../cache/cache.module';
import { MessagingModule } from '../messaging/messaging.module';
import { SearchModule } from '../search/search.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    CacheModule,
    MessagingModule,
    SearchModule,
  ],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
