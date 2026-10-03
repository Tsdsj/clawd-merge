import { createServer } from 'node:http';
import { isIP } from 'node:net';
import api from '../leaderboard/src/index.js';

export function createApiServer(env, { worker = api, maxBodyBytes = 16_384 } = {}) {
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(origin.hostname)) throw new Error('PUBLIC_ORIGIN must use HTTPS');
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('PUBLIC_ORIGIN must be an origin');
  const server = createServer(async (req, res) => {
    const send = (status, error) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error })); };
    try {
      if (!req.url?.startsWith('/api/')) return send(404, 'not_found');
      const target = new URL(req.url, origin);
      if (target.origin !== origin.origin) return send(400, 'bad_request');
      const headers = new Headers();
      for (const key of ['authorization', 'content-type', 'origin', 'accept', 'access-control-request-headers', 'access-control-request-method']) {
        if (typeof req.headers[key] === 'string') headers.set(key, req.headers[key]);
      }
      let clientIp = req.socket.remoteAddress?.replace(/^::ffff:/, '') || 'unknown';
      // Only enable behind the private Compose network. Nginx overwrites this
      // header with its peer address; never forward caller-supplied CF headers.
      if (env.TRUST_PROXY === '1' && typeof req.headers['x-real-ip'] === 'string' && isIP(req.headers['x-real-ip'])) clientIp = req.headers['x-real-ip'];
      headers.set('CF-Connecting-IP', clientIp);
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBodyBytes) return send(413, 'body_too_large');
        chunks.push(chunk);
      }
      const body = ['GET', 'HEAD'].includes(req.method) || size === 0 ? undefined : Buffer.concat(chunks);
      const response = await worker.fetch(new Request(target, { method: req.method, headers, body }), env);
      if (!response.headers.has('Cache-Control')) response.headers.set('Cache-Control', 'no-store');
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error(JSON.stringify({ event: 'http_error', type: error?.name || 'Error' }));
      if (!res.headersSent) send(500, 'internal');
      else res.destroy();
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
