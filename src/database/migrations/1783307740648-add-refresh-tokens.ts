// ファイル概要:
// このファイルはリフレッシュトークン導入（ADR-0012、Issue #163）の refresh_tokens テーブルを追加する migration です。
// baseline（1751594400000-baseline.ts）は凍結されているため、スキーマ変更は
// この形式の新規 migration ファイルとして追加します（CLAUDE.md「スキーマ変更フロー」）。
//
// 運用ルール:
// - ローカル PoC の正本 database/schema.sql も同じ PR で同期更新する。
// - DDL は冪等（IF NOT EXISTS）で書き、途中失敗したローカル DB へ再適用しても復旧できるようにする。
// - この migration は expand-only（テーブル追加のみ）で、既存テーブル・既存 API の動作を変えない。
//   /auth/refresh の実装は後続 Issue で行う（旧タスクはこのテーブルを参照しないため後方互換）。

import { MigrationInterface, QueryRunner } from 'typeorm';

const ADD_REFRESH_TOKENS_SQL = `
-- refresh_tokens はリフレッシュトークン（opaque、ADR-0012）の失効状態の正本です。
-- 生トークンは保存せず SHA-256 hash のみ保存するため、DB が漏洩しても元トークンは復元できません。
-- rotate-on-use と reuse detection（ファミリー失効）に必要な系譜情報をこのテーブルで追跡します。
CREATE TABLE IF NOT EXISTS refresh_tokens (
  -- id はトークン row を一意に識別する UUID 主キーです。系譜（parent / replaced_by）の参照にも使います。
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- user_id はトークンの持ち主です。ユーザー削除時はトークンも一括で消えます。
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- family_id は login / signup ごとに採番するトークンファミリーの識別子です。
  -- rotate で世代が進んでも family_id は引き継がれ、reuse detection の失効単位になります。
  family_id UUID NOT NULL,
  -- token_hash は opaque トークン（256bit ランダム値）の SHA-256 hash（hex 64 文字）です。
  token_hash TEXT NOT NULL,
  -- parent_token_id は rotate 元のトークンです。初回発行（login / signup）では NULL です。
  parent_token_id UUID REFERENCES refresh_tokens(id),
  -- replaced_by_token_id は rotate でこのトークンを置き換えた新トークンです。未使用なら NULL です。
  replaced_by_token_id UUID REFERENCES refresh_tokens(id),
  -- issued_at はトークン発行日時です。
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- expires_at はトークンの絶対期限（発行から 14 日。ADR-0012）です。超過は reuse とは扱いません。
  expires_at TIMESTAMPTZ NOT NULL,
  -- used_at は rotate-on-use でこのトークンが消費された日時です。消費済みトークンの再提示は盗用兆候です。
  used_at TIMESTAMPTZ,
  -- revoked_at はこのトークンが無効化された日時です（logout / reuse 検知によるファミリー失効）。
  revoked_at TIMESTAMPTZ,
  -- revoked_reason は無効化の理由（'logout' / 'reuse_detected' など）です。監査・調査用に残します。
  revoked_reason TEXT,
  -- created_ip はトークン発行時のクライアント IP（trusted-hops 解決後）です。盗用調査の手がかりに使います。
  created_ip TEXT,
  -- created_user_agent はトークン発行時の User-Agent です。同じく調査用の補助情報です。
  created_user_agent TEXT
);

-- token_hash は提示されたトークンの照合キーであり、一意である必要があります。
CREATE UNIQUE INDEX IF NOT EXISTS refresh_tokens_token_hash_uq ON refresh_tokens (token_hash);

-- family_id はファミリー失効（reuse detection / logout）の UPDATE 条件に使います。
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens (family_id);

-- user_id はユーザー単位の調査・将来の「ログイン中セッション一覧」に使います。
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);
`;

export class AddRefreshTokens1783307740648 implements MigrationInterface {
  name = 'AddRefreshTokens1783307740648';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(ADD_REFRESH_TOKENS_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // down は全ユーザーのログインセッション（リフレッシュトークン）を失う破壊的操作なので、明示的な DROP のみ行います。
    // dev / staging はエフェメラル環境（ADR-0008）のため、通常は destroy が巻き戻し手段です。
    await queryRunner.query('DROP INDEX IF EXISTS refresh_tokens_user_idx');
    await queryRunner.query('DROP INDEX IF EXISTS refresh_tokens_family_idx');
    await queryRunner.query('DROP INDEX IF EXISTS refresh_tokens_token_hash_uq');
    await queryRunner.query('DROP TABLE IF EXISTS refresh_tokens');
  }
}
