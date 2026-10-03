import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {openDatabase} from '../server/sqlite.mjs';
let checkReleaseConfig,rehearseRelease;
try{({checkReleaseConfig}=await import('../scripts/check-release-compose.mjs'));}catch{}
try{({rehearseRelease}=await import('../scripts/rehearse-account-release.mjs'));}catch{}
const valid=()=>({services:{api:{image:'clawd-api:fixture',environment:{PUBLIC_ORIGIN:'https://game.example.invalid',TRUST_PROXY:'1',PASSWORD_AUTH_ENABLED:'1',PASSWORD_REGISTRATION_ENABLED:'0',ACCOUNT_BINDING_ENABLED:'0',PASSWORD_AUTH_KEYRING_FILE:'/run/secrets/password_keyring'},secrets:[{source:'password_keyring'}]},web:{ports:[{host_ip:'127.0.0.1',target:80,published:'8080'}],environment:{PUBLIC_HOST:'game.example.invalid'},volumes:[{target:'/opt/clawd/nginx.conf.template',source:'/private/config/nginx-proxied.conf',read_only:true}]},backup:{image:'clawd-api:fixture'}},secrets:{password_keyring:{file:'/private/secrets/keyring.json'}}});
test('A07 release preflight rejects lost proxy overlay, exposed API, active certbot and password shutdown',()=>{
 assert.ok(checkReleaseConfig);const options={expectedImage:'clawd-api:fixture',requirePasswordAuth:true};assert.deepEqual(checkReleaseConfig(valid(),options),[]);
 for(const mutate of [d=>d.services.web.ports.push({target:443,published:'443'}),d=>d.services.api.ports=[{published:'3000'}],d=>d.services.certbot={},d=>d.services.api.environment.PASSWORD_AUTH_ENABLED='0',d=>d.services.backup.image='clawd-api:old']){const d=valid();mutate(d);assert.ok(checkReleaseConfig(d,options).length>0);}
});
test('A07 rehearsal upgrades only a new private copy and verifies data, restart and backup restoration',async t=>{
 assert.ok(rehearseRelease);const dir=mkdtempSync(join(tmpdir(),'clawd-release-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const old=join(dir,'migrations');mkdirSync(old);
 for(const file of readdirSync(new URL('../leaderboard/migrations/',import.meta.url)).filter(x=>/^000[1-4]_/.test(x)))copyFileSync(new URL('../leaderboard/migrations/'+file,import.meta.url),join(old,file));
 const source=join(dir,'source.sqlite'),db=openDatabase(source,{migrations:pathToFileURL(old+'/')});db.raw.prepare('INSERT INTO players(id,name,name_key,token_hash,created_at) VALUES(?,?,?,?,?)').run('private-player','PRIVATE-NAME','private-name','PRIVATE-TOKEN-HASH',1);db.close();
 const original=readFileSync(source),report=await rehearseRelease({source,outDir:join(dir,'rehearsal')});assert.equal(report.ok,true);assert.ok(report.originalDataPreserved&&report.restartStable&&report.restoredCopyMatches&&report.sourceUnchanged);assert.deepEqual(readFileSync(source),original);
 assert.ok(!JSON.stringify(report).includes('PRIVATE-NAME'));assert.ok(!JSON.stringify(report).includes('PRIVATE-TOKEN-HASH'));
 await assert.rejects(rehearseRelease({source,outDir:join(dir,'rehearsal')}));
});

test('A07 clean-commit packaging excludes ignored private files and produces container-readable static assets',async t=>{
 const {execFileSync}=await import('node:child_process'),{writeFileSync,statSync,existsSync}=await import('node:fs');
 const dir=mkdtempSync(join(tmpdir(),'clawd-package-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const repo=join(dir,'repo');mkdirSync(repo);mkdirSync(join(repo,'scripts'));mkdirSync(join(repo,'src'));mkdirSync(join(repo,'icons'));mkdirSync(join(repo,'leaderboard/migrations'),{recursive:true});
 for(const name of ['prepare-account-release.mjs','build-site.mjs'])copyFileSync(new URL('../scripts/'+name,import.meta.url),join(repo,'scripts',name));
 for(const name of ['index.html','migration.html','favicon.svg','manifest.webmanifest'])writeFileSync(join(repo,name),'fixture');writeFileSync(join(repo,'src/main.js'),'// fixture');writeFileSync(join(repo,'icons/icon.svg'),'<svg/>');writeFileSync(join(repo,'leaderboard/migrations/0001_fixture.sql'),'-- fixture');writeFileSync(join(repo,'.gitignore'),'.env\n');writeFileSync(join(repo,'.env'),'PRIVATE_SHOULD_NOT_SHIP=fixture');
 const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:'pipe'});git('init');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgSign','false');git('config','core.hooksPath',join(dir,'no-hooks'));git('add','.');git('commit','-m','fixture');
 const out=join(dir,'bundle');execFileSync(process.execPath,[join(repo,'scripts/prepare-account-release.mjs'),'--out-dir',out],{cwd:repo,env:{...process.env,PUBLIC_ORIGIN:'https://game.example.invalid',PRODUCTION_DATASET:'fixture'},stdio:'pipe'});
 assert.equal(existsSync(join(out,'source/.env')),false);assert.equal(statSync(join(out,'public')).mode&0o777,0o755);assert.equal(statSync(join(out,'public/src/main.js')).mode&0o777,0o644);
 const manifest=JSON.parse(readFileSync(join(out,'manifest.json'),'utf8'));assert.match(manifest.revision,/^[a-f0-9]{40}$/);assert.ok(manifest.assets['runtime-config.js']);assert.ok(!JSON.stringify(manifest).includes('PRIVATE_SHOULD_NOT_SHIP'));
});
