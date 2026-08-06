// ファイル概要:
// Issue #378 / ADR-0032 の writer mode 切替（activation / rollback）本体です。
// 排他 barrier（pg_advisory_xact_lock(335, 376)）で in-flight writer を drain し、
// #336 / #376 migration と同一の table lock 順で barrier を通らない writer も閉じ、
// mode 切替と DB parity 検査（PR-1 checkCutoverDatabase の再利用）を 1 transaction に
// 閉じます。COMMIT 前の失敗（timeout・lock 競合・違反検出）はどれも ROLLBACK し、
// 中間 state を永続化しません。COMMIT 自体の失敗だけは「サーバ側で確定済みだが応答を
// 受信できなかった」可能性があり結果を断定できないため、commit_outcome_unknown として
// 区別し、別 connection での mode 再確認で切替済み / 未適用 / 不明を分離します。
//
// activation（legacy -> ticket_type）と rollback（ticket_type -> legacy）は同じ経路の
// 逆方向実行です。この module は inventory_writer_control の 1 行 UPDATE 以外に
// 一切書き込みません（Valkey / OpenSearch / schema への write API を持たないことが
// 「compatibility artifact を維持したまま全体を戻す」制約の実装です）。

import type { Pool, PoolClient } from 'pg';
import type { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import {
  acquireExclusiveInventoryWriterBarrier,
  INVENTORY_WRITER_TABLE_LOCK_SQL,
  InventoryWriterMode,
  readInventoryWriterMode,
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

// writer mode の実行時妥当性検査（executeWriterModeSwitch / runWriterModeSwitch の
// 両公開入口で共有する単一実装。型を欺く実行時入力を fail closed で拒否する）。
function assertTargetWriterMode(mode: InventoryWriterMode): void {
  if (mode !== 'legacy' && mode !== 'ticket_type') {
    throw new Error(`invalid target writer mode: ${String(mode)}`);
  }
}

// toError は release(err) / cause 用に unknown を Error へ正規化します。
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

// SET LOCAL はパラメータ化できないため、interpolate する値の形式を fail closed に
// 制限する。PostgreSQL では timeout 0 は「timeout 無効化」を意味し fail-closed の
// 前提が崩れるため、正の値だけを許す（先頭の余分な 0 は許容、値としての 0 は拒否）。
const TIMEOUT_LITERAL = /^0*[1-9][0-9]*(ms|s|min)$/;

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
    throw new Error(
      `${label} must be a positive duration matching ${TIMEOUT_LITERAL}: ${value}`,
    );
  }
  return value;
}

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
  // 切替後（target mode）の DB parity 検査の全 category 結果。成功時も「全 category
  // violation 0 で commit した」ことの機械可読な証跡として呼び出し側が保存できる。
  postSwitchDatabaseResults: TicketTypeCutoverReadinessResult[];
}

// WriterModeSwitchCommitOutcomeUnknownError は「COMMIT を送信したが結果を確認
// できなかった」ことを表します（例: サーバ側で commit 確定後、応答受信前の接続断）。
// この場合 DB は target mode へ切替済みの可能性があり、ROLLBACK では取り消せません。
// 他の失敗（violation・timeout・lock 競合。これらは ROLLBACK が確実に効く）と
// 機械可読に区別し、呼び出し側は別 connection で現在の mode を再確認します。
export class WriterModeSwitchCommitOutcomeUnknownError extends Error {
  readonly kind = 'commit_outcome_unknown';
  // COMMIT 送信時点で確定していた切替内容（切替後 parity 検査は COMMIT 前に
  // 全 category 0 件で通過済み）。commit が実際に確定していた場合の証跡に使う。
  readonly pendingResult: ExecuteWriterModeSwitchResult;

  constructor(pendingResult: ExecuteWriterModeSwitchResult, cause: unknown) {
    const causeError = toError(cause);
    super(
      `writer mode switch COMMIT outcome is unknown (the switch may or may not have been applied): ${causeError.message}`,
      { cause: causeError },
    );
    this.name = 'WriterModeSwitchCommitOutcomeUnknownError';
    this.pendingResult = pendingResult;
  }
}

