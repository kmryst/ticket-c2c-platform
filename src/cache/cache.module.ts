// ファイル概要:
// このファイルは InventoryCacheService を提供する NestJS module です。

import { Module } from '@nestjs/common';
import { InventoryCacheService } from './inventory-cache.service';

@Module({
  providers: [InventoryCacheService],
  exports: [InventoryCacheService],
})
export class CacheModule {}
