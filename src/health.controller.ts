// ファイル概要:
// このファイルは API の簡易 health check endpoint を定義する controller です。
// PoC script が購入リクエストを送る前に GET /health を叩き、
// NestJS API プロセスが HTTP 応答できる状態かを確認するために使います。

// Controller はクラスを HTTP controller として NestJS に登録する decorator です。
import { Controller, Get } from '@nestjs/common';

// HealthController は API が起動しているかを確認するためだけの小さな controller です。
// PoC script は購入リクエストを投げる前に、この endpoint で API の準備状態を見ます。
@Controller('health')
export class HealthController {
  // @Get() は GET /health に対応する handler であることを表します。
  @Get()
  // getHealth は DB を見ず、API プロセスが HTTP 応答できることだけを返します。
  getHealth() {
    // status: ok は PoC script 側の「API が起動済み」という合図です。
    return { status: 'ok' };
  }
}
