BEGIN;

ALTER TABLE reference_values ADD COLUMN IF NOT EXISTS tax_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS reference_values_counterparty_tax_id_unique
  ON reference_values(tax_id)
  WHERE kind='counterparties' AND tax_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS undo_operations (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  description TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS undo_operations_user_idx
  ON undo_operations(user_id,id DESC);

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

CREATE INDEX IF NOT EXISTS chat_members_user_idx
  ON chat_members(user_id,conversation_id);

CREATE INDEX IF NOT EXISTS chat_messages_conversation_idx
  ON chat_messages(conversation_id,id DESC);

CREATE TABLE IF NOT EXISTS desktop_notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 50),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 160),
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  action_url TEXT NOT NULL DEFAULT '' CHECK (char_length(action_url) <= 1000),
  source_key TEXT CHECK (source_key IS NULL OR char_length(source_key) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS desktop_notifications_source_unique
  ON desktop_notifications(user_id,source_key)
  WHERE source_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS desktop_notifications_user_idx
  ON desktop_notifications(user_id,id);

COMMIT;
