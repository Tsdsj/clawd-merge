// Runs the leaderboard Worker locally on Node (in-memory D1 mock) — no wrangler
// or Cloudflare account needed. Usage: node leaderboard/test/dev-server.mjs
// then open the game with ?api=http://localhost:8787
import { createServer } from 'node:http';
import worker from '../src/index.js';
import { createD1 } from './d1-mock.mjs';

const port = Number(process.env.PORT) || 8787;
const env = { DB: createD1(process.env.DB_FILE || ':memory:'), ALLOWED_ORIGINS: '*', BLOCKED_WORDS: '' };

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    // Dev only: honour a client-supplied IP header (in production Cloudflare sets it).
    headers: { ...req.headers, 'cf-connecting-ip': req.headers['cf-connecting-ip'] || req.socket.remoteAddress },
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  });
  const response = await worker.fetch(request, env);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`leaderboard dev API on http://localhost:${port}`));
