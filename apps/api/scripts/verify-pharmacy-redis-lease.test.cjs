const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const key = 'pharmacy:prescription:synthetic-owned-fixture';

function load(state) {
  const module = { exports: {} };
  const required = (id) => {
    if (id === 'node:perf_hooks')
      return { performance: { now: () => state.now } };
    if (id === 'node:timers/promises')
      return {
        setTimeout: async (ms) => {
          state.now += ms;
        },
      };
    return require(id);
  };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, 'verify-pharmacy-redis-lease.cjs'),
      'utf8',
    ),
    { require: required, module },
  );
  return module.exports;
}

// VM dependency doubles exercise assertions and ordering, never live Redis proof.
function scenario(fault) {
  const state = {
    now: 0,
    clients: [],
  };
  const diagnostics = [];
  const adapter = {
    createClientDouble() {
      const client = {
        isOpen: false,
        async connect() {
          this.isOpen = true;
          this.everOpened = true;
          if (fault === 'connect') throw Error('fixture connect');
        },
        withCommandOptions(options) {
          assert.equal(options.timeout, 1500);
          return this;
        },
        async info(section) {
          assert.equal(section, 'server');
          return `redis_version:${fault === 'version' ? '8.0.0' : '7.4.1'}\r\n`;
        },
        async get() {
          if (state.now >= state.expires && fault !== 'immortal')
            state.owner = null;
          return state.owner ?? null;
        },
        async pTTL() {
          return (await this.get()) === null
            ? -2
            : fault === 'short'
              ? 1000
              : Math.max(0, state.expires - state.now);
        },
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
      }
      async acquire(key, owner) {
        assert.equal(key, key);
        if (!this.client.isOpen) await this.client.connect();
        if (state.owner) return fault === 'busy';
        state.owner = owner;
        state.acquisitions = (state.acquisitions ?? 0) + 1;
        state.expires =
          state.now +
          (fault === 'early-expiry' && state.acquisitions === 2 ? 1000 : 10000);
        return true;
      }
      async release(key, owner) {
        if (fault === 'release' || (fault === 'stale' && state.now >= 10000))
          return (state.owner = null);
        if (state.owner === owner && fault !== 'no-release') state.owner = null;
      }
      onModuleDestroy() {
        this.client.destroy();
      }
    },
  };
  const clients = [adapter.createClientDouble(), adapter.createClientDouble()];
  const services = clients.map(
    (client) => new adapter.PharmacyLockService(client),
  );
  const main = async () => {
    try {
      await load(state).verifyLease({
        client: clients[0],
        first: services[0],
        second: services[1],
        key,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
    } finally {
      clients.forEach((client) => {
        if (client.isOpen) client.destroy();
      });
    }
  };
  return { state, main, diagnostics };
}

test('lease assertions observe production expiry and owner-safe successor release', async () => {
  const { state, main } = scenario();
  await main();
  assert.equal(state.now, 10000);
  assert.equal(state.owner, null);
  assert.ok(
    state.clients.every((client) => !client.isOpen && client.destroyed),
  );
});

for (const [fault, message] of [
  ['version', /Redis 7 required/],
  ['short', /ten-second lease/],
  ['busy', /false/],
  ['release', /Wrong owner/],
  ['no-release', /Owner release/],
  ['stale', /Stale owner/],
  ['early-expiry', /Natural expiry before production lease/],
  ['immortal', /deadline/],
  ['connect', /fixture connect/],
])
  test(`rejects ${fault} and cleans every created client`, async () => {
    const { state, main } = scenario(fault);
    await assert.rejects(main(), message);
    assert.ok(
      state.clients.every(
        (client) => !client.isOpen && (client.destroyed || !client.everOpened),
      ),
    );
  });

for (const [fault, diagnostic] of [
  [
    'version',
    {
      checkpoint: 'redis_version',
      category: 'assertion_failed',
      actual: 'other_version',
      expected: 'redis7',
    },
  ],
  [
    'short',
    {
      checkpoint: 'first_lease_ttl',
      category: 'assertion_failed',
      actual: 'ttl_below_min',
      expected: 'ttl_in_range',
    },
  ],
  [
    'busy',
    {
      checkpoint: 'competing_acquire',
      category: 'assertion_failed',
      actual: 'true',
      expected: 'false',
    },
  ],
  [
    'connect',
    {
      checkpoint: 'client_connect',
      category: 'operation_failed',
      actual: 'unavailable',
      expected: 'success',
    },
  ],
])
  test(`reports bounded safe lease diagnostic for ${fault}`, async () => {
    const { state, main, diagnostics } = scenario(fault);
    await assert.rejects(main());
    assert.equal(diagnostics.length, 1);
    assert.equal(
      JSON.stringify(diagnostics[0]),
      JSON.stringify({ phase: 'lease', ...diagnostic }),
    );
    assert.doesNotMatch(
      JSON.stringify(diagnostics),
      /synthetic-owned-fixture|fixture connect|pharmacy:prescription/,
    );
  });
