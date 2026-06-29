import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { PurchasesService } from './purchases.service';
import { PurchaseRequestBody } from './purchase.types';

@Controller('events/:eventId/purchases')
export class PurchasesController {
  constructor(private readonly purchasesService: PurchasesService) {}

  @Post()
  @HttpCode(200)
  async createPurchase(
    @Param('eventId') eventId: string,
    @Body() body: PurchaseRequestBody,
  ) {
    try {
      return await this.purchasesService.createPurchase(eventId, body);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('requestId already exists');
      }

      throw error;
    }
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

