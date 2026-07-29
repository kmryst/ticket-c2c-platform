// ファイル概要:
// Issue #336 の Ticket Type expand schema readiness checker を CLI から実行します。
// #337 の cutover 前や #335 Rollout Gate A の証跡取得で使い、不整合があれば exit 1 で停止します。

import 'dotenv/config';
import { Client } from 'pg';
import { buildDatabaseUrl, getDatabaseSslConfig } from '../config';
import {
  checkTicketTypeExpandReadiness,
  hasTicketTypeExpandViolations,
  TICKET_TYPE_EXPAND_READINESS_CATEGORIES,
} from './ticket-type-expand-readiness';

async function main(): Promise<void> {
  const client = new Client({
    connectionString: buildDatabaseUrl(),
    ssl: getDatabaseSslConfig(),
  });
  await client.connect();
  let transactionStarted = false;

  try {
    // 1つのsnapshotで全categoryを照合し、このCLIからDB変更できないこともDB側で強制する。
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    transactionStarted = true;
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '5s'");

    const results = await checkTicketTypeExpandReadiness(client);
    await client.query('COMMIT');
    transactionStarted = false;
    const hasViolations = hasTicketTypeExpandViolations(results);
    console.log(
      JSON.stringify(
        {
          results,
          categoryCount: TICKET_TYPE_EXPAND_READINESS_CATEGORIES.length,
          complete: true,
        },
        null,
        2,
      ),
    );

    if (hasViolations) {
      process.exitCode = 1;
    }
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Ticket Type readiness rollback failed');
        console.error(
          rollbackError instanceof Error
            ? (rollbackError.stack ?? rollbackError.message)
            : rollbackError,
        );
      }
    }
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Ticket Type expand readiness check failed');
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
