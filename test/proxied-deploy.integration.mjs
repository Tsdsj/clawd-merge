import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const env={...process.env,PUBLIC_HOST:'game.example.invalid',PUBLIC_ORIGIN:'https://game.example.invalid',ALLOWED_ORIGINS:'https://game.example.invalid',LINUXDO_CLIENT_ID:'fixture',COMPOSE_FILE:'',COMPOSE_PROFILES:''};
function config(files){return JSON.parse(execFileSync('docker',['compose','--env-file','/dev/null',...files.flatMap(file=>['-f',resolve(root,'deploy',file)]),'config','--format','json'],{env,encoding:'utf8'}));}
test('proxied deployment binds only loopback, replaces the TLS template and excludes certbot',()=>{
 const d=config(['compose.yaml','compose.proxied.yaml']),web=d.services.web;
 assert.deepEqual(web.ports.map(p=>[p.host_ip,p.published,p.target]),[['127.0.0.1','8080',80]]);
 assert.ok(web.volumes.find(v=>v.target==='/opt/clawd/nginx.conf.template').source.endsWith('/nginx-proxied.conf'));
 assert.equal(d.services.certbot,undefined);assert.equal(d.services.api.ports,undefined);
 assert.deepEqual(Object.keys(d.services).sort(),['api','backup','web']);
});
test('standalone configuration remains usable and password overlay composes with host proxy',()=>{
 const base=config(['compose.yaml']);assert.ok(base.services.certbot);assert.deepEqual(base.services.web.ports.map(p=>p.published),['80','443']);
 const d=config(['compose.yaml','compose.proxied.yaml','compose.password.yaml']);
 assert.equal(d.services.api.environment.PASSWORD_AUTH_ENABLED,'1');assert.equal(d.services.web.ports.length,1);assert.equal(d.services.web.ports[0].host_ip,'127.0.0.1');assert.equal(d.services.certbot,undefined);
});
