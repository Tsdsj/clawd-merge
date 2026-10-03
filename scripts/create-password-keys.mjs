// Generates a private file, never key material on stdout. Refuses overwrites.
import {randomBytes} from 'node:crypto';
import {writeFileSync,realpathSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--out')throw Error('Usage: node scripts/create-password-keys.mjs --out /private/path/password-keyring.json');
const requested=resolve(args[1]),target=resolve(realpathSync(dirname(requested)),basename(requested)),root=fileURLToPath(new URL('../',import.meta.url)),rel=relative(root,target);
if(!rel||(!rel.startsWith('..')&&!isAbsolute(rel)))throw Error('Key material must be outside the public source checkout');
const secret=()=>randomBytes(32).toString('base64url');
writeFileSync(target,JSON.stringify({current:'v1',rate:secret(),versions:{v1:{ticket:secret(),receipt:secret(),payload:secret()}}},null,2)+'\n',{flag:'wx',mode:0o600});
console.log('Private keyring created. Keep it outside Git and preserve old versions during rotation.');
