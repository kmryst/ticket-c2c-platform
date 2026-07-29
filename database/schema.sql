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

-- refresh_tokens はリフレッシュトークン（opaque、ADR-0012、Issue #163）の失効状態の正本です。
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
  -- created_by はイベント作成者（users.id）です（L-10、Issue #194）。
  -- 認証必須化後は JWT の sub claim から入ります。認証導入前の row は NULL のままです。
  created_by UUID,
  -- created_at は DB に登録された日時です。履歴確認や並び替えに使えます。
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 認証導入前に作られた既存ローカル DB の events には created_by が無いため、後付けします。
-- IF NOT EXISTS により、何度 schema.sql を流しても止まりません。
ALTER TABLE events ADD COLUMN IF NOT EXISTS created_by UUID;

-- events.created_by -> users.id の外部キーです（L-10、Issue #194）。
-- 認証導入前のローカル DB には created_by が NULL の row があり得るため、
-- NOT VALID で「既存 row は検査せず、新規の書き込みだけに強制」します。
-- DO block により、何度 schema.sql を流しても duplicate_object で止まりません。
DO $$
BEGIN
  ALTER TABLE events
    ADD CONSTRAINT events_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES users(id)
    -- イベントを登録した作成者をうっかり削除できないようにします（purchases.buyer_id の RESTRICT と同じ方針）。
    ON DELETE RESTRICT
    NOT VALID;
EXCEPTION
  -- すでに FK が存在する場合は、再適用として何もしません。
  WHEN duplicate_object THEN NULL;
END
$$;

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

-- ---------------------------------------------------------------------------
-- Ticket Type expand schema（Issue #336 / ADR-0028）
-- ---------------------------------------------------------------------------
-- この段階では、上の ticket_inventory（Event 単位）が引き続き在庫の正本です。
-- Ticket Type 単位在庫は #337 の切替まで shadow として同期し、旧 backend binary が
-- ticket_type_id を知らない期間も同じ transaction 内の trigger で欠損を防ぎます。
--
-- backfill と trigger 有効化の間に旧 writer が入らないよう、expand 部分は 1 transaction
-- とし、既知 writer の入口から必要な最大 lock を決定的な順序で取得します。
-- Event / inventory の plain SELECT は継続できますが、purchases は ADD COLUMN が要求する
-- ACCESS EXCLUSIVE lock のためtransaction完了までreadも待機します。
BEGIN;

-- stuck transaction や想定外のデータ量でローカル処理を無期限に止めません。
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SET LOCAL search_path = public, pg_catalog, pg_temp;

-- events をwriter gateとして先に止めて既存writerの完了を待ち、purchasesの最大lockを
-- inventoryより先に取ることで、旧Purchaseとのlock upgrade deadlockを防ぎます。
-- Eventと後段tableを別transactionで更新する旧PoC scriptが後段lockを先取していた場合は、
-- NOWAITでtransaction全体をrollbackし、eventsを保持したまま相手を待ちません。
LOCK TABLE events IN EXCLUSIVE MODE;
LOCK TABLE purchases IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE ticket_inventory IN SHARE ROW EXCLUSIVE MODE NOWAIT;

-- ticket_types は Event 内の販売区分を表します。表示名は識別子として使わず、
-- FK は UUID、既定 Type の判定は is_default を使用します。
CREATE TABLE IF NOT EXISTS ticket_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ticket_types_name_nonblank_check
    CHECK (name <> '' AND name = btrim(name)),
  -- PostgreSQL 16 で (event_id, ticket_type_id) の複合 FK から参照する候補 key です。
  -- id 単独の PRIMARY KEY とは別に、参照列と同じ並びの UNIQUE を明示します。
  CONSTRAINT ticket_types_event_id_id_key UNIQUE (event_id, id)
);

-- 同じ Event 内で大文字小文字だけが違う表示名を重複登録できないようにします。
CREATE UNIQUE INDEX IF NOT EXISTS ticket_types_event_normalized_name_uq
  ON ticket_types (event_id, lower(name));

-- 「既定 Type」は同じ Event に最大 1 件です。最低 1 件は backfill / Event trigger で作り、
-- readiness checker が exactly-one であることを検査します。
CREATE UNIQUE INDEX IF NOT EXISTS ticket_types_one_default_per_event_uq
  ON ticket_types (event_id)
  WHERE is_default;

