-- A05 browser-bound OAuth. Legacy OAuth tables remain for older clients.
ALTER TABLE auth_operations ADD COLUMN recovery_method TEXT;
ALTER TABLE auth_operations ADD COLUMN oauth_action TEXT;
ALTER TABLE auth_operations ADD COLUMN oauth_purpose TEXT;
ALTER TABLE auth_operations ADD COLUMN client_nonce_hash TEXT;
CREATE TABLE oauth_account_flows (
  state_hash TEXT PRIMARY KEY NOT NULL CHECK(length(state_hash)=64),
  operation_id TEXT NOT NULL UNIQUE REFERENCES auth_operations(request_id) ON DELETE CASCADE,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','fetching','authorized','failed')),
  start_cipher TEXT NOT NULL,
  start_nonce TEXT NOT NULL,
  provider_code_hash TEXT,
  login_code_hash TEXT UNIQUE,
  login_code_expires_at INTEGER,
  authorization_cipher TEXT,
  authorization_nonce TEXT,
  CHECK(status!='authorized' OR (login_code_hash IS NOT NULL AND authorization_cipher IS NOT NULL AND authorization_nonce IS NOT NULL))
);
CREATE INDEX idx_oauth_account_flows_expiry ON oauth_account_flows(expires_at);
