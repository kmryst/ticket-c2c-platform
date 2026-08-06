// Issue #376: legacy / Ticket Type のどちらか一方だけを active writer にし、
// 非 active 側は同一 transaction の mirror write だけを受け付ける compatibility migration。
// control row は必ず legacy で作成し、この migration 自体は正本を切り替えない。

import { MigrationInterface, QueryRunner } from 'typeorm';

const SET_MIGRATION_TIMEOUTS_SQL = `
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '5min';
SET LOCAL search_path = public, pg_catalog, pg_temp;
`;

const ACQUIRE_EXCLUSIVE_WRITER_BARRIER_SQL = `
-- control-aware application writer が使う shared barrier の exclusive 側。
-- migration 中に新 writer が table access へ進まないよう、relation lock より先に取る。
SELECT pg_advisory_xact_lock(335, 376);
`;

// export は lock 順の共有定数（inventory-writer-control.ts の
// INVENTORY_WRITER_TABLE_LOCK_SQL）との一致を単体テストで強制するためだけのもの。
// 適用済み migration の実行内容は変更していない。
export const LOCK_WRITER_TABLES_SQL = `
-- 旧 writer の入口である events を先に gate とし、既存 transaction を drain する。
-- 後段 table に想定外の直接 writer がいれば、events を保持したまま待たず rollback する。
LOCK TABLE events IN EXCLUSIVE MODE;
LOCK TABLE purchases IN ACCESS EXCLUSIVE MODE NOWAIT;
LOCK TABLE ticket_types IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE ticket_inventory IN SHARE ROW EXCLUSIVE MODE NOWAIT;
LOCK TABLE ticket_type_inventory IN SHARE ROW EXCLUSIVE MODE NOWAIT;
`;

const ASSERT_IDEMPOTENCY_KEYS_UNAMBIGUOUS_SQL = `
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM purchases
    WHERE request_id IS NOT NULL
    GROUP BY buyer_id, event_id, request_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'inventory compatibility migration aborted: duplicate requestId exists across purchase statuses';
  END IF;
END
$$;
`;

const CREATE_CONTROL_STATE_SQL = `
CREATE TABLE inventory_writer_control (
  singleton BOOLEAN NOT NULL DEFAULT true,
  writer_mode TEXT NOT NULL DEFAULT 'legacy',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT inventory_writer_control_pkey PRIMARY KEY (singleton),
  CONSTRAINT inventory_writer_control_singleton_check CHECK (singleton),
  CONSTRAINT inventory_writer_control_mode_check
    CHECK (writer_mode IN ('legacy', 'ticket_type'))
);

INSERT INTO inventory_writer_control (singleton, writer_mode)
VALUES (true, 'legacy');
`;

const REPLACE_IDEMPOTENCY_INDEXES_SQL = `
-- confirmed / rejected を別々に一意化すると、同じ key が両 status に1件ずつ存在できる。
-- payloadを含めない単一indexをDBの最終ガードにし、payload比較は直列化後にapplicationが行う。
DROP INDEX purchases_request_id_uq;
DROP INDEX purchases_rejected_request_id_uq;

CREATE UNIQUE INDEX purchases_request_id_uq
  ON purchases (buyer_id, event_id, request_id)
  WHERE request_id IS NOT NULL;
`;

const REPLACE_FORWARD_BRIDGE_SQL = `
-- #336 forward bridgeの通常動作は維持する。Ticket Type -> legacy mirrorからのnested
-- 呼出しだけはupsert前に止め、default Type row lockの先取りと相互bounceを防ぐ。
CREATE OR REPLACE FUNCTION ticket_type_expand_sync_inventory()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  default_ticket_type_id UUID;
BEGIN
  IF pg_trigger_depth() > 1
     AND current_setting(
       'ticket_c2c.inventory_mirror_origin',
       true
     ) = 'ticket_type' THEN
    RETURN NEW;
  END IF;

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
`;

const RESTORE_FORWARD_BRIDGE_SQL = `
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
`;

