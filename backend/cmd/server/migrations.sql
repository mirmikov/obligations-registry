CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','editor','viewer')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS obligations (
  id BIGSERIAL PRIMARY KEY,
  source_row INTEGER,
  account_type TEXT,
  entry_date DATE,
  counterparty TEXT,
  legal_entity TEXT,
  cost_category TEXT,
  priority TEXT,
  responsible TEXT,
  document_number TEXT,
  deferment_days INTEGER,
  document_date DATE,
  amount NUMERIC(18,2),
  planned_payment_date DATE,
  approval_date DATE,
  actual_payment_date DATE,
  status TEXT,
  urgency TEXT,
  comment TEXT,
  source_note TEXT,
  created_by BIGINT REFERENCES users(id),
  updated_by BIGINT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE obligations ADD COLUMN IF NOT EXISTS source_note TEXT;
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS split_group_id TEXT;
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS split_parent_id BIGINT;
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS installment_number INTEGER;
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS installment_count INTEGER;

CREATE INDEX IF NOT EXISTS obligations_status_idx ON obligations(status);
CREATE INDEX IF NOT EXISTS obligations_planned_idx ON obligations(planned_payment_date);
CREATE INDEX IF NOT EXISTS obligations_approval_idx ON obligations(approval_date);
CREATE INDEX IF NOT EXISTS obligations_entity_idx ON obligations(legal_entity);
CREATE INDEX IF NOT EXISTS obligations_counterparty_idx ON obligations(counterparty);
CREATE INDEX IF NOT EXISTS obligations_split_group_idx ON obligations(split_group_id);

CREATE TABLE IF NOT EXISTS reference_values (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(kind, value)
);

-- Keep the counterparty reference in sync with registry records. The backfill
-- repairs databases populated before this trigger existed; ON CONFLICT keeps
-- values that an administrator deliberately deactivated inactive.
WITH counterparty_values AS (
  SELECT DISTINCT btrim(counterparty) AS value
  FROM obligations
  WHERE btrim(COALESCE(counterparty, '')) <> ''
), ordered_values AS (
  SELECT value,
    COALESCE((SELECT max(sort_order) FROM reference_values WHERE kind = 'counterparties'), -1)
      + row_number() OVER (ORDER BY lower(value), value) AS sort_order
  FROM counterparty_values
)
INSERT INTO reference_values(kind, value, sort_order)
SELECT 'counterparties', value, sort_order
FROM ordered_values
ON CONFLICT(kind, value) DO NOTHING;

CREATE OR REPLACE FUNCTION sync_counterparty_reference()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF btrim(COALESCE(NEW.counterparty, '')) <> '' THEN
    INSERT INTO reference_values(kind, value, sort_order)
    VALUES (
      'counterparties',
      btrim(NEW.counterparty),
      COALESCE((SELECT max(sort_order) + 1 FROM reference_values WHERE kind = 'counterparties'), 0)
    )
    ON CONFLICT(kind, value) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS obligations_sync_counterparty_reference ON obligations;
CREATE TRIGGER obligations_sync_counterparty_reference
AFTER INSERT OR UPDATE OF counterparty ON obligations
FOR EACH ROW EXECUTE FUNCTION sync_counterparty_reference();

CREATE TABLE IF NOT EXISTS saved_views (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_workspace_state (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  state JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id BIGINT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

