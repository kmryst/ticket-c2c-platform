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
// キー生成規則は inventory-cache.keys.ts が正本です（Issue #378 で抽出）。
// Gate B cutover checker と同じ規則を共有し、キー文字列の重複定義を防ぎます。
import {
  eventCounterKey,
  eventCounterVersionKey,
  purchaseRequestSeenKey,
  ticketTypeCounterKey,
  ticketTypeCounterRevisionKey,
} from './inventory-cache.keys';
// init / ticket-type sync の Lua script は inventory-cache.scripts.ts が正本です
// （Issue #378 で seed / reconcile CLI と共有するため抽出。script 文字列は不変）。
// reserve / release / legacy sync は購入 API 専用のためこのファイルに残しています。
import {
  INIT_SCRIPT,
  TICKET_TYPE_INIT_SCRIPT,
  TICKET_TYPE_SYNC_SCRIPT,
} from './inventory-cache.scripts';
// emitMetric は Valkey fail-open（障害時に判定を DB へ流した事象）の発生量を記録します（ADR-0014）。
import { emitMetric } from '../observability/emf';

// ReserveOutcome は前段フィルタの判定結果です。
// - reserved: カウンタを減算できた（DB 確定に進む。DB で失敗したら補償する）
// - sold_out: カウンタ上は売り切れ（DB に到達させず即時拒否する）
// - unknown: Valkey 無効・カウンタ不在・エラー（判定を DB に委ねる）
export type ReserveOutcome = 'reserved' | 'sold_out' | 'unknown';

// TicketTypeReserveResult は Ticket Type 単位 reserve の結果です（Issue #389）。
// reserve と CAS revision の取得を 1 つの Lua script で原子的に行うため、
// outcome と revision を一緒に返します。reserve 後に別の getCounterVersion を
// 呼ぶ設計だと、その隙間に別 request の reserve / release が割り込んで
// 古い revision で sync してしまうためです。
// - outcome: reserved / sold_out / unknown（Event 単位 reserve と同義）
// - revision: reserved 時に減算後の CAS revision（sync に使う）。
//   sold_out / unknown / Valkey 障害では null（sync できないことを表す）。
//
// この revision は Valkey 内でカウンタ変更回数を数える CAS 用の値であり、
// #376 が PostgreSQL transaction から返す inventory version（在庫行の version 列）
// とは別物です。混同しないよう型と名前を分けています。
export interface TicketTypeReserveResult {
  outcome: ReserveOutcome;
  revision: string | null;
}

// REQUEST_SEEN_TTL_SECONDS は「DB へ確定済みの requestId」マーカーの保持期間です。
// 売り切れ後の再送をどこまで idempotent replay として救済するかの窓で、
// クライアントの現実的なリトライ間隔（秒〜分）に対して十分長い 24 時間とします。
const REQUEST_SEEN_TTL_SECONDS = 24 * 60 * 60;

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

// --- Ticket Type 単位 namespace（Issue #389） ---
//
// Event 単位 key（inventory:<eventId> / inventory:<eventId>:v）は変更・削除しません。
// Ticket Type 用に衝突しない新 namespace を追加します。
// counter と revision は同じ Lua script で扱うため、Redis Cluster でも同じ hash slot に
// 乗るよう同じ hash tag `{<eventId>:<ticketTypeId>}` を使います。
//
// - inventory:ticket-type:{<eventId>:<ticketTypeId>}:remaining
// - inventory:ticket-type:{<eventId>:<ticketTypeId>}:revision

// TICKET_TYPE_RESERVE_SCRIPT は「存在確認 → 在庫比較 → 減算 → revision 更新 →
// race-safe な revision 取得」を 1 script で原子的に行います。
// reserved 時だけ減算後の revision を返します。counter 不在は unknown（fail-open）とし、
// キーを作りません。sold_out は減算しないため revision を返しません。
const TICKET_TYPE_RESERVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current == false then
  return {'unknown'}
