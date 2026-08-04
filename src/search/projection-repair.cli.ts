// ファイル概要:
// このファイルは検索 projection の手動修復 CLI です（Issue #377 / ADR-0031 / PR #396）。
// reconciliation の unexpected_event_document / unexpected_ticket_type / contract_corruption を
// operator の明示操作で収束させます（rebuild では収束しない差分。runbook 参照）。
//
// 安全制約:
// - 完全一致 UUID 指定必須（query 駆動の一括操作なし）。
// - dry-run 既定。--apply を明示しない限り書き込まない。
// - 書き込み前に PostgreSQL（正本）の現在値を再確認し、前提が崩れていれば refuse する。
// - AWS 上では既存 API artifact の command override（ECS run-task）から実行する
//   （SigV4 署名は createOpenSearchClient が担う）。自動実行しない。
//
// exit code:
//   0 = 成功（dry-run のレポート出力、または apply 完了）
//   2 = refuse（安全チェックにより書き込みを拒否。レポートの refusals を参照）
//   1 = 実行エラー（引数不正を含む）
//
// 実行例（既存 API artifact の command override）:
//   node dist/src/search/projection-repair.cli.js --mode delete-document --event-id <uuid>
//   node dist/src/search/projection-repair.cli.js --mode delete-document --event-id <uuid> --apply
//   node dist/src/search/projection-repair.cli.js --mode delete-ticket-type --event-id <uuid> --ticket-type-id <uuid> --apply
//   node dist/src/search/projection-repair.cli.js --mode repair-corruption --event-id <uuid>   # 事前 diff の確認
//   node dist/src/search/projection-repair.cli.js --mode repair-corruption --event-id <uuid> --apply

import 'dotenv/config';
import { isUuidString } from '../common/validation-primitives';
import { createProjectionClients } from './projection-cli.shared';
import {
  deleteOrphanDocument,
  deleteOrphanTicketType,
  repairContractCorruption,
  RepairMode,
  RepairReport,
} from './projection-repair.service';

// RepairCliArgs は検証済みの CLI 引数です。
export interface RepairCliArgs {
  mode: RepairMode;
  eventId: string;
  ticketTypeId?: string;
  apply: boolean;
}

const MODES: RepairMode[] = [
  'delete-document',
  'delete-ticket-type',
  'repair-corruption',
];

// parseRepairArgs は引数を厳密に検証します（不正・未知の引数は throw）。
// 完全一致 UUID を必須にし、mode ごとの必須 / 禁止オプションを固定します。
export function parseRepairArgs(argv: string[]): RepairCliArgs {
  let mode: string | undefined;
  let eventId: string | undefined;
  let ticketTypeId: string | undefined;
  let apply = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const readValue = (name: string): string => {
      const eqPrefix = `--${name}=`;
      if (arg.startsWith(eqPrefix)) {
        return arg.slice(eqPrefix.length);
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--${name} requires a value`);
      }
      i += 1;
      return value;
    };
    if (arg === '--apply') {
      apply = true;
    } else if (arg === '--mode' || arg.startsWith('--mode=')) {
      mode = readValue('mode');
    } else if (arg === '--event-id' || arg.startsWith('--event-id=')) {
      eventId = readValue('event-id');
    } else if (arg === '--ticket-type-id' || arg.startsWith('--ticket-type-id=')) {
      ticketTypeId = readValue('ticket-type-id');
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!mode || !(MODES as string[]).includes(mode)) {
    throw new Error(
      `--mode must be one of ${MODES.join(' / ')} (got: ${mode ?? 'none'})`,
    );
  }
  if (!isUuidString(eventId)) {
    throw new Error('--event-id must be a canonical UUID (exact-match required)');
  }
  if (mode === 'delete-ticket-type') {
    if (!isUuidString(ticketTypeId)) {
      throw new Error(
        '--ticket-type-id must be a canonical UUID for --mode delete-ticket-type',
      );
    }
  } else if (ticketTypeId !== undefined) {
    throw new Error(`--ticket-type-id is not allowed for --mode ${mode}`);
  }

  return {
    mode: mode as RepairMode,
    eventId,
    ...(ticketTypeId !== undefined ? { ticketTypeId } : {}),
    apply,
  };
}

async function main(): Promise<number> {
  const args = parseRepairArgs(process.argv.slice(2));

  const { pool, opensearch } = createProjectionClients();
  const client = await pool.connect();
  try {
    let report: RepairReport;
    if (args.mode === 'delete-document') {
      report = await deleteOrphanDocument(client, opensearch, args);
    } else if (args.mode === 'delete-ticket-type') {
      report = await deleteOrphanTicketType(client, opensearch, args);
    } else {
      report = await repairContractCorruption(client, opensearch, args);
    }
    // machine-readable JSON を stdout に出す（secret を含めない）。
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.refusals.length > 0 ? 2 : 0;
  } finally {
    client.release();
    await pool.end();
  }
}

// テスト（unit spec）から parseRepairArgs を import しても main が動かないようにする。
if (require.main === module) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ error: error instanceof Error ? error.message : 'projection repair failed' })}\n`,
      );
      process.exit(1);
    });
}
