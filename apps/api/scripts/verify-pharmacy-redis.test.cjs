const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  loadRunner: load,
} = require('./pharmacy-redis-runner-test-fixture.cjs');
const source = path.join(__dirname, 'verify-pharmacy-redis.cjs');
const imageId =
  'sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';

test('cleanup failure prevents suite PASS and retains private recovery files', async (t) => {
  const f = load(t, { cleanupFailure: true });
  await assert.rejects(f.api.main(['--isolated']), /cleanup/);
  assert.ok(f.output.every((line) => !line.includes('SUITE_PASSED')));
  assert.deepEqual(fs.readdirSync(f.root).sort(), [
    'redis-proof.json',
    'redis.conf',
  ]);
  assert.ok(!f.output.join('\n').includes(new URL(f.config.redisUrl).password));
});

test('success uses strict owned fixture arguments and emits PASS only after cleanup', async (t) => {
  const f = load(t);
  await f.api.main(['--isolated']);
  assert.equal(fs.existsSync(f.root), false);
  assert.equal(f.events.at(-1), 'cleanup');
  assert.ok(f.output[0].startsWith('PHARMACY_REDIS_CLEANUP_ASSERTED'));
  assert.ok(f.output[1].startsWith('PHARMACY_REDIS_SUITE_PASSED'));
  assert.equal(
    f.events.indexOf('capture-network') + 1,
    f.events.indexOf('network'),
  );
  assert.equal(
    f.events.indexOf('capture-container') + 1,
    f.events.indexOf('create'),
  );
  assert.ok(f.events.indexOf('guard') < f.events.indexOf('adapter'));
  assert.ok(f.clients.every((client) => client.destroyed));
  const create = f.calls.find(
    (call) => call.args.includes('create') && !call.args.includes('network'),
  );
  const tokens = create.args.slice(2);
  assert.deepEqual(tokens, [
    'create',
    '--pull=never',
    '--name',
    f.config.proof.networkName,
    '--network',
    f.config.proof.networkName,
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
    `${f.config.configFile}:/run/nina-redis.conf:ro`,
    '--publish',
    '127.0.0.1:49152:6379',
    '--label',
    'nina.pharmacy-redis.owner=nina-suite',
    '--label',
    `nina.pharmacy-redis.run=${f.config.proof.runId}`,
    'redis:7-alpine',
    'redis-server',
    '/run/nina-redis.conf',
  ]);
  const password = new URL(f.config.redisUrl).password;
  for (const call of f.calls) {
    assert.deepEqual(Object.keys(call.settings.env).sort(), ['HOME', 'PATH']);
    assert.equal(call.settings.env.HOME, f.root);
    assert.equal(call.settings.env.PATH, '/usr/bin:/bin');
    assert.ok(
      !JSON.stringify([call.args, call.settings.env, f.output]).includes(
        password,
      ),
    );
    assert.ok(call.settings.timeout > 0 && call.settings.timeout <= 60000);
    assert.ok(call.settings.signal);
    if (call.command === '/usr/bin/docker')
      assert.deepEqual(call.args.slice(0, 2), [
        '--host',
        'unix:///var/run/docker.sock',
      ]);
  }
  assert.equal(f.processDouble.listenerCount('SIGINT'), 0);
  assert.equal(f.processDouble.listenerCount('SIGTERM'), 0);
});

for (const args of [[], ['--isolated', 'extra'], ['--url=redis://foreign']])
  test(`rejects non-opted-in arguments before resources: ${JSON.stringify(args)}`, async (t) => {
    const f = load(t);
    await assert.rejects(f.api.main(args), /opt-in/);
    assert.equal(f.root, undefined);
    assert.equal(f.calls.length, 0);
  });

test('privileged runner rejects before allocating private files or commands', async (t) => {
  const f = load(t);
  f.processDouble.getuid = () => 0;
  await assert.rejects(f.api.main(['--isolated']), /Unprivileged/);
  assert.equal(f.root, undefined);
  assert.equal(f.calls.length, 0);
});

test('CLI rejects absent opt-in with only a generic failure', () => {
  const result = spawnSync(process.execPath, [source], {
    env: { PATH: '/usr/bin:/bin' },
    timeout: 5000,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'PHARMACY_REDIS_SUITE_FAILED');
});

for (const options of [
  { fail: 'image' },
  { image: 'sha256:' + 'd'.repeat(64) },
])
  test(`missing or changed cached image fails without creation: ${JSON.stringify(options)}`, async (t) => {
    const f = load(t, options);
    await assert.rejects(f.api.main(['--isolated']), /verification/);
    assert.equal(f.calls.length, 1);
    assert.equal(fs.existsSync(f.root), false);
    assert.equal(f.clients.length, 0);
  });

for (const fail of ['network', 'create', 'start', 'inspect', 'child'])
  test(`failed ${fail} operation settles before cleanup and cannot PASS`, async (t) => {
    const f = load(t, { fail });
    await assert.rejects(f.api.main(['--isolated']), /verification/);
    assert.equal(f.events.at(-1), 'cleanup');
    assert.equal(fs.existsSync(f.root), false);
    assert.ok(f.output.every((line) => !line.includes('SUITE_PASSED')));
  });

for (const options of [
  { createOutput: 'malformed' },
  { observation: '[]' },
  { guardFailure: true },
])
  test(`invalid startup fails before adapter load: ${JSON.stringify(options)}`, async (t) => {
    const f = load(t, options);
    await assert.rejects(f.api.main(['--isolated']), /verification/);
    assert.ok(!f.events.includes('adapter'));
    assert.equal(f.events.at(-1), 'cleanup');
  });

test('bounded readiness failure closes its client and never launches child', async (t) => {
  const f = load(t, { readinessFailure: true });
  await assert.rejects(f.api.main(['--isolated']), /verification/);
  assert.equal(f.clients.length, 1);
  assert.ok(f.clients.every((client) => client.destroyed));
  assert.ok(!f.events.includes('child'));
  assert.equal(f.events.at(-1), 'cleanup');
});

for (const failure of ['canonicalFailure', 'adapterFailure', 'factoryFailure'])
  test(`readiness ${failure} cleans owned resources without launching child`, async (t) => {
    const f = load(t, { [failure]: true });
    await assert.rejects(f.api.main(['--isolated']), /verification/);
    assert.equal(f.clients.length, 0);
    assert.ok(!f.events.includes('child'));
    assert.equal(f.events.at(-1), 'cleanup');
    assert.equal(fs.existsSync(f.root), false);
  });

for (const cancel of ['create', 'readiness', 'child'])
  test(`cancellation during ${cancel} settles and independently cleans up`, async (t) => {
    const f = load(t, { cancel });
    await assert.rejects(f.api.main(['--isolated']));
    assert.equal(f.events.at(-1), 'cleanup');
    assert.ok(f.clients.every((client) => client.destroyed));
    assert.equal(fs.existsSync(f.root), false);
    assert.equal(f.processDouble.exitCode, cancel === 'readiness' ? 143 : 130);
    assert.ok(f.output.every((line) => !line.includes('SUITE_PASSED')));
  });

test('child must return its exact scenario completion marker', async (t) => {
  const f = load(t, { childOutput: 'not a completed proof' });
  await assert.rejects(f.api.main(['--isolated']), /verification/);
  assert.equal(f.events.at(-1), 'cleanup');
});
