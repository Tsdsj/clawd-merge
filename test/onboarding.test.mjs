import test from 'node:test';
import assert from 'node:assert/strict';

const storage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test('first-run guide advances with drops and stays dismissed after reload', async () => {
  const { createGuide } = await import('../src/onboarding.js');
  const store = storage();
  const guide = createGuide(store);
  assert.equal(guide.step, 1);
  guide.advance(1);
  assert.equal(guide.step, 2);
  guide.advance(2);
  assert.equal(guide.step, 3);
  guide.advance(3);
  assert.equal(guide.step, null);
  assert.equal(createGuide(store).step, null);
});

test('skip and existing account suppress basic guidance; feature tips are once-only', async () => {
  const { createGuide } = await import('../src/onboarding.js');
  const store = storage();
  const guide = createGuide(store);
  guide.dismiss();
  assert.equal(guide.step, null);
  assert.equal(createGuide(storage(), true).step, null);
  assert.equal(guide.discover('claw'), true);
  assert.equal(guide.discover('claw'), false);
  assert.equal(createGuide(store).discover('claw'), false);
  assert.equal(guide.discover('rainbow'), true);
});

test('blocked or corrupted storage does not prevent playing or dismissing guidance', async () => {
  const { createGuide } = await import('../src/onboarding.js');
  for (const store of [
    { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } },
    { getItem: () => '{', setItem() {} },
    { getItem: () => 'null', setItem() {} },
  ]) {
    const guide = createGuide(store);
    assert.equal(guide.step, 1);
    guide.dismiss();
    assert.equal(guide.step, null);
  }
});
