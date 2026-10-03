const PREFERENCES = new Set(['clawd-merge:best','clawd-merge:seen','clawd-merge:sound','clawd-merge:comfort','clawd-merge:guide:v1']);
function allowed(key, scope) {
  return key === 'clawd-merge:player' || PREFERENCES.has(key) ||
    [`clawd-merge:save:${scope}`,`clawd-merge:save:daily:${scope}`,`clawd-merge:save:daily:${scope}:start`,`clawd-merge:challenge-cache:${scope}`].includes(key) ||
    key.startsWith(`clawd-merge:outbox:${encodeURIComponent(scope)}:`) || key.startsWith(`clawd-merge:outbox:${encodeURIComponent(`daily:${scope}`)}:`);
}
function validate(packet, scope) {
  if (!scope?.startsWith('production:') || packet?.version !== 1 || packet.scope !== scope || !Array.isArray(packet.entries) || packet.entries.length > 200) throw new Error('invalid_transfer');
  let size = 0;
  const keys = new Set();
  for (const row of packet.entries) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || typeof row[1] !== 'string' || !allowed(row[0],scope) || keys.has(row[0])) throw new Error('invalid_transfer');
    keys.add(row[0]);
    size += row[0].length + row[1].length;
    if (row[1].length > 2_000_000 || size > 8_000_000) throw new Error('invalid_transfer_size');
  }
  return packet;
}
export function collectTransfer(storage, scope) {
  const entries=[];
  for(let i=0;i<storage.length;i++) {
    const key=storage.key(i);
    if(typeof key==='string'&&allowed(key,scope))entries.push([key,storage.getItem(key)]);
  }
  return validate({version:1,scope,entries},scope);
}
export function importTransfer(storage, packet, scope) {
  validate(packet,scope);
  const changes=[];
  // Check every conflict before changing anything. Never silently replace a
  // different account, unfinished game, start intent or pending score.
  for(const [key,value] of packet.entries) {
    const existing=storage.getItem(key);
    if(existing===value)continue;
    if(existing!==null) {
      if(key==='clawd-merge:player') {
        let current,incoming;
        try {current=JSON.parse(existing);incoming=JSON.parse(value);} catch {throw new Error('transfer_conflict');}
        if(typeof current?.id==='string'&&current.id.length>0&&current.id===incoming?.id&&typeof current.token==='string'&&current.token.length>0)continue;
        throw new Error('transfer_conflict');
      } else if(key==='clawd-merge:best') {
        const next=String(Math.max(Number(existing)||0,Number(value)||0));
        if(next!==existing)changes.push([key,next,existing]);
      } else if(key==='clawd-merge:seen') {
        const before=JSON.parse(existing),incoming=JSON.parse(value);
        if(!Array.isArray(before)||!Array.isArray(incoming)||[...before,...incoming].some(n=>!Number.isInteger(n)||n<0||n>11))throw new Error('invalid_transfer');
        const next=JSON.stringify([...new Set([...before,...incoming])].sort((a,b)=>a-b));
        if(next!==existing)changes.push([key,next,existing]);
      } else if(PREFERENCES.has(key)||key.startsWith('clawd-merge:challenge-cache:')) {
        // Keep an explicit setting already made at the new site.
        continue;
      } else throw new Error('transfer_conflict');
    } else changes.push([key,value,null]);
  }
  const written=[];
  try {
    for(const [key,value,previous] of changes) { storage.setItem(key,value); written.push([key,previous]); }
  } catch(error) {
    let rollbackFailed=false;
    for(const [key,previous] of written.reverse())try { previous===null?storage.removeItem(key):storage.setItem(key,previous); } catch { rollbackFailed=true; }
    if(rollbackFailed)throw new Error('transfer_rollback_failed');
    throw error;
  }
  return changes.length;
}
