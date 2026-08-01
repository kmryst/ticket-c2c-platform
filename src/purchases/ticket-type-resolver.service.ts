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
// cache invalidation 境界（#379 が複数 Type 作成を公開するときに必要）:
// - 単一 Type の Event に 2 件目の Type を追加する（#379）
// - writer mode を legacy <-> ticket_type へ切り替える（#378 の activation / rollback）
// これらは cache TTL の範囲で最終的に反映されます。即時反映が必要な #378 / #379 は
// TTL 経過を待つか、EventsService のように prime() で明示更新します。詳細は
// docs/poc/inventory-purchase-poc.md「Ticket Type 単位 Valkey 前段フィルタ」節を正本とします。

import { Injectable, Optional } from '@nestjs/common';
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
      scope:
        | { kind: 'single'; ticketTypeId: string }
        | { kind: 'multi' };
    };

interface CacheEntry {
  plan: PrefilterPlan;
  expiresAt: number;
}

// DEFAULT_TTL_MS は cache エントリの寿命です。writer mode 切替と Type 追加は
// この TTL の範囲で反映されます。sold-out flood 時に DB 到達を抑えつつ、
// activation / rollback の反映遅延を短く保つ妥協点として短めにします。
const DEFAULT_TTL_MS = 5_000;

@Injectable()
export class TicketTypeResolverService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(
    @Optional() private readonly database?: DatabaseService,
  ) {
    const configured = Number(process.env.TICKET_TYPE_PREFILTER_CACHE_TTL_MS);
    this.ttlMs =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_TTL_MS;
  }

  // resolvePrefilterPlan は event の前段フィルタ plan を返します。
  // cache hit では DB へ到達せず、cache miss のときだけ 1 接続で解決して cache します。
  async resolvePrefilterPlan(eventId: string): Promise<PrefilterPlan> {
    const cached = this.cache.get(eventId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.plan;
    }

    const plan = await this.loadPlanFromDatabase(eventId);
    this.store(eventId, plan);
    return plan;
  }

  // prime は解決済み plan を明示的に cache へ入れます。
  // ticket_type mode の EventsService が、作成直後の Event→default Type mapping を
  // 反映するために使います（初回購入の cache miss を避ける）。
  prime(eventId: string, plan: PrefilterPlan): void {
    this.store(eventId, plan);
  }

  // invalidate は event の cache を破棄します。#378 / #379 が構成変更を即時反映したい
  // 場合の明示 API です（本 Issue の範囲では TTL 失効が主経路）。
  invalidate(eventId: string): void {
    this.cache.delete(eventId);
  }

  private store(eventId: string, plan: PrefilterPlan): void {
    this.cache.set(eventId, { plan, expiresAt: Date.now() + this.ttlMs });
  }

  private async loadPlanFromDatabase(eventId: string): Promise<PrefilterPlan> {
    if (!this.database) {
      // DB が無い構成（想定外）では安全側に legacy 扱いにする。
      return { writerMode: 'legacy' };
    }
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
