// ファイル概要:
// このファイルは dev 環境（Aurora）向けの起動時スキーマ適用 helper です。
// ローカル PoC では psql での手動適用が正ですが、dev 環境は private subnet 内の
// Aurora へ手元から psql できないため、API タスクの起動時に schema.sql を適用します。
// schema.sql は再適用に耐える冪等な書き方（IF NOT EXISTS / DO block）で維持されています。

import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import {
  buildDatabaseUrl,
  getOptionalEnv,
  isDatabaseSslEnabled,
} from './config';

// applySchemaOnBoot は RUN_SCHEMA_ON_BOOT=true のときだけ schema.sql を実行します。
export async function applySchemaOnBoot(): Promise<void> {
  if (getOptionalEnv('RUN_SCHEMA_ON_BOOT') !== 'true') {
    return;
  }

  const schemaPath = getOptionalEnv('SCHEMA_PATH') ?? 'database/schema.sql';
  const sql = await readFile(schemaPath, 'utf8');

  const client = new Client({
    connectionString: buildDatabaseUrl(),
    ssl: isDatabaseSslEnabled() ? { rejectUnauthorized: false } : undefined,
    // Aurora Serverless v2 の auto-pause からの再開を待てるよう、接続タイムアウトを長めに取ります。
    connectionTimeoutMillis: 30_000,
  });

  await client.connect();
  try {
    await client.query(sql);
    console.log('schema applied on boot', { schemaPath });
  } finally {
    await client.end();
  }
}
