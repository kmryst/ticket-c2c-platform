// ファイル概要:
// このファイルは Valkey を使った購入前段フィルタの service です。
// 在庫カウンタを Valkey に持ち、売り切れ後のリクエストを PostgreSQL に到達させずに拒否します。
// Valkey は正本ではないため、未設定・障害・カウンタ不在時は 'unknown' を返して DB 判定へ流します（fail-open）。
//
// カウンタの整合性設計（production-readiness M-2）:
// - カウンタを変更する操作（init / reserve / release / sync）はすべて Lua script で行い、
//   カウンタと並んで置く version キーを変更のたびに INCR します。
// - syncCounter は「DB 残在庫を読む前に控えた version」を呼び出し元から受け取り、
//   version が変わっていない場合だけ SET する CAS（compare-and-set）にします。
//   これにより、並行する reserve の DECRBY / release の INCRBY を古い DB 値で上書きしません。
// - release はカウンタ不在時に何もしません（素の INCRBY はキーを 0 から捏造してしまうため）。

import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { getOptionalEnv } from '../config';

// ReserveOutcome は前段フィルタの判定結果です。
// - reserved: カウンタを減算できた（DB 確定に進む。DB で失敗したら補償する）
// - sold_out: カウンタ上は売り切れ（DB に到達させず即時拒否する）
// - unknown: Valkey 無効・カウンタ不在・エラー（判定を DB に委ねる）
export type ReserveOutcome = 'reserved' | 'sold_out' | 'unknown';

// REQUEST_SEEN_TTL_SECONDS は「DB へ確定済みの requestId」マーカーの保持期間です。
// 売り切れ後の再送をどこまで idempotent replay として救済するかの窓で、
// クライアントの現実的なリトライ間隔（秒〜分）に対して十分長い 24 時間とします。
const REQUEST_SEEN_TTL_SECONDS = 24 * 60 * 60;

// INIT_SCRIPT はイベント作成時のカウンタ初期化です。
// KEYS[1]=カウンタ、KEYS[2]=version。version を進めることで、
// 初期化をまたいだ古い syncCounter の CAS を失敗させます。
const INIT_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[2])
return 'initialized'
`;

// RESERVE_SCRIPT は「存在確認 → 在庫比較 → 減算」を Valkey 上で原子的に行う Lua script です。
// GET と DECRBY を分けると同時リクエストで過剰減算が起きるため 1 script にまとめます。
// 減算した場合のみ version を進めます（カウンタを変更しない sold_out / unknown は進めない）。
const RESERVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false then
  return 'unknown'
end
if tonumber(current) < tonumber(ARGV[1]) then
  return 'sold_out'
end
redis.call('DECRBY', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[2])
return 'reserved'
`;

// RELEASE_SCRIPT は reserve の補償（カウンタを戻す）です。
// カウンタ不在時は何もしません。素の INCRBY だとキーを 0 起点で新規作成してしまい、
// 「実在庫と無関係な小さいカウンタ」が捏造されて誤拒否の温床になるためです。
const RELEASE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'skipped'
end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[2])
return 'released'
`;

// SYNC_SCRIPT は DB 残在庫によるカウンタ上書きの CAS 版です。
// ARGV[2]（呼び出し元が DB 判定前に控えた version）と現在の version が一致する場合だけ SET します。
// version が進んでいれば、その間に reserve / release がカウンタを変更しているので上書きを見送ります。
const SYNC_SCRIPT = `
local version = redis.call('GET', KEYS[2])
if version == false then
  version = '0'
