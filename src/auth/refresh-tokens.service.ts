// ファイル概要:
// このファイルはリフレッシュトークン（opaque + DB hash 保存。ADR-0012、Issue #165）のデータ層と
// 状態遷移（発行 / rotate-on-use / reuse detection / ファミリー失効）を担当する service です。
// 生トークンは 256bit のランダム値で、DB には SHA-256 hash のみ保存します。
// rotate は「行ロック → 状態確認 → 旧トークン消費 + 新トークン INSERT」を 1 transaction で行い、
// 同時 refresh のレースで正規ユーザーを reuse と誤判定しないようにします。

// Injectable は service を NestJS の DI 対象として登録する decorator です。
// UnauthorizedException はトークン不正を 401 として返すために使います。
import { Injectable, UnauthorizedException } from '@nestjs/common';
// randomBytes は opaque トークン本体、randomUUID はトークンファミリーの採番に使います。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
// PoolClient は transaction を張るために DatabaseService から借りる 1 接続です。
import { PoolClient } from 'pg';
// REFRESH_TOKEN_TTL_SECONDS はリフレッシュトークンの絶対寿命（14 日。ADR-0012）です。
import { REFRESH_TOKEN_TTL_SECONDS } from '../config';
// DatabaseService は PostgreSQL の PoolClient を借りるための共有 service です。
import { DatabaseService } from '../database/database.service';

// RefreshTokenRow は refresh_tokens テーブルから読む row の形です。
// token_hash は含めません（照合は WHERE 句で行い、読み出す必要がないため）。
export interface RefreshTokenRow {
  // id はトークン row の UUID です。
  id: string;
  // user_id はトークンの持ち主（users.id）です。
  user_id: string;
  // family_id は login / signup 時に採番されるファミリー識別子です。
  family_id: string;
  // expires_at はトークンの絶対期限です。
  expires_at: Date;
  // used_at は rotate-on-use で消費された日時です。null なら未使用です。
  used_at: Date | null;
  // revoked_at は無効化された日時です。null なら有効です。
  revoked_at: Date | null;
  // replaced_by_token_id は rotate で置き換えた新トークンの id です。
  replaced_by_token_id: string | null;
}

// TokenClientMeta はトークン発行時に記録する調査用のクライアント情報です。
export interface TokenClientMeta {
  // ip は trusted-hops 解決後のクライアント IP です（client-ip.ts）。
  ip?: string;
  // userAgent はリクエストの User-Agent ヘッダです。
  userAgent?: string;
}

// IssuedRefreshToken は発行結果としてクライアントへ返す情報です。
export interface IssuedRefreshToken {
  // token は生のリフレッシュトークンです。この値は DB に保存されず、ログにも出してはいけません。
  token: string;
  // expiresIn は有効期間（秒）です。Cookie の Max-Age と response に使います。
  expiresIn: number;
}

// RotatedRefreshToken は rotate 成功時の結果です。
export interface RotatedRefreshToken {
  // userId は新しいアクセストークンを発行すべきユーザーです。
  userId: string;
  // token は新世代の生リフレッシュトークンです。
  token: string;
  // expiresIn は新トークンの有効期間（秒）です。
  expiresIn: number;
}

// REVOKE_REASON_* は revoked_reason に入れる値の定数です。監査・調査時の検索キーになります。
export const REVOKE_REASON_LOGOUT = 'logout';
export const REVOKE_REASON_REUSE = 'reuse_detected';

// RefreshTokensService を NestJS の DI に登録します。
@Injectable()
// RefreshTokensService は refresh_tokens テーブルへの raw SQL アクセスと状態遷移の正本です。
export class RefreshTokensService {
  // constructor injection で DB 接続管理 service を受け取ります。
  constructor(private readonly database: DatabaseService) {}

  // issue は login / signup 時に新しいトークンファミリーの初代トークンを発行します。
  async issue(userId: string, meta: TokenClientMeta): Promise<IssuedRefreshToken> {
    // 生トークンは 256bit のランダム値です。DB には hash のみ保存します。
    const token = generateToken();

    const client = await this.database.connect();
    try {
      await client.query(
        // family_id はここで新規採番します（初代なので parent_token_id は NULL）。
        `
          INSERT INTO refresh_tokens
            (user_id, family_id, token_hash, expires_at, created_ip, created_user_agent)
          VALUES
            ($1, $2, $3, now() + make_interval(secs => $4), $5, $6)
        `,
        [
          userId,
          randomUUID(),
          hashToken(token),
          REFRESH_TOKEN_TTL_SECONDS,
          meta.ip ?? null,
          meta.userAgent ?? null,
        ],
      );

      return { token, expiresIn: REFRESH_TOKEN_TTL_SECONDS };
    } finally {
      client.release();
    }
  }

