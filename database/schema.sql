-- ファイル概要:
-- このファイルはローカル在庫 PoC の PostgreSQL 構造を定義する schema です。
-- events / ticket_inventory / purchases と idempotency 用 index を作り、
-- NestJS API が参照する「在庫の正本」と「購入判定の履歴」を DB 上に用意します。

-- ローカル在庫 PoC 用の PostgreSQL schema です。
-- このファイルは、Docker Compose で起動した PostgreSQL にそのまま流し込む実行可能な DB 定義です。
-- 現時点の目的はプロダクト全体の完成形を表すことではありません。
-- 目的は「同時購入が来ても在庫数を超えて confirmed にしない」ことを DB レベルで検証することです。

-- pgcrypto は gen_random_uuid() を使うために有効化します。
-- UUID を API や PoC script 側で毎回作らなくても、DB 側で主キーを生成できます。
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- purchase_status は購入判定の結果を DB 上で enum として固定します。
-- confirmed は在庫を確保できた購入、rejected は在庫不足などで確保できなかった購入です。
-- DO block にしているのは、同じ schema.sql を何度流しても duplicate_object で止まらないようにするためです。
DO $$
BEGIN
  -- 初回適用時だけ purchase_status enum を作成します。
  CREATE TYPE purchase_status AS ENUM ('confirmed', 'rejected');
EXCEPTION
  -- すでに enum が存在する場合は、ローカル再適用として何もしません。
  WHEN duplicate_object THEN NULL;
END
$$;

-- users はメール+パスワード認証のアカウントを表す table です（ADR-0010、Issue #132）。
-- purchases.buyer_id が指す「購入者の正本」をここに置きます。
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

-- events は販売対象になるイベントを表す table です。
-- この PoC では購入対象としての event_id が主役ですが、後続の検索 PoC でも使えるよう最低限の属性を持ちます。
CREATE TABLE IF NOT EXISTS events (
  -- id はイベントを一意に識別する UUID 主キーです。
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- title はイベント名です。PoC script が seed data として分かりやすい名前を入れます。
  title TEXT NOT NULL,
  -- event_type は music / sports などの分類を想定した文字列です。
  event_type TEXT NOT NULL,
  -- starts_at はイベント開始日時です。検索や並び替えの対象になります。
  starts_at TIMESTAMPTZ NOT NULL,
  -- location_latitude は緯度です。位置検索 PoC で使えるよう残しています。
  location_latitude NUMERIC(9, 6),
  -- location_longitude は経度です。位置検索 PoC で使えるよう残しています。
  location_longitude NUMERIC(9, 6),
  -- created_at は DB に登録された日時です。履歴確認や並び替えに使えます。
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ticket_inventory はイベントごとの在庫を表す table です。
-- この table の remaining_quantity が、PoC における在庫の正本です。
-- API は confirmed の購入履歴を作る前に、必ずこの table の在庫を減らします。
CREATE TABLE IF NOT EXISTS ticket_inventory (
  -- event_id は events.id に対応する在庫 row の主キーです。
  -- PRIMARY KEY にすることで「1 event につき在庫 row は 1 つだけ」と DB が保証します。
  -- ON DELETE CASCADE はローカル PoC で event を消したとき、対応する在庫も消せるようにする設定です。
  event_id UUID PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  -- total_quantity はイベントの初期販売可能枚数です。
  -- CHECK により、初期在庫がマイナスになる不正データを防ぎます。
  total_quantity INTEGER NOT NULL CHECK (total_quantity >= 0),
  -- remaining_quantity は現在残っている在庫数です。
  -- PurchasesService は conditional UPDATE でこの値を減らし、0 未満にならない条件を SQL に含めます。
  remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0),
  -- version は confirmed の購入で在庫更新に成功するたび 1 増えます。
  -- PoC の結果確認で「在庫更新が何回成功したか」を観察するための軽いカウンターです。
  version INTEGER NOT NULL DEFAULT 0,
  -- updated_at は在庫 row の最終更新日時です。
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- remaining_quantity は total_quantity を超えてはいけないため、防御的に table 制約を置きます。
  CHECK (remaining_quantity <= total_quantity)
);