// executeWriterModeSwitch は ADR-0032 の切替 transaction を実行します。
// drain・table lock・切替前 parity 検査（source mode）・mode UPDATE・切替後 parity
// 検査（target mode）を 1 transaction に閉じ、COMMIT 前の失敗はどれも ROLLBACK して
// 例外を投げます。COMMIT 自体の失敗だけは結果を断定できないため、
// WriterModeSwitchCommitOutcomeUnknownError として区別して投げます。
export async function executeWriterModeSwitch(
  client: QueryClient,
  targetMode: InventoryWriterMode,
  options: ExecuteWriterModeSwitchOptions = {},
): Promise<ExecuteWriterModeSwitchResult> {
  assertTargetWriterMode(targetMode);
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
    // barrier を通らない直接 SQL writer / 旧 binary への defense-in-depth
    // （#336 / #376 migration と同一の決定的 lock 順。共有定数）。
    await client.query(INVENTORY_WRITER_TABLE_LOCK_SQL);

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

    // 切替後 parity: 同じ transaction 上で target mode としても無違反であることを確認して
    // から commit する（違反があれば ROLLBACK され、mode 変更は永続化されない）。
    const after = await checkCutoverDatabase(client, targetMode);
    if (after.writerMode !== targetMode) {
      throw new Error(
        `writer mode switch aborted: control state did not converge to ${targetMode}`,
      );
    }
    // table lock 対象外の table（typeorm_migrations 等）への migration commit は
    // READ COMMITTED では statement ごとに可視になる。切替前後の 2 回の読み取りで
    // revision が動いていたら fail closed で停止する。
    if (after.schemaRevision !== before.schemaRevision) {
      throw new Error(
        `writer mode switch aborted: schema revision changed during switch transaction (started at ${before.schemaRevision}, found ${after.schemaRevision})`,
      );
    }
    assertNoCutoverViolations(after.results, `post-switch (${targetMode})`);

    const pendingResult: ExecuteWriterModeSwitchResult = {
      sourceMode,
      targetMode,
      schemaRevision: before.schemaRevision,
      postSwitchDatabaseResults: after.results,
    };
    try {
      await client.query('COMMIT');
    } catch (commitError) {
      // COMMIT 自体の失敗は「サーバ側で確定したが応答を受信できなかった」可能性を
      // 排除できない（例: commit 確定後の接続断）。この場合 transaction はサーバ側で
      // 終了済みか connection が死んでいるかのどちらかで、ROLLBACK で取り消せる状態に
      // はないため、結果不明として区別したエラーを投げる（呼び出し側が mode を再確認）。
      throw new WriterModeSwitchCommitOutcomeUnknownError(
        pendingResult,
        commitError,
      );
    }
    return pendingResult;
  } catch (error) {
    if (error instanceof WriterModeSwitchCommitOutcomeUnknownError) {
      throw error;
    }
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // ROLLBACK 失敗は握りつぶさず記録する。connection は aborted のままの可能性が
      // あるため、呼び出し側は release(error) で pool へ返さず破棄する。
      console.error('writer mode switch rollback failed');
      console.error(
        rollbackError instanceof Error
          ? (rollbackError.stack ?? rollbackError.message)
          : rollbackError,
      );
    }
    throw error;
  }
}

// --- preflight + 切替の合成（CLI 本体） ---

// WriterModeSwitchPhaseTwoError は「preflight は green だったが切替 transaction が
// 失敗した」ことを表します。構築済みの preflight evidence を保持し、呼び出し側
// （CLI）が証跡として出力・保存できるようにします（evidence の握りつぶし防止）。
export class WriterModeSwitchPhaseTwoError extends Error {
  readonly evidence: string;

