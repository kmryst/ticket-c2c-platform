// ファイル概要:
// このファイルは Valkey を使った購入前段フィルタの service です。
// 在庫カウンタを Valkey に持ち、売り切れ後のリクエストを PostgreSQL に到達させずに拒否します。
// Valkey は正本ではないため、未設定・障害・カウンタ不在時は 'unknown' を返して DB 判定へ流します（fail-open）。

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { getOptionalEnv } from '../config';

// ReserveOutcome は前段フィルタの判定結果です。
// - reserved: カウンタを減算できた（DB 確定に進む。DB で失敗したら補償する）
// - sold_out: カウンタ上は売り切れ（DB に到達させず即時拒否する）
// - unknown: Valkey 無効・カウンタ不在・エラー（判定を DB に委ねる）
export type ReserveOutcome = 'reserved' | 'sold_out' | 'unknown';

// reserve は「存在確認 → 在庫比較 → 減算」を Valkey 上で原子的に行う Lua script です。
// GET と DECRBY を分けると同時リクエストで過剰減算が起きるため 1 script にまとめます。
const RESERVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false then
  return 'unknown'
end
if tonumber(current) < tonumber(ARGV[1]) then
  return 'sold_out'
end
redis.call('DECRBY', KEYS[1], ARGV[1])
return 'reserved'
`;

@Injectable()
export class InventoryCacheService implements OnModuleDestroy {
  // client は VALKEY_URL が設定されている場合のみ作られます。null は無効化状態です。
  private readonly client: Redis | null;

  constructor() {
    const url = getOptionalEnv('VALKEY_URL');
    this.client = url
      ? new Redis(url, {
          // 障害時に購入 API 全体を巻き込まないよう、接続リトライは短く抑えます。
          maxRetriesPerRequest: 1,
          connectTimeout: 3000,
          // 起動時に Valkey が落ちていても API 自体は起動できるよう lazy 接続にします。
          lazyConnect: false,
        })
      : null;

    if (this.client) {
      this.client.on('error', (error) => {
        // 接続断は fail-open で DB 判定に流れるため、ログだけ残して処理は継続します。
        console.error('Valkey error:', error.message);
      });
    }
  }

  // isEnabled は検証ログ用に前段フィルタが有効かを返します。
  isEnabled(): boolean {
    return this.client !== null;
  }

  // initCounter はイベント作成時に在庫カウンタを初期化します。
  async initCounter(eventId: string, quantity: number): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      await this.client.set(this.key(eventId), String(quantity));
    } catch (error) {
      console.error('Valkey initCounter failed:', error);
    }
  }

  // reserve は購入前の前段フィルタ本体です。
  async reserve(eventId: string, quantity: number): Promise<ReserveOutcome> {
    if (!this.client) {
      return 'unknown';
    }
    try {
      const outcome = await this.client.eval(
        RESERVE_SCRIPT,
        1,
        this.key(eventId),
        String(quantity),
      );
      return outcome as ReserveOutcome;
    } catch (error) {
      // Valkey 障害で購入を止めない。正確性は PostgreSQL の条件付き更新が保証します。
      console.error('Valkey reserve failed:', error);
      return 'unknown';
    }
  }

  // release は reserve 後に DB 確定へ進めなかった場合の補償（カウンタを戻す）です。
  async release(eventId: string, quantity: number): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      await this.client.incrby(this.key(eventId), quantity);
    } catch (error) {
      console.error('Valkey release failed:', error);
    }
  }

  // syncCounter は DB の残在庫を正としてカウンタを上書きします。
  // reserve が unknown のまま confirmed した場合や、カウンタと DB がずれた場合の補正に使います。
  async syncCounter(eventId: string, remaining: number): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      await this.client.set(this.key(eventId), String(remaining));
    } catch (error) {
      console.error('Valkey syncCounter failed:', error);
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      // quit はサーバー応答を待つため、落ちている場合に備えて disconnect で確実に閉じます。
      this.client.disconnect();
    }
  }

  private key(eventId: string): string {
    return `inventory:${eventId}`;
  }
}
