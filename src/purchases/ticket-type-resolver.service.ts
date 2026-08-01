// ファイル概要:
// このファイルは購入前段フィルタの Ticket Type 解決 service です（Issue #389）。
//
// sold-out prefilter より前に、対象 Event の在庫 writer mode と Ticket Type scope を
// 決めます。writer mode（inventory_writer_control）は #378 が所有する DB 上の切替
// スイッチであり、Valkey 単独の activation switch は追加しません。前段フィルタが
// 使う namespace（Event 単位 / Ticket Type 単位）は、この DB mode に追従します。
//
// 解決結果は event 単位に in-process cache します。cache hit では PostgreSQL へ
// 到達しないため、通常の sold-out request は解決目的の DB クエリを発生させません。
// cache miss のときだけ、writer mode と Event の Ticket Type 一覧を 1 接続でまとめて
// 読み、TTL 付きで cache します。
//
// resolver が writer mode を解決できない場合は例外を投げます。呼び出し元
// （PurchasesService）は legacy を推測せず、Event / Ticket Type どちらの counter も
// 使わない DB-only bypass で authoritative transaction へ fail-open します。
//
// cache invalidation 境界（#379 が複数 Type 作成を公開するときに必要）:
// - 単一 Type の Event に 2 件目の Type を追加する（#379）
// - writer mode を legacy <-> ticket_type へ切り替える（#378 の activation / rollback）
// これらは cache TTL の範囲で最終的に反映されます。即時反映が必要な #378 / #379 は
// TTL 経過を待つか、EventsService のように prime() で明示更新します。詳細は
// docs/poc/inventory-purchase-poc.md「Ticket Type 単位 Valkey 前段フィルタ」節を正本とします。

import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { InventoryWriterMode } from '../database/inventory-writer-control';

// PrefilterPlan は前段フィルタの scope 決定結果です。
// - legacy: Event 単位 counter を使う（旧挙動を維持）。
// - ticket_type + single: 単一 Type の Event。その Type の counter を使う。
// - ticket_type + multi: 複数 Type の Event。Type 省略では scope を安全に決められないため
//   Valkey を bypass し、#376 の transaction に判断させる。
export type PrefilterPlan =
  | { writerMode: 'legacy' }
  | {
      writerMode: 'ticket_type';
      scope: { kind: 'single'; ticketTypeId: string } | { kind: 'multi' };
    };

interface CacheEntry {
  plan: PrefilterPlan;
  expiresAt: number;
}

// DEFAULT_TTL_MS は cache エントリの寿命です。writer mode 切替と Type 追加は
// この TTL の範囲で反映されます。sold-out flood 時に DB 到達を抑えつつ、
// activation / rollback の反映遅延を短く保つ妥協点として短めにします。
const DEFAULT_TTL_MS = 5_000;

// DEFAULT_MAX_ENTRIES は cache エントリ数の上限です。TTL に加えて有限上限を設け、
// event 種類が単調増加してもプロセスメモリを保護します。上限超過時は挿入順で最も古い
// エントリを O(1) で追い出します（超過分は次回 cache miss として DB へ劣化します）。
const DEFAULT_MAX_ENTRIES = 10_000;

@Injectable()
export class TicketTypeResolverService {
  // cache は挿入順を LRU 近似として使う（Map は挿入順を保持する）。
  private readonly cache = new Map<string, CacheEntry>();
  // inflight は同一 eventId への並行 cache miss を 1 回の DB load に coalesce する。
  private readonly inflight = new Map<
    string,
    { promise: Promise<PrefilterPlan>; token: number }
  >();
  private loadToken = 0;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(private readonly database: DatabaseService) {
    const configuredTtl = Number(
      process.env.TICKET_TYPE_PREFILTER_CACHE_TTL_MS,
    );
    this.ttlMs =
      Number.isFinite(configuredTtl) && configuredTtl > 0
        ? configuredTtl
        : DEFAULT_TTL_MS;
    const configuredMax = Number(
      process.env.TICKET_TYPE_PREFILTER_CACHE_MAX_ENTRIES,
    );
    this.maxEntries =
      Number.isInteger(configuredMax) && configuredMax > 0
        ? configuredMax
        : DEFAULT_MAX_ENTRIES;
  }

