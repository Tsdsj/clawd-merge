-- A03 additive foundation. No password routes or credential conversion here.
-- Keep 0001-0004 immutable. Production migrator wraps this file in a transaction.
ALTER TABLE players ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0 CHECK(auth_version >= 0);
ALTER TABLE players ADD COLUMN display_name_source TEXT NOT NULL DEFAULT 'guest' CHECK(display_name_source IN ('guest','linuxdo','local'));
ALTER TABLE players ADD COLUMN name_policy_version TEXT;
ALTER TABLE players ADD COLUMN name_policy_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK(name_policy_status IN ('unreviewed','allowed','masked'));
ALTER TABLE players ADD COLUMN public_alias TEXT;
CREATE UNIQUE INDEX idx_players_public_alias ON players(public_alias);
UPDATE players SET display_name_source = CASE WHEN linuxdo_id IS NULL THEN 'guest' ELSE 'linuxdo' END;

-- Allocate monotonic, unique public aliases without truncating/hashing player IDs.
-- This counter and the player write roll back together; deleted numbers are not reused.
CREATE TABLE name_alias_sequence (id INTEGER PRIMARY KEY CHECK(id=1), next_value INTEGER NOT NULL CHECK(next_value>0));
UPDATE players SET public_alias = printf('玩家·%06d', rowid);
INSERT INTO name_alias_sequence VALUES (1, (SELECT COALESCE(MAX(rowid),0)+1 FROM players));
CREATE TRIGGER allocate_player_public_alias AFTER INSERT ON players
BEGIN
  UPDATE players SET public_alias=printf('玩家·%06d',(SELECT next_value FROM name_alias_sequence WHERE id=1)),
    display_name_source=CASE WHEN NEW.linuxdo_id IS NULL THEN NEW.display_name_source ELSE 'linuxdo' END
    WHERE id=NEW.id;
  UPDATE name_alias_sequence SET next_value=next_value+1 WHERE id=1;
END;

ALTER TABLE tokens ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'legacy' CHECK(auth_method IN ('legacy','guest','password','linuxdo','recovery'));
ALTER TABLE tokens ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0 CHECK(auth_version >= 0);
ALTER TABLE tokens ADD COLUMN authenticated_at INTEGER;
ALTER TABLE tokens ADD COLUMN expires_at INTEGER;
UPDATE tokens SET auth_method=CASE WHEN EXISTS(SELECT 1 FROM players p WHERE p.id=tokens.player_id AND p.linuxdo_id IS NOT NULL) THEN 'linuxdo' ELSE 'guest' END,
  authenticated_at=created_at,
  expires_at=CASE WHEN EXISTS(SELECT 1 FROM players p WHERE p.id=tokens.player_id AND p.linuxdo_id IS NOT NULL) THEN CAST(strftime('%s','now') AS INTEGER)*1000+2592000000 ELSE NULL END;
CREATE INDEX idx_tokens_expiry ON tokens(expires_at) WHERE expires_at IS NOT NULL;
CREATE UNIQUE INDEX idx_tokens_owner ON tokens(token_hash, player_id);
-- Existing insert paths remain compatible until A04 writes explicit metadata.
CREATE TRIGGER classify_legacy_token AFTER INSERT ON tokens WHEN NEW.auth_method='legacy'
BEGIN
  UPDATE tokens SET auth_method=CASE WHEN EXISTS(SELECT 1 FROM players p WHERE p.id=NEW.player_id AND p.linuxdo_id IS NOT NULL) THEN 'linuxdo' ELSE 'guest' END,
    auth_version=COALESCE((SELECT auth_version FROM players WHERE id=NEW.player_id),0),authenticated_at=NEW.created_at,
    expires_at=CASE WHEN EXISTS(SELECT 1 FROM players p WHERE p.id=NEW.player_id AND p.linuxdo_id IS NOT NULL) THEN NEW.created_at+2592000000 ELSE NULL END
    WHERE token_hash=NEW.token_hash;
END;

