// ファイル概要:
// このファイルは Event 単位の在庫を正本に残したまま、Ticket Type 単位の
// shadow schema を追加する expand migration です（Issue #336）。
//
// 後方互換:
// - 旧 application は引き続き events / ticket_inventory / purchases だけへ書き込む。
// - temporary trigger bridge が同じ transaction 内で default Ticket Type と
//   Ticket Type 在庫を補完するため、migration 後も旧 binary の write が収束する。
// - Ticket Type 単位の在庫を正本へ切り替えるのは後続 Issue #337 で行う。
//
// 排他方針:
// - TypeORM が migration 全体を 1 transaction で実行する前提で、最初に既知 writer の
//   入口である events を EXCLUSIVE lock し、必要な最大 lock を決定的な順序で取得する。
// - backfill と trigger 導入の間に旧 binary の write が入り込む one-shot gap を
//   作らず、trigger と整合性検査が揃ってから commit する。

import { MigrationInterface, QueryRunner } from 'typeorm';

const SET_MIGRATION_TIMEOUTS_SQL = `
-- stuck transaction や想定外のデータ量で販売処理を無期限に止めない。
-- deadline 超過時は migration transaction 全体を rollback し、安全に再実行する。
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SET LOCAL search_path = public, pg_catalog, pg_temp;
`;

const LOCK_LEGACY_TABLES_SQL = `
-- 1. events の EXCLUSIVE lock は plain SELECT を許可しつつ、旧 Event/Purchase writer が
--    新しく transaction へ入ることを止め、すでに入っている writer の完了を待つ。
-- 2. purchases は ADD COLUMN / SET NOT NULL が要求する ACCESS EXCLUSIVE を先取りする。
-- 3. その後に inventory write を止めることで、旧 Purchase が purchases read を保持したまま
--    inventory write 待ちになる lock upgrade deadlock を作らない。
-- events と後段 table を別 transaction で更新する旧 PoC script が後段 lock を先取した場合は、
-- NOWAIT で migration 全体を即時 rollback する。events を保持したまま相手を待たない。
LOCK TABLE events IN EXCLUSIVE MODE;
LOCK TABLE purchases IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE ticket_inventory IN SHARE ROW EXCLUSIVE MODE NOWAIT;
`;

const ASSERT_LEGACY_INVENTORY_SQL = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM events AS event
    LEFT JOIN ticket_inventory AS inventory
      ON inventory.event_id = event.id
    WHERE inventory.event_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'ticket type expand migration aborted: legacy event without ticket_inventory';
  END IF;
END
$$;
`;

const CREATE_EXPAND_SCHEMA_SQL = `
CREATE TABLE ticket_types (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL,
  name TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ticket_types_pkey PRIMARY KEY (id),
  CONSTRAINT ticket_types_event_id_fkey
    FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  CONSTRAINT ticket_types_name_nonblank_check
    CHECK (name <> '' AND name = btrim(name)),
  -- PostgreSQL の複合 FK は参照列と同じ一意制約を必要とする。
  -- id 単独の PK から (event_id, id) の一意性は自動推論されないため明示する。
  CONSTRAINT ticket_types_event_id_id_key UNIQUE (event_id, id)
);

-- 同じ Event 内では、大文字小文字だけが異なる Ticket Type 名も重複とみなす。
CREATE UNIQUE INDEX ticket_types_event_normalized_name_uq
  ON ticket_types (event_id, lower(name));

-- 表示名とは独立して「default は Event ごとに最大 1 件」を DB で保証する。
CREATE UNIQUE INDEX ticket_types_one_default_per_event_uq
  ON ticket_types (event_id)
  WHERE is_default;

CREATE TABLE ticket_type_inventory (
  ticket_type_id UUID NOT NULL,
  event_id UUID NOT NULL,
  total_quantity INTEGER NOT NULL,
  remaining_quantity INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ticket_type_inventory_pkey PRIMARY KEY (ticket_type_id),
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
    REFERENCES ticket_types(event_id, id)
    ON DELETE CASCADE
);

CREATE INDEX ticket_type_inventory_event_id_idx
  ON ticket_type_inventory (event_id);

-- NULL 許容で expand してから全 row を backfill し、trigger 導入後に NOT NULL 化する。
ALTER TABLE purchases
  ADD COLUMN ticket_type_id UUID;
`;

const BACKFILL_EXPAND_SCHEMA_SQL = `
-- 既存 Event は、移行前の 1 Event = 1 inventory を表す default Ticket Type へ写像する。
INSERT INTO ticket_types (event_id, name, is_default)
SELECT id, 'General Admission', true
FROM events;

-- Issue #336 では legacy ticket_inventory が正本であり、この table は shadow copy。
INSERT INTO ticket_type_inventory (
  ticket_type_id,
  event_id,
  total_quantity,
  remaining_quantity,
  version,
  updated_at
)
SELECT
  ticket_type.id,
  inventory.event_id,
  inventory.total_quantity,
  inventory.remaining_quantity,
  inventory.version,
  inventory.updated_at
