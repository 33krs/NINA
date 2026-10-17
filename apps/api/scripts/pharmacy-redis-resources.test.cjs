const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  resourceFixture,
} = require('./pharmacy-redis-resource-test-fixture.cjs');
const source = path.join(__dirname, 'pharmacy-redis-resources.cjs');

function load(execute, clock) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    module,
    process,
    URL,
    require: (id) =>
      id === 'node:perf_hooks' && clock
        ? { performance: { now: clock } }
        : id === './verify-odontogram-postgres.cjs'
          ? {
              run: execute,
              dockerArgs: (args) => [
                '--host',
                'unix:///var/run/docker.sock',
                ...args,
              ],
              createPossiblyOwned: require('./verify-odontogram-postgres.cjs')
                .createPossiblyOwned,
            }
          : require(id),
  });
  return module.exports;
}

test('foreign recovered container must reject without removal', async (t) => {
  const f = resourceFixture(t);
  const calls = [];
  const api = load(async (...args) => {
    calls.push(args);
    return JSON.stringify([{ Id: f.containerId, Name: '/foreign' }]);
  });
  const tracker = api.createResourceTracker
    ? api.createResourceTracker({
        runId: f.context.runId,
        imageId: f.context.imageId,
        root: f.root,
      })
    : {};
  if (api.captureCreation)
    await assert.rejects(
      api.captureCreation(tracker, 'container', async () => {
        throw Error('lost create result');
      }),
    );
  await assert.rejects(api.reconcileResources(tracker), /ownership/);
  assert.ok(calls.every(([, args]) => !args.includes('rm')));
});

function fixture(t, options = {}) {
  const f = resourceFixture(t);
  const rows = f.rows;
  const calls = [];
  const api = load(async (command, rawArgs, config) => {
    calls.push({ command, rawArgs, config });
    const args = rawArgs.slice(2);
    const kind = args[0] === 'network' ? 'network' : 'container';
    const target = args.at(-1);
    if (args.includes('inspect')) {
      if (options.inspectError) throw options.inspectError;
      if (options.output !== undefined) return options.output;
      if (!rows[kind])
        throw Object.assign(Error('fixture absent'), {
          status: 1,
          stderr:
            kind === 'container'
              ? `Error: No such object: ${target}`
              : `Error response from daemon: network ${target} not found`,
        });
      return JSON.stringify([rows[kind]]);
    }
    assert.ok(args.includes('rm'));
    if (options.remove !== 'present') {
      delete rows[kind];
      if (kind === 'container' && rows.network)
        delete rows.network.Containers[f.containerId];
    }
    if (options.remove) throw Error('fixture remove failure');
    return target;
  });
  const tracker = api.createResourceTracker({
    runId: f.context.runId,
    imageId: f.context.imageId,
    root: f.root,
  });
  const capture = (kind, output = f[kind + 'Id']) =>
    api.captureCreation(tracker, kind, async () => output);
  return {
    ...f,
    api,
    tracker,
    rows,
    calls,
    capture,
    cleanup: (options) => api.reconcileResources(tracker, options),
  };
}

for (const status of ['created', 'exited'])
  test(`cleans ${status} container before its empty owned network`, async (t) => {
    const f = fixture(t);
    f.rows.container.State.Status = status;
    f.rows.network.Containers[f.containerId] = {};
    assert.equal(await f.capture('network'), f.networkId);
    assert.equal(await f.capture('container'), f.containerId);
    await f.cleanup();
    assert.equal(
      JSON.stringify(
        f.calls
          .filter((call) => call.rawArgs.includes('rm'))
          .map((call) => call.rawArgs.at(-1)),
      ),
      JSON.stringify([f.containerId, f.networkId]),
    );
    for (const { command, rawArgs, config } of f.calls) {
      assert.equal(command, '/usr/bin/docker');
      assert.equal(rawArgs[0], '--host');
      assert.equal(rawArgs[1], 'unix:///var/run/docker.sock');
      assert.equal(
        JSON.stringify(config.env),
        JSON.stringify({ PATH: '/usr/bin:/bin', HOME: f.root }),
      );
      assert.ok(config.timeout > 0 && config.timeout <= 5000);
      assert.equal(config.signal, undefined);
    }
    const count = f.calls.length;
    await f.cleanup();
    assert.equal(f.calls.length, count);
  });

test('cleans network-only creation without probing a container', async (t) => {
  const f = fixture(t);
  await f.capture('network');
  await f.cleanup();
  assert.ok(f.calls.every((call) => call.rawArgs[2] === 'network'));
});

