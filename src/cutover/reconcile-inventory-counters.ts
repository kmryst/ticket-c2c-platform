// ファイル概要:
// Issue #378 の Valkey 在庫 counter seed / reconcile CLI です（Gate B cutover 運用専用）。
// InventoryCacheService の init は fail-open（失敗しても metric 送出のみ）のため、
// Gate B の seed（positive 証明が必要）には使えません。この CLI は checker CLI と同じ
// fail-closed 規律で、counter / version(revision) を Lua script で対に初期化・補正します。
//
// 引数（どちらも既定値なしの必須。--phase と同じ fail-closed 規律）:
// - --namespace <ticket-type|legacy>: 対象 namespace。
//   ticket-type = inventory:ticket-type:{<eventId>:<ticketTypeId>}:remaining / :revision
//   legacy      = inventory:<eventId> / inventory:<eventId>:v
// - --mode <seed|reconcile>:
//   seed      = counter を DB 残数で初期化する（inactive namespace のみ許可。下記 guard）。
//   reconcile = 既存 counter を DB 残数で CAS 補正する（counter 不在は skip・
//               revision 不一致は skip。counter を新規作成しない）。
//
// seed の guard（fail closed）:
// init 系 Lua script は無条件 SET で既存 counter を上書きするため、seed は
// 「active writer が触らない側の namespace」だけに許可する。
// - --namespace ticket-type は writer_mode = 'legacy' のときのみ（activation 前 seed）
// - --namespace legacy は writer_mode = 'ticket_type' のときのみ（rollback 前の再 seed）
// guard 違反は exit 2 で refuse し、Valkey には一切書き込まない。
//
// TOCTOU 対策:
// guard の mode 読み取りと Valkey 書き込みの間に mode が切り替わらないよう、
// seed は snapshot transaction 冒頭で shared writer barrier を取得し、Valkey 書き込みが
// 完了するまで transaction を保持する。切替 CLI（ADR-0032）は同じ key の exclusive
// barrier を取るため、seed 実行中の切替は block される（advisory lock は READ ONLY
// transaction でも取得できる）。
//
// exit code:
// - 0: 成功（1 行 JSON evidence を stdout へ出力。secret なし）
// - 2: seed guard 違反（refuse。書き込みなし。evidence は refused: true で出力）
// - 1: 実行エラー（接続失敗・script の想定外応答等）

import 'dotenv/config';
import Redis from 'ioredis';
import { Pool, QueryResult } from 'pg';
import {
  getDatabasePoolConfig,
  getDatabaseSslConfig,
  getOptionalEnv,
} from '../config';
import {
  eventCounterKey,
  eventCounterVersionKey,
  ticketTypeCounterKey,
  ticketTypeCounterRevisionKey,
} from '../cache/inventory-cache.keys';
import {
  CLI_LEGACY_GUARDED_SYNC_SCRIPT,
  INIT_SCRIPT,
  TICKET_TYPE_INIT_SCRIPT,
  TICKET_TYPE_SYNC_SCRIPT,
} from '../cache/inventory-cache.scripts';
import {
  acquireSharedInventoryWriterBarrier,
  InventoryWriterMode,
  readInventoryWriterMode,
} from '../database/inventory-writer-control';
import { DEFAULT_PAGE_SIZE } from '../search/inventory-projection-source';
import {
  parseIntOption,
  parseStringOption,
} from '../search/projection-cli.shared';

const USAGE =
  'usage: --namespace <ticket-type|legacy> --mode <seed|reconcile> [--page-size N]';

// evidence の action 名（1 行 JSON の識別子）。
const ACTION = 'inventory-counter-reconcile';

export type CounterNamespace = 'ticket-type' | 'legacy';
export type CounterCliMode = 'seed' | 'reconcile';

// --namespace / --mode は既定値を持たない必須オプションにする（fail closed:
// 対象と操作を明示しない実行は使用エラーで停止する。checker CLI の --phase と同じ規律）。
export function parseNamespaceOption(argv: string[]): CounterNamespace {
  const raw = parseStringOption(argv, 'namespace');
  if (raw !== 'ticket-type' && raw !== 'legacy') {
    throw new Error(USAGE);
  }
  return raw;
}

export function parseModeOption(argv: string[]): CounterCliMode {
  const raw = parseStringOption(argv, 'mode');
  if (raw !== 'seed' && raw !== 'reconcile') {
    throw new Error(USAGE);
  }
  return raw;
}

// SeedNamespaceActiveError は「active namespace への seed」の refuse を表します（exit 2）。
// message には namespace と writer mode 以外を含めません（secret なし）。
export class SeedNamespaceActiveError extends Error {
  constructor(
    readonly namespace: CounterNamespace,
    readonly writerMode: InventoryWriterMode,
  ) {
    super(
      `refusing to seed namespace ${namespace}: it is active under writer_mode=${writerMode} ` +
        '(seed is allowed only for the inactive namespace)',
    );
    this.name = 'SeedNamespaceActiveError';
  }
}

