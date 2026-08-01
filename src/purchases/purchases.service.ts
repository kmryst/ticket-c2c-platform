// 購入判定の PostgreSQL authoritative writer。
// Issue #376 では shared barrier と DB control state に従い、legacy / Ticket Type の
// active inventory だけを更新する。公開 Ticket Type contract は #379 まで追加しない。

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  acquirePurchaseRequestLock,
  acquireSharedInventoryWriterBarrier,
  InventoryWriterMode,
  readInventoryWriterMode,
} from '../database/inventory-writer-control';
import {
  InventoryCacheService,
  TicketTypeReserveResult,
} from '../cache/inventory-cache.service';
import { DomainEventsService } from '../messaging/domain-events.service';
import { emitMetric } from '../observability/emf';
import { traceLogFields } from '../observability/trace-context';
import {
  PrefilterPlan,
  TicketTypeResolverService,
} from './ticket-type-resolver.service';
import {
  ParsedPurchaseInput,
  PurchaseRequestBody,
  PurchaseResult,
} from './purchase.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSTGRES_INT4_MAX = 2_147_483_647;

interface PurchaseTicketTypeSelection {
  // #379 が controller から渡すまでは、integration test と内部呼出しだけが使う。
  ticketTypeId?: unknown;
}

interface EventRow {
  id: string;
}

interface TicketTypeRow {
  id: string;
}

interface InventoryRow {
  remaining_quantity: number;
  version: number;
}

interface CompatibilityInventoryRow {
  remaining_quantity: number;
}

interface ExistingPurchaseRow {
  purchase_id: string;
  event_id: string;
  buyer_id: string;
  ticket_type_id: string;
  quantity: number;
  status: 'confirmed' | 'rejected';
  rejection_reason: string | null;
  remaining_quantity_after: number | null;
}

interface PurchaseRow {
  id: string;
}

interface PurchaseInventoryChange {
  ticketTypeId: string;
  remainingQuantity: number;
  inventoryVersion: number;
}

interface PurchaseTransactionOutcome {
  result: PurchaseResult;
  disposition: 'created' | 'replayed';
  // #377 producer が利用できる transaction 由来の内部interface。HTTPへはまだ返さない。
  inventoryChange: PurchaseInventoryChange | null;
  // Event 単位 Valkey counter（legacy path）を補正するための互換aggregate。
  compatibilityRemainingQuantity: number | null;
  // #389: Ticket Type 単位 Valkey counter の補償に使う transaction 解決結果。
  // resolvedTicketTypeId は transaction が確定した Type。prefilter で reserve した Type と
  // 異なる場合は cross-Type sync を避ける。ticketTypeRemainingQuantity は ticket_type mode
  // での実際の Type 残数（legacy mode や replay では null）。
  resolvedTicketTypeId: string | null;
  ticketTypeRemainingQuantity: number | null;
}

type QueryClient = {
  query: typeof import('pg').Client.prototype.query;
};

@Injectable()
export class PurchasesService {
  private readonly resolver: TicketTypeResolverService;

  constructor(
    private readonly database: DatabaseService,
    private readonly inventoryCache: InventoryCacheService,
    private readonly domainEvents: DomainEventsService,
    // resolver は DI で共有 singleton を注入する。未注入（一部の単体テスト）では
    // database から fallback で生成する。
    @Optional() resolver?: TicketTypeResolverService,
  ) {
    this.resolver = resolver ?? new TicketTypeResolverService(database);
  }

  async createPurchase(
    eventId: string,
    buyerId: string,
    body: unknown,
    // HTTP controller はこの引数を渡さない。#379 の公開contractまで既存API形状を維持する。
    selection: PurchaseTicketTypeSelection = {},
  ): Promise<PurchaseResult> {
    const input = parsePurchaseInput(eventId, buyerId, body, selection);

    // sold-out prefilter より前に、writer mode と Ticket Type scope を解決する。
    // cache hit では DB へ到達しないため、通常の sold-out request は解決目的の
    // DB クエリを発生させない（#389 受け入れ条件）。
    const plan = await this.resolver.resolvePrefilterPlan(input.eventId);
    if (plan.writerMode === 'ticket_type') {
      return this.createPurchaseTicketType(input, plan);
    }
    return this.createPurchaseLegacy(input);
  }

