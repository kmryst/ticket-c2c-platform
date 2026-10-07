// ファイル概要:
// このファイルは refresh_tokens クリーンアップ（Issue #195 / #542）の設定を環境変数から読む helper です。
// api の定期実行（refresh-token-cleanup.service.ts）と手動実行の入口（cleanup-refresh-tokens.ts）で共有します。

import { getOptionalEnv } from '../config';
import { DEFAULT_RETENTION_DAYS } from './refresh-token-cleanup';

// DEFAULT_REFRESH_TOKEN_CLEANUP_CRON は定期実行の既定スケジュールです（UTC で解釈します）。
// 毎日 18:30 UTC = 03:30 JST。#195 の EventBridge Scheduler（cron(30 18 * * ? *)）と同じ時刻で、
// トラフィックの少ない深夜帯に寄せています。
export const DEFAULT_REFRESH_TOKEN_CLEANUP_CRON = '30 18 * * *';

// resolveRetentionDays は猶予日数を REFRESH_TOKEN_RETENTION_DAYS から読みます（未設定なら既定 30 日）。
export function resolveRetentionDays(): number {
  const raw = getOptionalEnv('REFRESH_TOKEN_RETENTION_DAYS');
  if (raw === undefined) {
    return DEFAULT_RETENTION_DAYS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `REFRESH_TOKEN_RETENTION_DAYS must be a non-negative integer, got: ${raw}`,
    );
  }
  return parsed;
}

// resolveCleanupCron は定期実行のスケジュール（cron 式）を REFRESH_TOKEN_CLEANUP_CRON から読みます。
// ローカルの多重実行の確認で短い間隔（例: 秒指定の '*/20 * * * * *'）にするためのもので、
// AWS の task definition では設定せず既定値を使います。
export function resolveCleanupCron(): string {
  return (
    getOptionalEnv('REFRESH_TOKEN_CLEANUP_CRON') ??
    DEFAULT_REFRESH_TOKEN_CLEANUP_CRON
  );
}

// isCleanupEnabled は定期実行を登録するかを REFRESH_TOKEN_CLEANUP_ENABLED から読みます。
// 既定は有効で、'false' のときだけ無効にします（調査時に一時的に止めるための切り替え）。
export function isCleanupEnabled(): boolean {
  return getOptionalEnv('REFRESH_TOKEN_CLEANUP_ENABLED') !== 'false';
}

// resolveMinLockHoldMs は lock を保持する最短時間（ミリ秒）の上書きを REFRESH_TOKEN_CLEANUP_MIN_LOCK_HOLD_MS
// から読みます。未設定なら undefined を返し、service の既定値（5 分）を使います。
// REFRESH_TOKEN_CLEANUP_CRON と同じく、ローカルで短い間隔の実行を繰り返し確認するためのものです。
export function resolveMinLockHoldMs(): number | undefined {
  const raw = getOptionalEnv('REFRESH_TOKEN_CLEANUP_MIN_LOCK_HOLD_MS');
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `REFRESH_TOKEN_CLEANUP_MIN_LOCK_HOLD_MS must be a non-negative integer, got: ${raw}`,
    );
  }
  return parsed;
}
