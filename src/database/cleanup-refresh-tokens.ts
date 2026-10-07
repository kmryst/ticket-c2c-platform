// ファイル概要:
// このファイルは refresh_tokens 期限切れクリーンアップの手動実行の入口です（L-9 残課題、Issue #195）。
// 日次の実行は api プロセス内の定期実行（refresh-token-cleanup.service.ts、Issue #542 / ADR-0041）が行い、
// この入口は定期実行が失敗し続けたときの再実行など、運用者が手動で 1 回だけ実行する経路として残します。
// - AWS: ECS run-task の command override で、稼働中の api の task definition から起動する:
//   node dist/src/database/cleanup-refresh-tokens.js
// - ローカル検証: ts-node src/database/cleanup-refresh-tokens.ts
// api の定期実行と同じ advisory lock を取るため、api の実行と重なっても削除は 1 か所でしか走りません
// （lock を取れなければ何もせず終わります）。
// 短命プロセスのため、DB パスワードは静的注入の DB_PASSWORD（buildDatabaseUrl）で足ります
// （run-migrations.ts と同じ判断。ローテーション追従は不要）。
//
// 出力は標準出力のみで、CloudWatch Logs（API タスクのロググループ）へそのまま流れます。
// 失敗時は非 0 exit で ECS タスクが failed になり、ログから追えます。

import 'dotenv/config';
import { Client } from 'pg';
import { buildDatabaseUrl, getDatabaseSslConfig } from '../config';
import { runRefreshTokenCleanupWithLock } from './refresh-token-cleanup';
import { resolveRetentionDays } from './refresh-token-cleanup.config';

async function main(): Promise<void> {
  const retentionDays = resolveRetentionDays();
  const client = new Client({
    connectionString: buildDatabaseUrl(),
    // Aurora では RDS CA バンドルによる証明書検証つき TLS で接続する（production-readiness M-4）。
    ssl: getDatabaseSslConfig(),
  });

  await client.connect();
  try {
    const result = await runRefreshTokenCleanupWithLock(client, {
      retentionDays,
    });
    if (result.status === 'skipped') {
      console.log(
        'refresh token cleanup skipped: another process holds the advisory lock',
      );
      return;
    }
    // 運用時はこの 1 行を CloudWatch Logs で確認します。
    console.log(
      `refresh token cleanup completed: deleted ${result.deletedRows} rows in ${result.deletedFamilies} families` +
        ` (${result.batches} batches${result.reachedMaxBatches ? ', reached max batches; run again to continue' : ''};` +
        ` retention: expired > ${retentionDays} days ago, family-wise)`,
    );
  } finally {
    // 接続を閉じると session も終わり、advisory lock は必ず解放されます。
    await client.end();
  }
}

main().catch((error) => {
  console.error('refresh token cleanup failed');
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