  // createPurchaseLegacy は Event 単位 counter を使う従来経路です（writer mode = legacy）。
  // #389 は旧 Event 単位 key の意味を変えないため、この経路は据え置きます。
  private async createPurchaseLegacy(
    input: ParsedPurchaseInput,
  ): Promise<PurchaseResult> {
    const reserveOutcome = await this.inventoryCache.reserve(
      input.eventId,
      input.quantity,
    );

    // requestId付きはValkey markerに依存せずDBへ進める。同じkeyのpayload衝突と
    // confirmed / rejected replayはPostgreSQLの一意制約とtransactionが正本になる。
    if (reserveOutcome === 'sold_out' && !input.requestId) {
      emitMetric('PurchaseRejected', 1, 'Count', {
        Reason: 'sold_out_precheck',
      });
      return {
        purchaseId: null,
        eventId: input.eventId,
        buyerId: input.buyerId,
        quantity: input.quantity,
        status: 'rejected',
        rejectionReason: 'sold_out_precheck',
        remainingQuantity: null,
      };
    }

    const gate: 'reserved' | 'unknown' =
      reserveOutcome === 'reserved' ? 'reserved' : 'unknown';
    const counterVersion = await this.inventoryCache.getCounterVersion(
      input.eventId,
    );

    let outcome: PurchaseTransactionOutcome;
    try {
      outcome = await this.executePurchaseTransaction(input);
    } catch (error) {
      // transaction が確定していない場合だけ reserve を補償する。
      if (gate === 'reserved') {
        await this.inventoryCache.release(input.eventId, input.quantity);
      }
      throw error;
    }

    const { result } = outcome;

    if (result.status === 'confirmed') {
      emitMetric('PurchaseConfirmed', 1, 'Count');
    } else {
      emitMetric('PurchaseRejected', 1, 'Count', {
        Reason: result.rejectionReason ?? 'unknown',
      });
    }

    // DB-backed result の marker は replay 時にも更新し、sold-out 後の再送窓を延長する。
    if (input.requestId && result.purchaseId !== null) {
      await this.inventoryCache.markRequestSeen(
        input.buyerId,
        input.eventId,
        input.requestId,
      );
    }

    if (outcome.disposition === 'replayed') {
      if (gate === 'reserved') {
        await this.inventoryCache.release(input.eventId, input.quantity);
      }
    } else if (
      result.status === 'confirmed' &&
      gate === 'unknown' &&
      counterVersion !== null &&
      outcome.compatibilityRemainingQuantity !== null
    ) {
      await this.inventoryCache.syncCounter(
        input.eventId,
        outcome.compatibilityRemainingQuantity,
        counterVersion,
      );
    } else if (
      result.status === 'rejected' &&
      gate === 'reserved' &&
      outcome.compatibilityRemainingQuantity !== null
    ) {
      const synced =
        counterVersion !== null &&
        (await this.inventoryCache.syncCounter(
          input.eventId,
          outcome.compatibilityRemainingQuantity,
          counterVersion,
        ));
      if (!synced) {
        await this.inventoryCache.release(input.eventId, input.quantity);
      }
    }

    // replay は在庫を変えていないので domain event を再発行しない。
    if (result.status === 'confirmed' && outcome.disposition === 'created') {
      await this.domainEvents.publish('TicketPurchased', {
        eventId: result.eventId,
        purchaseId: result.purchaseId,
        quantity: result.quantity,
        remainingQuantity: result.remainingQuantity,
      });
      await this.domainEvents.publish('InventoryChanged', {
        eventId: result.eventId,
        remainingQuantity: result.remainingQuantity,
      });
    }

    return result;
  }

