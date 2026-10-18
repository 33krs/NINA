const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createResourceContext,
  ownedResourceId,
  isResourceAbsent,
} = require('./pharmacy-redis-resource-identity.cjs');
const {
  resourceFixture,
} = require('./pharmacy-redis-resource-test-fixture.cjs');

for (const status of ['created', 'exited'])
  test(`owned identity contract permits ${status} fixture observations without running-service authority`, (t) => {
    const f = resourceFixture(t);
    assert.ok(Object.isFrozen(f.context));
    f.rows.container.State.Status = status;
    assert.equal(
      ownedResourceId(f.context, 'container', f.rows.container),
      f.containerId,
    );
    assert.equal(
      ownedResourceId(f.context, 'network', f.rows.network),
      f.networkId,
    );
  });

for (const [kind, mutate] of [
  ['container', (row) => (row.Id = 'd'.repeat(64))],
  ['container', (row) => (row.Name = '/foreign')],
  ['container', (row) => (row.Image = 'sha256:' + 'd'.repeat(64))],
  ['container', (row) => (row.Config.Image = 'other:7')],
  [
    'container',
    (row) => (row.Config.Labels['nina.pharmacy-redis.owner'] = 'foreign'),
  ],
  [
    'container',
    (row) => (row.Config.Labels['nina.pharmacy-redis.run'] = 'foreign'),
  ],
  ['network', (row) => (row.Id = 'd'.repeat(64))],
  ['network', (row) => (row.Name = 'foreign')],
  ['network', (row) => (row.Labels['nina.pharmacy-redis.owner'] = 'foreign')],
  ['network', (row) => (row.Labels['nina.pharmacy-redis.run'] = 'foreign')],
])
  test(`rejects foreign ${kind} identity mutation ${mutate.toString()}`, (t) => {
    const f = resourceFixture(t);
    mutate(f.rows[kind]);
    assert.throws(
      () => ownedResourceId(f.context, kind, f.rows[kind], f[kind + 'Id']),
      /ownership/,
    );
  });

test('rejects invalid resource context without creating credentials', (t) => {
  const f = resourceFixture(t);
  for (const input of [
    { runId: 'bad', imageId: f.context.imageId, root: f.root },
    { runId: f.context.runId, imageId: 'bad', root: f.root },
    { runId: f.context.runId, imageId: f.context.imageId, root: '/missing' },
  ])
    assert.throws(() => createResourceContext(input));
});

for (const error of [
  { status: 1, stderr: 'permission denied' },
  { status: 1, stderr: 'Cannot connect to the Docker daemon' },
  { status: 1, stderr: 'Error: No such object: foreign' },
  { status: 2, stderr: 'Error: No such object: ' + 'b'.repeat(64) },
])
  test(`inspection error is not absence: ${error.stderr}`, () => {
    assert.equal(isResourceAbsent(error, 'container', 'b'.repeat(64)), false);
  });

for (const kind of ['container', 'network'])
  test(`recognizes only exact-target ${kind} absence`, () => {
    const target = 'b'.repeat(64);
    const stderr =
      kind === 'container'
        ? `Error: No such object: ${target}`
        : `Error response from daemon: network ${target} not found`;
    assert.equal(isResourceAbsent({ status: 1, stderr }, kind, target), true);
    assert.equal(isResourceAbsent({ status: 1, stderr }, kind, 'other'), false);
  });
