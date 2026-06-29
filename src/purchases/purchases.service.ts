import {
  BadRequestException,
  Injectable,
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
        'SELECT id FROM events WHERE id = $1',
        [input.eventId],
      );

      if (event.rowCount === 0) {
        throw new NotFoundException('event not found');
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
      const rejectionReason = confirmed ? null : 'insufficient_inventory';

      const purchase = await client.query<PurchaseRow>(
        `
          INSERT INTO purchases (
            event_id,
            buyer_id,
            request_id,
            quantity,
            status,
            rejection_reason
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          RETURNING id
        `,
        [
          input.eventId,
          input.buyerId,
          input.requestId,
          input.quantity,
          confirmed ? 'confirmed' : 'rejected',
          rejectionReason,
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
        remainingQuantity: confirmed
          ? inventoryUpdate.rows[0].remaining_quantity
          : null,
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (err) {
        rollbackError =
          err instanceof Error ? err : new Error('ROLLBACK failed');
        // Preserve the original purchase error if rollback fails after a broken connection.
      }

      throw error;
    } finally {
      client.release(rollbackError);
    }
  }
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