  // createPurchaseTicketType は Ticket Type 単位 counter を使う経路です
  // （writer mode = ticket_type、Issue #389）。reserve / release / sync / revision と
  // PostgreSQL 失敗時の補償を、すべて同じ eventId + ticketTypeId scope で行い、
  // 別 Type の counter を変更しません。
  private async createPurchaseTicketType(
    input: ParsedPurchaseInput,
    plan: Extract<PrefilterPlan, { writerMode: 'ticket_type' }>,
  ): Promise<PurchaseResult> {
    // prefilter scope の Type を解決する。
    // 優先順: 明示 ticketTypeId > 単一/default Type cache > bypass（複数 Type）。
    let prefilterTicketTypeId: string | null;
    if (input.ticketTypeId) {
      prefilterTicketTypeId = input.ticketTypeId;
    } else if (plan.scope.kind === 'single') {
      prefilterTicketTypeId = plan.scope.ticketTypeId;
    } else {
      // 複数 Type かつ Type 省略。scope を安全に決められないため Valkey を bypass し、
      // #376 の transaction に判断させる。
      prefilterTicketTypeId = null;
    }

    const reserve: TicketTypeReserveResult = prefilterTicketTypeId
      ? await this.inventoryCache.reserveTicketType(
          input.eventId,
          prefilterTicketTypeId,
          input.quantity,
        )
      : { outcome: 'unknown', revision: null };

    // requestId なしの sold_out は即時前段拒否（DB へ到達させない）。
    if (reserve.outcome === 'sold_out' && !input.requestId) {
      emitMetric('PurchaseRejected', 1, 'Count', {
        Reason: 'sold_out_precheck',
      });
      return {
        purchaseId: null,
        eventId: input.eventId,
        buyerId: input.buyerId,
        quantity: input.quantity,
        status: 'rejected',
        rejectionReason: 'sold_out_precheck',
        remainingQuantity: null,
      };
    }

    // requestId 付きの sold_out は Valkey で即時終了させず PostgreSQL へ進める
    // （同じ payload の replay / 異なる payload の 409 / 在庫回復時の confirmed を
    // DB が authoritative に決める）。DB 到達量を ID 値なしで観測する。
    if (reserve.outcome === 'sold_out' && input.requestId) {
      emitMetric('PurchaseSoldOutToPostgres', 1, 'Count');
    }

    const gate: 'reserved' | 'unknown' =
      reserve.outcome === 'reserved' ? 'reserved' : 'unknown';

    let outcome: PurchaseTransactionOutcome;
    try {
      outcome = await this.executePurchaseTransaction(input);
    } catch (error) {
      // transaction が確定していない場合だけ、reserve した Type と数量を補償する。
      if (gate === 'reserved' && prefilterTicketTypeId) {
        await this.compensateTicketTypeRelease(
          input.eventId,
          prefilterTicketTypeId,
          input.quantity,
        );
      }
      throw error;
    }

    const { result } = outcome;

    if (result.status === 'confirmed') {
      emitMetric('PurchaseConfirmed', 1, 'Count');
    } else {
      emitMetric('PurchaseRejected', 1, 'Count', {
        Reason: result.rejectionReason ?? 'unknown',
      });
      // 新規 rejected row の永続化数（rejected insert rate の観測元）。replay は数えない。
      if (outcome.disposition === 'created') {
        emitMetric('PurchaseRejectedPersisted', 1, 'Count');
      }
    }

    if (input.requestId && result.purchaseId !== null) {
      await this.inventoryCache.markRequestSeen(
        input.buyerId,
        input.eventId,
        input.requestId,
      );
    }

    await this.reconcileTicketTypeCounter({
      input,
      prefilterTicketTypeId,
      gate,
      reservedRevision: reserve.revision,
      outcome,
    });

    // replay は在庫を変えていないので domain event を再発行しない。
    // 公開 response と既存 event payload は Event 互換集計を維持する（#377 / #379 まで）。
    if (result.status === 'confirmed' && outcome.disposition === 'created') {
      await this.domainEvents.publish('TicketPurchased', {
        eventId: result.eventId,
        purchaseId: result.purchaseId,
        quantity: result.quantity,
        remainingQuantity: result.remainingQuantity,
      });
      await this.domainEvents.publish('InventoryChanged', {
        eventId: result.eventId,
        remainingQuantity: result.remainingQuantity,
      });
    }

    return result;
  }

