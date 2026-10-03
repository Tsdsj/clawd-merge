// Prints aggregate verification only, never player rows or credentials.
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
if(!process.argv[2])throw new Error('Pass a private SQLite database path');
const db=new DatabaseSync(process.argv[2],{readOnly:true});
try {
  db.exec('BEGIN');
  const integrity=db.prepare('PRAGMA integrity_check').get().integrity_check;
  if(integrity!=='ok')throw new Error('Database integrity check failed');
  const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(x=>x.name).filter(x=>!x.startsWith('sqlite_')&&!x.startsWith('_cf_')&&!['d1_migrations','app_migrations'].includes(x));
  const result=tables.map(name=>{
    const safe=name.replaceAll('"','""');
    const rows=db.prepare(`SELECT * FROM "${safe}"`).all().map(row=>JSON.stringify(row)).sort();
    return {table:name,rows:rows.length,sha256:createHash('sha256').update(rows.join('\n')).digest('hex')};
  });
  db.exec('COMMIT');
  console.log(JSON.stringify({integrity,tables:result},null,2));
} finally {db.close();}
