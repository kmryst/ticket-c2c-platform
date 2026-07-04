// ファイル概要:
// staging 環境の配線を外側から検証する smoke test です（staging-environment.md「smoke test」）。
// AWS credential は使わず、STAGING_BASE_URL への HTTP のみで検証します。
//
// 検証経路:
// 1. GET /healthz / GET /readyz（ALB -> API -> Aurora）
// 2. POST /events で capacity 2 の test event を seed（API 経由。DB 直接投入はしない）
// 3. POST /events/:eventId/purchases x3（#1 / #2 confirmed、#3 は Valkey 前段拒否 sold_out_precheck）
// 4. GET /events/search に projection が反映される（EventBridge -> SQS -> Worker -> OpenSearch）
//
// test data は削除しない（失敗時調査用。staging destroy で消える）。

import { randomUUID } from 'node:crypto';

const baseUrl = requiredEnv('STAGING_BASE_URL').replace(/\/+$/, '');

// timeout / interval は staging-environment.md の表に合わせる。
const HEALTH_TIMEOUT_MS = 2 * 60 * 1000;
const PROJECTION_TIMEOUT_MS = 3 * 60 * 1000;
const POLL_INTERVAL_MS = 5 * 1000;

// run id + timestamp を test data の名前に入れて、実行ごとに一意にする。
const runId = randomUUID().slice(0, 8);
const startedAt = new Date();
const runLabel = `smoke-${runId}-${startedAt.toISOString()}`;

interface EventSummary {
  eventId: string;
  remainingQuantity: number;
}

interface PurchaseResult {
  purchaseId: string | null;
  status: 'confirmed' | 'rejected';
  rejectionReason: string | null;
  remainingQuantity: number | null;
}

interface SearchedEvent {
  eventId: string;
  remainingQuantity: number | null;
}

async function main(): Promise<void> {
  console.log(`smoke test run: ${runLabel}`);
  console.log(`base URL: ${baseUrl}`);

  // 1. health check（ECS 起動直後や ALB health check 反映の揺れをリトライで吸収する）
  await waitFor('GET /healthz', HEALTH_TIMEOUT_MS, async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    return res.status === 200;
  });
  await waitFor('GET /readyz', HEALTH_TIMEOUT_MS, async () => {
    const res = await fetch(`${baseUrl}/readyz`);
    return res.status === 200;
  });

  // 2. seed: capacity 2 の test event を API 経由で作成する
  const eventType = `smoke-${runId}`;
  const created = await requestJson<EventSummary>('POST /events', `${baseUrl}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: runLabel,
      eventType,
      startsAt: new Date(startedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      latitude: 35.68,
      longitude: 139.76,
      totalQuantity: 2,
    }),
    expectedStatus: 201,
  });
  assert(typeof created.eventId === 'string' && created.eventId.length > 0, 'event created with id');
  console.log(`seeded event ${created.eventId} (capacity 2, eventType ${eventType})`);

  // 3. purchases: #1 / #2 confirmed、#3 は Valkey 前段拒否（sold_out_precheck）
  //    requestId を付けると前段フィルタをバイパスするため、あえて付けない。
  const purchase = (label: string) =>
    requestJson<PurchaseResult>(label, `${baseUrl}/events/${created.eventId}/purchases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ buyerId: randomUUID(), quantity: 1 }),
      expectedStatus: 200,
    });

  const p1 = await purchase('purchase #1');
  assert(p1.status === 'confirmed', `purchase #1 confirmed (got ${p1.status} / ${p1.rejectionReason})`);
  const p2 = await purchase('purchase #2');
  assert(p2.status === 'confirmed', `purchase #2 confirmed (got ${p2.status} / ${p2.rejectionReason})`);
  assert(p2.remainingQuantity === 0, `purchase #2 leaves remainingQuantity 0 (got ${p2.remainingQuantity})`);

  const p3 = await purchase('purchase #3');
  assert(p3.status === 'rejected', `purchase #3 rejected (got ${p3.status})`);
  // 拒否レイヤの判定: Valkey 前段拒否は rejectionReason=sold_out_precheck かつ DB に履歴を残さない
  // （purchaseId=null）。Aurora 到達後の拒否は insufficient_inventory + purchaseId 付きになる。
  assert(
    p3.rejectionReason === 'sold_out_precheck',
    `purchase #3 rejected by Valkey precheck (got ${p3.rejectionReason})`,
  );
  assert(p3.purchaseId === null, `purchase #3 has no DB record (purchaseId=${p3.purchaseId})`);

  // 4. projection: EventBridge -> SQS -> Worker -> OpenSearch の非同期反映を待つ。
  //    staging は OPENSEARCH_ENDPOINT 設定済みのため /events/search は OpenSearch のみを見る
  //    （DB フォールバックで偽陽性にならない）。remainingQuantity 0 まで確認して
  //    EventListed / InventoryChanged 両方の反映を見る。
  await waitFor(
    `GET /events/search reflects event ${created.eventId} with remainingQuantity 0`,
    PROJECTION_TIMEOUT_MS,
    async () => {
      const res = await fetch(`${baseUrl}/events/search?eventType=${encodeURIComponent(eventType)}`);
      if (res.status !== 200) {
        return false;
      }
      const events = (await res.json()) as SearchedEvent[];
      const hit = events.find((e) => e.eventId === created.eventId);
      return hit !== undefined && hit.remainingQuantity === 0;
    },
  );

  console.log('');
  console.log('smoke test PASSED');
  console.log(`- event: ${created.eventId} (eventType ${eventType})`);
  console.log('- purchases: #1 confirmed / #2 confirmed / #3 rejected (sold_out_precheck)');
  console.log('- search projection: reflected with remainingQuantity 0');
  console.log('- test data は削除していない（staging destroy で消える）');
}

// requestJson は 1 回の HTTP リクエストを送り、期待 status を検証して JSON を返します。
async function requestJson<T>(
  label: string,
  url: string,
  init: RequestInit & { expectedStatus: number },
): Promise<T> {
  const { expectedStatus, ...rest } = init;
  const res = await fetch(url, rest);
  const text = await res.text();
  if (res.status !== expectedStatus) {
    throw new Error(`${label}: expected HTTP ${expectedStatus}, got ${res.status}: ${text.slice(0, 500)}`);
  }
  console.log(`${label}: HTTP ${res.status}`);
  return JSON.parse(text) as T;
}

// waitFor は条件が true になるまで interval ごとにリトライします（非同期反映の揺れ吸収）。
async function waitFor(
  label: string,
  timeoutMs: number,
  check: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      if (await check()) {
        console.log(`${label}: ok (attempt ${attempt})`);
        return;
      }
    } catch (error) {
      // 起動直後の接続エラー等はリトライで吸収する
      console.log(`${label}: attempt ${attempt} error: ${String(error)}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`${label}: timed out after ${timeoutMs} ms`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

function assert(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`assertion failed: ${label}`);
  }
  console.log(`assert ok: ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

main().catch((error) => {
  console.error('');
  console.error('smoke test FAILED');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
