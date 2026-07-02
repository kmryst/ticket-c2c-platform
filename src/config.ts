// ファイル概要:
// このファイルはクラウド連携のオプション設定を 1 箇所で読む helper です。
// ローカル PoC では未設定のまま動き、dev 環境では ECS タスク定義の環境変数で有効化されます。

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

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

// DatabasePoolConfig は pg.Pool にそのまま渡せる接続設定の部分集合です。
// password は文字列、または接続のたびに呼ばれる非同期関数を受け付けます（pg 8.11+）。
export interface DatabasePoolConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string | (() => Promise<string>);
}

// Aurora の RDS 管理 secret は既定で 7 日ごとに自動ローテーションされます。
// キャッシュを持たず毎接続で取得すると Secrets Manager への呼び出しが増えるため、
// ローテーション間隔よりずっと短い TTL でキャッシュし、鮮度と呼び出し回数を両立します。
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
let cachedSecretPassword: { value: string; fetchedAt: number } | undefined;
let secretsManagerClient: SecretsManagerClient | undefined;

async function fetchDbPasswordFromSecretsManager(
  secretArn: string,
): Promise<string> {
  const now = Date.now();
  if (
    cachedSecretPassword &&
    now - cachedSecretPassword.fetchedAt < SECRET_CACHE_TTL_MS
  ) {
    return cachedSecretPassword.value;
  }

  secretsManagerClient ??= new SecretsManagerClient({});
  const result = await secretsManagerClient.send(
    new GetSecretValueCommand({ SecretId: secretArn }),
  );
  const parsed = JSON.parse(result.SecretString ?? '{}') as {
    password?: string;
  };
  if (!parsed.password) {
    throw new Error(`Secret ${secretArn} does not contain a "password" field`);
  }

  cachedSecretPassword = { value: parsed.password, fetchedAt: now };
  return parsed.password;
}

// getDatabasePoolConfig は DatabaseService の長寿命 pool 向けの接続設定を組み立てます。
// DB_PASSWORD_SECRET_ARN が設定されている場合、Aurora のパスワードローテーションに
// 追従できるよう、password に「接続のたびに Secrets Manager から取り直す関数」を渡します。
// schema-on-boot（起動時 1 回きりの接続）はローテーション影響を受けないため、
// 従来どおり buildDatabaseUrl の静的な DB_PASSWORD を使い続けます。
export function getDatabasePoolConfig(): DatabasePoolConfig {
  const direct = getOptionalEnv('DATABASE_URL');
  if (direct) {
    return { connectionString: direct };
  }

  const host = getOptionalEnv('DB_HOST');
  const database = getOptionalEnv('DB_NAME');
  const user = getOptionalEnv('DB_USERNAME');
  const port = Number(getOptionalEnv('DB_PORT') ?? '5432');
  const secretArn = getOptionalEnv('DB_PASSWORD_SECRET_ARN');
  const staticPassword = getOptionalEnv('DB_PASSWORD');

  if (!host || !database || !user) {
    throw new Error(
      'DATABASE_URL or DB_HOST/DB_NAME/DB_USERNAME is required. Copy .env.example to .env for local PoC runs.',
    );
  }

  if (secretArn) {
    return {
      host,
      port,
      database,
      user,
      password: () => fetchDbPasswordFromSecretsManager(secretArn),
    };
  }

  if (staticPassword) {
    return { host, port, database, user, password: staticPassword };
  }

  throw new Error(
    'DB_PASSWORD or DB_PASSWORD_SECRET_ARN is required alongside DB_HOST/DB_NAME/DB_USERNAME.',
  );
}