  constructor(evidence: string, cause: unknown) {
    const causeError = toError(cause);
    super(`writer mode switch transaction failed: ${causeError.message}`, {
      cause: causeError,
    });
    this.name = 'WriterModeSwitchPhaseTwoError';
    this.evidence = evidence;
  }
}

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
    }
  | {
      // COMMIT の結果が不明だったが、別 connection での再確認で現在の mode を
      // 確定できた場合。verifiedMode === target なら切替は有効（postflight へ進む）、
      // verifiedMode === source なら切替は未適用（新しい preflight から再実行可能）。
      // 再確認自体が失敗した場合はこの outcome にならず、実行エラーとして throw する。
      status: 'commit_ambiguous';
      evidence: string;
      verifiedMode: InventoryWriterMode;
      // verifiedMode === target のときだけ、COMMIT 前に確定していた切替内容
      // （切替後 parity 検査 0 件を含む）を証跡として返す。
      result: ExecuteWriterModeSwitchResult | null;
    };

// verifyWriterModeAfterAmbiguousCommit は COMMIT 結果不明時に、別 connection・別
// transaction で現在の control state を確定的に読み直します。
//
// 単純な SELECT では不十分である点に注意: 元 transaction の COMMIT がサーバ側で
// まだ処理中（WAL flush 中など）のタイミングで読むと、旧 source mode を読んだ直後に
// commit が確定する race があり、「未適用」と誤報告し得る。そこで同じ固定 key の
// 排他 advisory barrier（pg_advisory_xact_lock(335, 376)）を取得してから読む。
// advisory xact lock は元 transaction の終了（commit 確定 / abort）まで解放されない
// ため、取得できた時点で元 transaction の結末は確定しており、読んだ mode が最終
// 状態になる。呼び出し側は検証を始める前に元 connection を release(error) で破棄し、
// socket 終了をサーバへ通知して idle-open な transaction を早期に abort させる。
//
// barrier 取得の timeout（元 transaction が極端に長く終了しない等）を含め、確認
// できない場合は null を返す（呼び出し側が実行エラーへ変換する。source / target の
// どちらにも断定しない）。
async function verifyWriterModeAfterAmbiguousCommit(
  pool: Pool,
  timeouts: WriterModeSwitchTimeouts,
): Promise<InventoryWriterMode | null> {
  const lockTimeout = assertTimeoutLiteral(timeouts.lockTimeout, 'lock_timeout');
  const statementTimeout = assertTimeoutLiteral(
    timeouts.statementTimeout,
    'statement_timeout',
  );
  try {
    const client = await pool.connect();
    let verifyError: Error | undefined;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '${lockTimeout}'`);
      await client.query(
        `SET LOCAL statement_timeout = '${statementTimeout}'`,
      );
      // 元 transaction の終了を待つ（終了まで exclusive barrier は取得できない）。
      await acquireExclusiveInventoryWriterBarrier(client);
      const mode = await readInventoryWriterMode(client);
      await client.query('COMMIT');
      return mode;
    } catch (error) {
      verifyError = toError(error);
      try {
        await client.query('ROLLBACK');
      } catch {
        // connection が壊れている場合は release(error) の破棄に任せる。
      }
      throw error;
    } finally {
      client.release(verifyError);
    }
  } catch (error) {
    console.error('writer mode verification after ambiguous COMMIT failed');
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    return null;
  }
}

// runWriterModeSwitch は ADR-0032 の Phase 1（in-process preflight）と Phase 2
// （切替 transaction）を実行します。preflight は PR-1 checker 関数を expected mode =
// source（現 mode）・phase = preflight で再実行し、violation が 1 件でもあれば切替
// transaction を開始せず evidence を返します（呼び出し側は exit 2）。
// Valkey / OpenSearch は DB transaction に参加できないため、直前の in-process 実行で
// TOCTOU 窓を最小化し、DB parity だけは切替 transaction 内で再検査します。
// Phase 2 の失敗は WriterModeSwitchPhaseTwoError として preflight evidence を添えて
// 投げます。
export async function runWriterModeSwitch(
  clients: WriterModeSwitchClients,
  options: RunWriterModeSwitchOptions,
): Promise<WriterModeSwitchOutcome> {
  const { pool, valkey, opensearch } = clients;
  const targetMode = options.targetMode;
  assertTargetWriterMode(targetMode);
  const sourceMode = oppositeWriterMode(targetMode);

  // Phase 1: in-process preflight（check-ticket-type-cutover-readiness と同じ規則）。
  const snapshotClient = await pool.connect();
  let databaseCheck: Awaited<ReturnType<typeof checkCutoverDatabase>>;
  let valkeyResults: TicketTypeCutoverReadinessResult[];
  let snapshotError: Error | undefined;
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
    snapshotError = toError(error);
    if (transactionStarted) {
      try {
        await snapshotClient.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('writer mode switch preflight rollback failed');
        console.error(
          rollbackError instanceof Error
            ? (rollbackError.stack ?? rollbackError.message)
            : rollbackError,
        );
      }
    }
    throw error;
  } finally {
    // 失敗時は release(error) で connection を pool へ返さず破棄する
    // （aborted transaction の connection を後続に再利用させない）。
    snapshotClient.release(snapshotError);
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
  let projectionError: Error | undefined;
  try {
    opensearchCheck = await checkCutoverOpenSearch(projectionClient, opensearch, {
      index: options.opensearchIndex,
      pageSize: options.pageSize,
      maxFindings: options.maxFindings,
    });
  } catch (error) {
    projectionError = toError(error);
    throw error;
  } finally {
    projectionClient.release(projectionError);
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
  let switchError: Error | undefined;
  let switchClientReleased = false;
  try {
    const result = await executeWriterModeSwitch(switchClient, targetMode, {
      expectedSchemaRevision: databaseCheck.schemaRevision,
      timeouts: options.timeouts,
    });
    return { status: 'switched', evidence, result };
  } catch (error) {
    switchError = toError(error);
    if (error instanceof WriterModeSwitchCommitOutcomeUnknownError) {
      // COMMIT の結果が不明な場合は、現在の mode を再確認して「切替済み / 未適用 /
      // 不明」を機械可読に分離する（ADR-0032）。
      //
      // 順序が重要: 「client 側が接続断を検知したこと」と「サーバ側で COMMIT 処理が
      // 完了したこと」は独立事象で順序保証がない（COMMIT が WAL flush 中の可能性が
      // ある）。そのため、
      // 1. まず元 connection を release(error) で破棄し、socket 終了をサーバへ
      //    通知して idle-open な transaction を早期に abort させる。
      // 2. 検証は別 transaction で同じ排他 advisory barrier を取得してから読む
      //    （元 transaction の終了 = barrier 解放まで待つため、処理中の COMMIT を
      //    追い越して旧値を読む race がない）。
      // barrier 取得の timeout 時は null が返り、source / target のどちらにも
      // 断定せず実行エラー（手動確認要求）へ倒す。
      switchClient.release(switchError);
      switchClientReleased = true;
      const verifiedMode = await verifyWriterModeAfterAmbiguousCommit(pool, {
        ...DEFAULT_WRITER_MODE_SWITCH_TIMEOUTS,
        ...options.timeouts,
      });
      if (verifiedMode === targetMode) {
        return {
          status: 'commit_ambiguous',
          evidence,
          verifiedMode,
          result: error.pendingResult,
        };
      }
      if (verifiedMode === sourceMode) {
        return {
          status: 'commit_ambiguous',
          evidence,
          verifiedMode,
          result: null,
        };
      }
      // 再確認自体が失敗した（mode を断定できない）場合は fail closed に停止する。
      // 運用者は inventory_writer_control を手動確認してから次の操作を決める。
      throw new WriterModeSwitchPhaseTwoError(
        evidence,
        new Error(
          `COMMIT outcome is unknown and writer mode verification failed; inspect inventory_writer_control manually before retrying (original: ${error.message})`,
          { cause: error },
        ),
      );
    }
    // preflight green の evidence を添えて失敗を報告する（証跡の握りつぶし防止）。
    throw new WriterModeSwitchPhaseTwoError(evidence, error);
  } finally {
    if (!switchClientReleased) {
      switchClient.release(switchError);
    }
  }
}
