// ファイル概要:
// Issue #378 / ADR-0032 の writer mode 切替（activation / rollback）本体です。
// 排他 barrier（pg_advisory_xact_lock(335, 376)）で in-flight writer を drain し、
// #336 / #376 migration と同一の table lock 順で barrier を通らない writer も閉じ、
// mode 切替と DB parity 検査（PR-1 checkCutoverDatabase の再利用）を 1 transaction に
// 閉じます。timeout・lock 競合・違反検出のいずれでも ROLLBACK し、中間 state を
// 永続化しません。
//
// activation（legacy -> ticket_type）と rollback（ticket_type -> legacy）は同じ経路の
// 逆方向実行です。この module は inventory_writer_control の 1 行 UPDATE 以外に
// 一切書き込みません（Valkey / OpenSearch / schema への write API を持たないことが
// 「compatibility artifact を維持したまま全体を戻す」制約の実装です）。

import type { Pool, PoolClient } from 'pg';
import type { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import {
  acquireExclusiveInventoryWriterBarrier,
  InventoryWriterMode,
  updateInventoryWriterMode,
} from '../database/inventory-writer-control';
import {
  checkCutoverDatabase,
  checkCutoverOpenSearch,
  checkCutoverValkey,
  hasTicketTypeCutoverViolations,
  serializeTicketTypeCutoverEvidence,
  TicketTypeCutoverReadinessResult,
  ValkeyReadClient,
} from './ticket-type-cutover-readiness';

type QueryClient = Pick<PoolClient, 'query'>;

export function oppositeWriterMode(
  mode: InventoryWriterMode,
): InventoryWriterMode {
  return mode === 'legacy' ? 'ticket_type' : 'legacy';
}

// SET LOCAL はパラメータ化できないため、interpolate する値の形式を fail closed に
// 制限する（単位付き非負整数のみ）。
const TIMEOUT_LITERAL = /^[0-9]+(ms|s|min)$/;

export interface WriterModeSwitchTimeouts {
  // lock_timeout は排他 barrier の取得待ち（= in-flight writer の drain 待ち）と
  // table lock 取得の両方に効く。10s は #336 / #376 migration の実績値と同一。
  lockTimeout: string;
  // statement_timeout 60s は PR-1 checker の DB 検査 budget と同一
  // （同じ parity SQL を同じ budget で実行する）。
  statementTimeout: string;
  idleInTransactionTimeout: string;
}

export const DEFAULT_WRITER_MODE_SWITCH_TIMEOUTS: WriterModeSwitchTimeouts = {
  lockTimeout: '10s',
  statementTimeout: '60s',
  idleInTransactionTimeout: '60s',
};

function assertTimeoutLiteral(value: string, label: string): string {
  if (!TIMEOUT_LITERAL.test(value)) {
    throw new Error(`${label} must match ${TIMEOUT_LITERAL}: ${value}`);
  }
  return value;
}

// #336 / #376 migration と同一の順序・lock mode（ADR-0028 / ADR-0032）。
// events を先頭の gate として既存 transaction を drain し、後段は NOWAIT で
// 「後段 lock を先取した想定外 writer」を待たずに即 rollback する。
export const WRITER_MODE_SWITCH_TABLE_LOCK_SQL = `
LOCK TABLE events IN EXCLUSIVE MODE;
LOCK TABLE purchases IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE ticket_types IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE ticket_inventory IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE ticket_type_inventory IN SHARE ROW EXCLUSIVE MODE NOWAIT;
`;

// assertNoCutoverViolations は violation が 1 件でもあれば category 一覧付きで
// fail closed に停止します。
export function assertNoCutoverViolations(
  results: readonly TicketTypeCutoverReadinessResult[],
  label: string,
): void {
  const violated = results.filter((result) => result.violationCount > 0);
  if (violated.length === 0) {
    return;
  }
  const summary = violated
    .map((result) => `${result.category}=${result.violationCount}`)
    .join(', ');
  throw new Error(`${label} readiness violations detected: ${summary}`);
}

export interface ExecuteWriterModeSwitchOptions {
  // preflight 時点の schemaRevision。切替 transaction 内で再読した revision と
  // 一致しない場合は fail closed で停止する（preflight と切替の間の migration 適用を検出）。
  expectedSchemaRevision?: string;
  timeouts?: Partial<WriterModeSwitchTimeouts>;
}

export interface ExecuteWriterModeSwitchResult {
  sourceMode: InventoryWriterMode;
  targetMode: InventoryWriterMode;
  schemaRevision: string;
}

// executeWriterModeSwitch は ADR-0032 の切替 transaction を実行します。
// drain・table lock・切替前 parity 検査（source mode）・mode UPDATE・切替後 parity
// 検査（target mode）を 1 transaction に閉じ、どの失敗でも ROLLBACK して例外を投げます。
export async function executeWriterModeSwitch(
  client: QueryClient,
  targetMode: InventoryWriterMode,
  options: ExecuteWriterModeSwitchOptions = {},
): Promise<ExecuteWriterModeSwitchResult> {
  if (targetMode !== 'legacy' && targetMode !== 'ticket_type') {
    throw new Error(`invalid target writer mode: ${String(targetMode)}`);
  }
  const sourceMode = oppositeWriterMode(targetMode);
  const timeouts: WriterModeSwitchTimeouts = {
    ...DEFAULT_WRITER_MODE_SWITCH_TIMEOUTS,
    ...options.timeouts,
  };
  const lockTimeout = assertTimeoutLiteral(timeouts.lockTimeout, 'lock_timeout');
  const statementTimeout = assertTimeoutLiteral(
    timeouts.statementTimeout,
    'statement_timeout',
  );
  const idleTimeout = assertTimeoutLiteral(
    timeouts.idleInTransactionTimeout,
    'idle_in_transaction_session_timeout',
  );

  await client.query('BEGIN');
  try {
    await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
    await client.query(`SET LOCAL statement_timeout = '${statementTimeout}'`);
    await client.query(
      `SET LOCAL idle_in_transaction_session_timeout = '${idleTimeout}'`,
    );
    await client.query('SET LOCAL search_path = public, pg_catalog, pg_temp');

    // 排他 barrier: shared 保持中の in-flight writer の commit / abort を待って drain し、
    // 新規 writer を block する（lock_timeout が drain 待ちの上限になる）。
    await acquireExclusiveInventoryWriterBarrier(client);
    // barrier を通らない直接 SQL writer / 旧 binary への defense-in-depth。
    await client.query(WRITER_MODE_SWITCH_TABLE_LOCK_SQL);

    // 切替前 parity: 現在の control state が source mode として無違反であることを確認する。
    const before = await checkCutoverDatabase(client, sourceMode);
    if (before.writerMode === null) {
      throw new Error(
        'inventory writer control state is missing or invalid; refusing to switch',
      );
    }
    if (before.writerMode !== sourceMode) {
      throw new Error(
        `writer mode switch aborted: expected current mode ${sourceMode} but found ${before.writerMode}`,
      );
    }
    if (
      options.expectedSchemaRevision !== undefined &&
      before.schemaRevision !== options.expectedSchemaRevision
    ) {
      throw new Error(
        `writer mode switch aborted: schema revision changed since preflight (expected ${options.expectedSchemaRevision}, found ${before.schemaRevision})`,
      );
    }
    assertNoCutoverViolations(before.results, `pre-switch (${sourceMode})`);

    await updateInventoryWriterMode(client, targetMode);

    // 切替後 parity: 同じ snapshot 上で target mode としても無違反であることを確認して
    // から commit する（違反があれば ROLLBACK され、mode 変更は永続化されない）。
    const after = await checkCutoverDatabase(client, targetMode);
    if (after.writerMode !== targetMode) {
      throw new Error(
        `writer mode switch aborted: control state did not converge to ${targetMode}`,
      );
    }
    assertNoCutoverViolations(after.results, `post-switch (${targetMode})`);

    await client.query('COMMIT');
    return {
      sourceMode,
      targetMode,
      schemaRevision: before.schemaRevision,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

// --- preflight + 切替の合成（CLI 本体） ---

export interface WriterModeSwitchClients {
  pool: Pool;
  valkey: ValkeyReadClient;
  opensearch: OpenSearchClient;
}

export interface RunWriterModeSwitchOptions {
  targetMode: InventoryWriterMode;
  opensearchIndex: string;
  pageSize?: number;
  maxFindings?: number;
  timeouts?: Partial<WriterModeSwitchTimeouts>;
}

export type WriterModeSwitchOutcome =
  | { status: 'preflight_violations'; evidence: string }
  | {
      status: 'switched';
      evidence: string;
      result: ExecuteWriterModeSwitchResult;
    };

// runWriterModeSwitch は ADR-0032 の Phase 1（in-process preflight）と Phase 2
// （切替 transaction）を実行します。preflight は PR-1 checker 関数を expected mode =
// source（現 mode）・phase = preflight で再実行し、violation が 1 件でもあれば切替
// transaction を開始せず evidence を返します（呼び出し側は exit 2）。
// Valkey / OpenSearch は DB transaction に参加できないため、直前の in-process 実行で
// TOCTOU 窓を最小化し、DB parity だけは切替 transaction 内で再検査します。
export async function runWriterModeSwitch(
  clients: WriterModeSwitchClients,
  options: RunWriterModeSwitchOptions,
): Promise<WriterModeSwitchOutcome> {
  const { pool, valkey, opensearch } = clients;
  const targetMode = options.targetMode;
  if (targetMode !== 'legacy' && targetMode !== 'ticket_type') {
    throw new Error(`invalid target writer mode: ${String(targetMode)}`);
  }
  const sourceMode = oppositeWriterMode(targetMode);

  // Phase 1: in-process preflight（check-ticket-type-cutover-readiness と同じ規則）。
  const snapshotClient = await pool.connect();
  let databaseCheck: Awaited<ReturnType<typeof checkCutoverDatabase>>;
  let valkeyResults: TicketTypeCutoverReadinessResult[];
  let transactionStarted = false;
  try {
    await snapshotClient.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    transactionStarted = true;
    await snapshotClient.query("SET LOCAL statement_timeout = '60s'");
    await snapshotClient.query("SET LOCAL lock_timeout = '5s'");
    await snapshotClient.query(
      "SET LOCAL idle_in_transaction_session_timeout = '60s'",
    );

    databaseCheck = await checkCutoverDatabase(snapshotClient, sourceMode);
    valkeyResults = await checkCutoverValkey(
      snapshotClient,
      valkey,
      sourceMode,
      'preflight',
      { pageSize: options.pageSize },
    );

    await snapshotClient.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await snapshotClient.query('ROLLBACK').catch(() => undefined);
    }
    throw error;
  } finally {
    snapshotClient.release();
  }

  // control state を attest できなければ切替を試みない（実行エラーで停止）。
  if (databaseCheck.writerMode === null) {
    throw new Error(
      'inventory writer control state is missing or invalid; cannot attest writerMode',
    );
  }
  // 既に target mode の場合は暗黙の no-op にしない。切替は原子的で「途中まで進んだ
  // 再実行」は存在しないため、同一 mode への再実行は運用の状況誤認として扱う（ADR-0032）。
  if (databaseCheck.writerMode === targetMode) {
    throw new Error(
      `writer mode is already ${targetMode}; refusing implicit no-op switch`,
    );
  }

  // OpenSearch reconciliation は #377 実装が自前 snapshot を開始するため専用 connection。
  const projectionClient = await pool.connect();
  let opensearchCheck: Awaited<ReturnType<typeof checkCutoverOpenSearch>>;
  try {
    opensearchCheck = await checkCutoverOpenSearch(projectionClient, opensearch, {
      index: options.opensearchIndex,
      pageSize: options.pageSize,
      maxFindings: options.maxFindings,
    });
  } finally {
    projectionClient.release();
  }

  const results = [
    ...databaseCheck.results,
    ...valkeyResults,
    opensearchCheck.result,
  ];
  const evidence = serializeTicketTypeCutoverEvidence({
    expectedWriterMode: sourceMode,
    checkPhase: 'preflight',
    writerMode: databaseCheck.writerMode,
    schemaRevision: databaseCheck.schemaRevision,
    opensearchIndex: options.opensearchIndex,
    results,
    opensearchReport: opensearchCheck.report,
  });

  if (hasTicketTypeCutoverViolations(results)) {
    return { status: 'preflight_violations', evidence };
  }

  // Phase 2: 切替 transaction（drain・table lock・parity・UPDATE・parity を 1 transaction）。
  const switchClient = await pool.connect();
  try {
    const result = await executeWriterModeSwitch(switchClient, targetMode, {
      expectedSchemaRevision: databaseCheck.schemaRevision,
      timeouts: options.timeouts,
    });
    return { status: 'switched', evidence, result };
  } finally {
    switchClient.release();
  }
}
