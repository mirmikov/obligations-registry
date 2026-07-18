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

CREATE INDEX IF NOT EXISTS obligations_status_idx ON obligations(status);
CREATE INDEX IF NOT EXISTS obligations_planned_idx ON obligations(planned_payment_date);
CREATE INDEX IF NOT EXISTS obligations_approval_idx ON obligations(approval_date);
CREATE INDEX IF NOT EXISTS obligations_entity_idx ON obligations(legal_entity);
CREATE INDEX IF NOT EXISTS obligations_counterparty_idx ON obligations(counterparty);

CREATE TABLE IF NOT EXISTS reference_values (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE(kind, value)
);

CREATE TABLE IF NOT EXISTS saved_views (
  user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
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
