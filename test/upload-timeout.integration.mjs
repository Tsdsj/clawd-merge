// Real fetch timeout, including a response whose headers arrived but body stalls.
// Run explicitly: node test/upload-timeout.integration.mjs (takes about 16 seconds).
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.write('{');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  globalThis.location = new URL(`http://localhost:5173/?api=http://127.0.0.1:${server.address().port}`);
  const data = new Map();
  globalThis.localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
  };
  const { leaderboard } = await import('../src/leaderboard.js');
  const start = performance.now();
  await assert.rejects(
    leaderboard.sendResult(
      { sessionId: 'isolated-ticket', score: 30, drops: 1, maxLevel: 3 },
      'synthetic-token',
    ),
    { code: 'timeout' },
  );
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 7500 && elapsed < 15000, `elapsed ${elapsed}`);
  console.log(`PASS: response-body timeout aborts the real HTTP request after ${Math.round(elapsed)} ms.`);
  leaderboard.save({ id: 'test-player', name: 'Test' }, 'synthetic-token');
  const check = await leaderboard.checkSavedSession({
    playerId: 'test-player',
    sessionId: 'isolated-ticket',
  });
  assert.equal(check.status, 'network');
  console.log('PASS: externally signalled recovery timeout stays retryable, not expired.');
} finally {
  server.closeAllConnections();
  server.close();
}