FROM ticket_inventory AS inventory
JOIN ticket_types AS ticket_type
  ON ticket_type.event_id = inventory.event_id
 AND ticket_type.is_default;

-- 既存 Purchase は、同じ Event の default Ticket Type へ紐付ける。
UPDATE purchases AS purchase
SET ticket_type_id = ticket_type.id
FROM ticket_types AS ticket_type
WHERE ticket_type.event_id = purchase.event_id
  AND ticket_type.is_default;
`;

const CREATE_LIVE_WRITE_BRIDGE_SQL = `
-- 旧 binary が Event だけを INSERT しても、その transaction 内で default Type を作る。
CREATE FUNCTION ticket_type_expand_create_default_ticket_type()
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

CREATE TRIGGER events_ticket_type_expand_default_trg
AFTER INSERT ON events
FOR EACH ROW
EXECUTE FUNCTION ticket_type_expand_create_default_ticket_type();

-- legacy inventory が正本の expand 期間は、INSERT / UPDATE の最終値を shadow へ同期する。
CREATE FUNCTION ticket_type_expand_sync_inventory()
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

CREATE TRIGGER ticket_inventory_ticket_type_expand_sync_trg
AFTER INSERT OR UPDATE ON ticket_inventory
FOR EACH ROW
EXECUTE FUNCTION ticket_type_expand_sync_inventory();

-- 旧 binary は purchases.ticket_type_id を指定しないため、INSERT 前に default を補完する。
CREATE FUNCTION ticket_type_expand_set_purchase_ticket_type()
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

CREATE TRIGGER purchases_ticket_type_expand_default_trg
BEFORE INSERT ON purchases
FOR EACH ROW
EXECUTE FUNCTION ticket_type_expand_set_purchase_ticket_type();
`;

const FINALIZE_PURCHASE_CONSTRAINTS_SQL = `
-- NOT VALID で短時間に登録した後、この migration 内で必ず既存 row も検証する。
-- #337 の cutover へ未検証 FK を持ち越さない。
ALTER TABLE purchases
  ADD CONSTRAINT purchases_event_ticket_type_fkey
  FOREIGN KEY (event_id, ticket_type_id)
  REFERENCES ticket_types(event_id, id)
  ON DELETE RESTRICT
  NOT VALID;

ALTER TABLE purchases
  VALIDATE CONSTRAINT purchases_event_ticket_type_fkey;

-- BEFORE INSERT trigger が旧 binary の省略値を補完するため、NOT NULL と両立する。
ALTER TABLE purchases
  ALTER COLUMN ticket_type_id SET NOT NULL;

CREATE INDEX purchases_event_ticket_type_created_at_idx
  ON purchases (event_id, ticket_type_id, created_at);
`;

// up後のassertとdown前のguardで、legacy正本とdefault Type shadowの
// 同じ不変条件を使う。片方だけの条件変更でrollback可否を誤判定させない。
const LEGACY_SHADOW_INVENTORY_MISMATCH_PREDICATE_SQL = `EXISTS (
  SELECT 1
  FROM ticket_inventory AS legacy
  FULL JOIN (
    SELECT
      ticket_type.event_id,
      shadow.total_quantity,
      shadow.remaining_quantity,
      shadow.version,
      shadow.updated_at
    FROM ticket_types AS ticket_type
    JOIN ticket_type_inventory AS shadow
      ON shadow.event_id = ticket_type.event_id
     AND shadow.ticket_type_id = ticket_type.id
    WHERE ticket_type.is_default
  ) AS expanded
    ON expanded.event_id = legacy.event_id
  WHERE legacy.event_id IS NULL
     OR expanded.event_id IS NULL
     OR expanded.total_quantity IS DISTINCT FROM legacy.total_quantity
     OR expanded.remaining_quantity IS DISTINCT FROM legacy.remaining_quantity
     OR expanded.version IS DISTINCT FROM legacy.version
     OR expanded.updated_at IS DISTINCT FROM legacy.updated_at
)`;

const ASSERT_EXPAND_SCHEMA_SQL = `
DO $$
BEGIN
  IF EXISTS (
    SELECT event.id
    FROM events AS event
    LEFT JOIN ticket_types AS ticket_type
      ON ticket_type.event_id = event.id
    GROUP BY event.id
    HAVING count(ticket_type.id) <> 1
       OR count(ticket_type.id) FILTER (WHERE ticket_type.is_default) <> 1
  ) THEN
    RAISE EXCEPTION
      'ticket type expand migration aborted: default ticket type count is not exactly one';
  END IF;

  IF ${LEGACY_SHADOW_INVENTORY_MISMATCH_PREDICATE_SQL} OR EXISTS (
    SELECT 1
    FROM ticket_type_inventory AS shadow
    JOIN ticket_types AS ticket_type
      ON ticket_type.event_id = shadow.event_id
     AND ticket_type.id = shadow.ticket_type_id
    WHERE NOT ticket_type.is_default
  ) THEN
    RAISE EXCEPTION
      'ticket type expand migration aborted: ticket type inventory does not match legacy inventory';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM purchases AS purchase
    LEFT JOIN ticket_types AS ticket_type
      ON ticket_type.event_id = purchase.event_id
     AND ticket_type.id = purchase.ticket_type_id
    WHERE purchase.ticket_type_id IS NULL
       OR ticket_type.id IS NULL
       OR NOT ticket_type.is_default
  ) THEN
    RAISE EXCEPTION
      'ticket type expand migration aborted: purchase ticket type linkage is invalid';
  END IF;
