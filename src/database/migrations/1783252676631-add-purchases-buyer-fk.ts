// ファイル概要:
// このファイルは purchases.buyer_id -> users.id の外部キーを追加する migration です（ADR-0010、Issue #135）。
// 購入 API の認証必須化により buyer_id は JWT の sub（users.id）由来になるため、
// 参照整合性を DB でも保証します（expand-contract の contract 段階）。
//
// NOT VALID にする理由:
// - 認証導入前に作られた既存 purchases row は、users に存在しないランダムな buyer_id を持ち得る
//   （PoC スクリプトがクライアント申告 UUID を送っていた M-1 時代のデータ）。
// - NOT VALID の FK は「既存 row は検査しないが、新規 INSERT / UPDATE には制約を強制する」ため、
//   ローカル PoC DB の過去データを壊さずに、これからの購入の整合性だけを保証できる。
// - dev / staging はエフェメラル環境（ADR-0008）で毎回 migration から作り直すため実質 VALID と同じ。
//   本番相当環境で完全な VALIDATE が必要になったら、過去データ整理とセットで別 migration にする。

import { MigrationInterface, QueryRunner } from 'typeorm';

const ADD_BUYER_FK_SQL = `
-- 既存の purchases（buyer table が無い時代の table 定義）へ、users への FK を後付けします。
-- DO block により、同じ migration/schema.sql を複数回流しても duplicate_object で止まりません。
DO $$
BEGIN
  ALTER TABLE purchases
    ADD CONSTRAINT purchases_buyer_id_fkey
    FOREIGN KEY (buyer_id) REFERENCES users(id)
    -- 購入履歴がある buyer をうっかり削除できないようにします（event_id の RESTRICT と同じ方針）。
    ON DELETE RESTRICT
    -- 既存 row は検査せず、新規の書き込みだけに制約を強制します（ファイル冒頭コメント参照）。
    NOT VALID;
EXCEPTION
  -- すでに FK が存在する場合は、再適用として何もしません。
  WHEN duplicate_object THEN NULL;
END
$$;
`;

export class AddPurchasesBuyerFk1783252676631 implements MigrationInterface {
  name = 'AddPurchasesBuyerFk1783252676631';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(ADD_BUYER_FK_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // FK の削除は非破壊（データは消えない）なので、素直に落とします。
    await queryRunner.query(
      'ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_buyer_id_fkey',
    );
  }
}
