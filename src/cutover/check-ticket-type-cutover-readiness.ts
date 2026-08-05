// ファイル概要:
// Issue #378 の Gate B cutover readiness checker を CLI から実行します。
// #335 Gate B の preflight / postflight 証跡取得で使い、DB / control state / Valkey /
// OpenSearch のいずれかに差分があれば fail closed で停止します。
//
// exit code:
// - 0: 全 category violation 0（evidence を stdout へ 1 行 JSON で出力）
// - 2: violation あり（evidence は出力する）
// - 1: 実行エラー（接続失敗・revision 不明・control state を attest できない等。evidence なし）
//
// evidence には secret / credential を含めません（category 名・件数・id のみ）。

import 'dotenv/config';
import Redis from 'ioredis';
import { getOptionalEnv } from '../config';
import { EVENTS_INDEX } from '../search/events-projection.store';
import {
  createProjectionClients,
  parseIntOption,
} from '../search/projection-cli.shared';
import type { InventoryWriterMode } from '../database/inventory-writer-control';
import {
  checkCutoverDatabase,
  checkCutoverOpenSearch,
  checkCutoverValkey,
  hasTicketTypeCutoverViolations,
  serializeTicketTypeCutoverEvidence,
  TicketTypeCutoverReadinessResult,
} from './ticket-type-cutover-readiness';

// parseStringOption は `--name=value` / `--name value` 形式の文字列オプションを読みます。
function parseStringOption(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const eq = argv.find((a) => a.startsWith(prefix));
  if (eq) {
    return eq.slice(prefix.length);
  }
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  return undefined;
}

function parseExpectMode(argv: string[]): InventoryWriterMode {
  const raw = parseStringOption(argv, 'expect-mode');
  if (raw !== 'legacy' && raw !== 'ticket_type') {
    throw new Error(
      'usage: --expect-mode <legacy|ticket_type> [--page-size N] [--max-findings N]',
    );
  }
  return raw;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const expectedWriterMode = parseExpectMode(argv);
  const pageSize = parseIntOption(argv, 'page-size');
  const maxFindings = parseIntOption(argv, 'max-findings');

  // checker は fail-open にしない: Valkey へ接続できなければ実行エラーで停止する
  // （購入 API の InventoryCacheService と異なり、誤って green を返してはいけない）。
  const valkeyUrl = getOptionalEnv('VALKEY_URL');
  if (!valkeyUrl) {
    throw new Error('VALKEY_URL is required for cutover readiness check');
  }

  const { pool, opensearch } = createProjectionClients();
  const valkey = new Redis(valkeyUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    lazyConnect: true,
  });

  try {
    await valkey.connect();

    // DB / control state / Valkey 突き合わせは 1 つの REPEATABLE READ READ ONLY
    // snapshot で読む。READ ONLY により、この CLI から DB を変更できないことを DB 側でも強制する。
    const snapshotClient = await pool.connect();
    let transactionStarted = false;
    let databaseCheck: Awaited<ReturnType<typeof checkCutoverDatabase>>;
    let valkeyResults: TicketTypeCutoverReadinessResult[];
    try {
      await snapshotClient.query(
        'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      transactionStarted = true;
      await snapshotClient.query("SET LOCAL statement_timeout = '60s'");
      await snapshotClient.query("SET LOCAL lock_timeout = '5s'");

      databaseCheck = await checkCutoverDatabase(
        snapshotClient,
        expectedWriterMode,
      );
      valkeyResults = await checkCutoverValkey(
        snapshotClient,
        valkey,
        expectedWriterMode,
        { pageSize },
      );

      await snapshotClient.query('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          await snapshotClient.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('cutover readiness rollback failed');
          console.error(
            rollbackError instanceof Error
              ? (rollbackError.stack ?? rollbackError.message)
              : rollbackError,
          );
        }
      }
      throw error;
    } finally {
      snapshotClient.release();
    }

    // control state を attest できない場合は evidence を作れない（実行エラーで停止）。
    // writer_control_state_missing_or_invalid は violation としても数えているが、
    // evidence は writerMode を必須にしているため、この経路は exit 1 とする（fail closed）。
    if (databaseCheck.writerMode === null) {
      throw new Error(
        'inventory writer control state is missing or invalid; cannot attest writerMode',
      );
    }

    // OpenSearch reconciliation は #377 の実装が自前 snapshot を開始するため、専用
    // connection で外側 transaction と分けて実行する（cross-store snapshot は元々非原子的）。
    const projectionClient = await pool.connect();
    let opensearchCheck: Awaited<ReturnType<typeof checkCutoverOpenSearch>>;
    try {
      opensearchCheck = await checkCutoverOpenSearch(
        projectionClient,
        opensearch,
        { index: EVENTS_INDEX, pageSize, maxFindings },
      );
    } finally {
      projectionClient.release();
    }

    const results = [
      ...databaseCheck.results,
      ...valkeyResults,
      opensearchCheck.result,
    ];
    const evidence = serializeTicketTypeCutoverEvidence({
      expectedWriterMode,
      writerMode: databaseCheck.writerMode,
      schemaRevision: databaseCheck.schemaRevision,
      opensearchIndex: EVENTS_INDEX,
      results,
      opensearchReport: opensearchCheck.report,
    });
    const hasViolations = hasTicketTypeCutoverViolations(results);
    console.log(evidence);

    if (hasViolations) {
      process.exitCode = 2;
    }
  } finally {
    valkey.disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Ticket Type cutover readiness check failed');
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
