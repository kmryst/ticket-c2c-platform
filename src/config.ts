// ファイル概要:
// このファイルはクラウド連携のオプション設定を 1 箇所で読む helper です。
// ローカル PoC では未設定のまま動き、dev 環境では ECS タスク定義の環境変数で有効化されます。

// getOptionalEnv は未設定・空文字を undefined に正規化して返します。
export function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

// buildDatabaseUrl は DATABASE_URL、または DB_* 分解値から接続文字列を組み立てます。
// dev 環境では Aurora の RDS 管理 secret から DB_PASSWORD だけを注入するため、分解形を受けます。
export function buildDatabaseUrl(): string {
  const direct = getOptionalEnv('DATABASE_URL');
  if (direct) {
    return direct;
  }

  const host = getOptionalEnv('DB_HOST');
  const name = getOptionalEnv('DB_NAME');
  const user = getOptionalEnv('DB_USERNAME');
  const password = getOptionalEnv('DB_PASSWORD');
  const port = getOptionalEnv('DB_PORT') ?? '5432';

  if (host && name && user && password) {
    // パスワードに記号が含まれても壊れないよう URL エンコードします。
    return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`;
  }

  throw new Error(
    'DATABASE_URL or DB_HOST/DB_NAME/DB_USERNAME/DB_PASSWORD is required. Copy .env.example to .env for local PoC runs.',
  );
}

// isDatabaseSslEnabled は Aurora など TLS 接続が必要な環境かを判定します。
export function isDatabaseSslEnabled(): boolean {
  return getOptionalEnv('DB_SSL') === 'true';
}
