// ファイル概要:
// このファイルは rebuild / reindex CLI です（Issue #377 / ADR-0031）。
// Aurora PostgreSQL（正本）から OpenSearch projection を再構築します。
// Worker と同じ atomic version guard を共有し、処理中の新 event を巻き戻しません。
// このファイルは AWS 上で自動実行しません（手動 / 既存運用経路から command override で実行）。
//
// exit code:
//   0 = 成功
//   1 = 実行エラー（bulk item error を含む）
//
// 実行例（既存 API artifact の command override）:
//   node dist/src/search/inventory-rebuild.cli.js --page-size 200 --bulk-size 200

import 'dotenv/config';
import { createProjectionClients, parseIntOption } from './projection-cli.shared';
import { rebuildInventoryProjection } from './inventory-rebuild.service';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const pageSize = parseIntOption(argv, 'page-size');
  const bulkSize = parseIntOption(argv, 'bulk-size');

  const { pool, opensearch } = createProjectionClients();
  const client = await pool.connect();
  try {
    const report = await rebuildInventoryProjection(client, opensearch, {
      pageSize,
      bulkSize,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return 0;
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
    process.stderr.write(
      `${JSON.stringify({ error: error instanceof Error ? error.message : 'rebuild failed' })}\n`,
    );
    process.exit(1);
  });
