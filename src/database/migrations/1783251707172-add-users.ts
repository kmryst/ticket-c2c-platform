// ファイル概要:
// このファイルはメール+パスワード認証（ADR-0010、Issue #132）の users テーブルを追加する migration です。
// baseline（1751594400000-baseline.ts）は凍結されているため、スキーマ変更は
// この形式の新規 migration ファイルとして追加します（CLAUDE.md「スキーマ変更フロー」）。
//
// 運用ルール:
// - ローカル PoC の正本 database/schema.sql も同じ PR で同期更新する。
// - DDL は冪等（IF NOT EXISTS）で書き、途中失敗したローカル DB へ再適用しても復旧できるようにする。
// - purchases.buyer_id -> users.id の FK は購入フロー統合（Issue #135）の migration で追加する。
//   認証 API 未デプロイの時間帯に旧 API が任意の buyer_id を INSERT できる後方互換を保つため、
//   この migration では table 追加までに留める（expand-contract の expand 段階）。

import { MigrationInterface, QueryRunner } from 'typeorm';

const ADD_USERS_SQL = `
-- users はメール+パスワード認証のアカウントを表す table です（ADR-0010）。
-- purchases.buyer_id が指す「購入者の正本」をここに置き、
-- クライアント申告の UUID を信用していた PoC 初期状態から脱却します。
CREATE TABLE IF NOT EXISTS users (
  -- id はユーザーを一意に識別する UUID 主キーです。JWT の sub claim にもこの値を入れます。
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- email はログイン ID です。大文字小文字の揺れは下の functional unique index で吸収します。
  email TEXT NOT NULL,
  -- password_hash は bcrypt（コストファクター 12）のハッシュ文字列です。平文は保存しません。
  password_hash TEXT NOT NULL,
  -- created_at はアカウント作成日時です。
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- updated_at はパスワード変更など row 更新時に上書きする日時です。
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- email の一意性は lower(email) の functional unique index で保証します。
-- Foo@example.com と foo@example.com を別アカウントとして登録できてしまう事故を DB 側で防ぎます。
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (lower(email));
`;

export class AddUsers1783251707172 implements MigrationInterface {
  name = 'AddUsers1783251707172';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(ADD_USERS_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // down はユーザーアカウントを失う破壊的操作なので、明示的な DROP のみ行います。
    // dev / staging はエフェメラル環境（ADR-0008）のため、通常は destroy が巻き戻し手段です。
    await queryRunner.query('DROP INDEX IF EXISTS users_email_uq');
    await queryRunner.query('DROP TABLE IF EXISTS users');
  }
}
