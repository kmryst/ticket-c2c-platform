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
  UseGuards,
} from '@nestjs/common';
// JwtPayload は JwtAuthGuard 検証済みトークンの claim 型です。
import { JwtPayload } from '../auth/auth.types';
// CurrentUser は request.user（検証済み payload）を handler 引数として受け取るデコレータです。
import { CurrentUser } from '../auth/current-user.decorator';
// JwtAuthGuard は Bearer トークン（または httpOnly Cookie）を検証する自作 Guard です（ADR-0010）。
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EventsService } from './events.service';
import { SearchParams } from '../search/search.service';

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Post()
  // イベント登録は認証必須です（production-readiness L-10、Issue #194）。
  // C2C のため主催者ロールのような特別な権限は作らず、購入 API（Issue #135）と同じ
  // 「JWT 認証済みの一般ユーザーなら誰でも」の認可レベルにします。
  // 有効なトークンがないリクエストは handler 到達前に 401 になります。
  @UseGuards(JwtAuthGuard)
  @HttpCode(201)
  createEvent(@CurrentUser() user: JwtPayload, @Body() body: unknown) {
    // 作成者はクライアント申告ではなく、トークンの sub claim（users.id）を使います。
    // body に作成者 ID 系のフィールドが混ざっていても無視されます（購入 API の buyer_id と同じ方針）。
    return this.eventsService.createEvent(body, user.sub);
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
