-- A04 operation receipts/context. Historical migrations stay immutable.
ALTER TABLE auth_operations ADD COLUMN preparation_hmac TEXT;
ALTER TABLE auth_operations ADD COLUMN operation_ticket TEXT;
ALTER TABLE auth_operations ADD COLUMN actor_player_id TEXT;
ALTER TABLE auth_operations ADD COLUMN actor_token_hash TEXT;
ALTER TABLE auth_operations ADD COLUMN actor_auth_version INTEGER;
ALTER TABLE auth_operations ADD COLUMN login_name TEXT;
ALTER TABLE auth_operations ADD COLUMN login_handle TEXT;
ALTER TABLE auth_operations ADD COLUMN login_handle_key TEXT;
ALTER TABLE auth_operations ADD COLUMN result_player_id TEXT;
ALTER TABLE auth_operations ADD COLUMN result_token_hash TEXT;
ALTER TABLE auth_operations ADD COLUMN result_status INTEGER;
CREATE INDEX idx_auth_operations_actor ON auth_operations(actor_token_hash, status);
CREATE INDEX idx_oauth_states_source ON oauth_states(source_token_hash);
CREATE INDEX idx_login_codes_source ON login_codes(source_token_hash);
UPDATE login_codes SET auth_version=COALESCE((SELECT auth_version FROM players WHERE id=login_codes.player_id),0) WHERE auth_version IS NULL;
-- A claim exists only inside one OAuth merge batch; it is deleted before commit.
-- It authorizes the batch once, before moving the source token to its target.
CREATE TABLE oauth_operation_claims (claim_id TEXT PRIMARY KEY NOT NULL);
