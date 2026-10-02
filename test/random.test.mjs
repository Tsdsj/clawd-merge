import test from 'node:test';
import assert from 'node:assert/strict';

// Versioned vectors are a compatibility contract, not statistical quality claims.
test('gameplay RNG has stable unsigned 32-bit vectors including zero', async () => {
  const { GameplayRandom } = await import('../src/random.js');
  const rng = new GameplayRandom(1);
  assert.deepEqual(Array.from({ length: 4 }, () => rng.next() * 2 ** 32),
    [2693262067, 11749833, 2265367787, 4213581821]);
  for (const seed of [0, 1, 0xffffffff]) {
    const a = new GameplayRandom(seed), b = new GameplayRandom(seed);
    for (let i = 0; i < 200; i++) {
      const n = a.next();
      assert.ok(n >= 0 && n < 1);
      assert.equal(n, b.next());
    }
  }
  for (const seed of [-1, 2 ** 32, 1.2, NaN, '1', null]) {
    assert.throws(() => new GameplayRandom(seed));
  }
});

test('RNG snapshot resumes exactly and rejects unknown or corrupt algorithms', async () => {
  const { GameplayRandom } = await import('../src/random.js');
  const original = new GameplayRandom(123);
  for (let i = 0; i < 37; i++) original.next();
  const resumed = GameplayRandom.fromSnapshot(JSON.parse(JSON.stringify(original.snapshot())));
  assert.deepEqual(Array.from({ length: 50 }, () => resumed.next()), Array.from({ length: 50 }, () => original.next()));
  for (const bad of [null, {}, { algorithm: 'new', state: 1 }, { algorithm: 'mulberry32-1', state: -1 }]) {
    assert.throws(() => GameplayRandom.fromSnapshot(bad));
  }
});

test('daily sequence is immutable, prefix-stable, and independent of ambient randomness', async (t) => {
  const { createChallengeSequence } = await import('../src/drop-sequence.js');
  const input = { challengeId: '2026-10-02', rulesVersion: 'daily-1', count: 100 };
  const first = createChallengeSequence(input);
  t.mock.method(Math, 'random', () => { throw new Error('ambient RNG must not be read'); });
  const second = createChallengeSequence(input);
  assert.deepEqual(first, second);
  assert.deepEqual(createChallengeSequence({ ...input, count: 20 }).levels, first.levels.slice(0, 20));
  assert.equal(first.levels[0], 1);
  assert.ok(first.levels.slice(0, 16).every(n => n >= 1 && n <= 5));
  assert.ok(first.levels.every(n => Number.isInteger(n) && n >= 0 && n <= 5));
  assert.ok(first.levels.every((n, i) => n !== 0 || first.levels[i - 1] !== 0));
  assert.ok(first.levels.includes(4) && first.levels.includes(5));
  assert.notDeepEqual(first.levels, createChallengeSequence({ ...input, challengeId: '2026-10-03' }).levels);
  assert.throws(() => { first.levels[0] = 5; });
  assert.throws(() => { first.rulesVersion = 'anything'; });
});

test('challenge identity, version and allocation bounds fail closed', async () => {
  const { createChallengeSequence } = await import('../src/drop-sequence.js');
  const valid = { challengeId: '2026-10-02', rulesVersion: 'daily-1', count: 100 };
  for (const change of [{ challengeId: '' }, { challengeId: '日常' }, { challengeId: 'a'.repeat(129) },
    { rulesVersion: 'classic-1' }, { rulesVersion: 'daily-2' }, { rulesVersion: undefined },
    { count: 0 }, { count: 1.5 }, { count: 1001 }, { count: NaN }]) {
    assert.throws(() => createChallengeSequence({ ...valid, ...change }));
  }
});

test('classic weights, growth cap and rainbow eligibility retain their boundary behaviour', async () => {
  const { chooseClassicLevel } = await import('../src/drop-sequence.js');
  const values = (...samples) => () => { assert.ok(samples.length, 'unexpected random draw'); return samples.shift(); };
  assert.equal(chooseClassicLevel(values(0.999), { drops: 0, current: 1, maxLevel: 1 }), 3);
  assert.equal(chooseClassicLevel(values(0.999), { drops: 0, current: 1, maxLevel: 4 }), 4);
  assert.equal(chooseClassicLevel(values(0.999), { drops: 0, current: 1, maxLevel: 11 }), 5);
  for (const [sample, expected] of [[0, 1], [0.21999, 1], [0.22, 2], [0.44, 3], [0.66, 4], [0.84, 5]]) {
    assert.equal(chooseClassicLevel(values(sample), { drops: 0, current: 1, maxLevel: 5 }), expected);
  }
  assert.equal(chooseClassicLevel(values(0.034999), { drops: 15, current: 1, maxLevel: 3 }), 0);
  assert.equal(chooseClassicLevel(values(0.035, 0.999), { drops: 15, current: 1, maxLevel: 3 }), 3);
  assert.equal(chooseClassicLevel(values(0), { drops: 14, current: 1, maxLevel: 3 }), 1);
  assert.equal(chooseClassicLevel(values(0), { drops: 15, current: 0, maxLevel: 3 }), 1);
});

test('UTF-8 seed hashing and two published daily vectors cannot silently drift', async () => {
  const { readFile } = await import('node:fs/promises');
  const { seedFromText } = await import('../src/random.js');
  const { createChallengeSequence } = await import('../src/drop-sequence.js');
  assert.equal(seedFromText(''), 2166136261);
  assert.equal(seedFromText('hello'), 0x4f9f2cab);
  const vectors = JSON.parse(await readFile(new URL('./fixtures/daily-1.json', import.meta.url), 'utf8'));
  for (const expected of vectors) {
    assert.deepEqual(createChallengeSequence({ ...expected, count: expected.levels.length }), expected);
  }
});
