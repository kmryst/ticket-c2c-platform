import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';

const databaseUrl = getRequiredDatabaseUrl();
const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
const totalQuantity = Number(process.env.POC_TOTAL_QUANTITY ?? 20);
const purchaseAttempts = Number(process.env.POC_PURCHASE_ATTEMPTS ?? 50);
const purchaseConcurrency = Number(process.env.POC_PURCHASE_CONCURRENCY ?? 9);
const purchaseQuantity = Number(process.env.POC_PURCHASE_QUANTITY ?? 1);

interface PurchaseApiResult {
  purchaseId: string;
  status: 'confirmed' | 'rejected';
  quantity: number;
  rejectionReason: string | null;
}

interface PurchaseAttemptResult {
  ok: boolean;
  httpStatus: number;
  latencyMs: number;
  body: PurchaseApiResult | { message?: unknown };
}

interface InventoryRow {
  total_quantity: number;
  remaining_quantity: number;
  version: number;
}

interface PurchaseSummaryRow {
  status: 'confirmed' | 'rejected';
  purchase_count: string;
  total_quantity: string;
}

async function main() {
  validatePositiveInteger('POC_TOTAL_QUANTITY', totalQuantity);
  validatePositiveInteger('POC_PURCHASE_ATTEMPTS', purchaseAttempts);
  validatePositiveInteger('POC_PURCHASE_CONCURRENCY', purchaseConcurrency);
  validatePositiveInteger('POC_PURCHASE_QUANTITY', purchaseQuantity);

  const pool = new Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
    max: 10,
  });
  pool.on('error', (error) => {
    console.error('Unexpected PoC pool error:', error);
  });

  try {
    await assertApiIsReady();
    const eventId = await seedEvent(pool);
    const runId = randomUUID();

    const results = await runWithConcurrency(
      purchaseAttempts,
      purchaseConcurrency,
      (index) => sendPurchase(eventId, runId, index),
    );

    const settled = results.map((result): PurchaseAttemptResult => {
      if (result.status === 'fulfilled') {
        return result.value;
      }

      return {
        ok: false,
        httpStatus: 0,
        latencyMs: 0,
        body: { message: String(result.reason) },
      };
    });

    const [inventory, purchaseSummary] = await Promise.all([
      loadInventory(pool, eventId),
      loadPurchaseSummary(pool, eventId),
    ]);
    const latencySummary = summarizeLatency(
      settled.map((result) => result.latencyMs).filter((value) => value > 0),
    );

    const apiConfirmed = settled.filter(
      (result) =>
        result.ok &&
        'status' in result.body &&
        result.body.status === 'confirmed',
    ).length;
    const apiRejected = settled.filter(
      (result) =>
        result.ok &&
        'status' in result.body &&
        result.body.status === 'rejected',
    ).length;
    const apiErrors = settled.length - apiConfirmed - apiRejected;

    const dbConfirmedQuantity = purchaseSummary.confirmed.quantity;
    const oversold =
      dbConfirmedQuantity > inventory.total_quantity ||
      inventory.remaining_quantity < 0 ||
      inventory.total_quantity - inventory.remaining_quantity !==
        dbConfirmedQuantity;

    const summary = {
      eventId,
      attempts: purchaseAttempts,
      concurrency: purchaseConcurrency,
      purchaseQuantity,
      api: {
        confirmed: apiConfirmed,
        rejected: apiRejected,
        errors: apiErrors,
      },
      database: {
        totalQuantity: inventory.total_quantity,
        remainingQuantity: inventory.remaining_quantity,
        version: inventory.version,
        confirmedPurchases: purchaseSummary.confirmed.count,
        confirmedQuantity: purchaseSummary.confirmed.quantity,
        rejectedPurchases: purchaseSummary.rejected.count,
      },
      latencyMs: latencySummary,
      oversold,
    };

    console.log(JSON.stringify(summary, null, 2));

    if (oversold || apiErrors > 0) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

async function assertApiIsReady() {
  const response = await fetch(`${apiBaseUrl}/health`);
  if (!response.ok) {
    throw new Error(`API health check failed: ${response.status}`);
  }
}

async function seedEvent(pool: Pool): Promise<string> {
  const event = await pool.query<{ id: string }>(
    `
      INSERT INTO events (
        title,
        event_type,
        starts_at,
        location_latitude,
        location_longitude
      )
      VALUES ($1, $2, now() + interval '30 days', $3, $4)
      RETURNING id
    `,
    [
      `Inventory PoC ${new Date().toISOString()}`,
      'music',
      '35.681236',
      '139.767125',
    ],
  );

  const eventId = event.rows[0].id;

  await pool.query(
    `
      INSERT INTO ticket_inventory (
        event_id,
        total_quantity,
        remaining_quantity
      )
      VALUES ($1, $2, $2)
    `,
    [eventId, totalQuantity],
  );

  return eventId;
}

async function sendPurchase(
  eventId: string,
  runId: string,
  index: number,
): Promise<PurchaseAttemptResult> {
  const startedAt = performance.now();
  const response = await fetch(`${apiBaseUrl}/events/${eventId}/purchases`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      buyerId: randomUUID(),
      quantity: purchaseQuantity,
      requestId: `${runId}-${index}`,
    }),
  });
  const body = (await response.json()) as PurchaseAttemptResult['body'];
  const latencyMs = performance.now() - startedAt;

  return {
    ok: response.ok,
    httpStatus: response.status,
    latencyMs,
    body,
  };
}

