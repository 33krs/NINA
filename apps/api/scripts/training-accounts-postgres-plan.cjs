const path = require('node:path');
const { dockerArgs } = require('./verify-odontogram-postgres.cjs');
const {
  readRecoveryState,
  validatePreparedArtifacts,
} = require('./verify-training-accounts-postgres.cjs');

const IMAGE = 'postgres:15-alpine';
const OWNER_LABEL = 'nina.training-postgres.owner';
const RUN_LABEL = 'nina.training-postgres.run';
const OWNER_VALUE = 'nina-suite';
const PROOF_PATH = '/run/nina-proof/proof.sql';
const FIXTURE_KEYS = Object.freeze([
  'database',
  'databaseUser',
  'username',
  'artifacts',
  'assertions',
  'expectedRejections',
]);
const OPERATIONS = new Set([
  'inspect_image',
  'create_network',
  'create_container',
  'start_container',
  'inspect_network',
  'inspect_container',
  'wait_ready',
  'server_version',
  'run_assertions',
]);

function invalidPlan() {
  throw new Error('Training-account PostgreSQL command plan rejected');
}

function readDataProperties(value, keys) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    invalidPlan();
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) invalidPlan();
    result[key] = descriptor.value;
  }
  return result;
}

function validatedFixture(context, fixture) {
  const state = readRecoveryState(context);
  const values = readDataProperties(fixture, FIXTURE_KEYS);
  const artifacts = readDataProperties(values.artifacts, [
    'proofSql',
    'postgresEnv',
  ]);
  const compactRunId = state.runId.replaceAll('-', '');
  if (
    state.runId !== context.runId ||
    state.name !== context.name ||
    values.database !== `training_${compactRunId.slice(0, 16)}` ||
    values.databaseUser !== `training_${compactRunId.slice(0, 16)}` ||
    values.username !== `nina_${compactRunId.slice(0, 12)}` ||
    !Array.isArray(values.assertions) ||
    !Array.isArray(values.expectedRejections) ||
    artifacts.proofSql !== path.join(context.root, 'proof.sql') ||
    artifacts.postgresEnv !== path.join(context.root, 'postgres.env')
  )
    invalidPlan();
  return { state, artifacts };
}

function fixedArgs(args) {
  return Object.freeze(dockerArgs(args));
}

function requirePreparedArtifacts(context, expectedPaths) {
  let actualPaths;
  try {
    actualPaths = validatePreparedArtifacts(context);
  } catch {
    invalidPlan();
  }
  if (
    actualPaths.proofSql !== expectedPaths.proofSql ||
    actualPaths.postgresEnv !== expectedPaths.postgresEnv
  )
    invalidPlan();
  return actualPaths;
}

