import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../deploy/legacy-worker.mjs';
const env={MIGRATION_TARGET:'https://new.example.test',LEGACY_ALLOWED_ORIGINS:'https://old.example.test'};

test('cutover maintenance blocks mutations and preserves retryable CORS response',async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw new Error('must not forward');});
  const res=await worker.fetch(new Request('https://old-api.example.test/api/score',{method:'POST',headers:{Origin:'https://old.example.test'},body:'{}'}),env);
  assert.equal(res.status,503);assert.equal(res.headers.get('Retry-After'),'60');assert.equal(res.headers.get('Access-Control-Allow-Origin'),'https://old.example.test');
});
test('legacy API proxy preserves method, body and credentials only for the configured target',async t=>{
  let seen;
  t.mock.method(globalThis,'fetch',async(url,options)=>{seen={url:String(url),method:options.method,token:options.headers.get('Authorization'),body:await new Response(options.body).text()};return Response.json({best:10});});
  const res=await worker.fetch(new Request('https://old-api.example.test/api/score',{method:'POST',headers:{Authorization:'Bearer fixture-token'},body:'{"score":10}'}),{...env,MIGRATION_MODE:'proxy'});
  assert.deepEqual(seen,{url:'https://new.example.test/api/score',method:'POST',token:'Bearer fixture-token',body:'{"score":10}'});assert.equal(res.status,200);
});
test('old OAuth callbacks restart at the new site without leaking the old authorization code',async()=>{
  const res=await worker.fetch(new Request('https://old-api.example.test/api/auth/linuxdo/callback?code=old-code&state=old-state'),{...env,MIGRATION_MODE:'proxy'});
  assert.equal(res.status,302);const target=new URL(res.headers.get('Location'));assert.equal(target.origin,env.MIGRATION_TARGET);assert.equal(target.search,'');assert.equal(target.href.includes('old-code'),false);
});
