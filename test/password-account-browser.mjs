import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {openDatabase} from '../server/sqlite.mjs';
import {createApiServer} from '../server/http.mjs';
import {createPasswordAuth} from '../server/password-auth.mjs';
import {createPasswordKdf} from '../server/password-kdf.mjs';
import worker from '../leaderboard/src/index.js';
const db=openDatabase(':memory:'),secret=()=>randomBytes(32).toString('base64url');
const env={DB:db,PUBLIC_ORIGIN:'http://127.0.0.1',ALLOWED_ORIGINS:'*'};
env.PASSWORD_AUTH=createPasswordAuth({DB:db,keyring:{current:'v1',rate:secret(),versions:{v1:{ticket:secret(),receipt:secret(),payload:secret()}}},kdf:createPasswordKdf(),enabled:true});
// Optional, fixed fixture flags affect responses only, after real writes commit.
let dropRegistration=process.env.CLAWD_FIXTURE_DROP_REGISTRATION==='1';
const api=createApiServer(env,{worker:{async fetch(request,context){if(new URL(request.url).pathname==='/api/__fixture/counts')return Response.json({players:db.raw.prepare('SELECT count(*) n FROM players').get().n,passwords:db.raw.prepare('SELECT count(*) n FROM password_credentials').get().n});const response=await worker.fetch(request,context);if(dropRegistration&&new URL(request.url).pathname==='/api/auth/password/register'&&response.status===201){dropRegistration=false;await new Promise(r=>setTimeout(r,9500));}return response;}}});
await new Promise(r=>api.listen(0,'127.0.0.1',r));
const root=resolve('.'),types={'.js':'text/javascript','.css':'text/css','.html':'text/html; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const site=createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 if(!(path==='/'||['/index.html','/runtime-config.js','/favicon.svg','/manifest.webmanifest'].includes(path)||path.startsWith('/src/')||path.startsWith('/icons/'))){res.writeHead(404).end();return;}
 const file=resolve(root,'.'+(path==='/'?'/index.html':path));
 try{if(!file.startsWith(root+'/'))throw Error('path');const data=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);}catch{res.writeHead(404).end();}
});
await new Promise(r=>site.listen(0,'127.0.0.1',r));
console.log(`http://127.0.0.1:${site.address().port}/?api=http://127.0.0.1:${api.address().port}`);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{site.close();api.close(()=>db.close());});
