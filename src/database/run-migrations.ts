// ファイル概要:
// このファイルは migration 適用の実行入口です（Issue #92）。
// API の boot path からは呼ばれず、次の経路からだけ実行します:
// - ローカル: npm run migration:run:local（Docker Compose の PostgreSQL に適用）
// - AWS: db-migrate workflow / deploy-app workflow の run_migrations 入力
//   （ECS run-task の command override: node dist/src/database/run-migrations.js）
// 短命プロセスのため、DB パスワードは静的注入の DB_PASSWORD（buildDatabaseUrl）で足りる。

import 'dotenv/config';
import { dataSource } from './data-source';

// migration runner の多重起動を DB 側で直列化するための advisory lock キー。
// 誤って 2 つの workflow / タスクが同時に走っても、後続は先行の完了を待ってから
// 「適用済み」を確認して no-op になる（DDL 競合を構造的に防ぐ）。
const MIGRATION_ADVISORY_LOCK_KEY = 7513594;

async function main(): Promise<void> {
  await dataSource.initialize();
  const lockRunner = dataSource.createQueryRunner();
  await lockRunner.connect();
  try {
    await lockRunner.query('SELECT pg_advisory_lock($1)', [
      MIGRATION_ADVISORY_LOCK_KEY,
    ]);
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    if (applied.length === 0) {
      console.log('no pending migrations');
    }
    for (const migration of applied) {
      console.log(`applied migration: ${migration.name}`);
    }
  } finally {
    try {
      await lockRunner.query('SELECT pg_advisory_unlock($1)', [
        MIGRATION_ADVISORY_LOCK_KEY,
      ]);
      await lockRunner.release();
    } finally {
      await dataSource.destroy();
    }
  }
}

main().catch((error) => {
  console.error('migration failed');
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
