-- LINUX DO login + guest names that may repeat.
--
-- Players now come in two kinds:
--   * guests:    name + a random 4-digit tag ("橙色钳子#4821"); name_key = lower(name) || '#' || tag
--   * LINUX DO:  name = LINUX DO username, tag NULL;           name_key = 'ld:' || linuxdo_id
-- name_key stays UNIQUE, so the existing constraint keeps doing the dedup work.

ALTER TABLE players ADD COLUMN tag TEXT;
ALTER TABLE players ADD COLUMN linuxdo_id INTEGER;
ALTER TABLE players ADD COLUMN avatar TEXT;
ALTER TABLE players ADD COLUMN trust_level INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_players_linuxdo ON players (linuxdo_id);

-- Existing (guest) players get a tag so their name no longer blocks anyone else.
UPDATE players SET tag = substr('000' || (abs(random()) % 10000), -4) WHERE tag IS NULL;
UPDATE players SET name_key = name_key || '#' || tag;

-- Login tokens move to their own table so one account can be signed in on
-- several devices. Existing browsers keep working: their token is copied over.
CREATE TABLE IF NOT EXISTS tokens (
  token_hash TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_player ON tokens (player_id);
INSERT OR IGNORE INTO tokens (token_hash, player_id, created_at)
  SELECT token_hash, id, created_at FROM players;

-- OAuth "state" values (CSRF protection), single use, short lived.
CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  merge_player_id TEXT, -- guest whose scores move to the LINUX DO account
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One-time codes handed to the game page after login, swapped for a token.
CREATE TABLE IF NOT EXISTS login_codes (
  code_hash TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
