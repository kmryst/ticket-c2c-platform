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
  parseStringOption,
} from '../search/projection-cli.shared';
import type { InventoryWriterMode } from '../database/inventory-writer-control';
import {
  checkCutoverDatabase,
  checkCutoverOpenSearch,
  checkCutoverValkey,
  CutoverCheckPhase,
  hasTicketTypeCutoverViolations,
  serializeTicketTypeCutoverEvidence,
  TicketTypeCutoverReadinessResult,
} from './ticket-type-cutover-readiness';

const USAGE =
  'usage: --expect-mode <legacy|ticket_type> --phase <preflight|postflight> [--page-size N] [--max-findings N]';

function parseExpectMode(argv: string[]): InventoryWriterMode {
  const raw = parseStringOption(argv, 'expect-mode');
  if (raw !== 'legacy' && raw !== 'ticket_type') {
    throw new Error(USAGE);
  }
  return raw;
}

// --phase は既定値を持たない必須オプションにする。postflight は他方 namespace の
// counter 不在・stale を許容する緩和規則なので、暗黙に選ばれてはいけない
// （fail closed: 局面を明示しない実行は使用エラーで停止する）。
function parsePhase(argv: string[]): CutoverCheckPhase {
  const raw = parseStringOption(argv, 'phase');
  if (raw !== 'preflight' && raw !== 'postflight') {
    throw new Error(USAGE);
  }
  return raw;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const expectedWriterMode = parseExpectMode(argv);
  const checkPhase = parsePhase(argv);
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
    // 接続確立後に Valkey が応答不能になった場合の保険。DB 側の statement_timeout は
    // Valkey への GET 待ちには効かないため、command timeout が無いと REPEATABLE READ
    // snapshot を掴んだ transaction が無期限に保持され、vacuum horizon の停滞と
    // DB bloat を招く（timeout 到達時は fail closed に実行エラーで停止する）。
    commandTimeout: 5000,
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
      // statement_timeout は「クエリ実行中」にしか効かない。Valkey 待ちなどで
      // transaction が statement 間に留まった場合も DB 側から打ち切れるよう、
      // idle_in_transaction_session_timeout を同じ桁で設定する（多層防御）。
      await snapshotClient.query(
        "SET LOCAL idle_in_transaction_session_timeout = '60s'",
      );

      databaseCheck = await checkCutoverDatabase(
        snapshotClient,
        expectedWriterMode,
      );
      valkeyResults = await checkCutoverValkey(
        snapshotClient,
        valkey,
        expectedWriterMode,
        checkPhase,
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
      checkPhase,
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