end
if version ~= ARGV[2] then
  return 'skipped'
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[2])
return 'synced'
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
      await this.client.eval(
        INIT_SCRIPT,
        2,
        this.key(eventId),
        this.versionKey(eventId),
        String(quantity),
      );
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
        2,
        this.key(eventId),
        this.versionKey(eventId),
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
  // カウンタが存在しない場合（Valkey 再起動後など）は何もしません。
  async release(eventId: string, quantity: number): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      await this.client.eval(
        RELEASE_SCRIPT,
        2,
        this.key(eventId),
        this.versionKey(eventId),
        String(quantity),
      );
    } catch (error) {
      console.error('Valkey release failed:', error);
    }
  }

  // getCounterVersion は syncCounter の CAS ガードに使う現在の version を返します。
  // 呼び出し元は「DB の残在庫を読む前」に version を控え、syncCounter へ渡します。
  // null は Valkey 無効・エラーを表し、その場合 syncCounter は行えません（fail-open）。
  async getCounterVersion(eventId: string): Promise<string | null> {
    if (!this.client) {
      return null;
    }
    try {
      // version キー未作成は「まだ一度も変更されていない」ことを表す '0' として扱います。
      return (await this.client.get(this.versionKey(eventId))) ?? '0';
    } catch (error) {
      console.error('Valkey getCounterVersion failed:', error);
      return null;
    }
  }

  // syncCounter は DB の残在庫を正としてカウンタを補正します。
  // expectedVersion（DB 判定前に控えた version）から変化がない場合だけ上書きし、
  // 並行する reserve / release の効果を古い DB 値で消さないようにします（M-2）。
  // 戻り値は上書きできたかどうかで、false の場合の追加補償は呼び出し元が判断します。
  async syncCounter(
    eventId: string,
    remaining: number,
    expectedVersion: string,
  ): Promise<boolean> {
    if (!this.client) {
      return false;
    }
    try {
      const outcome = await this.client.eval(
        SYNC_SCRIPT,
        2,
        this.key(eventId),
        this.versionKey(eventId),
        String(remaining),
        expectedVersion,
      );
      return outcome === 'synced';
    } catch (error) {
      console.error('Valkey syncCounter failed:', error);
      return false;
    }
  }

  // markRequestSeen は DB へ確定（confirmed / rejected の row 作成）済みの requestId を記録します。
  // 売り切れ後の再送が来たとき、この記録の有無で「idempotent replay」と
  // 「売り切れ後の新規リクエスト」を Valkey 層で見分けます（production-readiness M-1）。
  async markRequestSeen(
    buyerId: string,
    eventId: string,
    requestId: string,
  ): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      await this.client.set(
        this.requestKey(buyerId, eventId, requestId),
        '1',
        'EX',
        REQUEST_SEEN_TTL_SECONDS,
      );
    } catch (error) {
      // マーカーを書けなくても購入結果は DB に確定済みです。
      // その場合、売り切れ後の再送が前段拒否される可能性がありますが、fail-open 設計の許容範囲とします。
      console.error('Valkey markRequestSeen failed:', error);
    }
  }

  // wasRequestSeen は requestId が確定済みマーカーとして記録されているかを返します。
  // エラー時は true（DB 判定へ流す）を返し、idempotent replay を誤って拒否しない側へ倒します。
  async wasRequestSeen(
    buyerId: string,
    eventId: string,
    requestId: string,
  ): Promise<boolean> {
    if (!this.client) {
      return true;
    }
    try {
      const exists = await this.client.exists(
        this.requestKey(buyerId, eventId, requestId),
      );
      return exists === 1;
    } catch (error) {
      console.error('Valkey wasRequestSeen failed:', error);
      return true;
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

  // versionKey はカウンタ変更回数を数える version キーです。syncCounter の CAS ガードに使います。
  private versionKey(eventId: string): string {
    return `inventory:${eventId}:v`;
  }

  // requestKey は確定済み requestId マーカーのキーです。
  // requestId は buyer + event の scope で idempotency key になる（DB の unique 制約と同じ scope）ため、
  // キーにも同じ 3 つ組を使います。
  private requestKey(
    buyerId: string,
    eventId: string,
    requestId: string,
  ): string {
    return `purchase-request:${buyerId}:${eventId}:${requestId}`;
  }
}
