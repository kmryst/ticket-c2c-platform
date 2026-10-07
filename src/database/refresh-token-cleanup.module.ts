// ファイル概要:
// このファイルは refresh_tokens 期限切れクリーンアップの定期実行（Issue #542 / ADR-0041）を
// api に登録する NestJS module です。AppModule からだけ import し、worker には入れません。

import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RefreshTokenCleanupService } from './refresh-token-cleanup.service';

@Module({
  // ScheduleModule.forRoot() が @Cron を付けた method を起動時に登録します。
  imports: [ScheduleModule.forRoot()],
  providers: [RefreshTokenCleanupService],
})
export class RefreshTokenCleanupModule {}
