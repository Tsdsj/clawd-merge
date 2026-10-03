// MINIFLARE_MODULE=/absolute/path/to/miniflare node scripts/probes/account-kdf/run.mjs
// PROBE_URL=http://127.0.0.1:8796 node scripts/probes/account-kdf/run.mjs
import { createRequire } from 'node:module';
import { pbkdf2Sync, scryptSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { cases } from './worker.mjs';

let mf;
const samples = [];
const password = 'A00-public-fixture-only-2026';
const salt = 'a00-public-salt-2026';
const target = process.env.PROBE_URL;
if (target && !/^http:\/\/127\.0\.0\.1:\d+$/.test(target)) throw new Error('PROBE_URL must be a loopback Wrangler proxy');
try {
  if (!target) {
    if (!process.env.MINIFLARE_MODULE) throw new Error('Set MINIFLARE_MODULE or PROBE_URL');
    const require = createRequire(import.meta.url);
    const { Miniflare, convertV4MiniflareOptions } = require(process.env.MINIFLARE_MODULE);
    const options = {
      name: 'clawd-account-a00-probe', host: '127.0.0.1', port: 0,
      modules: true, scriptPath: fileURLToPath(new URL('./worker.mjs', import.meta.url)),
      compatibilityDate: '2026-09-01', compatibilityFlags: ['nodejs_compat'], cf: false,
    };
    const normalized = convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options;
    if (convertV4MiniflareOptions) normalized.telemetry = { enabled: false };
    mf = new Miniflare(normalized);
    await mf.ready;
  }
  for (const [name, parameters] of Object.entries(cases)) {
    const before = performance.now();
    const cpuBefore = process.cpuUsage();
    const expected = name.startsWith('scrypt')
      ? scryptSync(password, salt, 32, parameters).toString('hex')
      : pbkdf2Sync(password, salt, parameters.iterations, 32, parameters.hash.replace('-', '').toLowerCase()).toString('hex');
    const nodeWallMs = Math.round((performance.now() - before) * 10) / 10;
    const cpu = process.cpuUsage(cpuBefore);
    const nodeCpuMs = Math.round((cpu.user + cpu.system) / 100) / 10;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const started = performance.now();
      const url = `${target || 'http://localhost'}/${name}`;
      const response = mf ? await mf.dispatchFetch(url) : await fetch(url, { signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      const roundTripMs = Math.round((performance.now() - started) * 10) / 10;
      samples.push({ name, attempt, status: response.status, ok: data.ok, matchesNode: data.ok ? data.hex === expected : null, nodeWallMs, nodeCpuMs, roundTripMs, ...(data.ok ? {} : { error: data.error, message: data.message }) });
      if (data.ok && data.hex !== expected) throw new Error(`KDF output mismatch: ${name}`);
    }
  }
  console.log(JSON.stringify({ runtime: target ? 'wrangler-proxy-see-session-log-for-mode' : 'local-workerd', compatibilityDate: '2026-09-01', timings: 'client wall-clock only; not Workers billed CPU', samples }, null, 2));
} finally {
  await mf?.dispose();
}
