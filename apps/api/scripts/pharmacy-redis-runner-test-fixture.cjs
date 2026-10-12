const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const shared = require('./verify-odontogram-postgres.cjs');
const resources = require('./pharmacy-redis-resources.cjs');
const { readRedisProof } = require('./verify-pharmacy-redis-proof.cjs');
const imageId =
  'sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';
const containerId = 'b'.repeat(64);
const networkId = 'c'.repeat(64);

// VM dependency doubles exercise orchestration, never Docker/Redis authority.
function load(t, options, fixtureOnly) {
  const source = path.join(
    __dirname,
    fixtureOnly
      ? 'pharmacy-redis-runner-fixture.cjs'
      : 'verify-pharmacy-redis.cjs',
  );
  const output = [];
  const calls = [];
  const events = [];
  const clients = [];
  const processDouble = Object.assign(new EventEmitter(), {
    getuid: process.getuid,
    getgid: process.getgid,
    execPath: process.execPath,
    argv: [],
  });
  let root;
  let config;
  let guarded = false;
  let pending = 0;
  let now = 0;
  const execute = async (command, args, settings) => {
    settings.guard?.();
    calls.push({ command, args: [...args], settings });
    const docker = command === '/usr/bin/docker';
    const tokens = docker ? args.slice(2) : args;
    const stage = !docker
      ? 'child'
      : tokens[0] === 'network'
        ? 'network'
        : tokens[0];
    events.push(stage);
    pending++;
    try {
      if (options.cancel === stage)
        processDouble.emit(options.signal ?? 'SIGINT');
      if (options.fail === stage) throw Error('synthetic private failure');
      if (stage === 'image') return options.image ?? imageId;
      if (stage === 'network' && tokens[1] === 'create') return networkId;
      if (stage === 'create') return options.createOutput ?? containerId;
      if (stage === 'start') return containerId;
      if (tokens.includes('inspect'))
        return options.observation ?? JSON.stringify([{ Id: tokens.at(-1) }]);
      assert.equal(stage, 'child');
      assert.ok(guarded);
      return (
        options.childOutput ??
        'PHARMACY_REDIS_SCENARIOS_PASSED redis_major=7 lease_ms=10000'
      );
    } finally {
      pending--;
      settings.guard?.();
    }
  };
  const module = { exports: {} };
  const context = {
    module,
    __dirname,
    process: processDouble,
    setTimeout,
    clearTimeout,
    console: {
      log: (line) => output.push(line),
      error: (line) => output.push(line),
    },
    require: (id) => {
      if (id === 'node:fs')
        return {
          ...fs,
          mkdtempSync: (prefix) => {
            root = fs.mkdtempSync(prefix);
            t.after(() => fs.rmSync(root, { recursive: true, force: true }));
            return root;
          },
          realpathSync: (file) =>
            file.endsWith('pharmacy-lock.service.js')
              ? options.canonicalFailure
                ? '/foreign/adapter.js'
                : file
              : fs.realpathSync(file),
        };
      if (id === 'node:crypto')
        return {
          ...require(id),
          randomInt: (min, max) => {
            assert.equal(min, 49152);
            assert.equal(max, 65536);
            return 49152;
          },
        };
      if (id === 'node:perf_hooks' && options.readinessFailure)
        return { performance: { now: () => (now += 16000) } };
      if (id === 'node:timers/promises') return { setTimeout: async () => {} };
      if (id === './pharmacy-redis-runner-fixture.cjs') {
        const fixtureModule = { exports: {} };
        vm.runInNewContext(
          fs.readFileSync(
            path.join(__dirname, 'pharmacy-redis-runner-fixture.cjs'),
            'utf8',
          ),
          { ...context, module: fixtureModule },
        );
        return fixtureModule.exports;
      }
      if (id === './verify-odontogram-postgres.cjs')
        return { ...shared, run: execute };
      if (id === './pharmacy-redis-resources.cjs')
        return {
          createResourceTracker: resources.createResourceTracker,
          captureCreation: async (tracker, kind, create) => {
            events.push(`capture-${kind}`);
            return resources.captureCreation(tracker, kind, create);
          },
          reconcileResources: async (tracker, settings) => {
            events.push('cleanup');
            assert.equal(pending, 0);
            assert.equal(settings.timeoutMs, 30000);
            assert.equal(settings.signal, undefined);
            assert.ok(tracker);
            if (options.cleanupFailure) throw Error('fixture cleanup failed');
          },
        };
      if (id === './verify-pharmacy-redis-runtime.cjs')
        return {
          validateRedisProof: (input, rows) => {
            events.push('guard');
            config = readRedisProof(input);
            assert.equal(rows.container.Id, containerId);
            assert.equal(rows.network.Id, networkId);
            assert.equal(fs.statSync(root).mode & 0o777, 0o700);
            for (const file of [config.configFile, input.proofFile])
              assert.equal(fs.statSync(file).mode & 0o777, 0o600);
            if (options.guardFailure) throw Error('fixture guard rejected');
            guarded = true;
            return config;
          },
        };
      if (path.isAbsolute(id) && id.endsWith('pharmacy-lock.service.js')) {
        events.push('adapter');
        assert.ok(guarded);
        if (options.adapterFailure) throw Error('fixture adapter failed');
        return {
          createPharmacyRedis: (url) => {
            if (options.factoryFailure) throw Error('fixture factory failed');
            assert.ok(url === config.redisUrl);
            const client = {
              isOpen: false,
              destroyed: false,
              connect: async () => {
                client.isOpen = true;
                if (options.cancel === 'readiness')
                  processDouble.emit('SIGTERM');
                if (options.readinessFailure)
                  throw Error('fixture connection failed');
              },
              withCommandOptions: (settings) => {
                assert.equal(settings.timeout, 1500);
                return { ping: async () => 'PONG' };
              },
              destroy: () => {
                client.destroyed = true;
                client.isOpen = false;
              },
            };
            clients.push(client);
            return client;
          },
        };
      }
      return require(id);
    },
  };
  vm.runInNewContext(fs.readFileSync(source, 'utf8'), context);
  return {
    api: module.exports,
    output,
    calls,
    events,
    clients,
    processDouble,
    get root() {
      return root;
    },
    get config() {
      return config;
    },
  };
}

module.exports = {
  loadRunner: (t, options = {}) => load(t, options, false),
  loadFixture: (t, options = {}) => load(t, options, true),
};
