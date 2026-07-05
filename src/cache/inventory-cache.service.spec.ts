// ファイル概要:
// このファイルは InventoryCacheService の単体テストです（Issue #129 / production-readiness M-2）。
// Lua script の原子性・CAS の実挙動を検証するため、モックではなく実 Valkey に接続します。
// - ローカル: `docker compose up -d`（valkey が 127.0.0.1:6379 で起動）
// - CI: pr-check の valkey service container
// 接続先は TEST_VALKEY_URL で上書きできます。

import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { InventoryCacheService } from './inventory-cache.service';

const TEST_VALKEY_URL =
  process.env.TEST_VALKEY_URL ?? 'redis://127.0.0.1:6379';

describe('InventoryCacheService (実 Valkey / Lua script)', () => {
  let service: InventoryCacheService;
  // inspector はテストからカウンタ値を直接確認するための別接続です。
  let inspector: Redis;
  // 作成したイベント ID を控え、テスト後にキーを掃除します。
  const usedEventIds: string[] = [];

  const counterKey = (eventId: string) => `inventory:${eventId}`;
  const versionKey = (eventId: string) => `inventory:${eventId}:v`;

  const newEventId = () => {
    const eventId = randomUUID();
    usedEventIds.push(eventId);
    return eventId;
  };

  beforeAll(async () => {
    process.env.VALKEY_URL = TEST_VALKEY_URL;
    service = new InventoryCacheService();
    inspector = new Redis(TEST_VALKEY_URL, { maxRetriesPerRequest: 1 });
    // 接続できない場合はここで明確に失敗させます（silent skip にしない）。
    await inspector.ping();
  });

  afterAll(async () => {
    // このテストで作成したキーだけを掃除します（既存データには触れない）。
    for (const eventId of usedEventIds) {
      await inspector.del(counterKey(eventId), versionKey(eventId));
    }
    await service.onModuleDestroy();
    inspector.disconnect();
  });

  describe('reserve', () => {
    it('在庫がある場合は reserved を返してカウンタを減算する', async () => {
      const eventId = newEventId();
      await service.initCounter(eventId, 10);

      await expect(service.reserve(eventId, 3)).resolves.toBe('reserved');
      await expect(inspector.get(counterKey(eventId))).resolves.toBe('7');
    });

    it('在庫が足りない場合は sold_out を返してカウンタを変更しない', async () => {
      const eventId = newEventId();
      await service.initCounter(eventId, 2);

      await expect(service.reserve(eventId, 3)).resolves.toBe('sold_out');
      await expect(inspector.get(counterKey(eventId))).resolves.toBe('2');
    });

    it('カウンタ未初期化の場合は unknown を返しキーを作らない', async () => {
      const eventId = newEventId();

      await expect(service.reserve(eventId, 1)).resolves.toBe('unknown');
      await expect(inspector.exists(counterKey(eventId))).resolves.toBe(0);
    });
  });

  describe('release', () => {
    it('reserve 済みカウンタへ返却できる', async () => {
      const eventId = newEventId();
      await service.initCounter(eventId, 10);
      await service.reserve(eventId, 4);

      await service.release(eventId, 4);

      await expect(inspector.get(counterKey(eventId))).resolves.toBe('10');
    });

    it('カウンタ未初期化の場合はキーを捏造しない（M-2）', async () => {
      const eventId = newEventId();

      await service.release(eventId, 5);

      // 旧実装（素の INCRBY）ではここで '5' のカウンタが新規作成されていた。
      await expect(inspector.exists(counterKey(eventId))).resolves.toBe(0);
    });
  });

  describe('syncCounter（version CAS）', () => {
    it('version が変わっていなければ DB 残在庫で上書きできる', async () => {
      const eventId = newEventId();
      await service.initCounter(eventId, 10);

      const version = await service.getCounterVersion(eventId);
      expect(version).not.toBeNull();

      await expect(
        service.syncCounter(eventId, 42, version as string),
      ).resolves.toBe(true);
      await expect(inspector.get(counterKey(eventId))).resolves.toBe('42');
    });

    it('version 取得後に reserve が入った場合は上書きを見送り、減算を消さない（M-2 レース再現）', async () => {
      const eventId = newEventId();
      await service.initCounter(eventId, 10);

      // syncCounter の呼び出し元が DB 残在庫（=10 と仮定）を読んだ時点の version。
      const staleVersion = await service.getCounterVersion(eventId);

      // その後、並行リクエストが reserve でカウンタを 10 -> 7 に減算。
      await expect(service.reserve(eventId, 3)).resolves.toBe('reserved');

      // 旧実装（無条件 SET）ではここで 10 に巻き戻り、reserve の減算が消えていた。
      await expect(
        service.syncCounter(eventId, 10, staleVersion as string),
      ).resolves.toBe(false);
      await expect(inspector.get(counterKey(eventId))).resolves.toBe('7');
    });

    it('version 取得後に release が入った場合も上書きを見送る', async () => {
      const eventId = newEventId();
      await service.initCounter(eventId, 10);
      await service.reserve(eventId, 3);

      const staleVersion = await service.getCounterVersion(eventId);
      await service.release(eventId, 3);

      await expect(
        service.syncCounter(eventId, 7, staleVersion as string),
      ).resolves.toBe(false);
      await expect(inspector.get(counterKey(eventId))).resolves.toBe('10');
    });

    it('version 取得後に initCounter が入った場合も上書きを見送る', async () => {
      const eventId = newEventId();
      await service.initCounter(eventId, 10);

      const staleVersion = await service.getCounterVersion(eventId);
      await service.initCounter(eventId, 100);

      await expect(
        service.syncCounter(eventId, 5, staleVersion as string),
      ).resolves.toBe(false);
      await expect(inspector.get(counterKey(eventId))).resolves.toBe('100');
    });

    it('カウンタ未作成でも version 0 起点で初回同期できる', async () => {
      const eventId = newEventId();

      const version = await service.getCounterVersion(eventId);
      expect(version).toBe('0');

      await expect(service.syncCounter(eventId, 8, '0')).resolves.toBe(true);
      await expect(inspector.get(counterKey(eventId))).resolves.toBe('8');
    });
  });

  describe('並行実行（reserve と syncCounter のレース）', () => {
    it('並行 reserve の合計減算が syncCounter で消えない', async () => {
      const eventId = newEventId();
      await service.initCounter(eventId, 100);

      const staleVersion = await service.getCounterVersion(eventId);

      // 並行に reserve x10（各 1 枚）と、古い version での syncCounter を同時に流します。
      const results = await Promise.all([
        ...Array.from({ length: 10 }, () => service.reserve(eventId, 1)),
        service.syncCounter(eventId, 100, staleVersion as string),
      ]);

      // reserve は全件成功しているはず。
      expect(results.slice(0, 10)).toEqual(Array(10).fill('reserved'));

      // syncCounter がどのタイミングで割り込んでも、成功した reserve の減算は失われない。
      // （sync が最初に走って成功した場合のみ true になり得るが、その後の減算は必ず反映される）
      await expect(inspector.get(counterKey(eventId))).resolves.toBe('90');
    });
  });

  describe('requestId マーカー（M-1 の replay 判別）', () => {
    it('markRequestSeen 前は false、後は true になり TTL が付く', async () => {
      const eventId = newEventId();
      const buyerId = randomUUID();
      const requestId = `req-${randomUUID()}`;

      await expect(
        service.wasRequestSeen(buyerId, eventId, requestId),
      ).resolves.toBe(false);

      await service.markRequestSeen(buyerId, eventId, requestId);

      await expect(
        service.wasRequestSeen(buyerId, eventId, requestId),
      ).resolves.toBe(true);

      const markerKey = `purchase-request:${buyerId}:${eventId}:${requestId}`;
      const ttl = await inspector.ttl(markerKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(24 * 60 * 60);

      await inspector.del(markerKey);
    });

    it('buyer / event / requestId のいずれかが違えば別リクエスト扱いになる', async () => {
      const eventId = newEventId();
      const buyerId = randomUUID();
      const requestId = `req-${randomUUID()}`;
      await service.markRequestSeen(buyerId, eventId, requestId);

      await expect(
        service.wasRequestSeen(randomUUID(), eventId, requestId),
      ).resolves.toBe(false);
      await expect(
        service.wasRequestSeen(buyerId, newEventId(), requestId),
      ).resolves.toBe(false);
      await expect(
        service.wasRequestSeen(buyerId, eventId, `req-${randomUUID()}`),
      ).resolves.toBe(false);

      await inspector.del(`purchase-request:${buyerId}:${eventId}:${requestId}`);
    });
  });
});
