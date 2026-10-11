const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { privateRedisFixture } = require('./pharmacy-redis-test-fixture.cjs');
const source = path.join(__dirname, 'verify-pharmacy-redis-scenarios.cjs');

function load(state) {
  const module = { exports: {} };
  const required = (id) => {
    if (path.isAbsolute(id)) {
      state.loads++;
      return state.adapter ?? {};
    }
    if (id === './verify-odontogram-postgres.cjs')
      return {
        dockerArgs: (args) => [
          '--host',
          'unix:///var/run/docker.sock',
          ...args,
        ],
        run: async (...args) => {
          state.calls.push(args);
          return (
            state.output ??
            JSON.stringify([
              state.calls.length === 1
                ? (state.observations?.container ?? {})
                : (state.observations?.network ?? {}),
            ])
          );
        },
      };
    if (id === './verify-pharmacy-redis-lease.cjs')
      return {
        verifyLease: async (context) => {
          assert.equal(context.client, state.clients[0]);
          assert.equal(context.first.client, state.clients[0]);
          assert.equal(context.second.client, state.clients[1]);
          assert.equal(context.key, `pharmacy:prescription:${state.runId}`);
          state.leaseCalls++;
          state.clients.forEach((client) => {
            client.isOpen = true;
          });
          if (state.fault === 'scenario') throw Error('fixture scenario');
        },
      };
    if (id === 'node:fs')
      return {
        ...fs,
        realpathSync: (file) =>
          state.noncanonical ? file + '.other' : fs.realpathSync(file),
      };
    return require(id);
  };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), {
    require: required,
    module,
    __dirname,
    process,
    console: { log: (line) => (state.summary = line) },
    URL,
  });
  return module.exports;
}

test('actual inspection identity must reject before loading the compiled adapter', async (t) => {
  const f = privateRedisFixture(t);
  const state = { loads: 0, calls: [] };
  await assert.rejects(
    load(state).main(f.input),
    /Redis container identity mismatch/,
  );
  assert.equal(state.loads, 0);
});

function observations(f) {
  const name = f.proof.networkName;
  const labels = {
    'nina.pharmacy-redis.owner': 'nina-suite',
    'nina.pharmacy-redis.run': f.proof.runId,
  };
  const ports = {
    '6379/tcp': [{ HostIp: '127.0.0.1', HostPort: String(f.proof.port) }],
  };
  return {
    container: {
      Id: f.proof.containerId,
      Image: f.proof.imageId,
      Name: '/' + name,
      State: { Status: 'running' },
      Config: {
        Image: f.proof.image,
        User: `${process.getuid()}:${process.getgid()}`,
        Labels: labels,
        Cmd: ['redis-server', '/run/nina-redis.conf'],
        Entrypoint: ['docker-entrypoint.sh'],
        Env: [],
      },
      HostConfig: {
        NetworkMode: name,
        ReadonlyRootfs: true,
        Privileged: false,
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        Binds: [`${f.configFile}:/run/nina-redis.conf:ro`],
        Tmpfs: {
          '/data': `rw,noexec,nosuid,size=16m,uid=${process.getuid()},gid=${process.getgid()}`,
        },
        PortBindings: ports,
      },
      Mounts: [
        {
          Type: 'bind',
          Source: f.configFile,
          Destination: '/run/nina-redis.conf',
          RW: false,
        },
      ],
      NetworkSettings: {
        Ports: ports,
        Networks: { [name]: { NetworkID: f.proof.networkId } },
      },
    },
    network: {
      Id: f.proof.networkId,
      Name: name,
      Driver: 'bridge',
      Internal: false,
      Labels: labels,
      Containers: { [f.proof.containerId]: {} },
    },
  };
}

