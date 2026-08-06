// ファイル概要:
// このファイルは reconciliation / rebuild CLI が共有する接続 helper です（Issue #377）。
// 既存 API artifact と同じ DB 設定解決（getDatabasePoolConfig）を使い、
// OPENSEARCH_ENDPOINT から OpenSearch client を生成します。
// DB と OpenSearch 双方へ接続できる artifact から command override で実行します。

import { Pool } from 'pg';
import type { Client } from '@opensearch-project/opensearch';
import { getDatabasePoolConfig, getDatabaseSslConfig, getOptionalEnv } from '../config';
import { createOpenSearchClient } from '../opensearch';

// createProjectionClients は CLI 用に pg Pool と OpenSearch client を生成します。
export function createProjectionClients(): { pool: Pool; opensearch: Client } {
  const endpoint = getOptionalEnv('OPENSEARCH_ENDPOINT');
  if (!endpoint) {
    throw new Error('OPENSEARCH_ENDPOINT is required for projection CLI');
  }
  const pool = new Pool({
    ...getDatabasePoolConfig(),
    ssl: getDatabaseSslConfig(),
    // CLI は単発実行のため小さめの pool にする（bounded）。
    max: 4,
    connectionTimeoutMillis: 5000,
  });
  const opensearch = createOpenSearchClient(endpoint);
  return { pool, opensearch };
}

// parseStringOption は `--name=value` / `--name value` 形式の文字列オプションを読みます
// （cutover 系 CLI が共有。Issue #378）。
export function parseStringOption(
  argv: string[],
  name: string,
): string | undefined {
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

// parseIntOption は `--name=value` / `--name value` 形式の整数オプションを読みます。
export function parseIntOption(
  argv: string[],
  name: string,
): number | undefined {
  const prefix = `--${name}=`;
  const eq = argv.find((a) => a.startsWith(prefix));
  if (eq) {
    const value = Number(eq.slice(prefix.length));
    return Number.isFinite(value) ? value : undefined;
  }
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length) {
    const value = Number(argv[idx + 1]);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}
