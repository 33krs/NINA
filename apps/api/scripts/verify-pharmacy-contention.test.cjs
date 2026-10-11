const assert = require('node:assert/strict');
const test = require('node:test');
const { observedWaiters } = require('./verify-pharmacy-contention.cjs');

const identities = [1, 2, 3].map((pid) => ({ pid, started: `start-${pid}` }));
function rows() {
  return identities.map((identity, index) => ({
    ...identity,
    state: 'active',
    wait: 'Lock',
    query: 'SELECT "id" FROM "Prescription" WHERE "id" = $1 FOR UPDATE',
    blockers: index ? [1] : [],
  }));
}

test('observes both exact writer identities blocked by the held backend', () => {
  assert.equal(observedWaiters(rows(), identities, 'Prescription'), true);
});

test('accepts a soft queue through the peer writer', () => {
  const snapshot = rows();
  snapshot[2].blockers = [2];
  assert.equal(observedWaiters(snapshot, identities, 'Prescription'), true);
});

test('observes the expected shared batch query, not a prescription query', () => {
  const snapshot = rows();
  for (const row of snapshot) row.query = 'SELECT "id" FROM "Batch" FOR UPDATE';
  assert.equal(observedWaiters(snapshot, identities, 'Batch'), true);
  assert.equal(observedWaiters(snapshot, identities, 'Prescription'), false);
});

test('rejects unknown tables and duplicate expected identities', () => {
  assert.equal(observedWaiters(rows(), identities, 'Patient'), false);
  assert.equal(
    observedWaiters(
      rows(),
      [identities[0], identities[1], identities[1]],
      'Prescription',
    ),
    false,
  );
});

for (const [name, change] of [
  ['missing writer', (snapshot) => snapshot.pop()],
  ['changed backend identity', (snapshot) => (snapshot[1].started = 'other')],
  ['changed blocker identity', (snapshot) => (snapshot[0].started = 'other')],
  ['unrelated blocker', (snapshot) => (snapshot[1].blockers = [99])],
  ['mixed unrelated blocker', (snapshot) => snapshot[1].blockers.push(99)],
  [
    'cycle',
    (snapshot) => {
      snapshot[1].blockers = [3];
      snapshot[2].blockers = [2];
    },
  ],
  [
    'cycle despite a direct blocker path',
    (snapshot) => {
      snapshot[1].blockers = [1, 3];
      snapshot[2].blockers = [2];
    },
  ],
  [
    'wrong table',
    (snapshot) => (snapshot[1].query = 'SELECT * FROM "Batch" FOR UPDATE'),
  ],
  ['no row-lock query', (snapshot) => (snapshot[1].query = 'SELECT 1')],
  ['not active', (snapshot) => (snapshot[1].state = 'idle in transaction')],
  ['not waiting on a lock', (snapshot) => (snapshot[1].wait = 'Client')],
  [
    'peer not waiting on the expected lock',
    (snapshot) => {
      snapshot[2].blockers = [2];
      snapshot[1].query = 'SELECT 1';
    },
  ],
  ['no blocker', (snapshot) => (snapshot[1].blockers = [])],
  ['duplicate backend row', (snapshot) => snapshot.push(snapshot[1])],
]) {
  test(`rejects ${name}`, () => {
    const snapshot = rows();
    change(snapshot);
    assert.equal(observedWaiters(snapshot, identities, 'Prescription'), false);
  });
}
