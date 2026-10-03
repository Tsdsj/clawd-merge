// Disposable local OAuth provider for browser integration. No real accounts,
// credentials, provider requests, or production data are accepted here.
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
export async function oauthProviderFixture(callback){
 const codes=new Map(),tokens=new Map(),secret=()=>randomBytes(32).toString('base64url');
 const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  if(url.pathname==='/favicon.ico'){res.writeHead(204).end();return;}
  if(url.pathname==='/authorize'){
   if(url.searchParams.get('redirect_uri')!==callback())return json(400,{error:'bad_redirect'});
   const state=url.searchParams.get('state');if(!/^[A-Za-z0-9_-]{43}$/.test(state||''))return json(400,{error:'bad_state'});
   const link=(id,label)=>`<p><a href="/approve?choice=${id}&state=${encodeURIComponent(state)}">${label}</a></p>`;
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end('<h1>隔离 OAuth 测试服务</h1><p>合成身份，仅供本地验收。</p>'+link(1001,'授权测试甲')+link(2002,'授权测试乙')+link('cancel','取消授权'));return;
  }
  if(url.pathname==='/approve'){
   const state=url.searchParams.get('state'),choice=url.searchParams.get('choice');if(!/^[A-Za-z0-9_-]{43}$/.test(state||'')||!['1001','2002','cancel'].includes(choice))return json(400,{error:'bad_request'});
   const target=new URL(callback());target.searchParams.set('state',state);
   if(choice==='cancel')target.searchParams.set('error','access_denied');else{const code=secret();codes.set(code,{id:Number(choice),username:choice==='1001'?'测试甲':'测试乙',active:true,silenced:false,trust_level:1});target.searchParams.set('code',code);}
   res.writeHead(302,{Location:target.toString(),'Cache-Control':'no-store'}).end();return;
  }
  if(url.pathname==='/token'&&req.method==='POST'){
   let body='';for await(const chunk of req){body+=chunk;if(body.length>8192)return json(400,{error:'bad_request'});}
   const params=new URLSearchParams(body),code=params.get('code'),user=codes.get(code);
   if(!user||params.get('client_id')!=='fixture'||params.get('client_secret')!=='fixture'||params.get('redirect_uri')!==callback())return json(400,{error:'invalid_grant'});
   codes.delete(code);const token=secret();tokens.set(token,user);return json(200,{access_token:token});
  }
  if(url.pathname==='/user'){const user=tokens.get(req.headers.authorization?.replace(/^Bearer /,''));return json(user?200:401,user||{error:'invalid_token'});}
  return json(404,{error:'not_found'});
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {origin:'http://127.0.0.1:'+server.address().port,close:()=>server.close()};
}
