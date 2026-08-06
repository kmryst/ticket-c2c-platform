// ファイル概要:
// Issue #378 / ADR-0032 の writer mode 切替 CLI です。activation
// （--target-mode ticket_type）と rollback（--target-mode legacy）を同じ経路で実行します。
//
// 動作（fail closed）:
// 1. 現 mode を読み、既に target mode なら実行エラーで停止する（暗黙 no-op 禁止）。
// 2. Phase 1: PR-1 checker を in-process 再実行（expected mode = 現 mode、phase =
//    preflight）。violation 1 件でも切替 transaction を開始しない。
// 3. Phase 2: 排他 barrier + migration と同一の table lock 順 + mode UPDATE +
//    切替前後の DB parity 検査を 1 transaction で実行する。
//
// exit code（check-ticket-type-cutover-readiness と同じ規約）:
// - 0: 切替成功（preflight evidence と切替結果を stdout へ 1 行 JSON で出力）
// - 2: preflight violation あり（切替せず evidence を出力する）
// - 1: 実行エラー（接続失敗・lock timeout・切替 transaction 内の違反検出・
//      既に target mode・control state 不明等。切替は永続化されない）
//
// この CLI は inventory_writer_control の 1 行 UPDATE 以外に何も書き込みません。
// Valkey / OpenSearch の seed / reconcile / rebuild は #389 / #377 の primitive と
// runbook が所有します（部分 rollback をこの CLI から実行できないことが仕様です）。

import 'dotenv/config';
import Redis from 'ioredis';
import { getOptionalEnv } from '../config';
import { EVENTS_INDEX } from '../search/events-projection.store';
import {
  createProjectionClients,
  parseIntOption,
} from '../search/projection-cli.shared';
import type { InventoryWriterMode } from '../database/inventory-writer-control';
import { runWriterModeSwitch } from './ticket-type-writer-mode-switch';

const USAGE =
  'usage: --target-mode <legacy|ticket_type> [--page-size N] [--max-findings N]';

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

// --target-mode は既定値を持たない必須オプションにする。activation と rollback は
// 同じ CLI の逆方向実行なので、方向を明示しない実行は使用エラーで停止する（fail closed）。
function parseTargetMode(argv: string[]): InventoryWriterMode {
  const raw = parseStringOption(argv, 'target-mode');
  if (raw !== 'legacy' && raw !== 'ticket_type') {
    throw new Error(USAGE);
  }
  return raw;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const targetMode = parseTargetMode(argv);
  const pageSize = parseIntOption(argv, 'page-size');
  const maxFindings = parseIntOption(argv, 'max-findings');

  // preflight は fail-open にしない: Valkey へ接続できなければ切替せず停止する。
  const valkeyUrl = getOptionalEnv('VALKEY_URL');
  if (!valkeyUrl) {
    throw new Error('VALKEY_URL is required for writer mode switch');
  }

  const { pool, opensearch } = createProjectionClients();
  const valkey = new Redis(valkeyUrl, {
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    // check-ticket-type-cutover-readiness と同じ保険: Valkey 応答不能時に
    // REPEATABLE READ snapshot を無期限に保持しない（fail closed に実行エラーで停止）。
    commandTimeout: 5000,
    lazyConnect: true,
  });

  try {
    await valkey.connect();

    const outcome = await runWriterModeSwitch(
      { pool, valkey, opensearch },
      {
        targetMode,
        opensearchIndex: EVENTS_INDEX,
        pageSize,
        maxFindings,
      },
    );

    // preflight evidence は成否にかかわらず証跡として出力する（secret を含まない）。
    console.log(outcome.evidence);

    if (outcome.status === 'preflight_violations') {
      process.exitCode = 2;
      return;
    }

    console.log(
      JSON.stringify({
        action: 'ticket-type-writer-mode-switch',
        switched: true,
        sourceMode: outcome.result.sourceMode,
        targetMode: outcome.result.targetMode,
        schemaRevision: outcome.result.schemaRevision,
      }),
    );
  } finally {
    valkey.disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Ticket Type writer mode switch failed');
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : error,
  );
  process.exitCode = 1;
});