  // reconcileTicketTypeCounter は transaction 後の Ticket Type counter 補償を行います。
  // reserve した Type と transaction が確定した Type が異なる場合は cross-Type sync を避け、
  // 安全側（reserve 分の release + log + metric）に倒します。
  private async reconcileTicketTypeCounter(args: {
    input: ParsedPurchaseInput;
    prefilterTicketTypeId: string | null;
    gate: 'reserved' | 'unknown';
    reservedRevision: string | null;
    outcome: PurchaseTransactionOutcome;
  }): Promise<void> {
    const { input, prefilterTicketTypeId, gate, reservedRevision, outcome } =
      args;
    const { result } = outcome;

    // replay は新規在庫消費が成立していない。reserve した Type と数量だけを戻す。
    if (outcome.disposition === 'replayed') {
      if (gate === 'reserved' && prefilterTicketTypeId) {
        await this.compensateTicketTypeRelease(
          input.eventId,
          prefilterTicketTypeId,
          input.quantity,
        );
      }
      return;
    }

    // prefilter で reserve した Type と transaction が確定した Type が異なる場合、
    // 一方の DB 残数を別 Type の Valkey key へ sync しない。安全側に倒す。
    const scopeMismatch =
      prefilterTicketTypeId !== null &&
      outcome.resolvedTicketTypeId !== null &&
      prefilterTicketTypeId !== outcome.resolvedTicketTypeId;
    if (scopeMismatch) {
      emitMetric('TicketTypeScopeMismatch', 1, 'Count');
      if (gate === 'reserved' && prefilterTicketTypeId) {
        await this.compensateTicketTypeRelease(
          input.eventId,
          prefilterTicketTypeId,
          input.quantity,
        );
      }
      return;
    }

    const typeRemaining = outcome.ticketTypeRemainingQuantity;

    if (result.status === 'confirmed') {
      // gate=reserved は reserve の減算がそのまま在庫消費として成立済み。追加操作不要。
      // gate=unknown（bypass / Valkey 障害 / 未 seed）は reserve していないため、
      // counter が存在する場合だけ DB Type 残数へ CAS 補正する（未 seed の Type は作らない）。
      if (
        gate === 'unknown' &&
        prefilterTicketTypeId &&
        typeRemaining !== null
      ) {
        const revision =
          await this.inventoryCache.getTicketTypeCounterRevision(
            input.eventId,
            prefilterTicketTypeId,
          );
        if (revision !== null) {
          await this.inventoryCache.syncTicketTypeCounter(
            input.eventId,
            prefilterTicketTypeId,
            typeRemaining,
            revision,
          );
        }
      }
      return;
    }

    // rejected は新規在庫消費が成立しなかった。reserve 分を戻す。
    // reserve で得た revision を使って DB Type 残数へ CAS sync できれば release 不要。
    if (gate === 'reserved' && prefilterTicketTypeId && typeRemaining !== null) {
      const synced =
        reservedRevision !== null &&
        (await this.inventoryCache.syncTicketTypeCounter(
          input.eventId,
          prefilterTicketTypeId,
          typeRemaining,
          reservedRevision,
        ));
      if (!synced) {
        await this.compensateTicketTypeRelease(
          input.eventId,
          prefilterTicketTypeId,
          input.quantity,
        );
      }
    }
  }

  // compensateTicketTypeRelease は補償 release を実行し、失敗を観測します。
  private async compensateTicketTypeRelease(
    eventId: string,
    ticketTypeId: string,
    quantity: number,
  ): Promise<void> {
    const ok = await this.inventoryCache.releaseTicketType(
      eventId,
      ticketTypeId,
      quantity,
    );
    if (!ok) {
      emitMetric('CompensationFailure', 1, 'Count', {
        Operation: 'releaseTicketType',
      });
    }
  }

