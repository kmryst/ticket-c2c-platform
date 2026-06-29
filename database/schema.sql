CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  CREATE TYPE purchase_status AS ENUM ('confirmed', 'rejected');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  event_type TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  location_latitude NUMERIC(9, 6),
  location_longitude NUMERIC(9, 6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ticket_inventory (
  event_id UUID PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  total_quantity INTEGER NOT NULL CHECK (total_quantity >= 0),
  remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (remaining_quantity <= total_quantity)
);

CREATE TABLE IF NOT EXISTS purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  buyer_id UUID NOT NULL,
  request_id TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status purchase_status NOT NULL,
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (status = 'confirmed' AND rejection_reason IS NULL)
    OR
    (status = 'rejected' AND rejection_reason IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS events_event_type_starts_at_idx
  ON events (event_type, starts_at);

CREATE INDEX IF NOT EXISTS events_starts_at_idx
  ON events (starts_at);

CREATE INDEX IF NOT EXISTS purchases_event_id_created_at_idx
  ON purchases (event_id, created_at);

CREATE INDEX IF NOT EXISTS purchases_buyer_id_created_at_idx
  ON purchases (buyer_id, created_at);

DROP INDEX IF EXISTS purchases_request_id_uq;

CREATE UNIQUE INDEX purchases_request_id_uq
  ON purchases (buyer_id, request_id)
  WHERE request_id IS NOT NULL
    AND status = 'confirmed';
