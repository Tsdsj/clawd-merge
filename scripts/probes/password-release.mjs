// Disposable, bounded API/KDF probe. No production database, keyring or network
// provider is used. Run in a capped --network none container for target evidence.
import {randomBytes} from 'node:crypto';
import {openDatabase} from '../../server/sqlite.mjs';
import {createApiServer} from '../../server/http.mjs';
import {createPasswordAuth} from '../../server/password-auth.mjs';
import {createPasswordKdf} from '../../server/password-kdf.mjs';
const cap=Number(process.env.PROBE_CONCURRENCY||2),secret=()=>randomBytes(32).toString('base64url'),db=openDatabase(':memory:');
const env={DB:db,PUBLIC_ORIGIN:'http://127.0.0.1',PASSWORD_AUTH:createPasswordAuth({DB:db,enabled:true,registrationEnabled:false,bindingEnabled:false,kdf:createPasswordKdf({maxConcurrent:cap}),keyring:{current:'probe',rate:secret(),versions:{probe:{ticket:secret(),receipt:secret(),payload:secret()}}}})};
const server=createApiServer(env);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
const deadline=setTimeout(()=>process.exit(2),30000);deadline.unref();let peak=process.memoryUsage().rss;const sample=setInterval(()=>peak=Math.max(peak,process.memoryUsage().rss),10);
const outcomes=[],health=[],boards=[];const started=performance.now();
async function request(path,options={}){const at=performance.now(),response=await fetch(base+path,{...options,signal:AbortSignal.timeout(8000)});await response.arrayBuffer();return {status:response.status,ms:Math.round(performance.now()-at)};}
try{
 for(let wave=0;wave<3;wave++){
  const pending=Array.from({length:6},(_,i)=>request('/api/auth/password/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({loginHandle:`probe${wave}${i}#0000`,password:'isolated-probe-password-2026'})}));
  const probes=await Promise.all([request('/api/health'),request('/api/leaderboard')]);health.push(probes[0]);boards.push(probes[1]);outcomes.push(...await Promise.all(pending));
 }
 peak=Math.max(peak,process.memoryUsage().rss);const result={node:process.version,concurrency:cap,requests:outcomes.length,statuses:Object.fromEntries([401,503].map(code=>[code,outcomes.filter(x=>x.status===code).length])),authMaxMs:Math.max(...outcomes.map(x=>x.ms)),healthMaxMs:Math.max(...health.map(x=>x.ms)),leaderboardMaxMs:Math.max(...boards.map(x=>x.ms)),peakRssMiB:Math.ceil(peak/1048576),elapsedMs:Math.round(performance.now()-started)};
 result.ok=outcomes.every(x=>[401,503].includes(x.status))&&result.statuses[503]>0&&health.every(x=>x.status===200&&x.ms<1000)&&boards.every(x=>x.status===200&&x.ms<1000)&&result.authMaxMs<4000&&result.peakRssMiB<220;
 console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
}finally{clearTimeout(deadline);clearInterval(sample);server.closeAllConnections();await new Promise(r=>server.close(r));db.close();}