for (const output of ['malformed-id', undefined])
  test(`recovers exact owned names after uncertain creation: ${output}`, async (t) => {
    const f = fixture(t);
    await assert.rejects(
      f.api.captureCreation(f.tracker, 'network', async () => {
        if (output === undefined) throw Error('cancelled create secret');
        return output;
      }),
      /Redis resource creation failed/,
    );
    await assert.rejects(
      f.api.captureCreation(f.tracker, 'container', async () => {
        throw Error('lost output');
      }),
    );
    await f.cleanup();
    assert.equal(f.calls[0].rawArgs.at(-1), f.context.name);
    assert.equal(f.calls[3].rawArgs.at(-1), f.context.name);
  });

test('creation settles before cleanup, and duplicate creation cannot overwrite identity', async (t) => {
  const f = fixture(t);
  await f.api.captureCreation(f.tracker, 'container', async () => {
    await assert.rejects(f.cleanup(), /must settle/);
    await assert.rejects(f.capture('container'), /already tracked/);
    return '\n' + f.containerId + '\n';
  });
  await assert.rejects(f.capture('container'), /already tracked/);
  assert.equal(f.calls.length, 0);
  await f.cleanup();
});

test('refuses a foreign network member without disconnecting it', async (t) => {
  const f = fixture(t);
  await f.capture('network');
  f.rows.network.Containers.foreign = {};
  await assert.rejects(f.cleanup(), /network still has members/);
  assert.equal(f.calls.length, 1);
});

for (const output of ['not-json', '[]', '[{},{}]'])
  test(`malformed inspection fails closed: ${output}`, async (t) => {
    const f = fixture(t, { output });
    await f.capture('container');
    await assert.rejects(f.cleanup(), /observation/);
    assert.equal(f.calls.length, 1);
  });

for (const value of [null, false, 0, ''])
  test(`invalid singleton row preserves tracked ownership: ${JSON.stringify(value)}`, async (t) => {
    const options = { output: JSON.stringify([value]) };
    const f = fixture(t, options);
    await f.capture('container');
    await assert.rejects(f.cleanup(), /observation/);
    assert.equal(f.calls.length, 1);
    delete options.output;
    await f.cleanup();
    assert.equal(f.rows.container, undefined);
    assert.equal(
      f.calls.filter((call) => call.rawArgs.includes('rm')).length,
      1,
    );
  });

for (const remove of ['absent', 'present'])
  test(`remove error requires actual absence: ${remove}`, async (t) => {
    const f = fixture(t, { remove });
    await f.capture('container');
    if (remove === 'absent') await f.cleanup();
    else await assert.rejects(f.cleanup(), /still present/);
    assert.equal(f.calls.length, 3);
  });

for (const kind of ['container', 'network'])
  test(`genuine missing ${kind} is clean without removal`, async (t) => {
    const f = fixture(t);
    await f.capture(kind);
    delete f.rows[kind];
    await f.cleanup();
    assert.equal(f.calls.length, 1);
  });

test('rejects invalid tracker/context/operation/deadline without executing Docker', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.api.reconcileResources({}));
  await assert.rejects(
    f.api.captureCreation(f.tracker, 'foreign', async () => 'x'),
  );
  for (const timeoutMs of [0, Infinity, 60001])
    await assert.rejects(f.cleanup({ timeoutMs }));
  assert.equal(f.calls.length, 0);
});

for (const kind of ['container', 'network'])
  test(`uncertain ${kind} creation with genuine absence leaves nothing to remove`, async (t) => {
    const f = fixture(t);
    delete f.rows[kind];
    await assert.rejects(
      f.api.captureCreation(f.tracker, kind, async () => {
        throw Error('aborted creation');
      }),
    );
    await f.cleanup();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].rawArgs.at(-1), f.context.name);
  });

test('owned container removal never permits deleting a network with a foreign member', async (t) => {
  const f = fixture(t);
  await f.capture('network');
  await f.capture('container');
  f.rows.network.Containers.foreign = {};
  await assert.rejects(f.cleanup(), /network still has members/);
  assert.equal(f.rows.container, undefined);
  assert.ok(f.rows.network.Containers.foreign);
  assert.equal(f.calls.filter((call) => call.rawArgs.includes('rm')).length, 1);
});

test('cleanup deadline bounds commands and never turns an expired budget into absence', async (t) => {
  const f = resourceFixture(t);
  let now = 0;
  const calls = [];
  const api = load(
    async (...args) => {
      calls.push(args);
      now = 100;
      return JSON.stringify([
        {
          Id: f.containerId,
          Name: '/' + f.context.name,
          Image: f.context.imageId,
          Config: {
            Image: 'redis:7-alpine',
            Labels: {
              'nina.pharmacy-redis.owner': 'nina-suite',
              'nina.pharmacy-redis.run': f.context.runId,
            },
          },
        },
      ]);
    },
    () => now,
  );
  const tracker = api.createResourceTracker({
    runId: f.context.runId,
    imageId: f.context.imageId,
    root: f.root,
  });
  await api.captureCreation(tracker, 'container', async () => f.containerId);
  await assert.rejects(
    api.reconcileResources(tracker, { timeoutMs: 50 }),
    /inspection failed/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].timeout, 50);
});
