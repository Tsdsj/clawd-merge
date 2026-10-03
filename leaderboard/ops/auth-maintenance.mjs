// A04 optional maintenance rules; only the report command emits these statements.
// Each statement touches at most 500 rows. Signed UUIDv7 intent expiry remains the
// replay boundary even after tombstones are eventually deleted.
export function authMaintenanceRules(report) {
  if(!report.authSchemaReady)return [];
  const cutoff=report.window.asOf,day=86400000;
  return [
    ...(report.oauthSchemaReady?[{table:'oauth_account_flows',key:'state_hash',predicate:`expires_at <= ${cutoff}`,order:'expires_at'}]:[]),
    {table:'tokens',key:'token_hash',predicate:`expires_at IS NOT NULL AND expires_at <= ${cutoff}`,order:'expires_at'},
    {table:'reauth_grants',key:'grant_hash',predicate:`expires_at <= ${cutoff}`,order:'expires_at'},
    {table:'login_handle_reservations',key:'operation_id',predicate:`expires_at <= ${cutoff}`,order:'expires_at'},
    // Delete only previously redacted tombstones. Fresh redaction happens last,
    // so a single preview does not create extra delete candidates in this run.
    {id:'auth_operations_purge',table:'auth_operations',key:'request_id',predicate:`expires_at <= ${Math.max(0,cutoff-day)} AND status='stale' AND actor_scope='expired' AND response_ciphertext IS NULL`,order:'expires_at'},
    {id:'auth_operations_redact',table:'auth_operations',key:'request_id',predicate:`expires_at <= ${cutoff} AND (status!='stale' OR actor_scope!='expired' OR response_ciphertext IS NOT NULL)`,order:'expires_at',
      update:"status='stale',actor_scope='expired',retry_secret_hash='0000000000000000000000000000000000000000000000000000000000000000',payload_hmac=NULL,response_ciphertext=NULL,nonce=NULL,key_version=NULL,result_auth_version=NULL,result_resource_version=NULL,preparation_hmac=NULL,operation_ticket=NULL,actor_player_id=NULL,actor_token_hash=NULL,actor_auth_version=NULL,login_name=NULL,login_handle=NULL,login_handle_key=NULL,result_player_id=NULL,result_token_hash=NULL,result_status=NULL"+(report.oauthSchemaReady?",oauth_action=NULL,oauth_purpose=NULL,client_nonce_hash=NULL,recovery_method=NULL":"")},
  ];
}
