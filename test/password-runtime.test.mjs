import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createPasswordKdf} from '../server/password-kdf.mjs';
import {configurePasswordAuth} from '../server/password-config.mjs';
test('native password KDF bounds concurrency and releases capacity',async()=>{
 const kdf=createPasswordKdf(),salt=randomBytes(16).toString('base64url');
 const tasks=[kdf('fixture password',salt),kdf('fixture password',salt)];
 await assert.rejects(kdf('overflow',salt),{code:'auth_busy'});
 const [a,b]=await Promise.all(tasks);assert.equal(a,b);assert.equal(a.length,43);
 assert.notEqual(await kdf('different password',salt),a);
 for(const maxConcurrent of [0,3,NaN])assert.throws(()=>createPasswordKdf({maxConcurrent}));
});
test('password service fails closed when disabled, missing keys or invalid concurrency',()=>{
 assert.equal(configurePasswordAuth(null,{}).available,false);
 assert.equal(configurePasswordAuth(null,{PASSWORD_AUTH_ENABLED:'1'}).available,false);
 assert.equal(configurePasswordAuth(null,{PASSWORD_AUTH_ENABLED:'1',PASSWORD_AUTH_KEYRING_FILE:'/missing-fixture-keyring'}).available,false);
});

test('A07 production password service defaults to closed enrollment while preserving login capability',async t=>{
 const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{openDatabase}=await import('../server/sqlite.mjs');
 const dir=mkdtempSync(join(tmpdir(),'clawd-keyring-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const file=join(dir,'keys.json'),s=()=>randomBytes(32).toString('base64url');writeFileSync(file,JSON.stringify({current:'v1',rate:s(),versions:{v1:{ticket:s(),receipt:s(),payload:s()}}}),{mode:0o600});const db=openDatabase(':memory:');t.after(()=>db.close());
 const config={PASSWORD_AUTH_ENABLED:'1',PASSWORD_AUTH_KEYRING_FILE:file},closed=configurePasswordAuth(db,config);assert.equal(closed.available,true);assert.equal(closed.registrationEnabled,false);assert.equal(closed.bindingEnabled,false);
 const opened=configurePasswordAuth(db,{...config,PASSWORD_REGISTRATION_ENABLED:'1',ACCOUNT_BINDING_ENABLED:'1'});assert.equal(opened.registrationEnabled,true);assert.equal(opened.bindingEnabled,true);
});