// assertSeedNamespaceInactive は seed 対象 namespace が inactive であることを強制します。
// active writer が触らない側だけ書ける、という 1 規則で activation 前 seed
// （ticket-type × legacy mode）と rollback 前 legacy 再 seed（legacy × ticket_type mode）の
// 双方を許可し、それ以外を refuse します。
export function assertSeedNamespaceInactive(
  namespace: CounterNamespace,
  writerMode: InventoryWriterMode,
): void {
  const requiredMode: InventoryWriterMode =
    namespace === 'ticket-type' ? 'legacy' : 'ticket_type';
  if (writerMode !== requiredMode) {
    throw new SeedNamespaceActiveError(namespace, writerMode);
  }
}

// ValkeyCounterClient は CLI が使う Valkey コマンドの最小 interface です（ioredis 互換）。
export interface ValkeyCounterClient {
  get(key: string): Promise<string | null>;
  eval(
    script: string,
    numKeys: number,
    ...args: (string | number)[]
  ): Promise<unknown>;
}

export interface CounterReconcileCounts {
  // processed は対象 namespace で列挙した DB 在庫行の件数です。
  processed: number;
  // initialized は seed で counter+version(revision) を初期化した件数です。
  initialized: number;
  // synced は reconcile の CAS が成立した件数です。
  synced: number;
  // skipped は reconcile で counter 不在・revision 不一致・行削除により見送った件数です。
  skipped: number;
}

export interface CounterReconcileOutcome {
  namespace: CounterNamespace;
  mode: CounterCliMode;
  // writerMode は snapshot 時点の control state（evidence 用）。
  writerMode: InventoryWriterMode;
  counts: CounterReconcileCounts;
}

export interface CounterReconcileDeps {
  pool: Pool;
  valkey: ValkeyCounterClient;
}

export interface CounterReconcileOptions {
  namespace: CounterNamespace;
  mode: CounterCliMode;
  pageSize?: number;
}

// InventoryCounterRow は列挙クエリの行型です（legacy namespace では ticket_type_id は
// 常に NULL）。keyset pagination の cursor 変数と相互参照になるため明示的に型を付けます。
interface InventoryCounterRow {
  event_id: string;
  ticket_type_id: string | null;
  remaining_quantity: number;
}

// 対象行の参照（reconcile は snapshot で id だけを列挙し、値は行単位の fresh read で取る）。
interface CounterRowRef {
  eventId: string;
  // legacy namespace では undefined。
  ticketTypeId?: string;
}

function boundedPageSize(pageSize: number | undefined): number {
  const requested = pageSize ?? DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(requested, 1000));
}

