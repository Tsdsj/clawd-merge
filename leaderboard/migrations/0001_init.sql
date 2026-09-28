-- 合成大Clawd leaderboard schema (Cloudflare D1 / SQLite).
-- Apply all migrations with: npx wrangler d1 migrations apply clawd-merge --remote
-- (Idempotent: safe on databases created earlier with `d1 execute --file=schema.sql`.)

-- One row per registered name. The browser keeps the secret token; only its
-- SHA-256 hash is stored. best_* hold the player's personal best.
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE, -- normalised lower-case name, enforces "no duplicate names"
  token_hash TEXT NOT NULL UNIQUE,
  best_score INTEGER NOT NULL DEFAULT 0,
  best_level INTEGER NOT NULL DEFAULT 0,
  best_at INTEGER,
  games INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_best ON players (best_score DESC, best_at ASC);

-- A server-issued ticket per game: scores must reference an unused session,
-- and the real elapsed time since it started is checked for plausibility.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_player ON sessions (player_id, started_at);

-- Every accepted game, for history / later analysis.
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  max_level INTEGER NOT NULL,
  drops INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_player ON scores (player_id, created_at);

-- Fixed-window counters for rate limiting (per IP / per player).
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
