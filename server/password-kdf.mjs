import { scrypt } from 'node:crypto';
export const SCRYPT_PARAMS = Object.freeze({ N:32768, r:8, p:3, maxmem:48*1024*1024, length:32, version:1 });
export function createPasswordKdf({maxConcurrent=2}={}) {
  if(!Number.isInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>2)throw Error('Invalid password concurrency');
  let active=0;
  return async (password,salt) => {
    if(active>=maxConcurrent){const e=new Error('Password capacity reached');e.code='auth_busy';throw e;}
    active++;
    try { return await new Promise((resolve,reject)=>scrypt(password,Buffer.from(salt,'base64url'),SCRYPT_PARAMS.length,{N:SCRYPT_PARAMS.N,r:SCRYPT_PARAMS.r,p:SCRYPT_PARAMS.p,maxmem:SCRYPT_PARAMS.maxmem},(err,key)=>err?reject(err):resolve(key.toString('base64url')))); }
    finally { active--; }
  };
}
