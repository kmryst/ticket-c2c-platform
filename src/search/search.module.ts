// ファイル概要:
// このファイルは SearchService を提供する NestJS module です。

import { Module } from '@nestjs/common';
import { SearchService } from './search.service';

@Module({
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