-- Ticket Type 単位の数量在庫です。#336 では legacy inventory の shadow であり、
-- total / remaining / version / updated_at を再計算せず、そのまま同期します。
CREATE TABLE IF NOT EXISTS ticket_type_inventory (
  ticket_type_id UUID PRIMARY KEY,
  event_id UUID NOT NULL,
  total_quantity INTEGER NOT NULL,
  remaining_quantity INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ticket_type_inventory_total_quantity_non_negative_check
    CHECK (total_quantity >= 0),
  CONSTRAINT ticket_type_inventory_remaining_quantity_non_negative_check
    CHECK (remaining_quantity >= 0),
  CONSTRAINT ticket_type_inventory_version_non_negative_check
    CHECK (version >= 0),
  CONSTRAINT ticket_type_inventory_remaining_lte_total_check
    CHECK (remaining_quantity <= total_quantity),
  CONSTRAINT ticket_type_inventory_event_ticket_type_fkey
    FOREIGN KEY (event_id, ticket_type_id)
    REFERENCES ticket_types (event_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ticket_type_inventory_event_id_idx
  ON ticket_type_inventory (event_id);

-- 旧 binary はこの列を INSERT しないため、まず nullable で追加し、下の BEFORE INSERT
-- trigger と既存 row の backfill を用意してから NOT NULL 化します。
ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS ticket_type_id UUID;

-- 既存 Event には正確に 1 件の既定 General Admission を作ります。
-- created_at / updated_at は migration 適用時刻とし、再適用時は既存 UUID と時刻を保持します。
INSERT INTO ticket_types (event_id, name, is_default)
SELECT
  e.id,
  'General Admission',
  true
FROM events e
WHERE NOT EXISTS (
  SELECT 1
  FROM ticket_types tt
  WHERE tt.event_id = e.id
    AND tt.is_default
);

-- legacy inventory が存在しない Event は現行 API 自体の前提崩れです。
-- 不完全な shadow を確定せず、expand transaction 全体を rollback します。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM events e
    LEFT JOIN ticket_inventory legacy ON legacy.event_id = e.id
    WHERE legacy.event_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Ticket Type expand aborted: an event has no legacy ticket_inventory';
  END IF;
END
$$;

-- 既存 Event 単位在庫を、その Event の既定 Ticket Type へコピーします。
INSERT INTO ticket_type_inventory (
  ticket_type_id,
  event_id,
  total_quantity,
  remaining_quantity,
  version,
  updated_at
)
SELECT
  defaults.id,
  legacy.event_id,
  legacy.total_quantity,
  legacy.remaining_quantity,
  legacy.version,
  legacy.updated_at
FROM ticket_inventory legacy
JOIN ticket_types defaults
  ON defaults.event_id = legacy.event_id
 AND defaults.is_default
ON CONFLICT (ticket_type_id) DO UPDATE
SET
  event_id = EXCLUDED.event_id,
  total_quantity = EXCLUDED.total_quantity,
  remaining_quantity = EXCLUDED.remaining_quantity,
  version = EXCLUDED.version,
  updated_at = EXCLUDED.updated_at;

-- 既存 Purchase は対象 Event の既定 Type へ紐付けます。
-- すでに値がある row は上書きせず、後段の整合性検査で誤紐付けを fail closed にします。
UPDATE purchases p
SET ticket_type_id = defaults.id
FROM ticket_types defaults
WHERE p.event_id = defaults.event_id
  AND defaults.is_default
  AND p.ticket_type_id IS NULL;

-- 新規 Event を旧 binary が作成した直後に、同じ transaction で既定 Type を作ります。
CREATE OR REPLACE FUNCTION ticket_type_expand_create_default_ticket_type()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  INSERT INTO public.ticket_types (event_id, name, is_default)
  VALUES (NEW.id, 'General Admission', true);

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS events_ticket_type_expand_default_trg ON events;
CREATE TRIGGER events_ticket_type_expand_default_trg
AFTER INSERT ON events
FOR EACH ROW
EXECUTE FUNCTION ticket_type_expand_create_default_ticket_type();

-- 旧 Event 単位在庫の INSERT / UPDATE を既定 Ticket Type の shadow へ同期します。
CREATE OR REPLACE FUNCTION ticket_type_expand_sync_inventory()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  default_ticket_type_id UUID;
BEGIN
  SELECT id
  INTO default_ticket_type_id
  FROM public.ticket_types
  WHERE event_id = NEW.event_id
    AND is_default;

  IF default_ticket_type_id IS NULL THEN
    RAISE EXCEPTION
      'ticket type inventory bridge failed: event % has no default ticket type',
      NEW.event_id;
  END IF;

  INSERT INTO public.ticket_type_inventory (
    ticket_type_id,
    event_id,
    total_quantity,
    remaining_quantity,
    version,
    updated_at
  )
  VALUES (
    default_ticket_type_id,
    NEW.event_id,
    NEW.total_quantity,
    NEW.remaining_quantity,
    NEW.version,
    NEW.updated_at
  )
  ON CONFLICT (ticket_type_id) DO UPDATE
  SET event_id = EXCLUDED.event_id,
      total_quantity = EXCLUDED.total_quantity,
      remaining_quantity = EXCLUDED.remaining_quantity,
      version = EXCLUDED.version,
      updated_at = EXCLUDED.updated_at;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS ticket_inventory_ticket_type_expand_sync_trg ON ticket_inventory;
CREATE TRIGGER ticket_inventory_ticket_type_expand_sync_trg
AFTER INSERT OR UPDATE ON ticket_inventory
FOR EACH ROW
EXECUTE FUNCTION ticket_type_expand_sync_inventory();

-- 旧 Purchase INSERT が ticket_type_id を省略した場合、対象 Event の既定 Type を補完します。
CREATE OR REPLACE FUNCTION ticket_type_expand_set_purchase_ticket_type()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.ticket_type_id IS NULL THEN
    SELECT id
    INTO NEW.ticket_type_id
    FROM public.ticket_types
    WHERE event_id = NEW.event_id
      AND is_default;
  END IF;

  IF NEW.ticket_type_id IS NULL THEN
    RAISE EXCEPTION
      'purchase ticket type bridge failed: event % has no default ticket type',
      NEW.event_id;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS purchases_ticket_type_expand_default_trg ON purchases;
CREATE TRIGGER purchases_ticket_type_expand_default_trg
BEFORE INSERT ON purchases
FOR EACH ROW
EXECUTE FUNCTION ticket_type_expand_set_purchase_ticket_type();

-- backfill と trigger が揃ったため、旧 binary の列省略を保ったまま NOT NULL にできます。
ALTER TABLE purchases
  ALTER COLUMN ticket_type_id SET NOT NULL;

-- FK の table scan と lock を分離できるよう一旦 NOT VALID で追加しますが、
-- #337 へ未検証の制約を持ち越さず、この transaction 内で必ず VALIDATE します。
DO $$
BEGIN
  ALTER TABLE purchases
    ADD CONSTRAINT purchases_event_ticket_type_fkey
    FOREIGN KEY (event_id, ticket_type_id)
    REFERENCES ticket_types (event_id, id)
    ON DELETE RESTRICT
    NOT VALID;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

ALTER TABLE purchases
  VALIDATE CONSTRAINT purchases_event_ticket_type_fkey;

CREATE INDEX IF NOT EXISTS purchases_event_ticket_type_created_at_idx
  ON purchases (event_id, ticket_type_id, created_at);

-- migration/schema 適用時点の最終整合性を検査します。1 件でも違反があれば、
-- TypeORM migration とこの expand transaction は rollback されます。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM events e
    LEFT JOIN ticket_types tt ON tt.event_id = e.id
    GROUP BY e.id
    HAVING count(tt.id) <> 1
       OR count(tt.id) FILTER (WHERE tt.is_default) <> 1
  ) THEN
    RAISE EXCEPTION
      'Ticket Type expand aborted: an event does not have exactly one default Ticket Type';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ticket_inventory legacy
    JOIN ticket_types defaults
      ON defaults.event_id = legacy.event_id
     AND defaults.is_default
    LEFT JOIN ticket_type_inventory shadow
      ON shadow.event_id = legacy.event_id
     AND shadow.ticket_type_id = defaults.id
    WHERE shadow.ticket_type_id IS NULL
       OR shadow.total_quantity IS DISTINCT FROM legacy.total_quantity
       OR shadow.remaining_quantity IS DISTINCT FROM legacy.remaining_quantity
       OR shadow.version IS DISTINCT FROM legacy.version
       OR shadow.updated_at IS DISTINCT FROM legacy.updated_at
  ) OR EXISTS (
    SELECT 1
    FROM ticket_type_inventory shadow
    JOIN ticket_types tt
      ON tt.event_id = shadow.event_id
     AND tt.id = shadow.ticket_type_id
    WHERE NOT tt.is_default
  ) THEN
    RAISE EXCEPTION
      'Ticket Type expand aborted: legacy and default Ticket Type inventory differ';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM purchases p
    LEFT JOIN ticket_types tt
      ON tt.event_id = p.event_id
     AND tt.id = p.ticket_type_id
    WHERE p.ticket_type_id IS NULL
       OR tt.id IS NULL
       OR NOT tt.is_default
  ) THEN
    RAISE EXCEPTION
      'Ticket Type expand aborted: a purchase is not linked to its Event Ticket Type';
  END IF;
END
$$;

COMMIT;
