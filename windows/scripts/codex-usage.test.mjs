import test from 'node:test';
import assert from 'node:assert/strict';
import * as care from '../src/care.ts';

const now = new Date('2026-01-02T00:00:00Z');
const source = 'codex-v2-' + 'a'.repeat(32);
function setup() {
  const values = new Map();
  globalThis.localStorage = {
    getItem: k => values.get(k) ?? null,
    setItem: (k, v) => { values.set(k, String(v)); },
  };
  care.codexUsageStart(now.getTime());
  return values;
}
function snapshot(cumulative, startedAt = '2026-01-02T01:00:00Z', id = source) {
  return { source: id, cumulative, startedAt };
}

test('new file is counted once, duplicate and lower snapshots are ignored', () => {
  setup();
  assert.equal(care.applyCodexSnapshot('pet-a', snapshot(5100), now), 5100);
  assert.equal(care.applyCodexSnapshot('pet-a', snapshot(5100), now), 0);
  assert.equal(care.applyCodexSnapshot('pet-a', snapshot(2000), now), 0);
  assert.equal(care.applyCodexSnapshot('pet-a', snapshot(6100), now), 1000);
  assert.equal(care.stateFor('pet-a').totalTokens, 6100);
  assert.equal(care.stateFor('pet-a').xp, 1);
  assert.equal(care.stateFor('pet-a').tokenCarry, 1100);
});

test('old file establishes baseline without replaying historical progress', () => {
  setup();
  care.mutate('pet-a', s => { s.xp = 100; s.totalTokens = 80000; });
  assert.equal(care.applyCodexSnapshot('pet-a', snapshot(1000000, '2025-12-01T00:00:00Z'), now), 0);
  assert.equal(care.applyCodexSnapshot('pet-a', snapshot(1000200, '2025-12-01T00:00:00Z'), now), 200);
  assert.equal(care.stateFor('pet-a').totalTokens, 80200);
  assert.equal(care.stateFor('pet-a').xp, 100);
});

test('restart uses persisted receipt, not process memory', () => {
  const values = setup();
  care.applyCodexSnapshot('pet-a', snapshot(5000), now);
  const disk = JSON.stringify([...values]);
  const reloaded = setup();
  for (const [k, v] of JSON.parse(disk)) reloaded.set(k, v);
  assert.equal(care.applyCodexSnapshot('pet-a', snapshot(5000), now), 0);
  assert.equal(care.applyCodexSnapshot('pet-a', snapshot(7000), now), 2000);
  assert.equal(care.stateFor('pet-a').totalTokens, 7000);
});

test('switching pets does not re-count the session', () => {
  setup();
  care.applyCodexSnapshot('pet-a', snapshot(5000), now);
  assert.equal(care.applyCodexSnapshot('pet-b', snapshot(5000), now), 0);
  assert.equal(care.applyCodexSnapshot('pet-b', snapshot(6000), now), 1000);
  assert.equal(care.applyCodexSnapshot('pet-a', snapshot(6500), now), 500);
  assert.equal(care.stateFor('pet-a').totalTokens, 5500);
  assert.equal(care.stateFor('pet-b').totalTokens, 1000);
});

test('failed care persistence leaves receipt unchanged and retry recovers', () => {
  const values = setup();
  care.applyCodexSnapshot('pet-a', snapshot(5000), now);
  const before = values.get('ap_care');
  const save = localStorage.setItem;
  localStorage.setItem = (k, v) => {
    if (k === 'ap_care') throw new Error('simulated disk full');
    save(k, v);
  };
  assert.throws(() => care.applyCodexSnapshot('pet-a', snapshot(7000), now), /disk full/);
  assert.equal(values.get('ap_care'), before);
  localStorage.setItem = save;
  assert.equal(care.applyCodexSnapshot('pet-a', snapshot(7000), now), 2000);
  assert.equal(care.stateFor('pet-a').totalTokens, 7000);
});

test('invalid snapshots and unknown timestamps cannot inflate progress', () => {
  setup();
  for (const n of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(care.applyCodexSnapshot('pet-a', snapshot(n), now), 0);
  }
  assert.equal(care.applyCodexSnapshot('pet-a', snapshot(1000, '', '__proto__'), now), 0);
  assert.equal(care.applyCodexSnapshot('pet-a', snapshot(1000, 'bad-date'), now), 0);
  assert.equal(care.stateFor('pet-a').totalTokens, 0);
});

test('corrupt care store fails closed instead of overwriting pets', () => {
  const values = setup();
  values.set('ap_care', '{broken');
  assert.throws(() => care.applyCodexSnapshot('pet-a', snapshot(1000), now));
  assert.equal(values.get('ap_care'), '{broken');
});
