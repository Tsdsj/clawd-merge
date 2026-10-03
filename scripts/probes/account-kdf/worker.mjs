// A00 feasibility probe only. No user input, secrets, database or production route.
import { scryptSync } from 'node:crypto';

export const cases = {
  'pbkdf2-control': { hash: 'SHA-256', iterations: 100_000 },
  'pbkdf2-sha256': { hash: 'SHA-256', iterations: 600_000 },
  'pbkdf2-sha512': { hash: 'SHA-512', iterations: 220_000 },
  'scrypt-32m': { N: 32768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 },
};
const password = 'A00-public-fixture-only-2026';
const salt = 'a00-public-salt-2026';
const encoder = new TextEncoder();

export default {
  async fetch(request) {
    const name = new URL(request.url).pathname.slice(1);
    if (request.method !== 'GET' || !Object.hasOwn(cases, name)) {
      return Response.json({ error: 'probe_case_required' }, { status: 404 });
    }
    try {
      const parameters = cases[name];
      let bytes;
      if (name.startsWith('scrypt')) {
        bytes = scryptSync(password, salt, 32, parameters);
      } else {
        const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
        bytes = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), ...parameters }, key, 256));
      }
      return Response.json({ name, ok: true, hex: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      return Response.json({ name, ok: false, error: error.name, message: error.message }, { status: 422 });
    }
  },
};
