-- Separate challenge definitions, allowance ledger, credentials and results.
CREATE TABLE challenge_definitions (
  id TEXT PRIMARY KEY,
  rules_version TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  submit_until INTEGER NOT NULL,
  drop_limit INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE challenge_allowances (
  challenge_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (challenge_id, player_id)
);
CREATE TABLE challenge_sessions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  challenge_id TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  player_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  submit_until INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0 CHECK (used IN (0,1))
);
CREATE INDEX idx_challenge_sessions_owner ON challenge_sessions(player_id, challenge_id);
CREATE TABLE challenge_scores (
  session_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  challenge_id TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  player_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  drops INTEGER NOT NULL,
  max_level INTEGER NOT NULL,
  claws_used INTEGER NOT NULL,
  settling_ms INTEGER NOT NULL,
  reason TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL,
  improved INTEGER NOT NULL,
  best INTEGER NOT NULL DEFAULT 0,
  rank INTEGER
);
CREATE INDEX idx_challenge_scores_owner ON challenge_scores(player_id, challenge_id);
CREATE TABLE challenge_bests (
  challenge_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  max_level INTEGER NOT NULL,
  best_at INTEGER NOT NULL,
  PRIMARY KEY (challenge_id, player_id)
);
CREATE INDEX idx_challenge_rank ON challenge_bests(challenge_id, score DESC, best_at ASC, player_id);
