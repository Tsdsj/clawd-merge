// Zero-dependency static server: `npm start` (or `node serve.mjs`).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT) || 5173;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.json': 'application/json',
};

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  let path = decodeURIComponent(pathname);
  if (path.endsWith('/')) path += 'index.html';
  const file = normalize(join(root, path));
  // Stay inside the project and never serve dotfiles.
  if (!file.startsWith(root) || path.split('/').some((seg) => seg.startsWith('.'))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '0.0.0.0', () => {
  console.log(`\n  合成大Clawd running at:\n`);
  console.log(`  ➜ Local:   http://localhost:${port}/`);
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  ➜ Network: http://${a.address}:${port}/  (open on your phone)`);
    }
  }
  console.log('');
});