const CREATE_MODE_AWARE_GUARDS_SQL = `
-- mirror_origin は再帰防止の目印であり、active writer の認可には使わない。
-- inactive 側を許可するには pg_trigger_depth() > 1 も必要なので、client が同名GUCを
-- 設定しただけでは直接writeを偽装できない。
CREATE FUNCTION inventory_compatibility_fence_inventory_statement()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_mode TEXT;
  mirror_origin TEXT;
BEGIN
  SELECT writer_mode
  INTO current_mode
  FROM public.inventory_writer_control
  WHERE singleton
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'inventory writer control row is missing'
      USING ERRCODE = '55000';
  END IF;

  mirror_origin := current_setting(
    'ticket_c2c.inventory_mirror_origin',
    true
  );

  -- statement trigger は対象行が0件でも発火する。旧binaryのsold-out UPDATEも、
  -- inactive tableへ到達した時点でfail closedにする。
  IF pg_trigger_depth() = 1 THEN
    IF (TG_TABLE_NAME = 'ticket_inventory' AND current_mode <> 'legacy')
       OR (
         TG_TABLE_NAME = 'ticket_type_inventory'
         AND current_mode <> 'ticket_type'
       ) THEN
      RAISE EXCEPTION
        'inactive inventory writer rejected for table % while mode is %',
        TG_TABLE_NAME,
        current_mode
        USING ERRCODE = '55000';
    END IF;

    PERFORM set_config(
      'ticket_c2c.inventory_mirror_origin',
      current_mode,
      true
    );
    RETURN NULL;
  END IF;

  IF (TG_TABLE_NAME = 'ticket_inventory'
      AND current_mode = 'ticket_type'
      AND mirror_origin = 'ticket_type')
     OR (TG_TABLE_NAME = 'ticket_type_inventory'
         AND current_mode = 'legacy'
         AND mirror_origin = 'legacy')
     OR (TG_TABLE_NAME = 'ticket_type_inventory'
         AND current_mode = 'ticket_type'
         AND mirror_origin = 'ticket_type') THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION
    'unexpected nested inventory statement for table %',
    TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER inventory_compatibility_fence_legacy_statement_trg
BEFORE INSERT OR UPDATE ON ticket_inventory
FOR EACH STATEMENT
EXECUTE FUNCTION inventory_compatibility_fence_inventory_statement();

CREATE TRIGGER inventory_compatibility_fence_ticket_type_statement_trg
BEFORE INSERT OR UPDATE ON ticket_type_inventory
FOR EACH STATEMENT
EXECUTE FUNCTION inventory_compatibility_fence_inventory_statement();

CREATE FUNCTION inventory_compatibility_guard_legacy_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_mode TEXT;
  mirror_origin TEXT;
BEGIN
  SELECT writer_mode
  INTO current_mode
  FROM public.inventory_writer_control
  WHERE singleton
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'inventory writer control row is missing'
      USING ERRCODE = '55000';
  END IF;

  mirror_origin := current_setting(
    'ticket_c2c.inventory_mirror_origin',
    true
  );

  IF pg_trigger_depth() = 1 THEN
    IF current_mode <> 'legacy' THEN
      RAISE EXCEPTION
        'inactive legacy inventory writer rejected while mode is ticket_type'
        USING ERRCODE = '55000';
    END IF;
    PERFORM set_config(
      'ticket_c2c.inventory_mirror_origin',
      'legacy',
      true
    );
    RETURN NEW;
  END IF;

  IF current_mode = 'ticket_type'
     AND mirror_origin = 'ticket_type' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'unexpected nested legacy inventory write'
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER inventory_compatibility_guard_legacy_write_trg
BEFORE INSERT OR UPDATE ON ticket_inventory
FOR EACH ROW
EXECUTE FUNCTION inventory_compatibility_guard_legacy_write();

CREATE FUNCTION inventory_compatibility_guard_ticket_type_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_mode TEXT;
  mirror_origin TEXT;
BEGIN
  SELECT writer_mode
  INTO current_mode
  FROM public.inventory_writer_control
  WHERE singleton
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'inventory writer control row is missing'
      USING ERRCODE = '55000';
  END IF;

  mirror_origin := current_setting(
    'ticket_c2c.inventory_mirror_origin',
    true
  );

  IF pg_trigger_depth() = 1 THEN
    IF current_mode <> 'ticket_type' THEN
      RAISE EXCEPTION
        'inactive Ticket Type inventory writer rejected while mode is legacy'
        USING ERRCODE = '55000';
    END IF;
    PERFORM set_config(
      'ticket_c2c.inventory_mirror_origin',
      'ticket_type',
      true
    );
    RETURN NEW;
  END IF;

  IF current_mode = 'legacy'
     AND mirror_origin = 'legacy' THEN
    RETURN NEW;
  END IF;

  -- ticket_type -> legacy mirror は既存 #336 forward bridge を発火させる。
  -- その nested upsert だけを行単位でskipし、相互triggerのbounceを止める。
  IF current_mode = 'ticket_type'
     AND mirror_origin = 'ticket_type' THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION
    'unexpected nested Ticket Type inventory write'
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER inventory_compatibility_guard_ticket_type_write_trg
BEFORE INSERT OR UPDATE ON ticket_type_inventory
FOR EACH ROW
EXECUTE FUNCTION inventory_compatibility_guard_ticket_type_write();

-- 在庫DELETEはaggregate mirrorを曖昧にするため直接実行を禁止する。
-- 許可するのは events DELETE statementの実行中に深いtriggerから届く既知のFK cascadeだけ。
CREATE FUNCTION inventory_compatibility_mark_event_delete_cascade()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM set_config(
    'ticket_c2c.event_delete_cascade',
    'true',
    true
  );
  RETURN NULL;
END
$$;

CREATE TRIGGER inventory_compatibility_mark_event_delete_before_trg
BEFORE DELETE ON events
FOR EACH STATEMENT
EXECUTE FUNCTION inventory_compatibility_mark_event_delete_cascade();

CREATE FUNCTION inventory_compatibility_guard_delete_cascade()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF pg_trigger_depth() >= 2
     AND current_setting(
       'ticket_c2c.event_delete_cascade',
       true
     ) = 'true' THEN
    RETURN NULL;
  END IF;

  RAISE EXCEPTION
    'direct delete rejected for compatibility table % at trigger depth %',
    TG_TABLE_NAME,
    pg_trigger_depth()
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER inventory_compatibility_guard_legacy_delete_trg
BEFORE DELETE ON ticket_inventory
FOR EACH STATEMENT
EXECUTE FUNCTION inventory_compatibility_guard_delete_cascade();

CREATE TRIGGER inventory_compatibility_guard_ticket_type_delete_trg
BEFORE DELETE ON ticket_type_inventory
FOR EACH STATEMENT
EXECUTE FUNCTION inventory_compatibility_guard_delete_cascade();

CREATE TRIGGER inventory_compatibility_guard_ticket_type_definition_delete_trg
BEFORE DELETE ON ticket_types
FOR EACH STATEMENT
EXECUTE FUNCTION inventory_compatibility_guard_delete_cascade();

CREATE FUNCTION inventory_compatibility_reject_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'truncate rejected for compatibility table %',
    TG_TABLE_NAME
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER inventory_compatibility_reject_legacy_truncate_trg
BEFORE TRUNCATE ON ticket_inventory
FOR EACH STATEMENT
EXECUTE FUNCTION inventory_compatibility_reject_truncate();

CREATE TRIGGER inventory_compatibility_reject_ticket_type_truncate_trg
BEFORE TRUNCATE ON ticket_type_inventory
FOR EACH STATEMENT
EXECUTE FUNCTION inventory_compatibility_reject_truncate();

CREATE TRIGGER inventory_compatibility_reject_ticket_type_definition_truncate_trg
BEFORE TRUNCATE ON ticket_types
FOR EACH STATEMENT
EXECUTE FUNCTION inventory_compatibility_reject_truncate();
`;

