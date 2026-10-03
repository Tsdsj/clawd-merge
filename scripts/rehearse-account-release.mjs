// Never opens the source for writing. Output must be a fresh private directory
// outside this checkout; no player rows, tokens, paths or names reach stdout.
import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,chmodSync,realpathSync} from 'node:fs';
import {resolve,dirname,basename,relative,isAbsolute,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {openDatabase} from '../server/sqlite.mjs';
import {auditNames} from '../leaderboard/ops/name-audit.mjs';
const quote=name=>'"'+name.replaceAll('"','""')+'"';
const digest=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const businessTables=db=>db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r=>r.name).filter(n=>!n.startsWith('sqlite_')&&!n.startsWith('_cf_')&&!['app_migrations','d1_migrations'].includes(n));
function snapshot(db,columns){
 columns||=Object.fromEntries(businessTables(db).map(t=>[t,db.prepare(`PRAGMA table_info(${quote(t)})`).all().map(c=>c.name)]));
 const tables={};for(const [table,fields]of Object.entries(columns)){const hash=createHash('sha256');let rows=0;for(const row of db.prepare(`SELECT ${fields.map(quote).join(',')} FROM ${quote(table)} ORDER BY ${fields.map(quote).join(',')}`).iterate()){hash.update(JSON.stringify(row)+'\n');rows++;}tables[table]={rows,sha256:hash.digest('hex')};}return {columns,tables};
}
function health(db){
 const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check,foreignKeyErrors=db.prepare('PRAGMA foreign_key_check').all().length,orphans={};
 for(const table of ['tokens','sessions','scores','score_receipts','challenge_allowances','challenge_sessions','challenge_scores','challenge_bests'])if(businessTables(db).includes(table))orphans[table]=db.prepare(`SELECT count(*) n FROM ${quote(table)} t LEFT JOIN players p ON p.id=t.player_id WHERE p.id IS NULL`).get().n;
 return {integrity,foreignKeyErrors,orphans};
}
export async function rehearseRelease({source,outDir}){
 const parent=realpathSync(dirname(resolve(outDir))),output=join(parent,basename(outDir)),root=realpathSync(fileURLToPath(new URL('../',import.meta.url))),rel=relative(root,output);
 if(!rel||(!rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&!isAbsolute(rel)))throw Error('Use a private output directory outside the checkout');
 mkdirSync(output,{mode:0o700});const sourceDigest=digest(source),original=new DatabaseSync(source,{readOnly:true});let before;
 const candidate=join(output,'migrated.sqlite'),restored=join(output,'restored.sqlite');
 try{original.exec('BEGIN');before=snapshot(original);if(health(original).integrity!=='ok')throw Error('source integrity');await backup(original,candidate);original.exec('COMMIT');}finally{original.close();}
 chmodSync(candidate,0o600);let db=openDatabase(candidate),after,report;
 try{const migratedOld=snapshot(db.raw,before.columns);after=snapshot(db.raw);const checks=health(db.raw);report={schemaVersion:1,ok:false,sourceUnchanged:digest(source)===sourceDigest,originalDataPreserved:JSON.stringify(before.tables)===JSON.stringify(migratedOld.tables),...checks,migrations:db.raw.prepare('SELECT name,sha256 FROM app_migrations ORDER BY name').all(),nameAudit:auditNames(db.raw),tables:after.tables};await backup(db.raw,restored);}finally{db.close();}
 chmodSync(restored,0o600);db=openDatabase(candidate);try{report.restartStable=JSON.stringify(snapshot(db.raw).tables)===JSON.stringify(after.tables);}finally{db.close();}
 const restoredDb=new DatabaseSync(restored,{readOnly:true});try{report.restoredCopyMatches=health(restoredDb).integrity==='ok'&&JSON.stringify(snapshot(restoredDb).tables)===JSON.stringify(after.tables);}finally{restoredDb.close();}
 report.ok=report.sourceUnchanged&&report.originalDataPreserved&&report.restartStable&&report.restoredCopyMatches&&report.integrity==='ok'&&report.foreignKeyErrors===0&&Object.values(report.orphans).every(n=>n===0)&&report.nameAudit.unavailable===0;
 writeFileSync(join(output,'report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});return report;
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
 try{const args=process.argv.slice(2);if(args.length!==4||args[0]!=='--source'||args[2]!=='--out-dir')throw Error();const r=await rehearseRelease({source:args[1],outDir:args[3]});console.log(r.ok?'PASS: private-copy migration, restart and backup restoration verified.':'FAIL: review the private rehearsal report; source was not modified.');if(!r.ok)process.exitCode=1;}
 catch{console.error('Rehearsal failed. Source is read-only; inspect the private output and do not deploy.');process.exitCode=1;}
}