  // resolvePrefilterPlan は event の前段フィルタ plan を返します。
  // cache hit では DB へ到達せず、cache miss のときだけ 1 接続で解決して cache します。
  // 同一 eventId への並行 cache miss は 1 回の DB load へ coalesce します（singleflight）。
  async resolvePrefilterPlan(eventId: string): Promise<PrefilterPlan> {
    const fresh = this.getFresh(eventId);
    if (fresh !== undefined) {
      return fresh;
    }

    // 進行中の同一 eventId load があれば相乗りする（DB connect / query を 1 回にする）。
    const existing = this.inflight.get(eventId);
    if (existing) {
      return existing.promise;
    }

    const token = ++this.loadToken;
    const load = (async () => {
      const plan = await this.loadPlanFromDatabase(eventId);
      // load 中に prime() / invalidate() が発生した場合、この inflight entry は
      // それらによって削除されている。古い load の結果で cache を上書きしないため、
      // 自分の token が現在の inflight entry として残っているときだけ store する。
      const current = this.inflight.get(eventId);
      if (current && current.token === token) {
        this.storeInternal(eventId, plan);
      }
      return plan;
    })();
    this.inflight.set(eventId, { promise: load, token });

    try {
      return await load;
    } finally {
      // 失敗時も含めて自分の inflight entry を必ず削除し、次回 retry 可能にする。
      // 新しい inflight entry（別 token）は削除しない。
      const current = this.inflight.get(eventId);
      if (current && current.token === token) {
        this.inflight.delete(eventId);
      }
    }
  }

  // prime は解決済み plan を明示的に cache へ入れます。
  // ticket_type mode の EventsService が、作成直後の Event→default Type mapping を
  // 反映するために使います（初回購入の cache miss を避ける）。
  // 進行中の古い load がこの結果を上書きしないよう、inflight entry を破棄します。
  prime(eventId: string, plan: PrefilterPlan): void {
    this.storeInternal(eventId, plan);
    this.inflight.delete(eventId);
  }

  // invalidate は event の cache を破棄します。#378 / #379 が構成変更を即時反映したい
  // 場合の明示 API です（本 Issue の範囲では TTL 失効が主経路）。
  // 進行中の古い load が破棄後に結果を復活させないよう、inflight entry も破棄します。
  invalidate(eventId: string): void {
    this.cache.delete(eventId);
    this.inflight.delete(eventId);
  }

  // getFresh は有効な cache エントリを返します。TTL 失効エントリは確実に削除します。
  private getFresh(eventId: string): PrefilterPlan | undefined {
    const entry = this.cache.get(eventId);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(eventId);
      return undefined;
    }
    // LRU touch: 参照されたエントリを末尾へ移動する（O(1)）。
    this.cache.delete(eventId);
    this.cache.set(eventId, entry);
    return entry.plan;
  }

  private storeInternal(eventId: string, plan: PrefilterPlan): void {
    // 既存キーを消してから set し直し、挿入順（LRU）を末尾へ更新する。
    this.cache.delete(eventId);
    this.cache.set(eventId, { plan, expiresAt: Date.now() + this.ttlMs });
    // 上限超過時は最も古いエントリ（Map 先頭）を追い出す。
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
  }

  private async loadPlanFromDatabase(eventId: string): Promise<PrefilterPlan> {
    const client = await this.database.connect();
    try {
      // writer mode は activation の切替スイッチ（routing hint）としてだけ読む。
      // 在庫更新の正本判定は #376 の transaction が barrier 下で mode を再読するため、
      // ここでは advisory barrier を取らない plain read で十分。
      const result = await client.query<{
        writer_mode: string;
        ticket_type_id: string | null;
      }>(
        `
          SELECT control.writer_mode, types.id AS ticket_type_id
          FROM inventory_writer_control control
          LEFT JOIN LATERAL (
            SELECT id
            FROM ticket_types
            WHERE event_id = $1
            ORDER BY id
            LIMIT 2
          ) types ON true
          WHERE control.singleton
        `,
        [eventId],
      );

      const writerMode = result.rows[0]?.writer_mode as
        | InventoryWriterMode
        | undefined;
      if (writerMode !== 'legacy' && writerMode !== 'ticket_type') {
        throw new Error('inventory writer control state is missing or invalid');
      }
      if (writerMode === 'legacy') {
        return { writerMode: 'legacy' };
      }

      const ticketTypeIds = result.rows
        .map((row) => row.ticket_type_id)
        .filter((id): id is string => id !== null);
      if (ticketTypeIds.length === 1) {
        return {
          writerMode: 'ticket_type',
          scope: { kind: 'single', ticketTypeId: ticketTypeIds[0] },
        };
      }
      // 0 件（構成不備）と 2 件以上（複数 Type）は、Type 省略では scope を安全に
      // 決められないため multi 扱いにして Valkey を bypass する。
      return { writerMode: 'ticket_type', scope: { kind: 'multi' } };
    } finally {
      client.release();
    }
  }
}