function trainingAccountPostgresCommand(context, fixture, operation) {
  if (
    arguments.length !== 3 ||
    typeof operation !== 'string' ||
    !OPERATIONS.has(operation)
  )
    invalidPlan();
  let validated;
  try {
    validated = validatedFixture(context, fixture);
  } catch {
    invalidPlan();
  }
  const { state } = validated;
  const { container, network, imageId } = state;
  const labelArgs = [
    '--label',
    `${OWNER_LABEL}=${OWNER_VALUE}`,
    '--label',
    `${RUN_LABEL}=${state.runId}`,
  ];
  switch (operation) {
    case 'inspect_image':
      if (imageId !== null || container.id !== null || network.id !== null)
        invalidPlan();
      return fixedArgs(['image', 'inspect', '--format', '{{json .}}', IMAGE]);
    case 'create_network':
      requirePreparedArtifacts(context, validated.artifacts);
      if (
        !imageId ||
        network.id !== null ||
        network.uncertain ||
        !network.absent
      )
        invalidPlan();
      return fixedArgs([
        'network',
        'create',
        '--driver',
        'bridge',
        '--internal',
        ...labelArgs,
        state.name,
      ]);
    case 'create_container': {
      if (
        !imageId ||
        !/^[a-f\d]{64}$/.test(network.id ?? '') ||
        network.uncertain ||
        network.absent ||
        container.id !== null ||
        container.uncertain ||
        !container.absent ||
        [
          context.root,
          validated.artifacts.proofSql,
          validated.artifacts.postgresEnv,
        ].some(
          (value) =>
            value.includes(',') || value.includes('\n') || value.includes('\r'),
        )
      )
        invalidPlan();
      const artifacts = requirePreparedArtifacts(context, validated.artifacts);
      return fixedArgs([
        'create',
        '--pull=never',
        '--name',
        state.name,
        ...labelArgs,
        '--network',
        network.id,
        '--read-only',
        '--tmpfs',
        '/tmp:rw,noexec,nosuid,size=16m',
        '--tmpfs',
        '/run/postgresql:rw,noexec,nosuid,size=16m',
        '--tmpfs',
        '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
        '--mount',
        `type=bind,source=${artifacts.proofSql},target=${PROOF_PATH},readonly`,
        '--env-file',
        artifacts.postgresEnv,
        '--user',
        '0',
        imageId,
      ]);
    }
    case 'start_container':
      requirePreparedArtifacts(context, validated.artifacts);
      if (
        !/^[a-f\d]{64}$/.test(container.id ?? '') ||
        container.uncertain ||
        container.absent
      )
        invalidPlan();
      return fixedArgs(['start', container.id]);
    case 'inspect_network':
      if (
        !/^[a-f\d]{64}$/.test(network.id ?? '') ||
        network.uncertain ||
        network.absent ||
        !imageId
      )
        invalidPlan();
      return fixedArgs([
        'network',
        'inspect',
        '--format',
        '{{json .}}',
        network.id,
      ]);
    case 'inspect_container':
      if (
        !/^[a-f\d]{64}$/.test(container.id ?? '') ||
        container.uncertain ||
        container.absent ||
        !/^[a-f\d]{64}$/.test(network.id ?? '') ||
        network.uncertain ||
        network.absent ||
        !imageId
      )
        invalidPlan();
      return fixedArgs([
        'inspect',
        '--type',
        'container',
        '--format',
        '{{json .}}',
        container.id,
      ]);
    case 'wait_ready':
      requirePreparedArtifacts(context, validated.artifacts);
      if (
        !/^[a-f\d]{64}$/.test(container.id ?? '') ||
        container.uncertain ||
        container.absent
      )
        invalidPlan();
      return fixedArgs([
        'exec',
        '--user',
        '0',
        container.id,
        'sh',
        '-c',
        'set -eu; attempts=0; until pg_isready --quiet --host=127.0.0.1 --port=5432 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"; do attempts=$((attempts + 1)); if [ "$attempts" -ge 30 ]; then exit 1; fi; sleep 1; done',
      ]);
    case 'server_version':
      requirePreparedArtifacts(context, validated.artifacts);
      if (
        !/^[a-f\d]{64}$/.test(container.id ?? '') ||
        container.uncertain ||
        container.absent ||
        !/^[a-f\d]{64}$/.test(network.id ?? '') ||
        network.uncertain ||
        network.absent ||
        !imageId
      )
        invalidPlan();
      return fixedArgs([
        'exec',
        '--user',
        '0',
        container.id,
        'sh',
        '-c',
        'export PGPASSWORD="$POSTGRES_PASSWORD" PGOPTIONS="-c statement_timeout=20000 -c lock_timeout=3000"; exec psql --quiet --tuples-only --no-align --no-password --no-psqlrc --set ON_ERROR_STOP=1 --host=127.0.0.1 --port=5432 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --command="SHOW server_version_num"',
      ]);
    case 'run_assertions':
      requirePreparedArtifacts(context, validated.artifacts);
      if (
        !/^[a-f\d]{64}$/.test(container.id ?? '') ||
        container.uncertain ||
        container.absent
      )
        invalidPlan();
      return fixedArgs([
        'exec',
        '--user',
        '0',
        container.id,
        'sh',
        '-c',
        'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql --quiet --tuples-only --no-align --no-password --no-psqlrc --set ON_ERROR_STOP=1 --host=127.0.0.1 --port=5432 --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --file=/run/nina-proof/proof.sql',
      ]);
    default:
      invalidPlan();
  }
}

module.exports = { trainingAccountPostgresCommand };
