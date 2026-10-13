const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  buildTrainingAccountAssertions,
} = require('./training-accounts-postgres-sql.cjs');
const {
  readRecoveryState,
  reportFailure,
  writePrivateArtifact,
} = require('./verify-training-accounts-postgres.cjs');

const MIGRATION_RELATIVE_PATH =
  'prisma/migrations/20261012190000_add_training_accounts/migration.sql';
const HASHER_RELATIVE_PATH = 'dist/modules/auth/password-hash.js';
const MAX_MIGRATION_BYTES = 16 * 1024;
const MAX_HASHER_BYTES = 2 * 1024 * 1024;
const MAX_PROOF_BYTES = 16 * 1024;
const MAX_ENV_BYTES = 4 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ASSERTION_NAMES = Object.freeze([
  'table_empty_before',
  'role_enum_values',
  'role_has_no_default',
  'username_c_collation',
  'valid_username_boundaries',
  'explicit_roles_and_defaults',
  'table_empty_after',
  'table_empty_after_rollback',
]);
const EXPECTED_REJECTIONS = Object.freeze([
  Object.freeze({ checkpoint: 'role_default', sqlState: '23502' }),
  Object.freeze({ checkpoint: 'username_null', sqlState: '23502' }),
  Object.freeze({ checkpoint: 'username_noncanonical', sqlState: '23514' }),
  Object.freeze({ checkpoint: 'username_too_short', sqlState: '23514' }),
  Object.freeze({ checkpoint: 'auth_version_negative', sqlState: '23514' }),
  Object.freeze({ checkpoint: 'username_duplicate', sqlState: '23505' }),
]);

function privateFailure() {
  throw new Error('Training account fixture preparation failed');
}

function assertNotAborted(signal) {
  if (signal === undefined) return;
  let aborted;
  try {
    aborted = signal.aborted;
  } catch {
    privateFailure();
  }
  if (typeof aborted !== 'boolean') privateFailure();
  if (aborted) privateFailure();
}

function readCanonicalFile(filename, maximumBytes) {
  if (
    path.resolve(filename) !== filename ||
    fs.realpathSync(filename) !== filename
  )
    privateFailure();

  const entry = fs.lstatSync(filename);
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    entry.nlink !== 1 ||
    entry.size <= 0 ||
    entry.size > maximumBytes
  )
    privateFailure();

  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino ||
      opened.size !== entry.size ||
      opened.size > maximumBytes
    )
      privateFailure();

    const bytes = fs.readFileSync(descriptor);
    const final = fs.fstatSync(descriptor);
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length !== opened.size ||
      bytes.length > maximumBytes ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size
    )
      privateFailure();
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) privateFailure();
    return text;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readTrainingAccountMigration() {
  try {
    const apiRoot = path.resolve(__dirname, '..');
    return readCanonicalFile(
      path.join(apiRoot, MIGRATION_RELATIVE_PATH),
      MAX_MIGRATION_BYTES,
    );
  } catch {
    privateFailure();
  }
}

function loadPasswordHasher(apiRoot) {
  const filename = path.join(apiRoot, HASHER_RELATIVE_PATH);
  const source = readCanonicalFile(filename, MAX_HASHER_BYTES);
  const helperModule = { exports: {} };
  const loadDependency = (specifier) => {
    if (specifier === 'node:buffer' || specifier === 'node:crypto')
      return require(specifier);
    privateFailure();
  };
  vm.runInNewContext(
    source,
    {
      exports: helperModule.exports,
      module: helperModule,
      require: loadDependency,
    },
    {
      filename: HASHER_RELATIVE_PATH,
      timeout: 1000,
    },
  );
  const helper = helperModule.exports;
  if (!helper || typeof helper.hashPassword !== 'function') privateFailure();
  return helper.hashPassword;
}

