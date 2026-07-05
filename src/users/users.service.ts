// ファイル概要:
// このファイルは users テーブルへの raw SQL アクセスを担当する service です（ADR-0010、Issue #133）。
// リポジトリの流儀に合わせ、TypeORM の query builder ではなく DatabaseService（pg Pool）から
// client を借りて明示的な SQL を発行します。パスワードの hash 化・比較は AuthService の責務です。

// Injectable は service を NestJS の DI 対象として登録する decorator です。
import { Injectable } from '@nestjs/common';
// DatabaseService は PostgreSQL の PoolClient を借りるための共有 service です。
import { DatabaseService } from '../database/database.service';

// UserRow は users テーブルから読む row の形です。
// password_hash を含むため、この型のままクライアントへ返してはいけません。
export interface UserRow {
  // id は users.id の UUID です。
  id: string;
  // email は登録時の表記のまま保存されたメールアドレスです。
  email: string;
  // password_hash は bcrypt のハッシュ文字列です。
  password_hash: string;
  // created_at はアカウント作成日時です。pg は timestamptz を Date として返します。
  created_at: Date;
}

// UsersService を NestJS の DI に登録します。
@Injectable()
// UsersService は users テーブルの作成・検索だけを担当する薄いデータアクセス層です。
export class UsersService {
  // constructor injection で DB 接続管理 service を受け取ります。
  constructor(private readonly database: DatabaseService) {}

  // createUser は新規ユーザーを 1 件 INSERT し、作成された row を返します。
  // email 重複時は users_email_uq により pg の unique violation（23505）が投げられます。
  // 409 への変換は呼び出し側（AuthService）が行います。
  async createUser(email: string, passwordHash: string): Promise<UserRow> {
    // 単発クエリでも pool の共有管理に乗せるため、client を借りて必ず返します。
    const client = await this.database.connect();
    try {
      const result = await client.query<UserRow>(
        // 応答に必要な値を RETURNING で取得します（password_hash は入力値と同じですが形を揃えます）。
        `
          INSERT INTO users (email, password_hash)
          VALUES ($1, $2)
          RETURNING id, email, password_hash, created_at
        `,
        // $1 は表記そのままの email、$2 は bcrypt ハッシュです。
        [email, passwordHash],
      );

      // INSERT ... RETURNING は成功時必ず 1 row を返します。
      return result.rows[0];
    } finally {
      // 成功・失敗に関係なく client を pool へ返します。
      client.release();
    }
  }

  // findByEmail はログイン時の資格情報照合のためにユーザーを検索します。
  // 一意判定と同じ lower(email) で照合し、大文字小文字の揺れを吸収します。
  async findByEmail(email: string): Promise<UserRow | null> {
    const client = await this.database.connect();
    try {
      const result = await client.query<UserRow>(
        // users_email_uq（lower(email) unique index）に乗る検索条件です。
        `
          SELECT id, email, password_hash, created_at
          FROM users
          WHERE lower(email) = lower($1)
          LIMIT 1
        `,
        // $1 はクライアントが入力した email です。
        [email],
      );

      // 見つからない場合は null を返し、401 への変換は AuthService に任せます。
      return result.rows[0] ?? null;
    } finally {
      client.release();
    }
  }

  // findById は JWT の sub claim（users.id）から現在のユーザーを引くために使います。
  async findById(id: string): Promise<UserRow | null> {
    const client = await this.database.connect();
    try {
      const result = await client.query<UserRow>(
        // 主キー lookup です。
        `
          SELECT id, email, password_hash, created_at
          FROM users
          WHERE id = $1
        `,
        // $1 は JWT 検証済みの sub（UUID）です。
        [id],
      );

      // トークン発行後にユーザーが消えた場合は null になります（呼び出し側で 401 扱い）。
      return result.rows[0] ?? null;
    } finally {
      client.release();
    }
  }
}