end
if tonumber(current) < tonumber(ARGV[1]) then
  return {'sold_out'}
end
redis.call('DECRBY', KEYS[1], ARGV[1])
local revision = redis.call('INCR', KEYS[2])
return {'reserved', tostring(revision)}
`;

// TICKET_TYPE_RELEASE_SCRIPT は reserve の補償です。
// counter 不在時は何もしません（素の INCRBY だとキーを 0 起点で捏造するため）。
const TICKET_TYPE_RELEASE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'skipped'
end
redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('INCR', KEYS[2])
return 'released'
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
      // fail-open の発生量をメトリクスに残します（ADR-0014）。前段フィルタが効いていない間は
      // 売り切れ後のトラフィックが Aurora へ素通りするため、増加はアラート対象の兆候です。
      emitMetric('ValkeyFailOpen', 1, 'Count', { Operation: 'reserve' });
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
      emitMetric('ValkeyFailOpen', 1, 'Count', { Operation: 'getCounterVersion' });
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
      emitMetric('ValkeyFailOpen', 1, 'Count', { Operation: 'wasRequestSeen' });
      return true;
    }
  }

  // --- Ticket Type 単位 API（Issue #389） ---

  // initTicketTypeCounter は Ticket Type 単位 counter を明示的に初期化します。
  // 呼び出し元は #378 の seed か、ticket_type mode の EventsService だけです。
  // merge / artifact deploy だけで新 counter を暗黙 activation しないため、
  // reserve / release / sync はこのメソッド以外で counter を作りません。
  async initTicketTypeCounter(
    eventId: string,
    ticketTypeId: string,
    quantity: number,
  ): Promise<void> {
    if (!this.client) {
      return;
    }
    try {
      await this.client.eval(
        TICKET_TYPE_INIT_SCRIPT,
        2,
        this.ticketTypeKey(eventId, ticketTypeId),
        this.ticketTypeRevisionKey(eventId, ticketTypeId),
        String(quantity),
      );
    } catch (error) {
      console.error('Valkey initTicketTypeCounter failed:', error);
      emitMetric('ValkeyFailOpen', 1, 'Count', {
        Operation: 'initTicketTypeCounter',
      });
    }
  }

  // reserveTicketType は Ticket Type 単位の前段フィルタ本体です。
  // reserved 時は減算後の CAS revision を同じ script で取得して返します。
  async reserveTicketType(
    eventId: string,
    ticketTypeId: string,
    quantity: number,
  ): Promise<TicketTypeReserveResult> {
    if (!this.client) {
      return { outcome: 'unknown', revision: null };
    }
    try {
      const raw = (await this.client.eval(
        TICKET_TYPE_RESERVE_SCRIPT,
        2,
        this.ticketTypeKey(eventId, ticketTypeId),
        this.ticketTypeRevisionKey(eventId, ticketTypeId),
        String(quantity),
      )) as [string, string?];
      const outcome = raw[0] as ReserveOutcome;
      return {
        outcome,
        revision: outcome === 'reserved' ? (raw[1] ?? null) : null,
      };
    } catch (error) {
      // Valkey 障害で購入を止めない。正確性は PostgreSQL の条件付き更新が保証します。
      console.error('Valkey reserveTicketType failed:', error);
      emitMetric('ValkeyFailOpen', 1, 'Count', {
        Operation: 'reserveTicketType',
      });
      return { outcome: 'unknown', revision: null };
    }
  }

  // releaseTicketType は reserve 後に DB 確定へ進めなかった場合の補償です。
  // counter 不在時は何もしません（未 seed の Type を捏造しない）。
  // 戻り値は補償が失敗しなかったか（true = released / skipped、false = Valkey error）。
  // Valkey 無効（前段フィルタ自体を使っていない）も補償対象がないため true を返します。
  // 呼び出し元は false のとき compensation failure を観測します。
  async releaseTicketType(
    eventId: string,
    ticketTypeId: string,
    quantity: number,
  ): Promise<boolean> {
    if (!this.client) {
      return true;
    }
    try {
      await this.client.eval(
        TICKET_TYPE_RELEASE_SCRIPT,
        2,
        this.ticketTypeKey(eventId, ticketTypeId),
        this.ticketTypeRevisionKey(eventId, ticketTypeId),
        String(quantity),
      );
      return true;
    } catch (error) {
      console.error('Valkey releaseTicketType failed:', error);
      emitMetric('ValkeyFailOpen', 1, 'Count', {
        Operation: 'releaseTicketType',
      });
      return false;
    }
  }

  // getTicketTypeCounterRevision は CAS sync のガードに使う現在の revision を返します。
  // reserve を伴わない fail-open confirmed の drift 補正で使います（reserve 済みの
  // 場合は reserveTicketType が返す revision を使い、別途この呼び出しはしません）。
  // null は Valkey 無効・エラーを表し、その場合 sync は行えません（fail-open）。
  async getTicketTypeCounterRevision(
    eventId: string,
    ticketTypeId: string,
  ): Promise<string | null> {
    if (!this.client) {
      return null;
    }
    try {
      return (
        (await this.client.get(
          this.ticketTypeRevisionKey(eventId, ticketTypeId),
        )) ?? '0'
      );
    } catch (error) {
      console.error('Valkey getTicketTypeCounterRevision failed:', error);
      emitMetric('ValkeyFailOpen', 1, 'Count', {
        Operation: 'getTicketTypeCounterRevision',
      });
      return null;
    }
  }

  // syncTicketTypeCounter は DB の Ticket Type 残数を正として counter を CAS 補正します。
  // counter 不在時はキーを作らず false を返します。expectedRevision から変化がない
  // 場合だけ上書きし、並行する reserve / release の効果を古い DB 値で消しません。
  async syncTicketTypeCounter(
    eventId: string,
    ticketTypeId: string,
    remaining: number,
    expectedRevision: string,
  ): Promise<boolean> {
    if (!this.client) {
      return false;
    }
    try {
      const outcome = await this.client.eval(
        TICKET_TYPE_SYNC_SCRIPT,
        2,
        this.ticketTypeKey(eventId, ticketTypeId),
        this.ticketTypeRevisionKey(eventId, ticketTypeId),
        String(remaining),
        expectedRevision,
      );
      return outcome === 'synced';
    } catch (error) {
      console.error('Valkey syncTicketTypeCounter failed:', error);
      emitMetric('ValkeyFailOpen', 1, 'Count', {
        Operation: 'syncTicketTypeCounter',
      });
      return false;
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      // quit はサーバー応答を待つため、落ちている場合に備えて disconnect で確実に閉じます。
      this.client.disconnect();
    }
  }

  private key(eventId: string): string {
    return eventCounterKey(eventId);
  }

  // ticketTypeKey / ticketTypeRevisionKey は Ticket Type 単位 namespace のキーです。
  // hash tag `{<eventId>:<ticketTypeId>}` を共有し、counter と revision を
  // Redis Cluster でも同じ hash slot に置きます（同一 Lua script で両方に触れるため）。
  private ticketTypeKey(eventId: string, ticketTypeId: string): string {
    return ticketTypeCounterKey(eventId, ticketTypeId);
  }

  private ticketTypeRevisionKey(eventId: string, ticketTypeId: string): string {
    return ticketTypeCounterRevisionKey(eventId, ticketTypeId);
  }

  // versionKey はカウンタ変更回数を数える version キーです。syncCounter の CAS ガードに使います。
  private versionKey(eventId: string): string {
    return eventCounterVersionKey(eventId);
  }

  // requestKey は確定済み requestId マーカーのキーです。
  // requestId は buyer + event の scope で idempotency key になる（DB の unique 制約と同じ scope）ため、
  // キーにも同じ 3 つ組を使います。
  private requestKey(
    buyerId: string,
    eventId: string,
    requestId: string,
  ): string {
    return purchaseRequestSeenKey(buyerId, eventId, requestId);
  }
}
