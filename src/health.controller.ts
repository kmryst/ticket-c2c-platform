// ファイル概要:
// このファイルは API の health check endpoint 群を定義する controller です。
// - GET /health: 既存 PoC script 用の互換 endpoint（プロセス応答のみ）
// - GET /healthz: liveness。依存に触れず、ALB target group の health check に使います。
// - GET /readyz: readiness。DB へ SELECT 1 を投げ、依存込みで応答可能かを返します。
// ALB の health check には /healthz を使います。/readyz を使うと定期 ping が
// Aurora Serverless v2 の auto-pause を妨げるためです（dev-environment.md）。

import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from './database/database.service';

@Controller()
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  // 既存 PoC script が見る互換 endpoint です。
  @Get('health')
  getHealth() {
    return { status: 'ok' };
  }

  // liveness: プロセスが HTTP 応答できることだけを返します。
  @Get('healthz')
  getLiveness() {
    return { status: 'ok' };
  }

  // readiness: DB 接続込みで応答できるかを返します。
  @Get('readyz')
  async getReadiness() {
    try {
      const client = await this.database.connect();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
      return { status: 'ok', database: 'ok' };
    } catch {
      // 依存が落ちている場合は 503 を返し、呼び出し側にトラフィックを止めさせます。
      throw new ServiceUnavailableException('database is not reachable');
    }
  }
}
