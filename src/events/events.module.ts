// ファイル概要:
// このファイルはイベント登録・一覧・検索 API の NestJS module です。

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { CacheModule } from '../cache/cache.module';
import { MessagingModule } from '../messaging/messaging.module';
import { SearchModule } from '../search/search.module';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';

@Module({
  imports: [DatabaseModule, CacheModule, MessagingModule, SearchModule],
  controllers: [EventsController],
  providers: [EventsService],
})
export class EventsModule {}
