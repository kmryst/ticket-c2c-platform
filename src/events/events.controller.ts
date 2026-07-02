// ファイル概要:
// このファイルはイベント登録・一覧・検索 API の HTTP 境界です。
// 検証やロジックは EventsService に委譲し、controller は薄く保ちます。

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
} from '@nestjs/common';
import { EventsService } from './events.service';
import { SearchParams } from '../search/search.service';

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  @HttpCode(201)
  createEvent(@Body() body: unknown) {
    return this.eventsService.createEvent(body);
  }

  @Get()
  listEvents() {
    return this.eventsService.listEvents();
  }

  // GET /events/search?eventType=music&date=2026-07-10&lat=35.68&lon=139.76&radiusKm=50
  @Get('search')
  searchEvents(
    @Query('eventType') eventType?: string,
    @Query('date') date?: string,
    @Query('lat') lat?: string,
    @Query('lon') lon?: string,
    @Query('radiusKm') radiusKm?: string,
  ) {
    const params: SearchParams = {};

    if (eventType) {
      params.eventType = eventType;
    }
    if (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new BadRequestException('date must be YYYY-MM-DD');
      }
      params.date = date;
    }
    if (lat !== undefined || lon !== undefined) {
      const latitude = Number(lat);
      const longitude = Number(lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        throw new BadRequestException('lat and lon must be numbers');
      }
      params.latitude = latitude;
      params.longitude = longitude;
    }
    if (radiusKm !== undefined) {
      const radius = Number(radiusKm);
      if (!Number.isFinite(radius) || radius <= 0 || radius > 20000) {
        throw new BadRequestException('radiusKm must be a positive number');
      }
      params.radiusKm = radius;
    }

    return this.eventsService.searchEvents(params);
  }
}
