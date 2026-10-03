import test from 'node:test';
import assert from 'node:assert/strict';
const load = () => import('../src/domain-migration.js');
const scope = 'production:https://old-api.example.test';
const storage = (entries = []) => {
  const data = new Map(entries);
  return { data, get length() { return data.size; }, key: i => [...data.keys()][i], getItem: k => data.get(k) ?? null, setItem: (k,v) => data.set(k,v), removeItem: k => data.delete(k) };
};

test('domain transfer includes only this production dataset, never other sites or development credentials', async () => {
  const { collectTransfer } = await load();
  const s = storage([['clawd-merge:player','identity'],['unrelated-password','secret'],['clawd-merge:player:dev:http://localhost:8787','dev'],[`clawd-merge:save:${scope}`,'board'],['clawd-merge:save:production:https://other.test','other']]);
  assert.deepEqual(collectTransfer(s,scope).entries,[['clawd-merge:player','identity'],[`clawd-merge:save:${scope}`,'board']]);
});

test('domain transfer preserves identity, saves and exact queue records without changing origin scope', async () => {
  const { collectTransfer, importTransfer } = await load();
  const queue=`clawd-merge:outbox:${encodeURIComponent(scope)}:round`;
  const source=storage([['clawd-merge:player','identity'],[`clawd-merge:save:${scope}`,'board'],[queue,'unconfirmed-result']]);
  const target=storage();
  importTransfer(target,collectTransfer(source,scope),scope);
  assert.deepEqual(target.data,source.data);
  assert.equal(source.length,3);
});

test('domain import refuses conflicting identities before any write and ignores forged keys', async () => {
  const { importTransfer } = await load();
  const target=storage([['clawd-merge:player','new-identity']]);
  assert.throws(()=>importTransfer(target,{version:1,scope,entries:[['clawd-merge:best','200'],['clawd-merge:player','old-identity']]},scope),/conflict/);
  assert.equal(target.length,1);
  assert.throws(()=>importTransfer(target,{version:1,scope,entries:[['unrelated-password','bad']]},scope),/invalid/);
});

test('a failed transfer restores destination values and leaves source available for retry', async () => {
  const { collectTransfer, importTransfer } = await load();
  const source=storage([['clawd-merge:best','50'],['clawd-merge:player','identity']]);
  const target=storage();let writes=0;
  target.setItem=(k,v)=>{if(++writes===2)throw new Error('quota');target.data.set(k,v);};
  assert.throws(()=>importTransfer(target,collectTransfer(source,scope),scope),/quota/);
  assert.equal(target.length,0);
  assert.equal(source.length,2);
});

test('migration combines discovered characters while preserving a higher destination best',async()=>{
  const {collectTransfer,importTransfer}=await load();
  const source=storage([['clawd-merge:seen','[1,0,5]'],['clawd-merge:best','300']]);
  const target=storage([['clawd-merge:seen','[1,3]'],['clawd-merge:best','500']]);
  importTransfer(target,collectTransfer(source,scope),scope);
  assert.deepEqual(JSON.parse(target.getItem('clawd-merge:seen')),[0,1,3,5]);
  assert.equal(target.getItem('clawd-merge:best'),'500');
});

test('an already signed-in instance of the same account keeps its newer token while receiving progress',async()=>{
  const {collectTransfer,importTransfer}=await load();
  const source=storage([['clawd-merge:player',JSON.stringify({id:'same-player',token:'old-token'})],['clawd-merge:best','800']]);
  const current=JSON.stringify({id:'same-player',token:'new-token'});
  const target=storage([['clawd-merge:player',current]]);
  importTransfer(target,collectTransfer(source,scope),scope);
  assert.equal(target.getItem('clawd-merge:player'),current);
  assert.equal(target.getItem('clawd-merge:best'),'800');
});
