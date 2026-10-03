// Actual UI + production SQLite adapter, on disposable loopback origins.
// Rename writes commit normally; only their responses are delayed for 2s.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {openDatabase} from '../server/sqlite.mjs';
import {createApiServer} from '../server/http.mjs';
import worker from '../leaderboard/src/index.js';
const db=openDatabase(':memory:');
const api=createApiServer({DB:db,PUBLIC_ORIGIN:'http://127.0.0.1',ALLOWED_ORIGINS:'*'}, {
  worker:{async fetch(request,env){const response=await worker.fetch(request,env);if(new URL(request.url).pathname==='/api/rename')await new Promise(r=>setTimeout(r,2000));return response;}},
});
await new Promise(r=>api.listen(0,'127.0.0.1',r));
const root=resolve('.');
const site=createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(!(pathname==='/'||['/index.html','/runtime-config.js','/favicon.svg','/manifest.webmanifest'].includes(pathname)||pathname.startsWith('/src/')||pathname.startsWith('/icons/'))){res.writeHead(404).end();return;}
  const path=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
  try{
    if(!path.startsWith(root+'/'))throw new Error('path');
    const data=await readFile(path);res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.html':'text/html; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'})[extname(path)]||'application/octet-stream');res.end(data);
  }catch{res.writeHead(404).end();}
});
await new Promise(r=>site.listen(0,'127.0.0.1',r));
console.log(`http://127.0.0.1:${site.address().port}/?api=http://127.0.0.1:${api.address().port}`);
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{site.close();api.close(()=>db.close());});