  private async executePurchaseTransaction(
    input: ParsedPurchaseInput,
  ): Promise<PurchaseTransactionOutcome> {
    const client = await this.database.connect();
    let rollbackError: Error | undefined;

    try {
      await client.query('BEGIN');

      // 必須順序: shared barrier -> requestId advisory lock -> first table access。
      await acquireSharedInventoryWriterBarrier(client);
      if (input.requestId) {
        await acquirePurchaseRequestLock(
          client,
          input.buyerId,
          input.eventId,
          input.requestId,
        );
      }

      const writerMode = await readInventoryWriterMode(client);
      const event = await client.query<EventRow>(
        'SELECT id FROM events WHERE id = $1 FOR SHARE',
        [input.eventId],
      );
      if (!event.rowCount) {
        throw new NotFoundException('event not found');
      }

      if (input.requestId) {
        const existing = await findExistingPurchase(client, input);
        if (existing.rowCount) {
          assertIdempotencyReplayPayload(existing.rows[0], input);
          await client.query('COMMIT');
          return replayOutcome(existing.rows[0]);
        }
      }

      // 既存keyのreplayを確定してから新規requestだけTypeを解決する。
      // これにより、省略payloadは後からTypeが増えても保存済み結果を返せる。
      const ticketTypeId = await resolveTicketType(
        client,
        input,
        writerMode,
      );

      const inventoryUpdate = await updateActiveInventory(
        client,
        input,
        ticketTypeId,
        writerMode,
      );
      const confirmed = inventoryUpdate.rowCount === 1;

      let activeInventory: InventoryRow;
      if (confirmed) {
        activeInventory = inventoryUpdate.rows[0];
      } else {
        const current = await readActiveInventory(
          client,
          input.eventId,
          ticketTypeId,
          writerMode,
        );
        if (!current.rowCount) {
          console.error('active ticket inventory not found for existing event', {
            eventId: input.eventId,
            ticketTypeId,
            writerMode,
            ...traceLogFields(),
          });
          throw new InternalServerErrorException(
            'ticket inventory is not configured',
          );
        }
        activeInventory = current.rows[0];
      }

      const rejectionReason = confirmed ? null : 'insufficient_inventory';

      // trigger mirror後のEvent aggregateを同じtransactionから取得する。
      // 旧public APIと既存event contractは#379/#377までEvent単位の残数を維持する。
      const compatibilityInventory =
        await client.query<CompatibilityInventoryRow>(
          `
            SELECT remaining_quantity
            FROM ticket_inventory
            WHERE event_id = $1
          `,
          [input.eventId],
        );
      if (!compatibilityInventory.rowCount) {
        throw new InternalServerErrorException(
          'compatibility ticket inventory is not configured',
        );
      }
      const compatibilityRemainingQuantity =
        compatibilityInventory.rows[0].remaining_quantity;
      const remainingQuantityAfter = confirmed
        ? compatibilityRemainingQuantity
        : null;
      const purchase = await client.query<PurchaseRow>(
        `
          INSERT INTO purchases (
            event_id,
            ticket_type_id,
            buyer_id,
            request_id,
            quantity,
            status,
            rejection_reason,
            remaining_quantity_after
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id
        `,
        [
          input.eventId,
          ticketTypeId,
          input.buyerId,
          input.requestId,
          input.quantity,
          confirmed ? 'confirmed' : 'rejected',
          rejectionReason,
          remainingQuantityAfter,
        ],
      );

      await client.query('COMMIT');

      const result: PurchaseResult = {
        purchaseId: purchase.rows[0].id,
        eventId: input.eventId,
        buyerId: input.buyerId,
        quantity: input.quantity,
        status: confirmed ? 'confirmed' : 'rejected',
        rejectionReason,
        remainingQuantity: remainingQuantityAfter,
      };

      return {
        result,
        disposition: 'created',
        inventoryChange: confirmed
          ? {
              ticketTypeId,
              remainingQuantity: activeInventory.remaining_quantity,
              inventoryVersion: activeInventory.version,
            }
          : null,
        compatibilityRemainingQuantity,
        resolvedTicketTypeId: ticketTypeId,
        // ticket_type mode では activeInventory が実際の Type 残数（confirmed は
        // 更新後、rejected は現在値）。legacy mode では Ticket Type sync を行わないため null。
        ticketTypeRemainingQuantity:
          writerMode === 'ticket_type'
            ? activeInventory.remaining_quantity
            : null,
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackFailure) {
        rollbackError =
          rollbackFailure instanceof Error
            ? rollbackFailure
            : new Error('ROLLBACK failed');
        console.error('ROLLBACK failed:', rollbackError);
      }

      // advisory lock がない旧binaryとのrolling raceは unified unique index が止める。
      // 負けたtransactionをrollback後、既存payloadを再検証してreplayまたは409へ変換する。
      if (
        !rollbackError &&
        input.requestId &&
        isConstraintViolation(error, 'purchases_request_id_uq')
      ) {
        const existing = await findExistingPurchase(client, input);
        if (existing.rowCount) {
          assertIdempotencyReplayPayload(existing.rows[0], input);
          return replayOutcome(existing.rows[0]);
        }
      }

      throw error;
    } finally {
      client.release(rollbackError);
    }
  }
}

