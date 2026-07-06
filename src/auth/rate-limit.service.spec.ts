// ファイル概要:
// このファイルは AuthRateLimitService の単体テストです（ADR-0012、Issue #167）。
// Lua script（INCR + 初回 EXPIRE + TTL 取得）の実挙動を検証するため、モックではなく実 Valkey に接続します。
// - ローカル: `docker compose up -d`（valkey が 127.0.0.1:6379 で起動）
// - CI: pr-check の valkey service container
// 接続先は TEST_VALKEY_URL で上書きできます。

import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { AuthRateLimitService } from './rate-limit.service';

const TEST_VALKEY_URL =
  process.env.TEST_VALKEY_URL ?? 'redis://127.0.0.1:6379';

describe('AuthRateLimitService (実 Valkey / Lua script)', () => {
  let service: AuthRateLimitService;
  // inspector はテストからカウンタを直接確認・掃除するための別接続です。
  let inspector: Redis;
  // 使ったキーを控え、テスト後に掃除します。
  const usedKeys: string[] = [];

  // newIp / newEmail はテスト間の干渉を避けるため毎回ユニークな主体を作ります。
  const newIp = () => {
    const ip = `test-ip-${randomUUID()}`;
    usedKeys.push(
      `ratelimit:signup:ip:${ip}`,
      `ratelimit:login:ip:${ip}`,
      `ratelimit:refresh:ip:${ip}`,
    );
    return ip;
  };
  const newEmail = () => {
    const email = `rl-${randomUUID()}@example.com`;
    usedKeys.push(
      `ratelimit:signup:sub:${email}`,
      `ratelimit:login:sub:${email}`,
      `ratelimit:refresh:sub:${email}`,
    );
    return email;
  };

  beforeAll(async () => {
    process.env.VALKEY_URL = TEST_VALKEY_URL;
    service = new AuthRateLimitService();
    inspector = new Redis(TEST_VALKEY_URL, { maxRetriesPerRequest: 1 });
    // 接続できない場合はここで明確に失敗させます（silent skip にしない）。
    await inspector.ping();
  });

  afterEach(() => {
    // 各テストが設定した上書き閾値を掃除します。
    delete process.env.AUTH_RATE_LIMIT_LOGIN_IP;
    delete process.env.AUTH_RATE_LIMIT_LOGIN_SECONDARY;
    delete process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS;
  });

  afterAll(async () => {
    if (usedKeys.length > 0) {
      await inspector.del(...usedKeys);
    }
    await service.onModuleDestroy();
    inspector.disconnect();
  });

  it('IP 単位の閾値以内は通り、超過で 429（retryAfterSeconds 付き）になる', async () => {
    process.env.AUTH_RATE_LIMIT_LOGIN_IP = '3';
    const ip = newIp();

    // 閾値ちょうどまでは通る。
    for (let i = 0; i < 3; i += 1) {
      await expect(service.enforce('login', { ip })).resolves.toBeUndefined();
    }

    // 4 回目は 429。
    await expect(service.enforce('login', { ip })).rejects.toMatchObject({
      status: 429,
    });

    // 429 の body には Retry-After 用の待機秒数が含まれる。
    const error = await service.enforce('login', { ip }).catch((e) => e);
    const response = (error as { getResponse: () => unknown }).getResponse();
    expect(response).toMatchObject({ statusCode: 429 });
    expect(
      (response as { retryAfterSeconds: number }).retryAfterSeconds,
    ).toBeGreaterThan(0);
  });

  it('メール（第 2 系統）単位の制限は IP と独立に効く', async () => {
    process.env.AUTH_RATE_LIMIT_LOGIN_SECONDARY = '2';
    const email = newEmail();

    // 異なる IP から同じメールを狙う攻撃（分散型の総当たり）を想定する。
    await expect(
      service.enforce('login', { ip: newIp(), secondary: email }),
    ).resolves.toBeUndefined();
    await expect(
      service.enforce('login', { ip: newIp(), secondary: email }),
    ).resolves.toBeUndefined();

    // IP はすべて別でも、メール系統の閾値超過で 429 になる。
    await expect(
      service.enforce('login', { ip: newIp(), secondary: email }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it('同じ IP でもエンドポイントが違えばカウンタは別になる', async () => {
    process.env.AUTH_RATE_LIMIT_LOGIN_IP = '1';
    const ip = newIp();

    await expect(service.enforce('login', { ip })).resolves.toBeUndefined();
    await expect(service.enforce('login', { ip })).rejects.toMatchObject({
      status: 429,
    });

    // login が超過しても refresh / signup のカウンタには影響しない。
    await expect(service.enforce('refresh', { ip })).resolves.toBeUndefined();
    await expect(service.enforce('signup', { ip })).resolves.toBeUndefined();
  });

  it('ウィンドウ経過（キー TTL 失効）で回復する', async () => {
    process.env.AUTH_RATE_LIMIT_LOGIN_IP = '1';
    process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = '1';
    const ip = newIp();

    await expect(service.enforce('login', { ip })).resolves.toBeUndefined();
    await expect(service.enforce('login', { ip })).rejects.toMatchObject({
      status: 429,
    });

    // 1 秒ウィンドウの失効を待つ。
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await expect(service.enforce('login', { ip })).resolves.toBeUndefined();
  });

  it('カウンタキーには必ず TTL が付く（TTL なしキーで永久カウントされない）', async () => {
    const ip = newIp();
    await service.enforce('signup', { ip });

    const ttl = await inspector.ttl(`ratelimit:signup:ip:${ip}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15 * 60);
  });

  it('VALKEY_URL 未設定では fail-open（制限なし）で通る', async () => {
    const original = process.env.VALKEY_URL;
    delete process.env.VALKEY_URL;
    const disabled = new AuthRateLimitService();
    process.env.VALKEY_URL = original;

    // 閾値を大きく超える回数でも一切ブロックされない。
    for (let i = 0; i < 30; i += 1) {
      await expect(
        disabled.enforce('login', { ip: 'no-valkey-ip' }),
      ).resolves.toBeUndefined();
    }
    await disabled.onModuleDestroy();
  });
});
