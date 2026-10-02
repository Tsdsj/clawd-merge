// Runs the leaderboard Worker locally on Node (in-memory D1 mock) — no wrangler
// or Cloudflare account needed. Usage: npm run lb:dev, then open the game with
// ?api=http://localhost:8787
//
// It also fakes LINUX DO Connect under /mock-linuxdo/*: the "authorize" page
// just asks which username to log in as.
import { createServer } from 'node:http';
import worker from '../src/index.js';
import { createD1 } from './d1-mock.mjs';

const port = Number(process.env.PORT) || 8787;
const base = `http://localhost:${port}`;
// Opt-in, local test server only. Never part of the deployed Worker.
const faultControls=process.env.SCORE_FAULTS==='1';
let scoreMode='pass';
const env = {
  DB: createD1(process.env.DB_FILE || ':memory:'),
  ALLOWED_ORIGINS: '*',
  GAME_URL: 'http://localhost:5173/',
  BLOCKED_WORDS: '',
  LINUXDO_CLIENT_ID: 'local-dev',
  LINUXDO_CLIENT_SECRET: 'local-dev-secret',
  LINUXDO_AUTHORIZE_URL: `${base}/mock-linuxdo/authorize`,
  LINUXDO_TOKEN_URL: `${base}/mock-linuxdo/token`,
  LINUXDO_USER_URL: `${base}/mock-linuxdo/user`,
};

// Fake LINUX DO: the code and access token are just the chosen username.
function mockLinuxdo(url, body) {
  if (url.pathname === '/mock-linuxdo/authorize') {
    const q = url.searchParams;
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
      <body style="font:16px system-ui;background:#1c1c1e;color:#eee;padding:40px;text-align:center">
      <h2>假的 LINUX DO 授权页（本地开发）</h2>
      <form action="/mock-linuxdo/approve"><input name="username" value="dev_user" style="font-size:16px;padding:8px">
      <input type="hidden" name="redirect_uri" value="${q.get('redirect_uri')}">
      <input type="hidden" name="state" value="${q.get('state')}">
      <p><button id="approve" style="font-size:16px;padding:8px 20px">允许</button>
      <a id="deny" style="color:#aaa" href="${q.get('redirect_uri')}?error=access_denied&state=${q.get('state')}">拒绝</a></p></form>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (url.pathname === '/mock-linuxdo/approve') {
    const target = new URL(url.searchParams.get('redirect_uri'));
    target.searchParams.set('code', url.searchParams.get('username'));
    target.searchParams.set('state', url.searchParams.get('state'));
    return Response.redirect(target.toString(), 302);
  }
  if (url.pathname === '/mock-linuxdo/token') {
    return Response.json({ access_token: new URLSearchParams(body.toString()).get('code') });
  }
  if (url.pathname === '/mock-linuxdo/user') {
    return null; // handled below (needs the Authorization header)
  }
  return undefined;
}

// Route the Worker's outgoing calls to the fake LINUX DO in-process.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.origin === base && url.pathname === '/mock-linuxdo/token') return mockLinuxdo(url, init.body);
  if (url.origin === base && url.pathname === '/mock-linuxdo/user') {
    const username = String(init.headers.Authorization).replace('Bearer ', '');
    const id = [...username].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    return Response.json({ id, username, avatar_template: null, trust_level: 1, active: true, silenced: false });
  }
  return realFetch(input, init);
};

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const url = new URL(req.url, base);
  if(faultControls && url.pathname.startsWith('/__test__/') &&
    !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
    res.writeHead(403).end();return;
  }
  if(faultControls && url.pathname==='/__test__/score-mode' && req.method==='POST') {
    let next;
    try { next=JSON.parse(body?.toString()||'{}').mode; } catch { res.writeHead(400).end();return; }
    if(!['pass','fail-before','drop-after'].includes(next)){res.writeHead(400).end();return;}
    scoreMode=next;res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({mode:scoreMode}));return;
  }
  if(faultControls && url.pathname==='/__test__/stats') {
    const scores=env.DB.raw.prepare('SELECT COUNT(*) AS n FROM scores').get().n;
    const receipts=env.DB.raw.prepare('SELECT COUNT(*) AS n FROM score_receipts').get().n;
    const games=env.DB.raw.prepare('SELECT COALESCE(SUM(games),0) AS n FROM players').get().n;
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({scores,receipts,games}));return;
  }
  if(faultControls && url.pathname==='/api/score' && scoreMode==='fail-before') {
    res.writeHead(503,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'}).end(JSON.stringify({error:'test_unavailable',message:'隔离测试：暂不可用'}));return;
  }
  let response = url.pathname.startsWith('/mock-linuxdo/') ? mockLinuxdo(url, body ?? '') : undefined;
  if (!response) {
    const request = new Request(`${base}${req.url}`, {
      method: req.method,
      // Dev only: honour a client-supplied IP header (in production Cloudflare sets it).
      headers: { ...req.headers, 'cf-connecting-ip': req.headers['cf-connecting-ip'] || req.socket.remoteAddress },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    response = await worker.fetch(request, env);
  }
  if(faultControls && url.pathname==='/api/score' && scoreMode==='drop-after' && response.status===200) {
    res.destroy();return;
  }
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`leaderboard dev API on ${base} (fake LINUX DO at ${base}/mock-linuxdo)`));
