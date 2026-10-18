const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { readRedisProof } = require('./verify-pharmacy-redis-proof.cjs');
const { loadFixture } = require('./pharmacy-redis-runner-test-fixture.cjs');
const containerId = 'b'.repeat(64);
const networkId = 'c'.repeat(64);

function prepared(t) {
  const f = loadFixture(t);
  const fixture = f.api.createRedisFixture();
  return { f, fixture };
}

test('prepares private auth/proof without execution or client authority', (t) => {
  const { f, fixture } = prepared(t);
  assert.equal(fs.statSync(fixture.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(fixture.configFile).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(fixture.root), ['redis.conf']);
  const input = fixture.writeProof(containerId, networkId);
  const config = readRedisProof(input);
  assert.equal(fs.statSync(fixture.proofFile).mode & 0o777, 0o600);
  assert.equal(config.proof.imageId, f.api.IMAGE_ID);
  assert.equal(config.proof.port, 49152);
  assert.ok(fixture.redactions.includes(config.redisUrl));
  assert.deepEqual(Object.keys(fixture.environment).sort(), ['HOME', 'PATH']);
  assert.equal(f.calls.length, 0);
  assert.equal(f.clients.length, 0);
  fixture.dispose();
  assert.equal(fs.existsSync(fixture.root), false);
});

test('creation plans exactly bind owned identity/security with no argv credentials', (t) => {
  const { f, fixture } = prepared(t);
  assert.equal(
    JSON.stringify(fixture.networkArgs()),
    JSON.stringify([
      'network',
      'create',
      '--label',
      'nina.pharmacy-redis.owner=nina-suite',
      '--label',
      `nina.pharmacy-redis.run=${fixture.runId}`,
      fixture.name,
    ]),
  );
  const args = fixture.containerArgs();
  assert.equal(
    JSON.stringify(args),
    JSON.stringify([
      'create',
      '--pull=never',
      '--name',
      fixture.name,
      '--network',
      fixture.name,
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      `/data:rw,noexec,nosuid,size=16m,uid=${process.getuid()},gid=${process.getgid()}`,
      '--volume',
      `${fixture.configFile}:/run/nina-redis.conf:ro`,
      '--publish',
      '127.0.0.1:49152:6379',
      '--label',
      'nina.pharmacy-redis.owner=nina-suite',
      '--label',
      `nina.pharmacy-redis.run=${fixture.runId}`,
      f.api.IMAGE,
      'redis-server',
      '/run/nina-redis.conf',
    ]),
  );
  assert.ok(
    !JSON.stringify([args, fixture.environment]).includes(
      fixture.redactions[0],
    ),
  );
  args[0] = 'foreign';
  assert.equal(fixture.containerArgs()[0], 'create');
});

test('each prepared fixture gets fresh authentication and run identity', (t) => {
  const first = prepared(t).fixture;
  const second = prepared(t).fixture;
  assert.ok(first.runId !== second.runId);
  assert.ok(first.root !== second.root);
  assert.ok(first.redactions[0] !== second.redactions[0]);
});

for (const id of ['malformed', ''])
  test(`invalid proof IDs reject without writing: ${JSON.stringify(id)}`, (t) => {
    const { fixture } = prepared(t);
    assert.throws(() => fixture.writeProof(id, networkId), /resource IDs/);
    assert.throws(() => fixture.writeProof(containerId, id), /resource IDs/);
    assert.equal(fs.existsSync(fixture.proofFile), false);
  });

test('existing proof cannot be overwritten', (t) => {
  const { fixture } = prepared(t);
  fixture.writeProof(containerId, networkId);
  const original = fs.readFileSync(fixture.proofFile, 'utf8');
  assert.throws(() => fixture.writeProof('d'.repeat(64), networkId));
  assert.ok(fs.readFileSync(fixture.proofFile, 'utf8') === original);
});

test('private-file disposal never recursively removes unexpected entries', (t) => {
  const { fixture } = prepared(t);
  const unexpected = fixture.root + '/unrelated';
  fs.writeFileSync(unexpected, 'synthetic fixture');
  assert.throws(() => fixture.dispose());
  assert.equal(fs.existsSync(unexpected), true);
});

test('privileged fixture preparation rejects before filesystem allocation', (t) => {
  const f = loadFixture(t);
  f.processDouble.getuid = () => 0;
  assert.throws(() => f.api.createRedisFixture(), /Unprivileged/);
  assert.equal(f.root, undefined);
});
