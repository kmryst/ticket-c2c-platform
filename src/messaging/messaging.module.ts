// ファイル概要:
// このファイルは DomainEventsService を提供する NestJS module です。

import { Module } from '@nestjs/common';
import { DomainEventsService } from './domain-events.service';

@Module({
  providers: [DomainEventsService],
  exports: [DomainEventsService],
})
export class MessagingModule {}
