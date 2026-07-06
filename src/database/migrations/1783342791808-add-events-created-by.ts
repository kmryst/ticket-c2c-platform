// ファイル概要:
// このファイルは events.created_by（作成者）を追加する migration です（production-readiness L-10、Issue #194）。
// イベント登録 API の認証必須化により created_by は JWT の sub（users.id）由来になるため、
// カラムを追加し、参照整合性を DB でも保証します（purchases.buyer_id の FK と同じ方針）。
//
// 後方互換（expand-contract）:
// - created_by は NULL 許容で追加する。認証導入前に作られた既存 events row は作成者が不明なため、
//   NOT NULL 化はしない（dev / staging はエフェメラル環境のため実質すべて新規 row になる）。
// - 旧タスク（created_by を INSERT しないコード）が新スキーマ上で動いても、NULL のまま成功する。
//
// NOT VALID にする理由（purchases_buyer_id_fkey と同じ）:
// - NOT VALID の FK は「既存 row は検査しないが、新規 INSERT / UPDATE には制約を強制する」ため、
//   ローカル PoC DB の過去データを壊さずに、これからの登録の整合性だけを保証できる。
// - dev / staging はエフェメラル環境（ADR-0008）で毎回 migration から作り直すため実質 VALID と同じ。

import { MigrationInterface, QueryRunner } from 'typeorm';

const ADD_EVENTS_CREATED_BY_SQL = `
-- created_by はイベント作成者（users.id）です。認証必須化後は JWT の sub claim から入ります。
-- IF NOT EXISTS により、同じ migration/schema.sql を複数回流しても止まりません。
ALTER TABLE events ADD COLUMN IF NOT EXISTS created_by UUID;

-- 既存の events へ、users への FK を後付けします。
-- DO block により、同じ migration/schema.sql を複数回流しても duplicate_object で止まりません。
DO $$
BEGIN
  ALTER TABLE events
    ADD CONSTRAINT events_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users(id)
    -- イベントを登録した作成者をうっかり削除できないようにします（purchases.buyer_id の RESTRICT と同じ方針）。
    ON DELETE RESTRICT
    -- 既存 row は検査せず、新規の書き込みだけに制約を強制します（ファイル冒頭コメント参照）。
    NOT VALID;
EXCEPTION
  -- すでに FK が存在する場合は、再適用として何もしません。
  WHEN duplicate_object THEN NULL;
END
$$;
`;

export class AddEventsCreatedBy1783342791808 implements MigrationInterface {
  name = 'AddEventsCreatedBy1783342791808';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(ADD_EVENTS_CREATED_BY_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // FK とカラムの削除。カラム削除は created_by の値を失うが、dev / staging は
    // エフェメラル環境（ADR-0008）のため、通常は destroy が巻き戻し手段です。
    await queryRunner.query(
      'ALTER TABLE events DROP CONSTRAINT IF EXISTS events_created_by_fkey',
    );
    await queryRunner.query(
      'ALTER TABLE events DROP COLUMN IF EXISTS created_by',
    );
  }
}
