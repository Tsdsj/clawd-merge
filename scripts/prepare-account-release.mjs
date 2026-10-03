// Package only a clean committed tree. No deployment, secrets or DB are copied.
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,lstatSync,realpathSync,chmodSync} from 'node:fs';
import {resolve,dirname,basename,relative,isAbsolute,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
process.umask(0o077);
const root=fileURLToPath(new URL('../',import.meta.url)),args=process.argv.slice(2);
try{
 if(args.length!==2||args[0]!=='--out-dir'||!process.env.PUBLIC_ORIGIN||!process.env.PRODUCTION_DATASET)throw Error('arguments');
 const out=join(realpathSync(dirname(resolve(args[1]))),basename(args[1])),rel=relative(realpathSync(root),out);
 if(!rel||(!rel.startsWith('..'+(process.platform==='win32'?'\\':'/'))&&!isAbsolute(rel)))throw Error('private output required');
 const git=(...a)=>execFileSync('git',a,{cwd:root,encoding:'utf8'}).trim();if(git('status','--porcelain'))throw Error('clean committed tree required');
 const revision=git('rev-parse','HEAD');mkdirSync(out,{mode:0o700});const source=join(out,'source');mkdirSync(source);
 execFileSync('git',['archive','--format=tar.gz','--output',join(out,'source.tar.gz'),revision],{cwd:root});execFileSync('tar',['-xzf',join(out,'source.tar.gz'),'-C',source]);
 const hashes={};const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
 function walk(dir,base){chmodSync(dir,0o755);for(const name of readdirSync(dir).sort()){const file=join(dir,name),s=lstatSync(file);if(s.isSymbolicLink())throw Error('review symlink');if(s.isDirectory())walk(file,base);else{chmodSync(file,s.mode&0o111?0o755:0o644);hashes[relative(base,file)]=hash(file);}}}
 walk(source,source); // Refuse symlinks before a static build can follow them.
 execFileSync(process.execPath,[join(source,'scripts/build-site.mjs')],{cwd:source,env:{...process.env,SITE_OUTPUT:join(out,'public')},stdio:['ignore','ignore','pipe']});
 for(const key of Object.keys(hashes))delete hashes[key];walk(join(out,'public'),join(out,'public'));
 execFileSync('tar',['-czf',join(out,'public.tar.gz'),'-C',join(out,'public'),'.']);
 const migrations=Object.fromEntries(readdirSync(join(source,'leaderboard/migrations')).filter(n=>n.endsWith('.sql')).sort().map(n=>[n,hash(join(source,'leaderboard/migrations',n))]));
 const manifest={revision,sourceArchiveSha256:hash(join(out,'source.tar.gz')),publicArchiveSha256:hash(join(out,'public.tar.gz')),assets:hashes,migrations};
 writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});console.log('Prepared committed release '+revision+'; no deployment was performed.');
}catch{console.error('Release packaging failed. Use a clean committed tree, private fresh output directory, PUBLIC_ORIGIN and stable PRODUCTION_DATASET.');process.exitCode=1;}