// VM doubles validate binding/cleanup, not Redis behavior.
function scenario(t, fault) {
  const f = privateRedisFixture(t);
  const state = {
    loads: 0,
    calls: [],
    clients: [],
    observations: observations(f),
    runId: f.proof.runId,
    leaseCalls: 0,
    fault,
  };
  state.adapter = {
    createPharmacyRedis(url) {
      assert.equal(url, f.proof.redisUrl);
      if (fault === 'factory' && state.clients.length === 1)
        throw Error('fixture factory');
      const client = {
        isOpen: false,
        destroy() {
          this.isOpen = false;
          this.destroyed = true;
        },
      };
      state.clients.push(client);
      return client;
    },
    PharmacyLockService: class {
      constructor(client) {
        this.client = client;
        if (fault === 'constructor') throw Error('fixture constructor');
      }
      onModuleDestroy() {
        if (fault === 'cleanup') throw Error('fixture cleanup');
        if (this.client.isOpen) this.client.destroy();
      }
    },
  };
  return { f, state, main: load(state).main };
}

test('valid guarded scenario uses exact inspections and cleans both clients', async (t) => {
  const { f, state, main } = scenario(t);
  await main(f.input);
  assert.equal(state.loads, 1);
  assert.equal(state.calls.length, 2);
  for (const [index, [command, args, options]] of state.calls.entries()) {
    assert.equal(command, '/usr/bin/docker');
    assert.equal(
      JSON.stringify(args),
      JSON.stringify([
        '--host',
        'unix:///var/run/docker.sock',
        ...(index
          ? ['network', 'inspect', f.proof.networkId]
          : ['inspect', f.proof.containerId]),
      ]),
    );
    assert.equal(
      JSON.stringify(options.env),
      JSON.stringify({ PATH: '/usr/bin:/bin', HOME: f.root }),
    );
    assert.equal(options.timeout, 5000);
    assert.ok(
      options.redactions.includes(f.password) &&
        options.redactions.includes(f.proof.redisUrl),
    );
  }
  assert.equal(state.leaseCalls, 1);
  assert.ok(
    state.clients.every((client) => !client.isOpen && client.destroyed),
  );
  assert.equal(
    state.summary,
    'PHARMACY_REDIS_SCENARIOS_PASSED redis_major=7 lease_ms=10000',
  );
});

for (const [fault, message] of [
  ['factory', /fixture factory/],
  ['constructor', /fixture constructor/],
  ['cleanup', /Owned client cleanup/],
  ['scenario', /fixture scenario/],
])
  test(`rejects ${fault} and closes every opened client`, async (t) => {
    const { f, state, main } = scenario(t, fault);
    await assert.rejects(main(f.input), message);
    assert.ok(state.clients.every((client) => !client.isOpen));
    if (fault === 'scenario' || fault === 'cleanup')
      assert.ok(state.clients.every((client) => client.destroyed));
    assert.equal(state.summary, undefined);
  });

for (const kind of [
  'private',
  'network',
  'noncanonical',
  'multiple',
  'invalid-json',
])
  test(`rejects ${kind} before adapter load`, async (t) => {
    const { f, state, main } = scenario(t);
    if (kind === 'private') f.input.runId = 'invalid';
    if (kind === 'network') state.observations.network.Id = 'unrelated';
    if (kind === 'noncanonical') state.noncanonical = true;
    if (kind === 'multiple') state.output = '[{},{}]';
    if (kind === 'invalid-json') state.output = 'not-json';
    await assert.rejects(main(f.input));
    assert.equal(state.loads, 0);
    assert.equal(state.clients.length, 0);
    if (kind === 'private') assert.equal(state.calls.length, 0);
  });

test('CLI requires exact explicit arguments and emits only generic failure', () => {
  const state = { loads: 0, calls: [] };
  const { parseArguments } = load(state);
  assert.equal(
    JSON.stringify(parseArguments(['--run-id=uuid', '--proof-file=/private'])),
    JSON.stringify({ runId: 'uuid', proofFile: '/private' }),
  );
  for (const args of [
    [],
    ['--run-id=x'],
    ['--proof-file=x', '--run-id=y'],
    ['--run-id=x', '--proof-file=y', '--extra'],
  ])
    assert.throws(() => parseArguments(args));
  const result = spawnSync(
    process.execPath,
    [source, '--unknown=private-value'],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'PHARMACY_REDIS_SCENARIOS_FAILED');
});
