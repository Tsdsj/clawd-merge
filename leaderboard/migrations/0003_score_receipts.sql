-- Immutable acceptance receipts survive used-session cleanup and lost responses.
CREATE TABLE IF NOT EXISTS score_receipts (
  session_id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL UNIQUE,
  score INTEGER NOT NULL,
  drops INTEGER NOT NULL,
  max_level INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL,
  improved INTEGER NOT NULL,
  best INTEGER NOT NULL DEFAULT 0,
  rank INTEGER
);
CREATE INDEX IF NOT EXISTS idx_receipts_player ON score_receipts (player_id);
