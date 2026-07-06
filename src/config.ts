// ファイル概要:
// このファイルはクラウド連携のオプション設定を 1 箇所で読む helper です。
// ローカル PoC では未設定のまま動き、dev 環境では ECS タスク定義の環境変数で有効化されます。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

// getOptionalEnv は未設定・空文字を undefined に正規化して返します。
export function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

// JWT_ACCESS_TOKEN_TTL_SECONDS はアクセストークンの有効期限（15 分）です（ADR-0012、Issue #166）。
// リフレッシュトークン導入（Issue #165）に伴い、漏洩時の有効窓を 1h から 1/4 に短縮しました。
// UX はフロントエンドの silent refresh（期限切れ時に自動で /auth/refresh を呼ぶ）が維持します。
export const JWT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

// REFRESH_TOKEN_TTL_SECONDS はリフレッシュトークンの絶対寿命（14 日）です（ADR-0012）。
// rotate-on-use で世代が進んでも、各トークンの expires_at は発行時点から 14 日で固定されます。
export const REFRESH_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;

// JwtConfig は @nestjs/jwt の JwtModule.register にそのまま渡せる設定の部分集合です。
export interface JwtConfig {
  // secret は HS256 の署名・検証に使う共有シークレットです。
  secret: string;
  // signOptions は発行するトークンのアルゴリズムと有効期限を固定します。
  signOptions: {
    // 鍵共有者が API 1 サービスのみのため、対称鍵の HS256 を使います（ADR-0010）。
    algorithm: 'HS256';
    // expiresIn は秒数で指定します（JWT_ACCESS_TOKEN_TTL_SECONDS = 15 分）。
    expiresIn: number;
  };
}

// JwtSecrets はローテーション対応の署名シークレットの組です（ADR-0012、Issue #168）。
export interface JwtSecrets {
  // current は署名（発行）と検証の第一候補に使う現行シークレットです。
  current: string;
  // previous はローテーション直後の移行期間だけ検証のフォールバックに使う旧シークレットです。
  // 「previous を外せるのは、切替から最大アクセストークン TTL（15 分）経過後」が運用ルールです
  // （docs/runbooks/jwt-secret-rotation.md）。
  previous?: string;
}

// getJwtSecrets は JWT_SECRET 環境変数からシークレットの組を読みます。
// 値は 2 形式を受け付けます:
// - JSON: {"current": "...", "previous": "..."}（dev / staging の Secrets Manager。previous は空文字なら無し扱い）
// - プレーン文字列（ローカル PoC の .env。後方互換）
// JSON として始まる（{ で始まる）のに parse できない・current が無い値は、
// 「壊れた設定で誤って全トークンを無効化した状態」で稼働しないよう起動時に失敗させます（fail fast）。
export function getJwtSecrets(): JwtSecrets {
  const raw = getOptionalEnv('JWT_SECRET');
  if (!raw) {
    throw new Error(
      'JWT_SECRET is required. Copy .env.example to .env for local PoC runs.',
    );
  }

  // { で始まらない値はプレーン文字列シークレット（後方互換）として扱います。
  if (!raw.trimStart().startsWith('{')) {
    return { current: raw };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'JWT_SECRET looks like JSON but could not be parsed. Expected {"current": "...", "previous": "..."}.',
    );
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    typeof (parsed as { current?: unknown }).current !== 'string' ||
    ((parsed as { current: string }).current.length === 0)
  ) {
    throw new Error(
      'JWT_SECRET JSON must contain a non-empty "current" string.',
    );
  }

  const current = (parsed as { current: string }).current;
  const previousRaw = (parsed as { previous?: unknown }).previous;
  // previous は省略・空文字を「無し」として扱います（初期状態の Terraform 値は空文字）。
  const previous =
    typeof previousRaw === 'string' && previousRaw.length > 0
      ? previousRaw
      : undefined;

  return { current, previous };
}

// getJwtConfig は JWT_SECRET 環境変数から JWT 設定を組み立てます。
// ローカル PoC では .env の JWT_SECRET、dev / staging では Secrets Manager の値を
// ECS タスク定義の secrets 経由で注入します（既存の DB_PASSWORD と同じパターン。Issue #134）。
// 署名（発行）は常に current のみを使います。previous での検証フォールバックは JwtAuthGuard が行います。
export function getJwtConfig(): JwtConfig {
  return {
    secret: getJwtSecrets().current,
    signOptions: {
      algorithm: 'HS256',
      expiresIn: JWT_ACCESS_TOKEN_TTL_SECONDS,
    },
  };
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

// RDS_CA_BUNDLE_PATH は AWS RDS の CA バンドル（全リージョン分）の同梱先です。
// Dockerfile は database/ ディレクトリごとイメージへコピーするため、実行環境でもこの相対パスで読めます。
// 更新手順: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem を再取得して上書きする。
const RDS_CA_BUNDLE_PATH = 'database/rds-ca/global-bundle.pem';

// DatabaseSslConfig は pg の ssl オプションへそのまま渡す設定です。
export interface DatabaseSslConfig {
  rejectUnauthorized: true;
  ca: string;
}

// CA バンドルはプロセス内で不変なので、初回読み込み後はキャッシュします。
let cachedRdsCaBundle: string | undefined;

// getDatabaseSslConfig は DB_SSL=true のとき、RDS CA バンドルで証明書検証を行う
// ssl 設定を返します（production-readiness M-4: rejectUnauthorized: false の解消）。
// DB_SSL 未設定（ローカル PoC）では undefined を返し、SSL なし接続のままにします。
export function getDatabaseSslConfig(): DatabaseSslConfig | undefined {
  if (!isDatabaseSslEnabled()) {
    return undefined;
  }

  const bundlePath =
    getOptionalEnv('DB_SSL_CA_PATH') ?? resolve(process.cwd(), RDS_CA_BUNDLE_PATH);
  cachedRdsCaBundle ??= readFileSync(bundlePath, 'utf8');

  return { rejectUnauthorized: true, ca: cachedRdsCaBundle };
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

// Aurora のパスワードローテーション直後に古い値を返し続けないよう、TTL キャッシュは持たず
// 接続のたびに Secrets Manager から取得します。並行して複数接続が確立されるタイミングで
// 呼び出しが重複しないよう、進行中の取得を in-flight promise として共有します。
let secretsManagerClient: SecretsManagerClient | undefined;
let inFlightFetch: Promise<string> | undefined;

async function fetchDbPasswordFromSecretsManager(
  secretArn: string,
): Promise<string> {
  if (inFlightFetch) {
    return inFlightFetch;
  }

  inFlightFetch = (async () => {
    try {
      secretsManagerClient ??= new SecretsManagerClient({});
      const result = await secretsManagerClient.send(
        new GetSecretValueCommand({ SecretId: secretArn }),
      );
      if (!result.SecretString) {
        throw new Error(`Secret ${secretArn} does not contain SecretString`);
      }
      const parsed = JSON.parse(result.SecretString) as {
        password?: string;
      };
      if (!parsed.password) {
        throw new Error(
          `Secret ${secretArn} does not contain a "password" field`,
        );
      }

      return parsed.password;
    } finally {
      inFlightFetch = undefined;
    }
  })();

  return inFlightFetch;
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
