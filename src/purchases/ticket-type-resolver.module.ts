// ファイル概要:
// このファイルは購入前段フィルタの Ticket Type 解決 service（Issue #389）を提供する
// NestJS module です。EventsModule と AppModule の両方から import し、
// Event→default Type mapping cache を単一 singleton として共有します。

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { TicketTypeResolverService } from './ticket-type-resolver.service';

@Module({
  imports: [DatabaseModule],
  providers: [TicketTypeResolverService],
  exports: [TicketTypeResolverService],
})
export class TicketTypeResolverModule {}
