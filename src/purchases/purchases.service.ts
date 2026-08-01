// 購入判定の PostgreSQL authoritative writer。
// Issue #376 では shared barrier と DB control state に従い、legacy / Ticket Type の
// active inventory だけを更新する。公開 Ticket Type contract は #379 まで追加しない。

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  acquirePurchaseRequestLock,
  acquireSharedInventoryWriterBarrier,
  InventoryWriterMode,
  readInventoryWriterMode,
} from '../database/inventory-writer-control';
import { InventoryCacheService } from '../cache/inventory-cache.service';
import { DomainEventsService } from '../messaging/domain-events.service';
import { emitMetric } from '../observability/emf';
import { traceLogFields } from '../observability/trace-context';
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
  // #389 までは Event 単位 Valkey counter を補正するため、互換aggregateを使う。
  compatibilityRemainingQuantity: number | null;
}

type QueryClient = {
  query: typeof import('pg').Client.prototype.query;
};

@Injectable()
export class PurchasesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly inventoryCache: InventoryCacheService,
    private readonly domainEvents: DomainEventsService,
  ) {}

  async createPurchase(
    eventId: string,
    buyerId: string,
    body: unknown,
    // HTTP controller はこの引数を渡さない。#379 の公開contractまで既存API形状を維持する。
    selection: PurchaseTicketTypeSelection = {},
  ): Promise<PurchaseResult> {
    const input = parsePurchaseInput(eventId, buyerId, body, selection);

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