async function resolveTicketType(
  client: QueryClient,
  input: ParsedPurchaseInput,
  writerMode: InventoryWriterMode,
): Promise<string> {
  if (writerMode === 'legacy') {
    const types = await client.query<TicketTypeRow>(
      `
        SELECT id
        FROM ticket_types
        WHERE event_id = $1
        ORDER BY id
        LIMIT 2
        FOR SHARE
      `,
      [input.eventId],
    );
    if (!types.rowCount) {
      throw new InternalServerErrorException(
        'ticket type is not configured for event',
      );
    }
    if (types.rowCount !== 1) {
      throw new BadRequestException(
        'legacy inventory mode requires exactly one ticket type',
      );
    }
    if (input.ticketTypeId && input.ticketTypeId !== types.rows[0].id) {
      throw new NotFoundException('ticket type not found for event');
    }
    return types.rows[0].id;
  }

  if (input.ticketTypeId) {
    const selected = await client.query<TicketTypeRow>(
      `
        SELECT id
        FROM ticket_types
        WHERE event_id = $1
          AND id = $2
        FOR SHARE
      `,
      [input.eventId, input.ticketTypeId],
    );
    if (!selected.rowCount) {
      throw new NotFoundException('ticket type not found for event');
    }
    return selected.rows[0].id;
  }

  const types = await client.query<TicketTypeRow>(
    `
      SELECT id
      FROM ticket_types
      WHERE event_id = $1
      ORDER BY id
      LIMIT 2
      FOR SHARE
    `,
    [input.eventId],
  );
  if (!types.rowCount) {
    throw new InternalServerErrorException(
      'ticket type is not configured for event',
    );
  }
  if (types.rowCount !== 1) {
    throw new BadRequestException(
      'ticketTypeId is required when an event has multiple ticket types',
    );
  }
  return types.rows[0].id;
}

function updateActiveInventory(
  client: QueryClient,
  input: ParsedPurchaseInput,
  ticketTypeId: string,
  writerMode: InventoryWriterMode,
) {
  if (writerMode === 'legacy') {
    return client.query<InventoryRow>(
      `
        UPDATE ticket_inventory
        SET remaining_quantity = remaining_quantity - $2,
            version = version + 1,
            updated_at = now()
        WHERE event_id = $1
          AND remaining_quantity >= $2
        RETURNING remaining_quantity, version
      `,
      [input.eventId, input.quantity],
    );
  }

  return client.query<InventoryRow>(
    `
      UPDATE ticket_type_inventory
      SET remaining_quantity = remaining_quantity - $3,
          version = version + 1,
          updated_at = now()
      WHERE event_id = $1
        AND ticket_type_id = $2
        AND remaining_quantity >= $3
      RETURNING remaining_quantity, version
    `,
    [input.eventId, ticketTypeId, input.quantity],
  );
}

