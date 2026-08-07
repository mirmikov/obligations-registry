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

ALTER TABLE reference_values ADD COLUMN IF NOT EXISTS tax_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS reference_values_counterparty_tax_id_unique
  ON reference_values(tax_id)
  WHERE kind='counterparties' AND tax_id IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS undo_operations (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  description TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS undo_operations_user_idx ON undo_operations(user_id,id DESC);

CREATE TABLE IF NOT EXISTS chat_conversations (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('direct','group')),
  name TEXT,
  direct_key TEXT UNIQUE,
  created_by BIGINT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_members (
  conversation_id BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(conversation_id,user_id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  sender_id BIGINT NOT NULL REFERENCES users(id),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_members_user_idx ON chat_members(user_id,conversation_id);
CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx ON chat_messages(conversation_id,id DESC);
