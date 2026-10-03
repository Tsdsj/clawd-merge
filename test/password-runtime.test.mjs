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