const CREATE_REVERSE_MIRROR_SQL = `
CREATE FUNCTION inventory_compatibility_sync_ticket_type_to_legacy()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  current_mode TEXT;
  mirror_origin TEXT;
  aggregate_total BIGINT;
  aggregate_remaining BIGINT;
BEGIN
  mirror_origin := current_setting(
    'ticket_c2c.inventory_mirror_origin',
    true
  );

  -- legacy -> Ticket Type の既存bridgeから呼ばれた nested trigger はreverseしない。
  IF pg_trigger_depth() <> 1
     OR mirror_origin IS DISTINCT FROM 'ticket_type' THEN
    RETURN NEW;
  END IF;

  SELECT writer_mode
  INTO current_mode
  FROM public.inventory_writer_control
  WHERE singleton
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'inventory writer control row is missing'
      USING ERRCODE = '55000';
  END IF;

  IF current_mode <> 'ticket_type' THEN
    RAISE EXCEPTION
      'Ticket Type inventory reverse mirror invoked outside ticket_type mode'
      USING ERRCODE = '55000';
  END IF;

  -- 新規 Event の Ticket Type active write では legacy row がまだない。
  -- placeholder を同じ mirror 経路で作り、その row を Event 単位の集計mutexにする。
  INSERT INTO public.ticket_inventory (
    event_id,
    total_quantity,
    remaining_quantity,
    version,
    updated_at
  )
  VALUES (NEW.event_id, 0, 0, 0, now())
  ON CONFLICT (event_id) DO NOTHING;

  -- 異なる Type の並行更新を Event 単位で直列化してから、fresh statement snapshot で
  -- 合計を読み直す。lock待ち前の古いsnapshotでaggregateを上書きしない。
  PERFORM 1
  FROM public.ticket_inventory
  WHERE event_id = NEW.event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'legacy compatibility inventory row is missing for event %',
      NEW.event_id
      USING ERRCODE = '55000';
  END IF;

  SELECT sum(total_quantity), sum(remaining_quantity)
  INTO aggregate_total, aggregate_remaining
  FROM public.ticket_type_inventory
  WHERE event_id = NEW.event_id;

  IF aggregate_total IS NULL
     OR aggregate_remaining IS NULL
     OR aggregate_total > 2147483647
     OR aggregate_remaining > 2147483647 THEN
    RAISE EXCEPTION
      'Ticket Type inventory aggregate is missing or exceeds INTEGER for event %',
      NEW.event_id
      USING ERRCODE = '22003';
  END IF;

  UPDATE public.ticket_inventory
  SET total_quantity = aggregate_total::INTEGER,
      remaining_quantity = aggregate_remaining::INTEGER,
      version = version + 1,
      updated_at = now()
  WHERE event_id = NEW.event_id;

  RETURN NEW;
END
$$;

CREATE TRIGGER inventory_compatibility_sync_ticket_type_to_legacy_trg
AFTER INSERT OR UPDATE ON ticket_type_inventory
FOR EACH ROW
EXECUTE FUNCTION inventory_compatibility_sync_ticket_type_to_legacy();
`;

