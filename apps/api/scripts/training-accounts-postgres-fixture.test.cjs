const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { after, it } = require('node:test');
const sqlBuilder = require('./training-accounts-postgres-sql.cjs');
const recovery = require('./verify-training-accounts-postgres.cjs');

const API_ROOT = path.resolve(__dirname, '..');
const MIGRATION = path.join(
  API_ROOT,
  'prisma/migrations/20261012190000_add_training_accounts/migration.sql',
);
const HASHER = path.join(API_ROOT, 'dist/modules/auth/password-hash.js');
const source = fs.readFileSync(
  path.join(__dirname, 'training-accounts-postgres-fixture.cjs'),
  'utf8',
);
const roots = new Set();

after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function makeContext() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'training-fixture-test-'));
  roots.add(root);
  return recovery.createRecoveryContext({ temporaryDirectory: root });
}

function validSyntheticHash() {
  return `$nina$scrypt$v=1$N=131072,r=8,p=1$${crypto
    .randomBytes(16)
    .toString('base64url')}$${crypto.randomBytes(64).toString('base64url')}`;
}

function loadFixture({
  fsOverrides = {},
  hashPassword = async () => validSyntheticHash(),
  passwordHelper = { hashPassword },
  builder = sqlBuilder,
  recoveryApi = recovery,
  events,
} = {}) {
  const vmRuntime = {
    runInNewContext(source, context, options) {
      if (options?.filename === 'dist/modules/auth/password-hash.js') {
        events?.push('helper_load');
        context.module.exports = passwordHelper;
        context.exports = passwordHelper;
        return undefined;
      }
      return vm.runInNewContext(source, context, options);
    },
  };
  const fileSystem = new Proxy(fs, {
    get(target, key) {
      if (Object.hasOwn(fsOverrides, key)) return fsOverrides[key];
      if (key === 'openSync')
        return (filename, ...args) => {
          if (events && filename === MIGRATION) events.push('migration_read');
          if (events && filename === HASHER) events.push('helper_read');
          return target.openSync(filename, ...args);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const module = { exports: {} };
  const load = (specifier) => {
    if (specifier === 'node:fs') return fileSystem;
    if (specifier === 'node:path') return path;
    if (specifier === 'node:crypto') return crypto;
    if (specifier === 'node:vm') return vmRuntime;
    if (specifier === './training-accounts-postgres-sql.cjs') return builder;
    if (specifier === './verify-training-accounts-postgres.cjs')
      return recoveryApi;
    return require(specifier);
  };
  const processStub = new Proxy(process, {
    get(target, key) {
      if (key === 'env') throw new Error('Ambient environment access denied');
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const wrapper = vm.runInNewContext(
    `(function (require, module, exports, __filename, __dirname) { ${source}\n})`,
    {
      Buffer,
      process: processStub,
    },
    {
      filename: path.join(__dirname, 'training-accounts-postgres-fixture.cjs'),
    },
  );
  wrapper(
    load,
    module,
    module.exports,
    path.join(__dirname, 'training-accounts-postgres-fixture.cjs'),
    __dirname,
  );
  return module.exports;
}

function diagnostic(context) {
  return recovery.readRecoveryState(context).diagnostics.at(-1);
}

it('reads only the bounded canonical training-account migration', () => {
  const fixture = loadFixture();
  assert.equal(fixture.readTrainingAccountMigration.length, 0);
  assert.equal(
    fixture.readTrainingAccountMigration('/synthetic-untrusted-path'),
    fs.readFileSync(MIGRATION, 'utf8'),
  );

  const linkedFixture = loadFixture({
    fsOverrides: {
      lstatSync(target, ...args) {
        const stat = fs.lstatSync(target, ...args);
        if (target !== MIGRATION) return stat;
        return Object.assign(Object.create(stat), {
          isSymbolicLink: () => true,
        });
      },
    },
  });
  assert.throws(linkedFixture.readTrainingAccountMigration, {
    message: 'Training account fixture preparation failed',
  });
});

it('contains migration read failures behind the fixed failure message', () => {
  const fixture = loadFixture({
    fsOverrides: {
      realpathSync() {
        throw new Error('synthetic private filesystem detail');
      },
    },
  });
  assert.throws(fixture.readTrainingAccountMigration, {
    message: 'Training account fixture preparation failed',
  });
});

async function assertSafeFailure(promise, context, stage, marker) {
  await assert.rejects(promise, {
    message: 'Training account fixture preparation failed',
  });
  assert.equal(diagnostic(context).stage, stage);
  const persisted = JSON.stringify(recovery.readRecoveryState(context));
  assert.equal(persisted.includes(marker), false);
}

it('prepares bounded private artifacts and returns only frozen safe metadata', async () => {
  const context = makeContext();
  const seenPasswords = [];
  const events = [];
  const hash = validSyntheticHash();
  const recoveryApi = {
    ...recovery,
    writePrivateArtifact(current, kind, content) {
      events.push(kind);
      return recovery.writePrivateArtifact(current, kind, content);
    },
  };
  const builder = {
    buildTrainingAccountAssertions(input) {
      events.push('sql_build');
      assert.equal(input.runId, context.runId);
      assert.equal(input.passwordHash, hash);
      return sqlBuilder.buildTrainingAccountAssertions(input);
    },
  };
  const fixture = loadFixture({
    hashPassword: async (password) => {
      events.push('hash');
      seenPasswords.push(password);
      return hash;
    },
    builder,
    recoveryApi,
    events,
  });
  const result = await fixture.prepareTrainingAccountFixture(context, {
    migrationPath: `/synthetic-${crypto.randomUUID()}`,
  });

  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.artifacts));
  assert.ok(Object.isFrozen(result.assertions));
  assert.ok(Object.isFrozen(result.expectedRejections));
  assert.ok(result.assertions.includes('role_enum_values'));
  assert.equal(result.expectedRejections.length, 6);
  assert.match(result.database, /^[a-z][a-z0-9_]{2,30}$/);
  assert.match(result.username, /^[a-z][a-z0-9_]{2,30}$/);
  assert.equal(seenPasswords.length, 1);
  assert.ok(Buffer.byteLength(seenPasswords[0]) >= 24);
  assert.equal(JSON.stringify(result).includes(seenPasswords[0]), false);
  assert.deepEqual(Object.keys(result).sort(), [
    'artifacts',
    'assertions',
    'database',
    'databaseUser',
    'expectedRejections',
    'username',
  ]);

  const proof = fs.readFileSync(result.artifacts.proofSql, 'utf8');
  const environment = fs.readFileSync(result.artifacts.postgresEnv, 'utf8');
  const databasePassword = environment.match(/^POSTGRES_PASSWORD=(.+)$/m)?.[1];
  assert.ok(databasePassword);
  assert.notEqual(databasePassword, seenPasswords[0]);
  assert.ok(proof.includes('CREATE TYPE "UserRole"'));
  assert.ok(Buffer.byteLength(proof) <= 16 * 1024);
  for (const secret of [seenPasswords[0], databasePassword]) {
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(
      JSON.stringify(recovery.readRecoveryState(context)).includes(secret),
      false,
    );
  }
  assert.equal(JSON.stringify(result).includes(hash), false);
  assert.equal(
    JSON.stringify(recovery.readRecoveryState(context)).includes(hash),
    false,
  );
  assert.deepEqual(events, [
    'migration_read',
    'helper_read',
    'helper_load',
    'hash',
    'sql_build',
    'proof_sql',
    'postgres_env',
  ]);
  for (const filename of Object.values(result.artifacts)) {
    const stat = fs.lstatSync(filename);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o777, 0o600);
  }
});

it('rejects forged contexts and already-used artifact inventories before hashing', async () => {
  let hashes = 0;
  const fixture = loadFixture({
    hashPassword: async () => {
      hashes++;
      return validSyntheticHash();
    },
  });
  await assert.rejects(
    fixture.prepareTrainingAccountFixture({ runId: crypto.randomUUID() }),
    { message: 'Training account fixture preparation failed' },
  );

  const context = makeContext();
  recovery.writePrivateArtifact(context, 'proof_sql', 'synthetic marker');
  await assertSafeFailure(
    fixture.prepareTrainingAccountFixture(context),
    context,
    'fixture_source_read',
    'synthetic marker',
  );
  assert.equal(hashes, 0);
});

for (const [label, filename, alter, expectedStage] of [
  [
    'missing migration',
    MIGRATION,
    () => {
      throw Object.assign(new Error('private source'), { code: 'ENOENT' });
    },
    'fixture_source_read',
  ],
  [
    'linked migration',
    MIGRATION,
    (stat) =>
      Object.assign(Object.create(stat), { isSymbolicLink: () => true }),
    'fixture_source_read',
  ],
  [
    'oversized migration',
    MIGRATION,
    (stat) => Object.assign(Object.create(stat), { size: 32 * 1024 }),
    'fixture_source_read',
  ],
  [
    'missing compiled helper',
    HASHER,
    () => {
      throw Object.assign(new Error('private helper'), { code: 'ENOENT' });
    },
    'fixture_helper_load',
  ],
  [
    'linked compiled helper',
    HASHER,
    (stat) =>
      Object.assign(Object.create(stat), { isSymbolicLink: () => true }),
    'fixture_helper_load',
  ],
  [
    'oversized compiled helper',
    HASHER,
    (stat) => Object.assign(Object.create(stat), { size: 1024 * 1024 + 1 }),
    'fixture_helper_load',
  ],
]) {
  it(`rejects a ${label} without leaking its raw failure`, async () => {
    const context = makeContext();
    const originalLstat = fs.lstatSync.bind(fs);
    const fsOverrides = {
      lstatSync(target, ...args) {
        if (target === filename) {
          const stat = originalLstat(target, ...args);
          return alter(stat);
        }
        return originalLstat(target, ...args);
      },
    };
    const fixture = loadFixture({ fsOverrides });
    await assertSafeFailure(
      fixture.prepareTrainingAccountFixture(context),
      context,
      expectedStage,
      label.includes('missing') ? 'private' : 'never-present',
    );
    assert.deepEqual(recovery.readRecoveryState(context).artifacts, {
      proof_sql: null,
      postgres_env: null,
    });
  });
}

it('rejects a built helper without the required hash export', async () => {
  const context = makeContext();
  const fixture = loadFixture({ passwordHelper: {} });
  await assertSafeFailure(
    fixture.prepareTrainingAccountFixture(context),
    context,
    'fixture_helper_load',
    'hashPassword',
  );
});

it('rejects an oversized combined SQL artifact before writing either file', async () => {
  const context = makeContext();
  const metadata = sqlBuilder.buildTrainingAccountAssertions({
    passwordHash: validSyntheticHash(),
    runId: context.runId,
  });
  const fixture = loadFixture({
    builder: {
      buildTrainingAccountAssertions: () => ({
        sql: 'x'.repeat(16 * 1024),
        assertions: metadata.assertions,
        expectedRejections: metadata.expectedRejections,
      }),
    },
  });
  await assertSafeFailure(
    fixture.prepareTrainingAccountFixture(context),
    context,
    'fixture_sql_build',
    'xxxxxxxx',
  );
  assert.deepEqual(recovery.readRecoveryState(context).artifacts, {
    proof_sql: null,
    postgres_env: null,
  });
});

it('rejects altered assertion metadata before private artifact writes', async () => {
  const context = makeContext();
  const fixture = loadFixture({
    builder: {
      buildTrainingAccountAssertions: (input) => {
        const built = sqlBuilder.buildTrainingAccountAssertions(input);
        return {
          ...built,
          expectedRejections: built.expectedRejections.map((value, index) =>
            index === 0 ? { ...value, checkpoint: 'caller_override' } : value,
          ),
        };
      },
    },
  });
  await assertSafeFailure(
    fixture.prepareTrainingAccountFixture(context),
    context,
    'fixture_sql_build',
    'caller_override',
  );
  assert.deepEqual(recovery.readRecoveryState(context).artifacts, {
    proof_sql: null,
    postgres_env: null,
  });
});

it('contains raw hash and SQL-builder errors in fixed diagnostics', async () => {
  const hashContext = makeContext();
  const marker = `synthetic-${crypto.randomUUID()}`;
  const hostileError = {};
  Object.defineProperties(hostileError, {
    code: {
      get() {
        throw new Error(marker);
      },
    },
    stderr: {
      get() {
        return marker;
      },
    },
    message: {
      get() {
        throw new Error(marker);
      },
    },
  });
  await assertSafeFailure(
    loadFixture({
      hashPassword: async () => {
        throw hostileError;
      },
    }).prepareTrainingAccountFixture(hashContext),
    hashContext,
    'fixture_hash',
    marker,
  );

  const sqlContext = makeContext();
  await assertSafeFailure(
    loadFixture({
      builder: {
        buildTrainingAccountAssertions() {
          throw new Error(marker);
        },
      },
    }).prepareTrainingAccountFixture(sqlContext),
    sqlContext,
    'fixture_sql_build',
    marker,
  );
});

it('records cancellation before hashing and after an uninterruptible hash settles', async () => {
  const before = makeContext();
  const beforeAbort = new AbortController();
  beforeAbort.abort();
  let hashes = 0;
  const fixture = loadFixture({
    hashPassword: async () => {
      hashes++;
      return validSyntheticHash();
    },
  });
  await assertSafeFailure(
    fixture.prepareTrainingAccountFixture(before, {
      signal: beforeAbort.signal,
    }),
    before,
    'fixture_source_read',
    'AbortError',
  );
  assert.equal(hashes, 0);

  const after = makeContext();
  const duringAbort = new AbortController();
  const duringFixture = loadFixture({
    hashPassword: async () => {
      hashes++;
      duringAbort.abort();
      return validSyntheticHash();
    },
  });
  await assertSafeFailure(
    duringFixture.prepareTrainingAccountFixture(after, {
      signal: duringAbort.signal,
    }),
    after,
    'fixture_hash',
    'AbortError',
  );
  assert.equal(hashes, 1);
  assert.deepEqual(recovery.readRecoveryState(after).artifacts, {
    proof_sql: null,
    postgres_env: null,
  });
});

it('retains earlier proof evidence when writing the environment artifact fails', async () => {
  const context = makeContext();
  const recoveryApi = {
    ...recovery,
    writePrivateArtifact(current, kind, content) {
      if (kind === 'postgres_env')
        throw Object.assign(new Error('synthetic env write detail'), {
          code: 'EIO',
        });
      return recovery.writePrivateArtifact(current, kind, content);
    },
  };
  const fixture = loadFixture({ recoveryApi });
  await assertSafeFailure(
    fixture.prepareTrainingAccountFixture(context),
    context,
    'fixture_env_write',
    'synthetic env write detail',
  );
  assert.equal(fs.existsSync(path.join(context.root, 'proof.sql')), true);
  assert.equal(fs.existsSync(path.join(context.root, 'postgres.env')), false);
});

it('reports a private SQL write failure without exposing its content', async () => {
  const context = makeContext();
  const recoveryApi = {
    ...recovery,
    writePrivateArtifact() {
      throw Object.assign(new Error('synthetic SQL write detail'), {
        stderr: 'synthetic SQL write detail',
      });
    },
  };
  await assertSafeFailure(
    loadFixture({ recoveryApi }).prepareTrainingAccountFixture(context),
    context,
    'fixture_sql_write',
    'synthetic SQL write detail',
  );
  assert.equal(fs.existsSync(path.join(context.root, 'proof.sql')), false);
  assert.equal(fs.existsSync(path.join(context.root, 'postgres.env')), false);
});

it('generates distinct account and database credentials for every fixture', async () => {
  const first = makeContext();
  const second = makeContext();
  const accountPasswords = [];
  const fixture = loadFixture({
    hashPassword: async (password) => {
      accountPasswords.push(password);
      return validSyntheticHash();
    },
  });
  const firstResult = await fixture.prepareTrainingAccountFixture(first);
  const secondResult = await fixture.prepareTrainingAccountFixture(second);
  const firstDatabasePassword = fs
    .readFileSync(firstResult.artifacts.postgresEnv, 'utf8')
    .match(/^POSTGRES_PASSWORD=(.+)$/m)[1];
  const secondDatabasePassword = fs
    .readFileSync(secondResult.artifacts.postgresEnv, 'utf8')
    .match(/^POSTGRES_PASSWORD=(.+)$/m)[1];

  assert.notEqual(accountPasswords[0], accountPasswords[1]);
  assert.notEqual(firstDatabasePassword, secondDatabasePassword);
  assert.notEqual(accountPasswords[0], firstDatabasePassword);
  assert.notEqual(accountPasswords[1], secondDatabasePassword);
  assert.equal(
    firstResult.username,
    `nina_${first.runId.replaceAll('-', '').slice(0, 12)}`,
  );
});

it('creates independent secrets with the real compiled password hasher', async () => {
  const context = makeContext();
  const fixture = require('./training-accounts-postgres-fixture.cjs');
  const result = await fixture.prepareTrainingAccountFixture(context);
  const env = fs.readFileSync(result.artifacts.postgresEnv, 'utf8');
  const password = env.match(/^POSTGRES_PASSWORD=(.+)$/m)?.[1];
  assert.ok(password);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(password));
  assert.deepEqual(Object.keys(result).sort(), [
    'artifacts',
    'assertions',
    'database',
    'databaseUser',
    'expectedRejections',
    'username',
  ]);
});

it('executes the validated compiled helper instead of a cached module export', async () => {
  const context = makeContext();
  const fixture = require('./training-accounts-postgres-fixture.cjs');
  const cached = require.cache[HASHER];
  let cachedHasherCalls = 0;
  require.cache[HASHER] = {
    id: HASHER,
    filename: HASHER,
    loaded: true,
    exports: {
      hashPassword: async () => {
        cachedHasherCalls++;
        return validSyntheticHash();
      },
    },
    children: [],
    paths: [],
  };

  try {
    const result = await fixture.prepareTrainingAccountFixture(context);
    assert.equal(cachedHasherCalls, 0);
    assert.equal(typeof result.username, 'string');
  } finally {
    if (cached) require.cache[HASHER] = cached;
    else delete require.cache[HASHER];
  }
});