CREATE TABLE password_credentials (
  player_id TEXT PRIMARY KEY NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  login_handle TEXT NOT NULL UNIQUE,
  login_handle_key TEXT NOT NULL UNIQUE,
  algorithm TEXT NOT NULL CHECK(algorithm='scrypt'),
  salt TEXT NOT NULL CHECK(length(salt)>=22),
  derived_key TEXT NOT NULL CHECK(length(derived_key)>=43),
  params_version INTEGER NOT NULL CHECK(params_version>0),
  updated_at INTEGER NOT NULL
);
CREATE TABLE recovery_codes (
  player_id TEXT PRIMARY KEY NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL UNIQUE CHECK(length(code_hash)=64),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
  created_at INTEGER NOT NULL
);
CREATE TABLE reauth_grants (
  grant_hash TEXT PRIMARY KEY NOT NULL CHECK(length(grant_hash)=64),
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  auth_version INTEGER NOT NULL CHECK(auth_version>=0),
  purpose TEXT NOT NULL CHECK(purpose IN ('bind_linuxdo','change_password','rotate_recovery','set_password','recover_password')),
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(token_hash, player_id) REFERENCES tokens(token_hash, player_id) ON DELETE CASCADE
);
CREATE INDEX idx_reauth_grants_expiry ON reauth_grants(expires_at);
CREATE TABLE auth_operations (
  request_id TEXT PRIMARY KEY NOT NULL,
  actor_scope TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('register','set_password','change_password','recover_password','rotate_recovery','exchange_login')),
  retry_secret_hash TEXT NOT NULL CHECK(length(retry_secret_hash)=64),
  payload_hmac TEXT,
  status TEXT NOT NULL DEFAULT 'prepared' CHECK(status IN ('prepared','processing','complete','stale')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  response_ciphertext TEXT,
  nonce TEXT,
  key_version TEXT,
  result_auth_version INTEGER,
  result_resource_version INTEGER,
  CHECK(status!='complete' OR (response_ciphertext IS NOT NULL AND nonce IS NOT NULL AND key_version IS NOT NULL))
);
CREATE INDEX idx_auth_operations_expiry ON auth_operations(expires_at);
CREATE TABLE login_handle_reservations (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES auth_operations(request_id) ON DELETE CASCADE,
  login_handle TEXT NOT NULL,
  login_handle_key TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_login_handle_reservations_expiry ON login_handle_reservations(expires_at);
-- A04 consumes the reservation then inserts credentials within the same transaction.
-- Cross-table exclusions are enforced for inserts and key updates in both directions.
CREATE TRIGGER reserve_handle_insert BEFORE INSERT ON login_handle_reservations
WHEN EXISTS(SELECT 1 FROM password_credentials WHERE login_handle_key=NEW.login_handle_key)
BEGIN
  SELECT RAISE(ABORT,'login_handle_conflict');
END;
CREATE TRIGGER reserve_handle_update BEFORE UPDATE OF login_handle_key ON login_handle_reservations
WHEN EXISTS(SELECT 1 FROM password_credentials WHERE login_handle_key=NEW.login_handle_key)
BEGIN
  SELECT RAISE(ABORT,'login_handle_conflict');
END;
CREATE TRIGGER credential_handle_insert BEFORE INSERT ON password_credentials
WHEN EXISTS(SELECT 1 FROM login_handle_reservations WHERE login_handle_key=NEW.login_handle_key)
BEGIN
  SELECT RAISE(ABORT,'login_handle_reserved');
END;
CREATE TRIGGER credential_handle_update BEFORE UPDATE OF login_handle_key ON password_credentials
WHEN EXISTS(SELECT 1 FROM login_handle_reservations WHERE login_handle_key=NEW.login_handle_key)
BEGIN
  SELECT RAISE(ABORT,'login_handle_reserved');
END;

ALTER TABLE oauth_states ADD COLUMN action TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE oauth_states ADD COLUMN source_player_id TEXT;
ALTER TABLE oauth_states ADD COLUMN source_token_hash TEXT;
ALTER TABLE oauth_states ADD COLUMN auth_version INTEGER;
ALTER TABLE oauth_states ADD COLUMN client_nonce_hash TEXT;
ALTER TABLE oauth_states ADD COLUMN purpose TEXT;
ALTER TABLE oauth_states ADD COLUMN expires_at INTEGER;
ALTER TABLE oauth_states ADD COLUMN operation_id TEXT;
UPDATE oauth_states SET source_player_id=merge_player_id,expires_at=created_at+600000;
ALTER TABLE login_codes ADD COLUMN action TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE login_codes ADD COLUMN source_token_hash TEXT;
ALTER TABLE login_codes ADD COLUMN auth_version INTEGER;
ALTER TABLE login_codes ADD COLUMN client_nonce_hash TEXT;
ALTER TABLE login_codes ADD COLUMN purpose TEXT;
ALTER TABLE login_codes ADD COLUMN expires_at INTEGER;
ALTER TABLE login_codes ADD COLUMN operation_id TEXT;
UPDATE login_codes SET auth_version=COALESCE((SELECT auth_version FROM players WHERE id=login_codes.player_id),0),expires_at=created_at+120000;