// runInventoryCounterReconcile は seed / reconcile の本体です（CLI と統合テストが共有）。
//
// - seed: REPEATABLE READ READ ONLY snapshot + shared barrier の中で guard を検査し、
//   snapshot の DB 残数で init script を実行する。対象 namespace は inactive（他に
//   writer がいない）で、barrier が mode 切替も block するため、snapshot 値の init で
//   正しい（Valkey 書き込み完了まで transaction を保持する）。
// - reconcile: snapshot では対象行の id だけを列挙し、値の読み取りは行単位で
//   「revision を控える → DB を fresh read → CAS sync」の順に行う。CAS の契約
//   （inventory-cache.service.ts: 「DB 残在庫を読む前に控えた version」）どおり、
//   revision 取得より古い DB 値で sync しないための順序である（snapshot の値を
//   そのまま使うと、snapshot 後〜revision 取得前の購入による counter 変更を
//   古い DB 値で上書きしてしまう）。revision 取得後に counter が変われば
//   revision 不一致で skip される（安全側）。
export async function runInventoryCounterReconcile(
  deps: CounterReconcileDeps,
  options: CounterReconcileOptions,
): Promise<CounterReconcileOutcome> {
  const pageSize = boundedPageSize(options.pageSize);
  const counts: CounterReconcileCounts = {
    processed: 0,
    initialized: 0,
    synced: 0,
    skipped: 0,
  };

  const client = await deps.pool.connect();
  let transactionStarted = false;
  let writerMode: InventoryWriterMode;
  const reconcileTargets: CounterRowRef[] = [];
  try {
    await client.query(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    transactionStarted = true;
    await client.query("SET LOCAL statement_timeout = '60s'");
    await client.query("SET LOCAL lock_timeout = '5s'");
    // seed は Valkey 書き込み完了まで transaction（= shared barrier）を保持するため、
    // checker の 60s 固定は流用せず、件数見合いの上限として 300s にする
    // （dev/staging の実データ規模では秒オーダーの想定。無期限保持はしない。
    // 実測は dev rehearsal で取り、必要なら見直す）。
    await client.query(
      "SET LOCAL idle_in_transaction_session_timeout = '300s'",
    );

    // TOCTOU 対策: guard の mode 読み取りと Valkey 書き込みの間の切替を防ぐ。
    // 切替 CLI は同じ key の exclusive barrier を取るため、この shared barrier を
    // 保持している間は切替が block される。
    await acquireSharedInventoryWriterBarrier(client);
    writerMode = await readInventoryWriterMode(client);

    if (options.mode === 'seed') {
      assertSeedNamespaceInactive(options.namespace, writerMode);
    }

    // 対象行を keyset pagination で列挙する（checker と同じ bounded 規律）。
    let lastEventId: string | null = null;
    let lastTicketTypeId: string | null = null;
    for (;;) {
      const page: QueryResult<InventoryCounterRow> =
        options.namespace === 'ticket-type'
          ? await client.query<InventoryCounterRow>(
              `
                SELECT event_id::text AS event_id,
                       ticket_type_id::text AS ticket_type_id,
                       remaining_quantity
                FROM public.ticket_type_inventory
                WHERE ($1::uuid IS NULL OR (event_id, ticket_type_id) > ($1::uuid, $2::uuid))
                ORDER BY event_id ASC, ticket_type_id ASC
                LIMIT $3
              `,
              [lastEventId, lastTicketTypeId, pageSize],
            )
          : await client.query<InventoryCounterRow>(
              `
                SELECT event_id::text AS event_id,
                       NULL::text AS ticket_type_id,
                       remaining_quantity
                FROM public.ticket_inventory
                WHERE ($1::uuid IS NULL OR event_id > $1::uuid)
                ORDER BY event_id ASC
                LIMIT $2
              `,
              [lastEventId, pageSize],
            );
      if (page.rows.length === 0) {
        break;
      }

      for (const row of page.rows) {
        counts.processed += 1;
        // ticket-type namespace の行は ticket_type_id を必ず持つ（列挙 SQL の前提）。
        // NULL が来るのは想定外の schema 状態なので fail closed で停止する。
        let ticketTypeId: string | undefined;
        if (options.namespace === 'ticket-type') {
          if (row.ticket_type_id === null) {
            throw new Error(
              'ticket_type_inventory row without ticket_type_id',
            );
          }
          ticketTypeId = row.ticket_type_id;
        }

        if (options.mode === 'seed') {
          // seed は snapshot の残数で counter+version(revision) を対に初期化する
          // （barrier 保持中のため、この transaction の間に対象 namespace の writer も
          // mode 切替も現れない）。
          const outcome =
            ticketTypeId !== undefined
              ? await deps.valkey.eval(
                  TICKET_TYPE_INIT_SCRIPT,
                  2,
                  ticketTypeCounterKey(row.event_id, ticketTypeId),
                  ticketTypeCounterRevisionKey(row.event_id, ticketTypeId),
                  String(row.remaining_quantity),
                )
              : await deps.valkey.eval(
                  INIT_SCRIPT,
                  2,
                  eventCounterKey(row.event_id),
                  eventCounterVersionKey(row.event_id),
                  String(row.remaining_quantity),
                );
          if (outcome !== 'initialized') {
            // init script は initialized 以外を返さない。想定外応答は fail closed。
            throw new Error(
              `unexpected init script outcome: ${String(outcome)}`,
            );
          }
          counts.initialized += 1;
        } else {
          reconcileTargets.push({
            eventId: row.event_id,
            ...(ticketTypeId !== undefined ? { ticketTypeId } : {}),
          });
        }
      }

      const lastRow = page.rows[page.rows.length - 1];
      lastEventId = lastRow.event_id;
      lastTicketTypeId = lastRow.ticket_type_id;
      if (page.rows.length < pageSize) {
        break;
      }
    }

    await client.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('inventory counter reconcile rollback failed');
        console.error(
          rollbackError instanceof Error
            ? (rollbackError.stack ?? rollbackError.message)
            : rollbackError,
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }

  // reconcile 本体（snapshot transaction の外）。行ごとに
  // 「revision を控える → fresh read → CAS sync」の順で補正する。
  for (const target of reconcileTargets) {
    const counterKey =
      options.namespace === 'ticket-type'
        ? ticketTypeCounterKey(target.eventId, target.ticketTypeId as string)
        : eventCounterKey(target.eventId);
    const revisionKey =
      options.namespace === 'ticket-type'
        ? ticketTypeCounterRevisionKey(
            target.eventId,
            target.ticketTypeId as string,
          )
        : eventCounterVersionKey(target.eventId);

    // CAS の契約どおり、DB を読む前に revision を控える（不在は '0' 扱い）。
    const expectedRevision = (await deps.valkey.get(revisionKey)) ?? '0';

    const fresh =
      options.namespace === 'ticket-type'
        ? await deps.pool.query<{ remaining_quantity: number }>(
            `
              SELECT remaining_quantity
              FROM public.ticket_type_inventory
              WHERE event_id = $1 AND ticket_type_id = $2
            `,
            [target.eventId, target.ticketTypeId],
          )
        : await deps.pool.query<{ remaining_quantity: number }>(
            `
              SELECT remaining_quantity
              FROM public.ticket_inventory
              WHERE event_id = $1
            `,
            [target.eventId],
          );
    if (fresh.rows.length !== 1) {
      // 列挙後に行が消えた（Event 削除等）場合は補正対象がないので見送る。
      counts.skipped += 1;
      continue;
    }

    // ticket-type は既存の TICKET_TYPE_SYNC_SCRIPT（EXISTS ガードあり）を、
    // legacy は CLI 専用の EXISTS ガード付き script を使う。どちらも counter 不在時に
    // キーを作らない（未 seed namespace の暗黙 activation・counter 捏造をしない）。
    const outcome = await deps.valkey.eval(
      options.namespace === 'ticket-type'
        ? TICKET_TYPE_SYNC_SCRIPT
        : CLI_LEGACY_GUARDED_SYNC_SCRIPT,
      2,
      counterKey,
      revisionKey,
      String(fresh.rows[0].remaining_quantity),
      expectedRevision,
    );
    if (outcome === 'synced') {
      counts.synced += 1;
    } else if (outcome === 'skipped') {
      counts.skipped += 1;
    } else {
      throw new Error(`unexpected sync script outcome: ${String(outcome)}`);
    }
  }

  return {
    namespace: options.namespace,
    mode: options.mode,
    writerMode,
    counts,
  };
}

// serializeCounterReconcileEvidence は 1 行 JSON evidence を組み立てます（secret なし）。
export function serializeCounterReconcileEvidence(
  outcome: CounterReconcileOutcome,
): string {
  return JSON.stringify({
    action: ACTION,
    namespace: outcome.namespace,
    mode: outcome.mode,
    writerMode: outcome.writerMode,
    ...outcome.counts,
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const namespace = parseNamespaceOption(argv);
  const mode = parseModeOption(argv);
  const pageSize = parseIntOption(argv, 'page-size');

  // seed / reconcile は fail-open にしない: Valkey へ接続できなければ実行エラーで停止する
  // （購入 API の InventoryCacheService と異なり、書けたふりをしてはいけない）。
  const valkeyUrl = getOptionalEnv('VALKEY_URL');
  if (!valkeyUrl) {
    throw new Error(
      'VALKEY_URL is required for inventory counter seed / reconcile',
    );
  }

  // DB は checker CLI と同じ設定解決（既存 API artifact の command override で実行する
  // 前提）。OpenSearch は使わないため createProjectionClients は流用しない。
  const pool = new Pool({
    ...getDatabasePoolConfig(),
    ssl: getDatabaseSslConfig(),
    max: 4,
    connectionTimeoutMillis: 5000,
  });
  const valkey = new Redis(valkeyUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    // checker CLI と同じ保険: Valkey 応答不能時に snapshot transaction
    // （= shared barrier）を無期限に保持しない（fail closed に実行エラーで停止する）。
    commandTimeout: 5000,
    lazyConnect: true,
  });

  try {
    await valkey.connect();

    let outcome: CounterReconcileOutcome;
    try {
      outcome = await runInventoryCounterReconcile(
        { pool, valkey },
        { namespace, mode, pageSize },
      );
    } catch (error) {
      if (error instanceof SeedNamespaceActiveError) {
        // refuse も evidence として stdout へ残す（書き込みは行っていない）。
        console.log(
          JSON.stringify({
            action: ACTION,
            namespace,
            mode,
            writerMode: error.writerMode,
            refused: true,
            reason: error.message,
          }),
        );
        console.error(error.message);
        process.exitCode = 2;
        return;
      }
      throw error;
    }

    console.log(serializeCounterReconcileEvidence(outcome));
  } finally {
    // cleanup の失敗で本体の結果を上書きしない（switch CLI と同じ方針）。
    valkey.disconnect();
    try {
      await pool.end();
    } catch (poolEndError) {
      console.error('inventory counter reconcile cleanup failed: pool shutdown error');
      console.error(
        poolEndError instanceof Error
          ? (poolEndError.stack ?? poolEndError.message)
          : poolEndError,
      );
    }
  }
}

// テスト（unit / integration）が export を副作用なしで import できるよう、
// CLI として直接起動された場合だけ main を実行する（node dist / ts-node の両方で成立）。
if (require.main === module) {
  main().catch((error) => {
    console.error('Inventory counter seed / reconcile failed');
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exitCode = 1;
  });
}