const ASSERT_COMPATIBILITY_STATE_SQL = `
DO $$
BEGIN
  IF (SELECT count(*) FROM inventory_writer_control) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM inventory_writer_control
       WHERE singleton
         AND writer_mode = 'legacy'
     ) THEN
    RAISE EXCEPTION
      'inventory compatibility migration aborted: initial writer mode is not legacy';
  END IF;

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
  ) OR EXISTS (
    SELECT 1
    FROM purchases AS purchase
    LEFT JOIN ticket_types AS ticket_type
      ON ticket_type.event_id = purchase.event_id
     AND ticket_type.id = purchase.ticket_type_id
    WHERE ticket_type.id IS NULL
       OR NOT ticket_type.is_default
  ) THEN
    RAISE EXCEPTION
      'inventory compatibility migration aborted: expand readiness is not lossless';
  END IF;
END
$$;
`;

const ASSERT_SAFE_DOWN_SQL = `
DO $$
BEGIN
  IF (SELECT writer_mode FROM inventory_writer_control WHERE singleton)
       IS DISTINCT FROM 'legacy' THEN
    RAISE EXCEPTION
      'inventory compatibility rollback blocked: writer mode must be legacy';
  END IF;

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
  ) OR EXISTS (
    SELECT 1
    FROM ticket_type_inventory AS inventory
    JOIN ticket_types AS ticket_type
      ON ticket_type.event_id = inventory.event_id
     AND ticket_type.id = inventory.ticket_type_id
    WHERE NOT ticket_type.is_default
  ) OR EXISTS (
    SELECT 1
    FROM purchases AS purchase
    LEFT JOIN ticket_types AS ticket_type
      ON ticket_type.event_id = purchase.event_id
     AND ticket_type.id = purchase.ticket_type_id
    WHERE ticket_type.id IS NULL
       OR NOT ticket_type.is_default
  ) THEN
    RAISE EXCEPTION
      'inventory compatibility rollback blocked: legacy representation is not lossless';
  END IF;
END
$$;
`;

