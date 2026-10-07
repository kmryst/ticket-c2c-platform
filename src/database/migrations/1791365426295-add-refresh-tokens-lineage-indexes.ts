// ファイル概要:
// このファイルは refresh_tokens の自己参照 FK（parent_token_id / replaced_by_token_id）に
// index を追加する migration です（Issue #542）。
//
// 背景:
// - refresh token cleanup（refresh-token-cleanup.ts）は期限切れファミリーの row を DELETE する。
//   PostgreSQL は参照される側の row を DELETE するたびに、FK 制約の確認として
//   「この row を parent_token_id / replaced_by_token_id で参照している row が無いか」を検索する。
//   参照する側の列に index が無いと、この検索は削除 1 row ごとに refresh_tokens 全体の seq scan になる。
// - ローカルの計測（refresh_tokens 25 万 row、うち削除対象 2,000 row）で、DELETE 1 statement に
//   約 55 秒かかり、その大半（2 つの FK 確認で計 54.7 秒）がこの検索だった。
//   cleanup を api 内の定期実行へ移すにあたり（ADR-0041）、DB の CPU を長時間使い続けないよう index を足す。
//
// 運用ルール:
// - CREATE INDEX CONCURRENTLY で作り、login / refresh の書き込みを止めない。CONCURRENTLY は
//   transaction 内で実行できないため、この migration だけ transaction = false にする。
// - CONCURRENTLY が途中で失敗すると INVALID な index が残り、IF NOT EXISTS では作り直されない。
//   再実行で復旧できるよう、INVALID な index があれば先に DROP INDEX CONCURRENTLY する。
// - 部分 index（IS NOT NULL）にする。初回発行の row は parent_token_id が NULL、未使用の row は
//   replaced_by_token_id が NULL で、FK の確認（= 比較）は NULL の row を検索しないため。
// - expand-only（index の追加のみ）で、旧タスクの動作は変わらない。
// - ローカル PoC の正本 database/schema.sql も同じ PR で同期更新する。

import { MigrationInterface, QueryRunner } from 'typeorm';

const INDEXES = [
  {
    name: 'refresh_tokens_parent_token_idx',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS refresh_tokens_parent_token_idx ON refresh_tokens (parent_token_id) WHERE parent_token_id IS NOT NULL',
  },
  {
    name: 'refresh_tokens_replaced_by_token_idx',
    sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS refresh_tokens_replaced_by_token_idx ON refresh_tokens (replaced_by_token_id) WHERE replaced_by_token_id IS NOT NULL',
  },
] as const;

export class AddRefreshTokensLineageIndexes1791365426295
  implements MigrationInterface
{
  name = 'AddRefreshTokensLineageIndexes1791365426295';

  // CREATE INDEX CONCURRENTLY は transaction 内で実行できないため、この migration は transaction を張りません。
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const index of INDEXES) {
      const invalid = (await queryRunner.query(
        `
          SELECT 1
          FROM pg_index i
          JOIN pg_class c ON c.oid = i.indexrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = $1
            AND n.nspname = current_schema()
            AND NOT i.indisvalid
        `,
        [index.name],
      )) as unknown[];
      if (invalid.length > 0) {
        await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
      }
      await queryRunner.query(index.sql);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX CONCURRENTLY IF EXISTS refresh_tokens_replaced_by_token_idx',
    );
    await queryRunner.query(
      'DROP INDEX CONCURRENTLY IF EXISTS refresh_tokens_parent_token_idx',
    );
  }
}
