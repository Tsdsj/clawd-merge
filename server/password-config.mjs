import { readFileSync } from 'node:fs';
import { createPasswordKdf } from './password-kdf.mjs';
import { createPasswordAuth } from './password-auth.mjs';
export function configurePasswordAuth(DB, config=process.env) {
  if(config.PASSWORD_AUTH_ENABLED!=='1')return {available:false};
  try {
    if(!config.PASSWORD_AUTH_KEYRING_FILE)return {available:false};
    const raw=readFileSync(config.PASSWORD_AUTH_KEYRING_FILE,'utf8');
    if(raw.length>16384)return {available:false};
    const keyring=JSON.parse(raw),maxConcurrent=Number(config.PASSWORD_AUTH_CONCURRENCY||2);
    return createPasswordAuth({DB,keyring,kdf:createPasswordKdf({maxConcurrent}),enabled:true,registrationEnabled:config.PASSWORD_REGISTRATION_ENABLED==='1',bindingEnabled:config.ACCOUNT_BINDING_ENABLED==='1'});
  }catch{return {available:false};} // Do not print a secret value or private path.
}
