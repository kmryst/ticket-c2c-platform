import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import {
  ParsedPurchaseInput,
  PurchaseRequestBody,
  PurchaseResult,
} from './purchase.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSTGRES_INT4_MAX = 2_147_483_647;

interface EventRow {
  id: string;
}

interface InventoryUpdateRow {
  remaining_quantity: number;
}

interface ExistingConfirmedPurchaseRow {
  purchase_id: string;
  event_id: string;
  buyer_id: string;
  quantity: number;
  status: 'confirmed';
  rejection_reason: string | null;
  remaining_quantity_after: number | null;
}

interface ExistingRejectedPurchaseRow {
  purchase_id: string;
  event_id: string;
  buyer_id: string;
  quantity: number;
  status: 'rejected';
  rejection_reason: string;
  remaining_quantity_after: null;
}

interface PurchaseRow {
  id: string;
}

@Injectable()
export class PurchasesService {
  constructor(private readonly database: DatabaseService) {}

  async createPurchase(
    eventId: string,
    body: unknown,
  ): Promise<PurchaseResult> {
    const input = parsePurchaseInput(eventId, body);
    const client = await this.database.connect();
    let rollbackError: Error | undefined;

    try {
      await client.query('BEGIN');

      const event = await client.query<EventRow>(
        'SELECT id FROM events WHERE id = $1 FOR SHARE',
        [input.eventId],
      );

      if (!event.rowCount) {
        throw new NotFoundException('event not found');
      }

      const existingConfirmed = input.requestId
        ? await findExistingConfirmedPurchase(client, input)
        : null;

      if (existingConfirmed?.rowCount) {
        await client.query('COMMIT');

        return toPurchaseResult(existingConfirmed.rows[0]);
      }

      const inventoryUpdate = await client.query<InventoryUpdateRow>(
        `
          UPDATE ticket_inventory
          SET
            remaining_quantity = remaining_quantity - $2,
            version = version + 1,
            updated_at = now()
          WHERE event_id = $1
            AND remaining_quantity >= $2
          RETURNING remaining_quantity
        `,
        [input.eventId, input.quantity],
      );

      const confirmed = inventoryUpdate.rowCount === 1;

      if (!confirmed) {
        const inventory = await client.query<EventRow>(
          'SELECT event_id AS id FROM ticket_inventory WHERE event_id = $1',
          [input.eventId],
        );

        if (!inventory.rowCount) {
          console.error('ticket inventory not found for existing event', {
            eventId: input.eventId,
          });
          throw new InternalServerErrorException(
            'ticket inventory is not configured',
          );
        }

        if (input.requestId) {
          const existingRejected = await findExistingRejectedPurchase(
            client,
            input,
          );

          if (existingRejected.rowCount) {
            await client.query('COMMIT');

            return toPurchaseResult(existingRejected.rows[0]);
          }
        }
      }

      const rejectionReason = confirmed ? null : 'insufficient_inventory';
      const remainingQuantityAfter = confirmed
        ? inventoryUpdate.rows[0].remaining_quantity
        : null;

      const purchase = await client.query<PurchaseRow>(
        `
          INSERT INTO purchases (
            event_id,
            buyer_id,
            request_id,
            quantity,
            status,
            rejection_reason,
            remaining_quantity_after
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id
        `,
        [
          input.eventId,
          input.buyerId,
          input.requestId,
          input.quantity,
          confirmed ? 'confirmed' : 'rejected',
          rejectionReason,
          remainingQuantityAfter,
        ],
      );

      await client.query('COMMIT');

      return {
        purchaseId: purchase.rows[0].id,
        eventId: input.eventId,
        buyerId: input.buyerId,
        quantity: input.quantity,
        status: confirmed ? 'confirmed' : 'rejected',
        rejectionReason,
        remainingQuantity: remainingQuantityAfter,
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (err) {
        rollbackError =
          err instanceof Error ? err : new Error('ROLLBACK failed');
        console.error('ROLLBACK failed:', rollbackError);
        // Preserve the original purchase error if rollback fails after a broken connection.
      }

      if (!rollbackError && input.requestId) {
        if (isConfirmedRequestIdConflict(error)) {
          const existingConfirmed = await findExistingConfirmedPurchase(
            client,
            input,
          );

          if (existingConfirmed.rowCount) {
            return toPurchaseResult(existingConfirmed.rows[0]);
          }
        }

        if (isRejectedRequestIdConflict(error)) {
          const existingRejected = await findExistingRejectedPurchase(
            client,
            input,
          );

          if (existingRejected.rowCount) {
            return toPurchaseResult(existingRejected.rows[0]);
          }
        }
      }

      throw error;
    } finally {
      client.release(rollbackError);
    }
  }
}

function findExistingConfirmedPurchase(
  client: { query: typeof import('pg').Client.prototype.query },
  input: ParsedPurchaseInput,
) {
  return client.query<ExistingConfirmedPurchaseRow>(
    `
      SELECT
        id AS purchase_id,
        event_id,
        buyer_id,
        quantity,
        status,
        rejection_reason,
        remaining_quantity_after
      FROM purchases
      WHERE buyer_id = $1
        AND event_id = $2
        AND request_id = $3
        AND status = 'confirmed'
      LIMIT 1
    `,
    [input.buyerId, input.eventId, input.requestId],
  );
}

function findExistingRejectedPurchase(
  client: { query: typeof import('pg').Client.prototype.query },
  input: ParsedPurchaseInput,
) {
  return client.query<ExistingRejectedPurchaseRow>(
    `
      SELECT
        id AS purchase_id,
        event_id,
        buyer_id,
        quantity,
        status,
        rejection_reason,
        remaining_quantity_after
      FROM purchases
      WHERE buyer_id = $1
        AND event_id = $2
        AND request_id = $3
        AND status = 'rejected'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [input.buyerId, input.eventId, input.requestId],
  );
}

function toPurchaseResult(
  purchase: ExistingConfirmedPurchaseRow | ExistingRejectedPurchaseRow,
): PurchaseResult {
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

function isConfirmedRequestIdConflict(error: unknown): boolean {
  return isConstraintViolation(error, 'purchases_request_id_uq');
}

function isRejectedRequestIdConflict(error: unknown): boolean {
  return isConstraintViolation(error, 'purchases_rejected_request_id_uq');
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
  body: unknown,
): ParsedPurchaseInput {
  if (!UUID_PATTERN.test(eventId)) {
    throw new BadRequestException('eventId must be a UUID');
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('request body must be an object');
  }

  const requestBody = body as PurchaseRequestBody;

  if (
    typeof requestBody.buyerId !== 'string' ||
    !UUID_PATTERN.test(requestBody.buyerId)
  ) {
    throw new BadRequestException('buyerId must be a UUID');
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

  return {
    eventId,
    buyerId: requestBody.buyerId,
    quantity: requestBody.quantity,
    requestId: requestBody.requestId,
  };
}