function snapshotMetadata(result) {
  const assertions = result?.assertions;
  const expectedRejections = result?.expectedRejections;
  if (
    !Array.isArray(assertions) ||
    assertions.length !== ASSERTION_NAMES.length ||
    assertions.some((name, index) => name !== ASSERTION_NAMES[index]) ||
    !Array.isArray(expectedRejections) ||
    expectedRejections.length !== EXPECTED_REJECTIONS.length
  )
    privateFailure();

  const rejections = expectedRejections.map((value, index) => {
    const checkpoint = value?.checkpoint;
    const sqlState = value?.sqlState;
    if (
      checkpoint !== EXPECTED_REJECTIONS[index].checkpoint ||
      sqlState !== EXPECTED_REJECTIONS[index].sqlState
    )
      privateFailure();
    return Object.freeze({ checkpoint, sqlState });
  });
  return {
    assertions: Object.freeze([...assertions]),
    expectedRejections: Object.freeze(rejections),
  };
}

function privateCredentials(runId) {
  const compactRunId = runId.replaceAll('-', '');
  const suffix = compactRunId.slice(0, 16);
  const accountPassword = crypto.randomBytes(32).toString('base64url');
  let databasePassword = crypto.randomBytes(32).toString('base64url');
  for (
    let attempt = 0;
    accountPassword === databasePassword && attempt < 3;
    attempt++
  )
    databasePassword = crypto.randomBytes(32).toString('base64url');
  if (accountPassword === databasePassword) privateFailure();
  return {
    accountPassword,
    databasePassword,
    database: `training_${suffix}`,
    databaseUser: `training_${suffix}`,
    username: `nina_${compactRunId.slice(0, 12)}`,
  };
}

function postgresEnvironment({ database, databaseUser, databasePassword }) {
  return [
    `POSTGRES_DB=${database}`,
    `POSTGRES_USER=${databaseUser}`,
    `POSTGRES_PASSWORD=${databasePassword}`,
    'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
    'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
    `PGPASSWORD=${databasePassword}`,
    '',
  ].join('\n');
}

function recordFailure(context, stage, error) {
  try {
    reportFailure(context, stage, error);
  } catch {
    /* Retain the original generic preparation failure. */
  }
  privateFailure();
}

async function prepareTrainingAccountFixture(context, options = {}) {
  let stage = 'fixture_source_read';
  let signal;
  try {
    if (
      options === null ||
      typeof options !== 'object' ||
      Array.isArray(options)
    )
      privateFailure();
    signal = options.signal;
    const state = readRecoveryState(context);
    const runId = context.runId;
    if (
      typeof runId !== 'string' ||
      !UUID_PATTERN.test(runId) ||
      state.runId !== runId ||
      state.artifacts.proof_sql !== null ||
      state.artifacts.postgres_env !== null
    )
      privateFailure();
    assertNotAborted(signal);

    const apiRoot = path.resolve(__dirname, '..');
    const migration = readTrainingAccountMigration();

    stage = 'fixture_helper_load';
    assertNotAborted(signal);
    const hashPassword = loadPasswordHasher(apiRoot);

    stage = 'fixture_hash';
    assertNotAborted(signal);
    const credentials = privateCredentials(runId);
    const passwordHash = await hashPassword(credentials.accountPassword);
    assertNotAborted(signal);

    stage = 'fixture_sql_build';
    const built = buildTrainingAccountAssertions({ passwordHash, runId });
    if (typeof built?.sql !== 'string' || built.sql.length === 0)
      privateFailure();
    const metadata = snapshotMetadata(built);
    const proofSql = `${migration}\n${built.sql}`;
    if (Buffer.byteLength(proofSql, 'utf8') > MAX_PROOF_BYTES) privateFailure();

    const environment = postgresEnvironment(credentials);
    if (Buffer.byteLength(environment, 'utf8') > MAX_ENV_BYTES)
      privateFailure();
    const artifacts = Object.freeze({
      proofSql: path.join(context.root, 'proof.sql'),
      postgresEnv: path.join(context.root, 'postgres.env'),
    });

    stage = 'fixture_sql_write';
    assertNotAborted(signal);
    writePrivateArtifact(context, 'proof_sql', proofSql);

    stage = 'fixture_env_write';
    assertNotAborted(signal);
    writePrivateArtifact(context, 'postgres_env', environment);

    return Object.freeze({
      database: credentials.database,
      databaseUser: credentials.databaseUser,
      username: credentials.username,
      artifacts,
      assertions: metadata.assertions,
      expectedRejections: metadata.expectedRejections,
    });
  } catch (error) {
    recordFailure(context, stage, error);
  }
}

module.exports = {
  prepareTrainingAccountFixture,
  readTrainingAccountMigration,
};
