// ファイル概要:
// このファイルは refresh_tokens 期限切れクリーンアップの実行入口です（L-9 残課題、Issue #195）。
// API の boot path からは呼ばれず、次の経路からだけ実行します:
// - AWS: EventBridge Scheduler（日次）→ ECS RunTask の command override:
//   node dist/src/database/cleanup-refresh-tokens.js
//   （run-db-migration.sh と同じ「既存 API イメージ・別コマンド」パターン。terraform/modules/scheduled-task）
// - ローカル検証: ts-node src/database/cleanup-refresh-tokens.ts
// 短命プロセスのため、DB パスワードは静的注入の DB_PASSWORD（buildDatabaseUrl）で足ります
// （run-migrations.ts と同じ判断。ローテーション追従は不要）。
//
// 出力は標準出力のみで、CloudWatch Logs（API タスクのロググループ）へそのまま流れます。
// 新規アラーム等は追加しません（失敗時は非 0 exit で ECS タスクが failed になり、ログから追えます）。

import 'dotenv/config';
import { Client } from 'pg';
import { buildDatabaseUrl, getDatabaseSslConfig } from '../config';
import {
  cleanupExpiredRefreshTokenFamilies,
  DEFAULT_RETENTION_DAYS,
} from './refresh-token-cleanup';

// resolveRetentionDays は猶予日数を環境変数から読みます（未設定なら既定 30 日）。
function resolveRetentionDays(): number {
  const raw = process.env.REFRESH_TOKEN_RETENTION_DAYS;
  if (raw === undefined || raw === '') {
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

async function main(): Promise<void> {
  const retentionDays = resolveRetentionDays();
  const client = new Client({
    connectionString: buildDatabaseUrl(),
    // Aurora では RDS CA バンドルによる証明書検証つき TLS で接続する（production-readiness M-4）。
    ssl: getDatabaseSslConfig(),
  });

  await client.connect();
  try {
    const deleted = await cleanupExpiredRefreshTokenFamilies(
      client,
      retentionDays,
    );
    // 運用時はこの 1 行を CloudWatch Logs で確認します。
    console.log(
      `refresh token cleanup completed: deleted ${deleted} rows (retention: expired > ${retentionDays} days ago, family-wise)`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('refresh token cleanup failed');
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