  // rotate は /auth/refresh の本体です。旧トークンを消費し、同ファミリーの新トークンを発行します。
  // 失敗理由（不明・reuse・期限切れ）はすべて同じ 401 に丸め、攻撃者へのヒントを与えません。
  async rotate(rawToken: string, meta: TokenClientMeta): Promise<RotatedRefreshToken> {
    const client = await this.database.connect();
    // rollbackError は ROLLBACK 自体の失敗を finally の release に伝えるための変数です。
    let rollbackError: unknown;

    try {
      // BEGIN により、行ロック → 状態確認 → 消費 + INSERT を 1 つの transaction にまとめます。
      await client.query('BEGIN');

      // FOR UPDATE で対象トークン行をロックします。同じトークンでの同時 refresh は
      // ここで直列化され、後着はロック解放後に「消費済み」の最新状態を見ます。
      const result = await client.query<RefreshTokenRow>(
        `
          SELECT id, user_id, family_id, expires_at, used_at, revoked_at, replaced_by_token_id
          FROM refresh_tokens
          WHERE token_hash = $1
          FOR UPDATE
        `,
        [hashToken(rawToken)],
      );

      const row = result.rows[0];

      // hash が一致する row がなければ、単に無効なトークンです（どのファミリーかも不明）。
      if (!row) {
        throw new UnauthorizedException('invalid or expired refresh token');
      }

      // 消費済み・失効済み・置換済みトークンの再提示は盗用の兆候です（reuse detection）。
      // 正規ユーザー・攻撃者のどちらが持っていても、同一ファミリーの有効トークンを全て失効させます。
      if (row.used_at !== null || row.revoked_at !== null || row.replaced_by_token_id !== null) {
        await client.query(
          // 失効済み row（logout 等）の revoked_reason は上書きしません（WHERE revoked_at IS NULL）。
          `
            UPDATE refresh_tokens
            SET revoked_at = now(), revoked_reason = $2
            WHERE family_id = $1 AND revoked_at IS NULL
          `,
          [row.family_id, REVOKE_REASON_REUSE],
        );
        // ファミリー失効は reuse 検知の成果なので、401 を返す場合でも COMMIT して確定させます。
        await client.query('COMMIT');
        throw new UnauthorizedException('invalid or expired refresh token');
      }

      // 単純な期限切れは盗用兆候ではないため、ファミリーは失効させず 401 だけ返します（ADR-0012）。
      if (row.expires_at.getTime() <= Date.now()) {
        await client.query('ROLLBACK');
        throw new UnauthorizedException('invalid or expired refresh token');
      }

      // ここまで来たら正当な rotate です。新世代トークンを同じファミリーで発行します。
      const newToken = generateToken();
      const inserted = await client.query<{ id: string }>(
        `
          INSERT INTO refresh_tokens
            (user_id, family_id, token_hash, parent_token_id, expires_at, created_ip, created_user_agent)
          VALUES
            ($1, $2, $3, $4, now() + make_interval(secs => $5), $6, $7)
          RETURNING id
        `,
        [
          row.user_id,
          row.family_id,
          hashToken(newToken),
          row.id,
          REFRESH_TOKEN_TTL_SECONDS,
          meta.ip ?? null,
          meta.userAgent ?? null,
        ],
      );

      // 旧トークンを消費済みにし、置換先への系譜を残します。
      await client.query(
        `
          UPDATE refresh_tokens
          SET used_at = now(), replaced_by_token_id = $2
          WHERE id = $1
        `,
        [row.id, inserted.rows[0].id],
      );

      await client.query('COMMIT');

      return {
        userId: row.user_id,
        token: newToken,
        expiresIn: REFRESH_TOKEN_TTL_SECONDS,
      };
    } catch (error) {
      // UnauthorizedException のうち reuse 経路は COMMIT 済みです。それ以外の未確定 transaction を巻き戻します。
      rollbackError = await safeRollback(client);
      throw error;
    } finally {
      // ROLLBACK 自体が失敗した接続は状態が信用できないため、pool へ返さず破棄します。
      client.release(rollbackError instanceof Error ? rollbackError : undefined);
    }
  }

  // revokeFamilyByToken は logout 時に、提示されたトークンのファミリー全体を失効させます。
  // トークンが不明でもエラーにしません（logout は冪等な操作として常に成功させます）。
  async revokeFamilyByToken(rawToken: string, reason: string): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query(
        // token_hash からファミリーを引き、有効な row だけを失効させます。
        `
          UPDATE refresh_tokens
          SET revoked_at = now(), revoked_reason = $2
          WHERE revoked_at IS NULL
            AND family_id = (
              SELECT family_id FROM refresh_tokens WHERE token_hash = $1
            )
        `,
        [hashToken(rawToken), reason],
      );
    } finally {
      client.release();
    }
  }
}

// generateToken は 256bit のランダム値を base64url で返します（URL・Cookie 安全な 43 文字）。
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

// hashToken は生トークンの SHA-256 hash（hex 64 文字）を返します。
// トークン自体が一様ランダム 256bit のため、bcrypt のようなコスト付き hash は不要です（ADR-0012）。
function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

// safeRollback は ROLLBACK を試み、失敗した場合はその error を返します（成功時は undefined）。
async function safeRollback(client: PoolClient): Promise<unknown> {
  try {
    await client.query('ROLLBACK');
    return undefined;
  } catch (error) {
    return error;
  }
}
