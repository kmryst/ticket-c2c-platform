// ファイル概要:
// このファイルは read-only reconciliation CLI です（Issue #377 / ADR-0031）。
// Aurora PostgreSQL（正本）と OpenSearch（projection）の差分を machine-readable JSON で出力します。
// PostgreSQL も OpenSearch も変更しません。
//
// exit code:
//   0 = 差分 0
//   2 = 差分あり
//   1 = 実行エラー
//
// 実行例（既存 API artifact の command override）:
//   node dist/src/search/inventory-reconciliation.cli.js --page-size 200

import 'dotenv/config';
import { createProjectionClients, parseIntOption } from './projection-cli.shared';
import { reconcileInventoryProjection } from './inventory-reconciliation.service';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const pageSize = parseIntOption(argv, 'page-size');
  const maxFindings = parseIntOption(argv, 'max-findings');

  const { pool, opensearch } = createProjectionClients();
  const client = await pool.connect();
  try {
    const report = await reconcileInventoryProjection(client, opensearch, {
      pageSize,
      maxFindings,
    });
    // machine-readable JSON を stdout に出す（secret を含めない）。
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return report.hasDiff ? 2 : 0;
  } finally {
    client.release();
    await pool.end();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    // 実行エラーは exit 1。error message は secret を含み得ないが、payload 全体は出さない。
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : 'reconciliation failed' })}\n`,
    );
    process.exit(1);
  });