-- purchases は購入 API が下した判定を履歴として残す table です。
-- confirmed だけでなく rejected も保存することで、PoC 実行後に成功数・拒否数・再送挙動を確認できます。
CREATE TABLE IF NOT EXISTS purchases (
  -- id は購入履歴 row 自体を一意に識別する UUID 主キーです。
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- event_id は購入対象イベントです。
  -- ON DELETE RESTRICT により、購入履歴がある event をうっかり削除できないようにしています。
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  -- buyer_id は購入者（users.id）を識別する UUID です。
  -- 認証 API の統合（ADR-0010、Issue #135）により、値は JWT の sub claim 由来になりました。
  -- FK 制約は後方互換のため CREATE TABLE 内ではなく、下の DO block で後付けします。
  buyer_id UUID NOT NULL,
  -- request_id はクライアントが任意で送る idempotency key です。
  -- 同じ buyer/event/request_id の再送を、後続の partial unique index で制御します。
  request_id TEXT,
  -- quantity はこの購入判定で要求された枚数です。
  -- 0 枚以下の購入は業務的に意味がないため CHECK で拒否します。
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  -- status は confirmed / rejected のどちらかです。
  status purchase_status NOT NULL,
  -- rejection_reason は rejected の理由です。
  -- confirmed の場合は拒否理由がないため null にします。
  rejection_reason TEXT,
  -- remaining_quantity_after は confirmed 直後の残在庫 snapshot です。
  -- 同じ request_id の再送時に、後から変わった現在在庫ではなく元の応答値を返すために保存します。
  remaining_quantity_after INTEGER CHECK (
    -- rejected の場合など、残在庫 snapshot が存在しないときは null を許可します。
    remaining_quantity_after IS NULL
    -- snapshot がある場合は、在庫数なので 0 以上である必要があります。
    OR remaining_quantity_after >= 0
  ),
  -- created_at は購入判定が記録された日時です。
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- status と rejection_reason の整合性を DB 側でも守ります。
  CHECK (
    -- confirmed の購入には拒否理由があってはいけません。
    (status = 'confirmed' AND rejection_reason IS NULL)
    OR
    -- rejected の購入には拒否理由が必要です。
    (status = 'rejected' AND rejection_reason IS NOT NULL)
  )
);

-- 既存のローカル DB に対する後方互換の column 追加です。
-- 新規 DB では CREATE TABLE 内で作られるため、この ALTER は実質 no-op になります。
ALTER TABLE purchases
  -- IF NOT EXISTS により、何度 schema.sql を流しても同じ column 追加で失敗しません。
  ADD COLUMN IF NOT EXISTS remaining_quantity_after INTEGER;

-- 既存のローカル DB に対する後方互換の constraint 追加です。
-- 新規 DB では CREATE TABLE 内の CHECK が効くため、この DO block は再適用耐性のために残しています。
DO $$
BEGIN
  -- 古い purchases table に remaining_quantity_after の非負制約を追加します。
  ALTER TABLE purchases
    ADD CONSTRAINT purchases_remaining_quantity_after_non_negative
    CHECK (
      -- null は snapshot がない状態として許可します。
      remaining_quantity_after IS NULL
      -- 値がある場合は 0 以上に限定します。
      OR remaining_quantity_after >= 0
    );
EXCEPTION
  -- constraint がすでにある場合は、再適用として何もしません。
  WHEN duplicate_object THEN NULL;
END
$$;

-- purchases.buyer_id -> users.id の外部キーです（ADR-0010、Issue #135）。
-- 認証導入前のローカル DB には users に存在しない buyer_id を持つ row があり得るため、
-- NOT VALID で「既存 row は検査せず、新規の書き込みだけに強制」します。
-- DO block により、何度 schema.sql を流しても duplicate_object で止まりません。
DO $$
BEGIN
  ALTER TABLE purchases
    ADD CONSTRAINT purchases_buyer_id_fkey
    FOREIGN KEY (buyer_id) REFERENCES users(id)
    -- 購入履歴がある buyer をうっかり削除できないようにします（event_id の RESTRICT と同じ方針）。
    ON DELETE RESTRICT
    NOT VALID;
EXCEPTION
  -- すでに FK が存在する場合は、再適用として何もしません。
  WHEN duplicate_object THEN NULL;
END
$$;