END
$$;
`;

const LOCK_EXPANDED_TABLES_FOR_ROLLBACK_SQL = `
-- down は trigger / column / table を削除するため、必要な最大 lock を先に取得する。
-- events を writer gate として最初に止め、lock upgrade による deadlock を避ける。
-- 後段 table に既存 writer がいれば、events を保持したまま待たず全体を rollback する。
LOCK TABLE events IN ACCESS EXCLUSIVE MODE;
LOCK TABLE purchases IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE ticket_inventory IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE ticket_types IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE ticket_type_inventory IN ACCESS EXCLUSIVE MODE NOWAIT;
`;

const ASSERT_SAFE_ROLLBACK_SQL = `
DO $$
BEGIN
  -- rollback は 1 Event = 1 default Type へ可逆な expand 状態だけを許可する。
  IF EXISTS (
    SELECT event.id
    FROM events AS event
    LEFT JOIN ticket_types AS ticket_type
      ON ticket_type.event_id = event.id
    GROUP BY event.id
    HAVING count(ticket_type.id) <> 1
       OR count(ticket_type.id) FILTER (WHERE ticket_type.is_default) <> 1
  ) OR EXISTS (
    SELECT 1
    FROM ticket_types
    WHERE NOT is_default
  ) THEN
    RAISE EXCEPTION
      'ticket type expand rollback blocked: each event must have exactly one default ticket type';
  END IF;

  -- shadow にしかない在庫や値の差があれば、drop による情報消失を防いで停止する。
  IF ${LEGACY_SHADOW_INVENTORY_MISMATCH_PREDICATE_SQL} THEN
    RAISE EXCEPTION
      'ticket type expand rollback blocked: ticket type inventory does not match legacy inventory';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM purchases AS purchase
    WHERE purchase.ticket_type_id IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM ticket_types AS ticket_type
         WHERE ticket_type.event_id = purchase.event_id
           AND ticket_type.id = purchase.ticket_type_id
           AND ticket_type.is_default
       )
  ) THEN
    RAISE EXCEPTION
      'ticket type expand rollback blocked: purchases are not linked to the event default ticket type';
  END IF;
END
$$;
`;

const DROP_EXPAND_SCHEMA_SQL = `
DROP TRIGGER IF EXISTS events_ticket_type_expand_default_trg ON events;
DROP TRIGGER IF EXISTS ticket_inventory_ticket_type_expand_sync_trg
  ON ticket_inventory;
DROP TRIGGER IF EXISTS purchases_ticket_type_expand_default_trg ON purchases;

DROP FUNCTION IF EXISTS ticket_type_expand_create_default_ticket_type();
DROP FUNCTION IF EXISTS ticket_type_expand_sync_inventory();
DROP FUNCTION IF EXISTS ticket_type_expand_set_purchase_ticket_type();

ALTER TABLE purchases
  DROP CONSTRAINT IF EXISTS purchases_event_ticket_type_fkey;

DROP INDEX IF EXISTS purchases_event_ticket_type_created_at_idx;

ALTER TABLE purchases
  DROP COLUMN IF EXISTS ticket_type_id;

DROP TABLE ticket_type_inventory;
DROP TABLE ticket_types;
`;

export class AddTicketTypeExpandSchema1785128190273
  implements MigrationInterface
{
  name = 'AddTicketTypeExpandSchema1785128190273';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(SET_MIGRATION_TIMEOUTS_SQL);
    await queryRunner.query(LOCK_LEGACY_TABLES_SQL);
    await queryRunner.query(ASSERT_LEGACY_INVENTORY_SQL);
    await queryRunner.query(CREATE_EXPAND_SCHEMA_SQL);
    await queryRunner.query(BACKFILL_EXPAND_SCHEMA_SQL);
    await queryRunner.query(CREATE_LIVE_WRITE_BRIDGE_SQL);
    await queryRunner.query(FINALIZE_PURCHASE_CONSTRAINTS_SQL);
    await queryRunner.query(ASSERT_EXPAND_SCHEMA_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(SET_MIGRATION_TIMEOUTS_SQL);
    await queryRunner.query(LOCK_EXPANDED_TABLES_FOR_ROLLBACK_SQL);
    await queryRunner.query(ASSERT_SAFE_ROLLBACK_SQL);
    await queryRunner.query(DROP_EXPAND_SCHEMA_SQL);
  }
}