const DROP_COMPATIBILITY_WRITER_SQL = `
DROP TRIGGER inventory_compatibility_sync_ticket_type_to_legacy_trg
  ON ticket_type_inventory;
DROP TRIGGER inventory_compatibility_reject_ticket_type_definition_truncate_trg
  ON ticket_types;
DROP TRIGGER inventory_compatibility_reject_ticket_type_truncate_trg
  ON ticket_type_inventory;
DROP TRIGGER inventory_compatibility_reject_legacy_truncate_trg
  ON ticket_inventory;
DROP TRIGGER inventory_compatibility_guard_ticket_type_definition_delete_trg
  ON ticket_types;
DROP TRIGGER inventory_compatibility_guard_ticket_type_delete_trg
  ON ticket_type_inventory;
DROP TRIGGER inventory_compatibility_guard_legacy_delete_trg
  ON ticket_inventory;
DROP TRIGGER inventory_compatibility_mark_event_delete_before_trg
  ON events;
DROP TRIGGER inventory_compatibility_guard_ticket_type_write_trg
  ON ticket_type_inventory;
DROP TRIGGER inventory_compatibility_guard_legacy_write_trg
  ON ticket_inventory;
DROP TRIGGER inventory_compatibility_fence_ticket_type_statement_trg
  ON ticket_type_inventory;
DROP TRIGGER inventory_compatibility_fence_legacy_statement_trg
  ON ticket_inventory;

DROP FUNCTION inventory_compatibility_sync_ticket_type_to_legacy();
DROP FUNCTION inventory_compatibility_reject_truncate();
DROP FUNCTION inventory_compatibility_guard_delete_cascade();
DROP FUNCTION inventory_compatibility_mark_event_delete_cascade();
DROP FUNCTION inventory_compatibility_guard_ticket_type_write();
DROP FUNCTION inventory_compatibility_guard_legacy_write();
DROP FUNCTION inventory_compatibility_fence_inventory_statement();

DROP INDEX purchases_request_id_uq;
CREATE UNIQUE INDEX purchases_request_id_uq
  ON purchases (buyer_id, event_id, request_id)
  WHERE request_id IS NOT NULL
    AND status = 'confirmed';
CREATE UNIQUE INDEX purchases_rejected_request_id_uq
  ON purchases (buyer_id, event_id, request_id)
  WHERE request_id IS NOT NULL
    AND status = 'rejected';

DROP TABLE inventory_writer_control;
`;

export class AddTicketTypeCompatibilityWriter1785542400000 implements MigrationInterface {
  name = 'AddTicketTypeCompatibilityWriter1785542400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(SET_MIGRATION_TIMEOUTS_SQL);
    await queryRunner.query(ACQUIRE_EXCLUSIVE_WRITER_BARRIER_SQL);
    await queryRunner.query(LOCK_WRITER_TABLES_SQL);
    await queryRunner.query(ASSERT_IDEMPOTENCY_KEYS_UNAMBIGUOUS_SQL);
    await queryRunner.query(CREATE_CONTROL_STATE_SQL);
    await queryRunner.query(REPLACE_IDEMPOTENCY_INDEXES_SQL);
    await queryRunner.query(REPLACE_FORWARD_BRIDGE_SQL);
    await queryRunner.query(CREATE_MODE_AWARE_GUARDS_SQL);
    await queryRunner.query(CREATE_REVERSE_MIRROR_SQL);
    await queryRunner.query(ASSERT_COMPATIBILITY_STATE_SQL);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(SET_MIGRATION_TIMEOUTS_SQL);
    await queryRunner.query(ACQUIRE_EXCLUSIVE_WRITER_BARRIER_SQL);
    await queryRunner.query(LOCK_WRITER_TABLES_SQL);
    await queryRunner.query(ASSERT_SAFE_DOWN_SQL);
    await queryRunner.query(DROP_COMPATIBILITY_WRITER_SQL);
    await queryRunner.query(RESTORE_FORWARD_BRIDGE_SQL);
  }
}
