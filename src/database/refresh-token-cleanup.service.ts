// ファイル概要:
// このファイルは refresh_tokens 期限切れクリーンアップを api プロセス内で日次実行する service です
// （Issue #542 / ADR-0041。#195 の EventBridge Scheduler → ECS RunTask を置き換える）。
//
// - @nestjs/schedule の @Cron で毎日 18:30 UTC（03:30 JST）に実行します。
// - api は複数タスクで動くため、PostgreSQL の advisory lock（pg_try_advisory_lock）で
//   同時刻の実行を 1 タスクに絞ります。lock を取れなかったタスクは何もしません。
// - 接続は DatabaseService の pool（リクエスト処理用、max 10）から借りず、実行のたびに専用の
//   pg Client を作り、最後に必ず閉じます。session-level lock を pool に返した接続に残さないためと、
//   lock の保持中（minLockHoldMs）にリクエスト処理用の接続を 1 本ふさがないためです。
// - 失敗はログに出すだけで、例外を外へ投げません（api プロセスを落とさない）。
//   接続の切断（Aurora のフェイルオーバー等）でも、client の error event を受けてログに残し、
//   進行中の query の reject として処理します（database.service.ts の H-4 対応と同じ考え方）。
//   接続が切れれば PostgreSQL 側の session も終わるため、advisory lock は残りません。

