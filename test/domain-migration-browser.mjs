// Manual browser harness. Two ephemeral loopback origins, synthetic data only.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const root=resolve('.');
const scope='production:https://old-api.example.test';
let sourceOrigin,targetOrigin;
const app=createServer(handler),target=createServer(handler);
function fixture(){return `<!doctype html><meta charset="utf-8"><button id="seed">创建隔离样本并开始搬家</button><script>document.getElementById('seed').onclick=()=>{localStorage.setItem('clawd-merge:best','4321');localStorage.setItem('clawd-merge:player',JSON.stringify({id:'migration-fixture',name:'迁移样本',tag:'1234',token:'isolated-fixture-token'}));location.href='/migration.html'}</script>`;}
async function handler(req,res){
  if(req.url==='/migration-config.js'){res.setHeader('Content-Type','text/javascript');res.end('globalThis.CLAWD_MIGRATION='+JSON.stringify({sourceOrigin,sourcePath:'/migration.html',targetOrigin,scope})+';');return;}
  if(req.url==='/fixture'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fixture());return;}
  if(req.url==='/inspect'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(`<!doctype html><meta charset="utf-8"><h1>搬家结果</h1><pre id="result"></pre><script>const p=JSON.parse(localStorage.getItem('clawd-merge:player'));document.querySelector('#result').textContent=JSON.stringify({id:p?.id,name:p?.name,best:localStorage.getItem('clawd-merge:best')})</script>`);return;}
  try{const path=resolve(root,'.'+new URL(req.url,'http://localhost').pathname);if(!path.startsWith(root+'/'))throw new Error();const data=await readFile(path);res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[extname(path)]||'application/octet-stream');res.end(data);}catch{res.writeHead(404).end();}
}
await new Promise(r=>app.listen(0,'127.0.0.1',r));
await new Promise(r=>target.listen(0,'127.0.0.1',r));
sourceOrigin=`http://127.0.0.1:${app.address().port}`;targetOrigin=`http://127.0.0.1:${target.address().port}`;
console.log(JSON.stringify({source:sourceOrigin+'/fixture',target:targetOrigin+'/inspect'}));
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{app.close();target.close();});