-- event_type と starts_at の複合 index です。
-- 在庫 PoC の主役ではありませんが、イベント分類 + 開始日時検索の検証に使えます。
CREATE INDEX IF NOT EXISTS events_event_type_starts_at_idx
  -- event_type で絞り、starts_at で並べる検索を想定しています。
  ON events (event_type, starts_at);

-- starts_at 単体の index です。
-- 日付順のイベント一覧や期間検索を想定しています。
CREATE INDEX IF NOT EXISTS events_starts_at_idx
  -- starts_at の range scan を速くするための index です。
  ON events (starts_at);

-- event_id + created_at の index です。
-- PoC summary query や、将来の seller 向けイベント別購入履歴で使う想定です。
CREATE INDEX IF NOT EXISTS purchases_event_id_created_at_idx
  -- event ごとの購入履歴を作成日時順に読むための index です。
  ON purchases (event_id, created_at);

-- buyer_id + created_at の index です。
-- 将来の buyer 向け購入履歴一覧で使う想定です。
CREATE INDEX IF NOT EXISTS purchases_buyer_id_created_at_idx
  -- buyer ごとの購入履歴を作成日時順に読むための index です。
  ON purchases (buyer_id, created_at);

-- request_id 再送確認用の lookup index です。
-- PurchasesService が buyer/event/request_id/status で既存結果を探すために使います。
CREATE INDEX IF NOT EXISTS purchases_request_lookup_idx
  -- confirmed と rejected のどちらも同じ lookup 形で検索できるよう status まで含めます。
  ON purchases (buyer_id, event_id, request_id, status)
  -- request_id が null の通常購入は idempotency 対象外なので index から除外します。
  WHERE request_id IS NOT NULL;

-- 古い confirmed request_id unique index を置き換えるときに使う一時 index 名を先に消します。
-- これにより、途中で失敗したローカル DB に schema.sql を再適用しても復旧しやすくなります。
DROP INDEX IF EXISTS purchases_request_id_uq_next;

-- confirmed idempotency 用の unique index を用意します。
-- 同じ buyer/event/request_id の confirmed は最大 1 件だけ、というルールを DB が保証します。
-- DO block にすることで、古い index 形状のローカル DB も安全に移行できます。
DO $$
BEGIN
  -- まだ confirmed 用 unique index が存在しない新規 DB の場合です。
  IF to_regclass('public.purchases_request_id_uq') IS NULL THEN
    -- buyer/event/request_id の組み合わせを confirmed に限って一意にします。
    CREATE UNIQUE INDEX purchases_request_id_uq
      ON purchases (buyer_id, event_id, request_id)
      -- request_id がある confirmed row だけを一意制約の対象にします。
      WHERE request_id IS NOT NULL
        AND status = 'confirmed';
  -- 既存 index があるが、古い column 構成だった場合は作り直します。
  ELSIF NOT EXISTS (
    -- pg_indexes から現在の index 定義を確認します。
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'purchases_request_id_uq'
      -- buyer_id, event_id, request_id の順で作られているかを確認します。
      AND indexdef LIKE '%buyer_id, event_id, request_id%'
  ) THEN
    -- 新しい形の index を一時名で作ります。
    CREATE UNIQUE INDEX purchases_request_id_uq_next
      ON purchases (buyer_id, event_id, request_id)
      WHERE request_id IS NOT NULL
        AND status = 'confirmed';

    -- 古い index を削除します。
    DROP INDEX purchases_request_id_uq;

    -- 一時名の index を正式名へ変更します。
    ALTER INDEX purchases_request_id_uq_next
      RENAME TO purchases_request_id_uq;
  END IF;
END
$$;

-- rejected idempotency 用の unique index です。
-- 同じ buyer/event/request_id の rejected 再送で rejected row が無限に増えることを防ぎます。
-- confirmed とは別 index にしておくことで、将来在庫が補充された場合の confirmed 余地は残します。
CREATE UNIQUE INDEX IF NOT EXISTS purchases_rejected_request_id_uq
  -- rejected も buyer/event/request_id の組み合わせで一意にします。
  ON purchases (buyer_id, event_id, request_id)
  -- request_id がある rejected row だけを一意制約の対象にします。
  WHERE request_id IS NOT NULL
    AND status = 'rejected';
