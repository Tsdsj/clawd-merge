import test from 'node:test';
import assert from 'node:assert/strict';
const definition = {
  challengeId: '2026-10-03',
  rulesVersion: 'daily-1',
  count: 100,
  startsAt: Date.parse('2026-10-02T16:00:00Z'),
  endsAt: Date.parse('2026-10-03T16:00:00Z'),
  submitUntil: Date.parse('2026-10-03T16:10:00Z'),
  attemptLimit: 3,
  settleSeconds: 8,
  stableSeconds: 0.75,
};
const ticket = {
  sessionId: 'ticket-1',
  playerId: 'p1',
  challengeId: definition.challengeId,
  rulesVersion: 'daily-1',
  attempt: 1,
  startedAt: definition.startsAt,
  submitUntil: definition.submitUntil,
};
test('server definition and monotonic clock, not device date, control formal context', async () => {
  const { ChallengeApi } = await import('../src/challenge-api.js');
  let clock = 10;
  const api = new ChallengeApi({
    getPlayer: () => ({ id: 'p1', token: 't' }),
    monotonic: () => clock,
    request: async () => ({
      challenge: definition,
      serverNow: definition.startsAt,
      allowance: { playerId: 'p1', limit: 3, used: 0, remaining: 3 },
    }),
  });
  assert.equal(api.formalAvailable, false);
  await api.today();
  clock += 5000;
  assert.equal(api.now(), definition.startsAt + 5000);
  assert.equal(api.formalAvailable, true);
});
test('identity changes and mismatched definitions never become playable credentials', async () => {
  const { ChallengeApi } = await import('../src/challenge-api.js');
  let p = { id: 'p1', token: 't' };
  let reply;
  const api = new ChallengeApi({ getPlayer: () => p, request: async () => reply });
  reply = { challenge: { ...definition, count: 101 }, serverNow: definition.startsAt, allowance: null };
  await assert.rejects(api.today());
  reply = {
    status: 'valid',
    challenge: definition,
    session: { ...ticket, playerId: 'other' },
    serverNow: definition.startsAt,
    allowance: { playerId: 'p1', limit: 3, used: 1, remaining: 2 },
  };
  await assert.rejects(
    api.start({
      playerId: 'p1',
      requestId: 'request-00000001',
      challengeId: definition.challengeId,
      rulesVersion: 'daily-1',
    }),
  );
  p = { id: 'p2', token: 't2' };
  assert.equal((await api.check(ticket)).status, 'identity');
});

test('same-player token rotation discards a late challenge profile from the previous session',async()=>{
 const {ChallengeApi}=await import('../src/challenge-api.js');
 let player={id:'p1',token:'old'},resolve;
 const api=new ChallengeApi({getPlayer:()=>player,request:()=>new Promise(r=>resolve=r)});
 const pending=api.today();player={id:'p1',token:'new'};resolve({});
 await assert.rejects(pending,{code:'identity_changed'});assert.equal(api.data,null);
});