import {
  Inject,
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { Cron, SchedulerRegistry } from '@nestjs/schedule';
import { setTimeout as sleepWithSignal } from 'node:timers/promises';
import { Client } from 'pg';
import { getDatabasePoolConfig, getDatabaseSslConfig } from '../config';
import {
  LockedCleanupResult,
  runRefreshTokenCleanupWithLock,
} from './refresh-token-cleanup';
import {
  isCleanupEnabled,
  resolveCleanupCron,
  resolveMinLockHoldMs,
  resolveRetentionDays,
} from './refresh-token-cleanup.config';

// REFRESH_TOKEN_CLEANUP_JOB_NAME は SchedulerRegistry 上の job 名です（起動ログにも出します）。
export const REFRESH_TOKEN_CLEANUP_JOB_NAME = 'refresh-token-cleanup';

// DEFAULT_MIN_LOCK_HOLD_MS は lock を保持する最短時間です（ShedLock の lockAtLeastFor と同じ考え方）。
// 各タスクの発火時刻は接続確立・Secrets Manager からのパスワード取得・Aurora の auto-pause からの
// 再開待ちで数秒〜数十秒ずれることがあるため、余裕を持って 5 分にしています。
export const DEFAULT_MIN_LOCK_HOLD_MS = 5 * 60 * 1000;

// STATEMENT_TIMEOUT / LOCK_TIMEOUT は専用接続の session にだけ設定する上限です。
// 削除 statement が想定外に長引いたり、row lock 待ちで止まり続けたりしないようにします。
const STATEMENT_TIMEOUT = '5min';
const LOCK_TIMEOUT = '10s';

// CleanupClient は専用接続に必要な操作だけを表す interface です（テストで fake に差し替えます）。
export interface CleanupClient {
  connect(): Promise<unknown>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rowCount: number | null; rows: unknown[] }>;
  end(): Promise<void>;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

// REFRESH_TOKEN_CLEANUP_CLIENT_FACTORY は専用接続を作る関数の DI token です。
export const REFRESH_TOKEN_CLEANUP_CLIENT_FACTORY = Symbol(
  'REFRESH_TOKEN_CLEANUP_CLIENT_FACTORY',
);
export type CleanupClientFactory = () => CleanupClient;

// REFRESH_TOKEN_CLEANUP_MIN_LOCK_HOLD_MS は minLockHoldMs を上書きする DI token です（テスト用）。
export const REFRESH_TOKEN_CLEANUP_MIN_LOCK_HOLD_MS = Symbol(
  'REFRESH_TOKEN_CLEANUP_MIN_LOCK_HOLD_MS',
);

// createDefaultCleanupClient は api の pool と同じ接続設定（Secrets Manager の動的パスワード・
// RDS CA 検証つき TLS）で、クリーンアップ専用の pg Client を作ります。
export function createDefaultCleanupClient(): CleanupClient {
  return new Client({
    ...getDatabasePoolConfig(),
    ssl: getDatabaseSslConfig(),
    connectionTimeoutMillis: 5000,
  });
}

export type RefreshTokenCleanupRunResult =
  | LockedCleanupResult
  | { status: 'failed' };

@Injectable()
export class RefreshTokenCleanupService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  // shutdown（SIGTERM）時に minLockHoldMs の待機を打ち切るための signal です。
  private readonly shutdown = new AbortController();
  private readonly createClient: CleanupClientFactory;
  private readonly minLockHoldMs: number;

  constructor(
    @Optional() private readonly schedulerRegistry?: SchedulerRegistry,
    @Optional()
    @Inject(REFRESH_TOKEN_CLEANUP_CLIENT_FACTORY)
    createClient?: CleanupClientFactory,
    @Optional()
    @Inject(REFRESH_TOKEN_CLEANUP_MIN_LOCK_HOLD_MS)
    minLockHoldMs?: number,
  ) {
    this.createClient = createClient ?? createDefaultCleanupClient;
    this.minLockHoldMs =
      minLockHoldMs ?? resolveMinLockHoldMs() ?? DEFAULT_MIN_LOCK_HOLD_MS;
  }

  // 起動ログに定期実行の登録（次回の実行時刻）を 1 行出します（Issue #542 の受け入れ条件）。
  onApplicationBootstrap(): void {
    if (!isCleanupEnabled()) {
      console.log(
        'refresh token cleanup schedule is disabled (REFRESH_TOKEN_CLEANUP_ENABLED=false)',
      );
      return;
    }
    let nextRun = 'unknown';
    try {
      const job = this.schedulerRegistry?.getCronJob(
        REFRESH_TOKEN_CLEANUP_JOB_NAME,
      );
      const next = job?.nextDate();
      if (next) {
        nextRun = next.toUTC().toISO() ?? 'unknown';
      }
    } catch {
      // 登録の確認に失敗しても起動は止めません。
    }
    console.log(
      `refresh token cleanup scheduled: cron="${resolveCleanupCron()}" (UTC), next run at ${nextRun}`,
    );
  }

  onModuleDestroy(): void {
    this.shutdown.abort();
  }

  // handleCron は @nestjs/schedule から呼ばれる入口です。
  // waitForCompletion で同じプロセス内の重複起動を防ぎ、threshold を広げて
  // イベントループが一時的に詰まっても日次の実行を飛ばさないようにします。
  @Cron(resolveCleanupCron(), {
    name: REFRESH_TOKEN_CLEANUP_JOB_NAME,
    timeZone: 'UTC',
    waitForCompletion: true,
    disabled: !isCleanupEnabled(),
    threshold: 60_000,
  })
  async handleCron(): Promise<void> {
    await this.runOnce();
  }

  // runOnce は 1 回分の実行です。例外は投げず、結果を返します。
  async runOnce(): Promise<RefreshTokenCleanupRunResult> {
    let client: CleanupClient | undefined;
    try {
      const retentionDays = resolveRetentionDays();
      client = this.createClient();
      // 接続中・実行中に接続が切れると、error event が client から出ます。
      // listener が無いと未捕捉例外で api プロセスが落ちるため、必ずログに残します。
      client.on('error', (error) => {
        console.error(
          'refresh token cleanup: unexpected pg client error (connection likely lost):',
          error,
        );
      });
      await client.connect();
      await client.query(`SET statement_timeout = '${STATEMENT_TIMEOUT}'`);
      await client.query(`SET lock_timeout = '${LOCK_TIMEOUT}'`);

      const result = await runRefreshTokenCleanupWithLock(client, {
        retentionDays,
        minLockHoldMs: this.minLockHoldMs,
        sleep: (ms) => this.sleepUnlessShuttingDown(ms),
        onUnlockError: (error) => {
          console.error(
            'refresh token cleanup: advisory unlock failed (released when the connection closes):',
            error,
          );
        },
      });

      if (result.status === 'skipped') {
        console.log(
          'refresh token cleanup skipped: another api task holds the advisory lock',
        );
      } else {
        // 運用時はこの 1 行を CloudWatch Logs（API のロググループ）で確認します。
        console.log(
          `refresh token cleanup completed: deleted ${result.deletedRows} rows in ${result.deletedFamilies} families` +
            ` (${result.batches} batches${result.reachedMaxBatches ? ', reached max batches; the rest is left to the next run' : ''};` +
            ` retention: expired > ${retentionDays} days ago, family-wise)`,
        );
      }
      return result;
    } catch (error) {
      console.error('refresh token cleanup failed');
      console.error(
        error instanceof Error ? (error.stack ?? error.message) : error,
      );
      return { status: 'failed' };
    } finally {
      if (client) {
        // 接続を閉じると session も終わり、unlock に失敗していても advisory lock は解放されます。
        await client.end().catch((error: unknown) => {
          console.error('refresh token cleanup: failed to close connection:', error);
        });
      }
    }
  }

  // sleepUnlessShuttingDown は minLockHoldMs の待機です。shutdown 時は待たずに戻ります。
  private async sleepUnlessShuttingDown(ms: number): Promise<void> {
    try {
      await sleepWithSignal(ms, undefined, { signal: this.shutdown.signal });
    } catch {
      // AbortError（shutdown）は待機の打ち切りなので無視します。
    }
  }
}
