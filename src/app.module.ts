import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health.controller';
import { PurchasesController } from './purchases/purchases.controller';
import { PurchasesService } from './purchases/purchases.service';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController, PurchasesController],
  providers: [PurchasesService],
})
export class AppModule {}

