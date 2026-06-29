// ファイル概要:
// このファイルは購入 API の HTTP 境界を担当する controller です。
// POST /events/:eventId/purchases を受け取り、URL parameter と request body を
// PurchasesService に渡して、service の結果や例外を HTTP response に変換します。

// Body は request body を handler 引数へ渡す decorator です。
// ConflictException は 409 Conflict を返すための NestJS exception です。
// Controller は class を HTTP controller として登録する decorator です。
// HttpCode は成功時の HTTP status code を明示する decorator です。
// Param は URL path parameter を handler 引数へ渡す decorator です。
// Post は POST endpoint の handler を定義する decorator です。
import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
// PurchasesService は購入判定の business logic と transaction 処理を持つ service です。
import { PurchasesService } from './purchases.service';

// PurchasesController は購入リクエストを HTTP で受ける境界です。
// controller は薄く保ち、在庫や transaction の判断は PurchasesService に委譲します。
@Controller('events/:eventId/purchases')
export class PurchasesController {
  // constructor injection で PurchasesService を受け取り、handler から呼び出します。
  constructor(private readonly purchasesService: PurchasesService) {}

  // @Post() は POST /events/:eventId/purchases をこの method に対応させます。
  @Post()
  // 購入判定は confirmed / rejected のどちらも業務上は正常応答なので、成功時は 200 に統一します。
  @HttpCode(200)
  // createPurchase は HTTP request を service 呼び出しに変換するだけの薄い handler です。
  async createPurchase(
    // eventId は URL の :eventId から受け取ります。
    @Param('eventId') eventId: string,
    // body は JSON request body 全体を unknown として受け、service 側で validation します。
    @Body() body: unknown,
  ) {
    // service 内で NestJS exception が投げられた場合は、そのまま framework に処理させます。
    try {
      // 実際の購入判定、DB transaction、response 作成は service に任せます。
      return await this.purchasesService.createPurchase(eventId, body);
    } catch (error) {
      // requestId の unique constraint が service で吸収しきれず controller まで来た場合の fallback です。
      if (isUniqueViolation(error)) {
        // 同一 requestId の競合として、HTTP 409 Conflict に変換します。
        throw new ConflictException('requestId already exists');
      }

      // 既知の unique violation 以外は、元の例外として NestJS に渡します。
      throw error;
    }
  }
}

// isUniqueViolation は PostgreSQL の unique violation かつ対象 constraint かを見分けます。
function isUniqueViolation(error: unknown): boolean {
  // PurchasesService は通常 requestId 競合を idempotent response に変換します。
  // ここは万一 pg error が controller まで届いたときの保険です。
  return (
    // unknown のまま property に触ると危険なので、まず object であることを確認します。
    typeof error === 'object' &&
    // null も typeof は object なので、null は除外します。
    error !== null &&
    // PostgreSQL の unique violation は code = 23505 で表されます。
    'code' in error &&
    error.code === '23505' &&
    // constraint 名まで見て、この API が想定している requestId の制約だけを扱います。
    'constraint' in error &&
    (error.constraint === 'purchases_request_id_uq' ||
      // rejected 用の unique constraint も同じ requestId 競合として扱います。
      error.constraint === 'purchases_rejected_request_id_uq')
  );
}