async function loadInventory(pool: Pool, eventId: string): Promise<InventoryRow> {
  const result = await pool.query<InventoryRow>(
    `
      SELECT total_quantity, remaining_quantity, version
      FROM ticket_inventory
      WHERE event_id = $1
    `,
    [eventId],
  );

  if (result.rowCount !== 1) {
    throw new Error(`Inventory not found for event ${eventId}`);
  }

  return result.rows[0];
}

async function loadPurchaseSummary(pool: Pool, eventId: string) {
  const result = await pool.query<PurchaseSummaryRow>(
    `
      SELECT
        status,
        count(*) AS purchase_count,
        coalesce(sum(quantity), 0) AS total_quantity
      FROM purchases
      WHERE event_id = $1
      GROUP BY status
    `,
    [eventId],
  );

  const summary = {
    confirmed: { count: 0, quantity: 0 },
    rejected: { count: 0, quantity: 0 },
  };

  for (const row of result.rows) {
    const count = parseFiniteNumber('purchase_count', row.purchase_count);
    const quantity = parseFiniteNumber('total_quantity', row.total_quantity);

    summary[row.status] = {
      count,
      quantity,
    };
  }

  return summary;
}

function summarizeLatency(values: number[]) {
  if (values.length === 0) {
    return { p50: null, p95: null, p99: null };
  }

  const sorted = [...values].sort((left, right) => left - right);

  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

function percentile(sortedValues: number[], percentileValue: number): number {
  const index = Math.min(
    sortedValues.length - 1,
    Math.ceil(sortedValues.length * percentileValue) - 1,
  );

  return Number(sortedValues[index].toFixed(2));
}

function validatePositiveInteger(name: string, value: number) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

async function runWithConcurrency<T>(
  itemCount: number,
  concurrency: number,
  task: (index: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = [];

  for (let start = 0; start < itemCount; start += concurrency) {
    const end = Math.min(itemCount, start + concurrency);
    const batch = Array.from({ length: end - start }, (_, offset) =>
      task(start + offset),
    );
    results.push(...(await Promise.allSettled(batch)));
  }

  return results;
}

function parseFiniteNumber(name: string, value: string): number {
  const parsedValue = Number(value);

  if (!Number.isFinite(parsedValue)) {
    throw new Error(`Unexpected non-numeric ${name}: ${value}`);
  }

  return parsedValue;
}

function getRequiredDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required. Copy .env.example to .env for local PoC runs.');
  }

  return process.env.DATABASE_URL;
}

void main();
