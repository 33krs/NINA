const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  readRedisProof,
  redisConfiguration,
} = require('./verify-pharmacy-redis-proof.cjs');
const { privateRedisFixture } = require('./pharmacy-redis-test-fixture.cjs');

function fixture(t) {
  const data = privateRedisFixture(t);
  return { ...data, validate: () => readRedisProof(data.input) };
}

test('accepts a canonical private proof and returns immutable explicit configuration without loading Redis', (t) => {
  const f = fixture(t);
  const result = f.validate();
  assert.equal(result.redisUrl, f.proof.redisUrl);
  assert.equal(result.configFile, f.configFile);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.proof));
  assert.ok(
    !require.cache[
      require.resolve('redis', { paths: [path.resolve(__dirname, '..')] })
    ],
  );
});

for (const [field, value] of [
  ['runId', 'wrong-run'],
  ['suite', 'other'],
  ['owner', 'other'],
  ['image', 'redis:latest'],
  ['imageId', 'not-an-image-id'],
  ['containerId', 'short'],
  ['networkId', 'short'],
  ['networkName', 'other'],
  ['port', 0],
  ['port', 65536],
  ['port', 1.5],
  ['port', '49152'],
  ['redisUrl', 'redis://:short@127.0.0.1:49152/0'],
  ['redisUrl', 'redis://:secret@localhost:49152/0'],
])
  test(`rejects malformed proof field ${field}: ${String(value)}`, (t) => {
    const f = fixture(t);
    f.proof[field] = value;
    f.write();
    assert.throws(f.validate);
  });

for (const [name, mutate] of [
  ['root permissions', (f) => fs.chmodSync(f.root, 0o755)],
  ['proof permissions', (f) => fs.chmodSync(f.proofFile, 0o644)],
  ['config permissions', (f) => fs.chmodSync(f.configFile, 0o644)],
  [
    'proof symlink',
    (f) => {
      fs.renameSync(f.proofFile, f.proofFile + '.original');
      fs.symlinkSync(f.proofFile + '.original', f.proofFile);
    },
  ],
  [
    'config symlink',
    (f) => {
      fs.renameSync(f.configFile, f.configFile + '.original');
      fs.symlinkSync(f.configFile + '.original', f.configFile);
    },
  ],
  [
    'environment file',
    (f) => fs.writeFileSync(path.join(f.root, '.env'), 'dummy'),
  ],
  [
    'invalid JSON',
    (f) => fs.writeFileSync(f.proofFile, 'private malformed content'),
  ],
  ['missing config', (f) => fs.unlinkSync(f.configFile)],
  [
    'changed authentication',
    (f) => fs.writeFileSync(f.configFile, redisConfiguration('f'.repeat(64))),
  ],
  [
    'enabled persistence',
    (f) => fs.appendFileSync(f.configFile, 'appendonly yes\n'),
  ],
])
  test(`rejects unsafe private file: ${name}`, (t) => {
    const f = fixture(t);
    mutate(f);
    assert.throws(f.validate);
  });

test('rejects URL variations and never includes rejected credentials in diagnostics', (t) => {
  const f = fixture(t);
  for (const url of [
    f.proof.redisUrl + '?x=1',
    f.proof.redisUrl.replace('/0', '/1'),
    f.proof.redisUrl.replace('127.0.0.1', 'localhost'),
    f.proof.redisUrl.replace('redis:', 'rediss:'),
  ]) {
    f.proof.redisUrl = url;
    f.write();
    assert.throws(f.validate, (error) => !error.message.includes(f.password));
  }
});

for (const file of ['root', 'proofFile', 'configFile']) {
  test(`rejects non-owned private ${file} without changing filesystem ownership`, (t) => {
    const f = fixture(t);
    const original = fs.lstatSync;
    t.mock.method(fs, 'lstatSync', (...args) => {
      const stats = original(...args);
      if (args[0] === f[file]) stats.uid = process.getuid() + 1;
      return stats;
    });
    assert.throws(f.validate, /Private Redis proof paths/);
  });
}

test('rejects a symlinked private root', (t) => {
  const f = fixture(t);
  const alias = f.root + '-alias';
  fs.symlinkSync(f.root, alias);
  t.after(() => fs.unlinkSync(alias));
  f.input.proofFile = path.join(alias, 'redis-proof.json');
  assert.throws(f.validate, /Private Redis proof paths/);
});

test('rejects noncanonical and unexpected proof paths and missing run binding', (t) => {
  const f = fixture(t);
  for (const proofFile of [
    undefined,
    'relative',
    path.join(f.root, 'other.json'),
    f.root + '/../' + path.basename(f.root) + '/redis-proof.json',
  ]) {
    assert.throws(() => readRedisProof({ runId: f.input.runId, proofFile }));
  }
  assert.throws(() => readRedisProof({ proofFile: f.proofFile }));
});

test('pins complete configuration bytes rather than accepting appended directives', (t) => {
  const f = fixture(t);
  assert.equal(
    redisConfiguration(f.password),
    [
      'bind 0.0.0.0',
      'port 6379',
      'protected-mode yes',
      'daemonize no',
      'save ""',
      'appendonly no',
      'dir /data',
      'logfile ""',
      `requirepass ${f.password}`,
      '',
    ].join('\n'),
  );
  fs.appendFileSync(f.configFile, 'requirepass other\n');
  assert.throws(f.validate, (error) => !error.message.includes(f.password));
});

test('refuses a root-owned runtime rather than blessing an elevated Redis client', (t) => {
  const f = fixture(t);
  t.mock.method(process, 'getuid', () => 0);
  assert.throws(f.validate, /Unprivileged Unix ownership checks required/);
});
