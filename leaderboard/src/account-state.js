export const AUTH_QUERY = `SELECT p.*, t.auth_version AS token_auth_version, t.expires_at AS session_expires_at,
  t.auth_method AS token_auth_method, t.authenticated_at AS authenticated_at,
  c.login_handle, c.player_id AS credential_player_id
  FROM tokens t JOIN players p ON p.id=t.player_id
  LEFT JOIN password_credentials c ON c.player_id=p.id WHERE t.token_hash=?`;
export function sessionCurrent(row,now=Date.now()) {
  return Boolean(row&&row.auth_version===row.token_auth_version&&
    (row.session_expires_at===null||row.session_expires_at>now));
}
export function accountState(player,hasRecovery,{passwordEnabled=false,linuxdoEnabled=false,namingEnabled=true}={}) {
  const password=Boolean(player.credential_player_id||player.login_handle),linuxdo=player.linuxdo_id!=null;
  return { account:{kind:password?(linuxdo?'linked':'password'):(linuxdo?'linuxdo':'guest'),loginHandle:player.login_handle||null,
    authMethods:[...(password?['password']:[]),...(linuxdo?['linuxdo']:[])],authVersion:player.auth_version||0,hasRecoveryCode:Boolean(hasRecovery)},
    capabilities:{canRename:namingEnabled&&(!linuxdo||password),canSetPassword:passwordEnabled&&namingEnabled&&!password&&(!linuxdo||linuxdoEnabled),
      canChangePassword:passwordEnabled&&password,canBindLinuxdo:linuxdoEnabled&&!linuxdo&&(!password||passwordEnabled),
      canRotateRecoveryCode:passwordEnabled&&(password||(linuxdo&&linuxdoEnabled)),canRecoverPasswordWithLinuxdo:passwordEnabled&&password&&linuxdo&&linuxdoEnabled},sessionExpiresAt:player.session_expires_at??null };
}
