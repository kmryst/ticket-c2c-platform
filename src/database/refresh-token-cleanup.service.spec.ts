// ファイル概要:
// このファイルは api 内の refresh_tokens クリーンアップ定期実行（Issue #542 / ADR-0041）の単体テストです。
// fake client で、lock を取れたときだけ削除すること、取れなければ何もしないこと、
// 例外時に api プロセスへ例外を投げず、接続を必ず閉じる（session lock を残さない）ことを確認します。

import { EventEmitter } from 'node:events';
import {
  CLEANUP_SQL,
  TRY_LOCK_SQL,
  UNLOCK_SQL,
} from './refresh-token-cleanup';
import {
  CleanupClient,
  RefreshTokenCleanupService,
} from './refresh-token-cleanup.service';

// FakeClient は pg Client の代わりに SQL の発行順と接続の開閉を記録します。
class FakeClient extends EventEmitter implements CleanupClient {
  readonly executed: string[] = [];
  connected = false;
  ended = false;

  constructor(
    private readonly options: {
      locked?: boolean;
      connectError?: Error;
      deleteError?: Error;
    } = {},
  ) {
    super();
  }

  async connect(): Promise<void> {
    if (this.options.connectError) throw this.options.connectError;
    this.connected = true;
  }

  async query(text: string) {
    this.executed.push(text);
    if (text === TRY_LOCK_SQL) {
      return { rowCount: 1, rows: [{ locked: this.options.locked ?? true }] };
    }
    if (text === CLEANUP_SQL) {
      if (this.options.deleteError) throw this.options.deleteError;
      return {
        rowCount: 1,
        rows: [{ deleted_rows: 4, deleted_families: 2 }],
      };
    }
    return { rowCount: 1, rows: [{ unlocked: true }] };
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

// 本体の SQL（SET を除く）だけを取り出します。
const coreSql = (client: FakeClient) =>
  client.executed.filter((sql) => !sql.startsWith('SET '));

describe('RefreshTokenCleanupService', () => {
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('lock を取れたときだけ削除し、unlock して接続を閉じる', async () => {
    const client = new FakeClient({ locked: true });
    const service = new RefreshTokenCleanupService(undefined, () => client, 0);

    const result = await service.runOnce();

    expect(result).toMatchObject({ status: 'completed', deletedRows: 4 });
    expect(coreSql(client)).toEqual([TRY_LOCK_SQL, CLEANUP_SQL, UNLOCK_SQL]);
    // 専用接続の session にだけ statement_timeout / lock_timeout を設定する。
    expect(client.executed).toEqual(
      expect.arrayContaining([
        expect.stringContaining('statement_timeout'),
        expect.stringContaining('lock_timeout'),
      ]),
    );
    expect(client.ended).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('refresh token cleanup completed: deleted 4 rows'),
    );
  });

  it('lock を取れなければ削除せず skipped を返し、接続を閉じる', async () => {
    const client = new FakeClient({ locked: false });
    const service = new RefreshTokenCleanupService(undefined, () => client, 0);

    const result = await service.runOnce();

    expect(result).toEqual({ status: 'skipped' });
    expect(coreSql(client)).toEqual([TRY_LOCK_SQL]);
    expect(client.ended).toBe(true);
  });

  it('削除で例外が出ても例外を投げず failed を返し、unlock と接続の close を行う', async () => {
    const client = new FakeClient({
      locked: true,
      deleteError: new Error('canceling statement due to lock timeout'),
    });
    const service = new RefreshTokenCleanupService(undefined, () => client, 0);

    await expect(service.runOnce()).resolves.toEqual({ status: 'failed' });
    expect(coreSql(client)).toEqual([TRY_LOCK_SQL, CLEANUP_SQL, UNLOCK_SQL]);
    expect(client.ended).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith('refresh token cleanup failed');
  });

  it('DB に接続できなくても例外を投げず failed を返す', async () => {
    const client = new FakeClient({
      connectError: new Error('connect ECONNREFUSED'),
    });
    const service = new RefreshTokenCleanupService(undefined, () => client, 0);

    await expect(service.runOnce()).resolves.toEqual({ status: 'failed' });
    expect(client.executed).toEqual([]);
    expect(client.ended).toBe(true);
  });

  it('接続の error event を受けてもプロセスを落とさない（listener を必ず登録する）', async () => {
    const client = new FakeClient({ locked: true });
    const service = new RefreshTokenCleanupService(undefined, () => client, 0);
    await service.runOnce();

    // listener が無ければ EventEmitter の 'error' は例外になる。
    expect(() =>
      client.emit('error', new Error('Connection terminated unexpectedly')),
    ).not.toThrow();
  });

  it('shutdown 時は minLockHoldMs の待機を打ち切って unlock する', async () => {
    const client = new FakeClient({ locked: true });
    const service = new RefreshTokenCleanupService(
      undefined,
      () => client,
      60_000,
    );

    const running = service.runOnce();
    // lock 取得・削除が終わって待機に入るまで進める。
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    service.onModuleDestroy();

    await expect(running).resolves.toMatchObject({ status: 'completed' });
    expect(coreSql(client)).toEqual([TRY_LOCK_SQL, CLEANUP_SQL, UNLOCK_SQL]);
    expect(client.ended).toBe(true);
  });

  it('起動時に定期実行の登録（cron と次回時刻）をログに出す', () => {
    const service = new RefreshTokenCleanupService(
      {
        getCronJob: () => ({
          nextDate: () => ({ toUTC: () => ({ toISO: () => '2026-10-07T18:30:00.000Z' }) }),
        }),
      } as never,
      () => new FakeClient(),
      0,
    );

    service.onApplicationBootstrap();

    expect(logSpy).toHaveBeenCalledWith(
      'refresh token cleanup scheduled: cron="30 18 * * *" (UTC), next run at 2026-10-07T18:30:00.000Z',
    );
  });
});
