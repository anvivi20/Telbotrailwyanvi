-- Jalankan di Nhost Console → Database → SQL Editor

CREATE TABLE IF NOT EXISTS chat_history (
  id         SERIAL PRIMARY KEY,
  user_id    TEXT        NOT NULL,
  role       TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index agar query per user cepat
CREATE INDEX IF NOT EXISTS idx_chat_history_user_id
  ON chat_history (user_id, created_at DESC);