function readActiveInventory(
  client: QueryClient,
  eventId: string,
  ticketTypeId: string,
  writerMode: InventoryWriterMode,
) {
  if (writerMode === 'legacy') {
    return client.query<InventoryRow>(
      `
        SELECT remaining_quantity, version
        FROM ticket_inventory
        WHERE event_id = $1
      `,
      [eventId],
    );
  }
  return client.query<InventoryRow>(
    `
      SELECT remaining_quantity, version
      FROM ticket_type_inventory
      WHERE event_id = $1
        AND ticket_type_id = $2
    `,
    [eventId, ticketTypeId],
  );
}

function findExistingPurchase(client: QueryClient, input: ParsedPurchaseInput) {
  return client.query<ExistingPurchaseRow>(
    `
      SELECT
        id AS purchase_id,
        event_id,
        buyer_id,
        ticket_type_id,
        quantity,
        status,
        rejection_reason,
        remaining_quantity_after
      FROM purchases
      WHERE buyer_id = $1
        AND event_id = $2
        AND request_id = $3
      LIMIT 1
    `,
    [input.buyerId, input.eventId, input.requestId],
  );
}

function assertIdempotencyReplayPayload(
  purchase: ExistingPurchaseRow,
  input: ParsedPurchaseInput,
): void {
  if (
    purchase.quantity !== input.quantity ||
    (input.ticketTypeId !== undefined &&
      purchase.ticket_type_id !== input.ticketTypeId)
  ) {
    throw new ConflictException(
      'requestId was already used with a different purchase payload',
    );
  }
}

function replayOutcome(
  purchase: ExistingPurchaseRow,
): PurchaseTransactionOutcome {
  return {
    result: toPurchaseResult(purchase),
    disposition: 'replayed',
    inventoryChange: null,
    compatibilityRemainingQuantity: null,
    resolvedTicketTypeId: purchase.ticket_type_id,
    ticketTypeRemainingQuantity: null,
  };
}

function toPurchaseResult(purchase: ExistingPurchaseRow): PurchaseResult {
  return {
    purchaseId: purchase.purchase_id,
    eventId: purchase.event_id,
    buyerId: purchase.buyer_id,
    quantity: purchase.quantity,
    status: purchase.status,
    rejectionReason: purchase.rejection_reason,
    remainingQuantity: purchase.remaining_quantity_after,
  };
}

function isConstraintViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}

function parsePurchaseInput(
  eventId: string,
  buyerId: string,
  body: unknown,
  selection: PurchaseTicketTypeSelection,
): ParsedPurchaseInput {
  if (!UUID_PATTERN.test(eventId)) {
    throw new BadRequestException('eventId must be a UUID');
  }
  if (!UUID_PATTERN.test(buyerId)) {
    throw new BadRequestException('authenticated user id must be a UUID');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('request body must be an object');
  }

  const requestBody = body as PurchaseRequestBody;
  if (requestBody.buyerId !== undefined) {
    throw new BadRequestException(
      'buyerId is no longer accepted: it is derived from the authenticated user',
    );
  }
  if (
    typeof requestBody.quantity !== 'number' ||
    !Number.isInteger(requestBody.quantity) ||
    requestBody.quantity <= 0 ||
    requestBody.quantity > POSTGRES_INT4_MAX
  ) {
    throw new BadRequestException(
      'quantity must be a positive integer up to 2147483647',
    );
  }
  if (
    requestBody.requestId !== undefined &&
    (typeof requestBody.requestId !== 'string' ||
      requestBody.requestId.length === 0)
  ) {
    throw new BadRequestException('requestId must be a non-empty string');
  }
  if (
    selection.ticketTypeId !== undefined &&
    (typeof selection.ticketTypeId !== 'string' ||
      !UUID_PATTERN.test(selection.ticketTypeId))
  ) {
    throw new BadRequestException('ticketTypeId must be a UUID');
  }

  return {
    eventId,
    buyerId,
    quantity: requestBody.quantity,
    requestId: requestBody.requestId as string | undefined,
    ticketTypeId: selection.ticketTypeId as string | undefined,
  };
}
