const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OWNER_LABEL = 'nina.training-postgres.owner';
const RUN_LABEL = 'nina.training-postgres.run';
const OWNER_VALUE = 'nina-suite';
const MANIFEST_NAME = 'recovery.json';
const ROOT_PREFIX = 'nina-training-postgres-';
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_DIAGNOSTICS = 12;
const CLEANUP_COMMAND_TIMEOUT_MS = 5_000;
const RESOURCE_KINDS = ['container', 'network'];
const ARTIFACTS = Object.freeze({
  proof_sql: Object.freeze({ filename: 'proof.sql', maxBytes: 16 * 1024 }),
  postgres_env: Object.freeze({ filename: 'postgres.env', maxBytes: 4 * 1024 }),
});
const MANIFEST_V1_KEYS = Object.freeze([
  'version',
  'runId',
  'name',
  'imageId',
  'container',
  'network',
  'proofSucceeded',
  'cleanupConfirmed',
  'diagnostics',
]);
const STAGES = new Set([
  'fixture_source_read',
  'fixture_helper_load',
  'fixture_hash',
  'fixture_sql_build',
  'fixture_sql_write',
  'fixture_env_write',
  'image_inspect',
  'network_create',
  'container_create',
  'resource_inspect',
  'resource_remove',
  'proof_write',
  'proof_validation',
  'readiness',
  'sql_assertion',
  'cleanup',
]);
const REASONS = new Set([
  'operation_failed',
  'exit_status',
  'node_error',
  'sqlstate',
  'invalid_inspection',
  'ownership_mismatch',
  'foreign_network_members',
  'resource_present',
]);
const NODE_CODES = new Set([
  'EACCES',
  'EBUSY',
  'ECONNREFUSED',
  'ECONNRESET',
  'EEXIST',
  'EIO',
  'ENOBUFS',
  'ENOENT',
  'ENOSPC',
  'EPERM',
  'EROFS',
  'ESRCH',
  'ETIMEDOUT',
]);
const SQLSTATES = new Set([
  '23502',
  '23503',
  '23505',
  '23514',
  '42601',
  '42703',
  '42P01',
  '42883',
]);
const contexts = new WeakMap();
const activeRoots = new Map();

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function verifyPrivateRoot(root) {
  try {
    const stat = fs.lstatSync(root);
    if (
      !path.isAbsolute(root) ||
      path.basename(root).startsWith(ROOT_PREFIX) !== true ||
      fs.realpathSync(root) !== root ||
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      (stat.mode & 0o777) !== 0o700 ||
      (currentUid() !== undefined && stat.uid !== currentUid())
    )
      fail('Private recovery directory required');
  } catch {
    fail('Private recovery directory required');
  }
}

function rootMatchesRunId(root, runId) {
  const basename = path.basename(root);
  return (
    basename.startsWith(`${ROOT_PREFIX}${runId}-`) &&
    /^[A-Za-z0-9_-]{6}$/.test(basename.slice(-6)) &&
    basename.length === `${ROOT_PREFIX}${runId}-`.length + 6
  );
}

function resourceState() {
  return { id: null, uncertain: false, absent: true };
}

function emptyArtifactState() {
  return { proof_sql: null, postgres_env: null };
}

function makeManifest(runId, name) {
  return {
    version: 2,
    runId,
    name,
    imageId: null,
    container: resourceState(),
    network: resourceState(),
    proofSucceeded: false,
    cleanupConfirmed: false,
    diagnostics: [],
    artifacts: emptyArtifactState(),
  };
}

function contextFor(state) {
  const labels = Object.freeze({
    [OWNER_LABEL]: OWNER_VALUE,
    [RUN_LABEL]: state.manifest.runId,
  });
  const context = Object.freeze({
    root: state.root,
    manifestPath: state.manifestPath,
    runId: state.manifest.runId,
    name: state.manifest.name,
    labels,
  });
  contexts.set(context, state);
  return context;
}

function getState(context) {
  const state = contexts.get(context);
  if (!state) fail('Known training proof context required');
  return state;
}

function writeManifest(state) {
  const temporary = path.join(
    state.root,
    `.manifest-${crypto.randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    if (state.manifestIdentity) {
      const current = fs.lstatSync(state.manifestPath);
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.nlink !== 1 ||
        current.dev !== state.manifestIdentity.dev ||
        current.ino !== state.manifestIdentity.ino ||
        (current.mode & 0o777) !== 0o600 ||
        (currentUid() !== undefined && current.uid !== currentUid())
      )
        fail('Private recovery manifest identity changed');
    }
    if (state.manifest.version === 1) {
      state.manifest = {
        ...state.manifest,
        version: 2,
        artifacts: emptyArtifactState(),
      };
    }
    const bytes = JSON.stringify(state.manifest);
    if (Buffer.byteLength(bytes, 'utf8') > MAX_MANIFEST_BYTES)
      fail('Recovery manifest exceeds its size limit');
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, state.manifestPath);
    const manifestStat = fs.lstatSync(state.manifestPath);
    if (
      manifestStat.isSymbolicLink() ||
      !manifestStat.isFile() ||
      manifestStat.nlink !== 1 ||
      (manifestStat.mode & 0o777) !== 0o600 ||
      (currentUid() !== undefined && manifestStat.uid !== currentUid())
    )
      fail('Private recovery manifest required');
    state.manifestIdentity = {
      dev: manifestStat.dev,
      ino: manifestStat.ino,
    };
    const directory = fs.openSync(state.root, 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } catch {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* retain the generic error */
      }
    }
    try {
      fs.unlinkSync(temporary);
    } catch {
      /* retain recovery evidence */
    }
    fail('Recovery manifest write failed');
  }
}

function createRecoveryContext({ temporaryDirectory = os.tmpdir() } = {}) {
  let root;
  const runId = crypto.randomUUID();
  try {
    if (
      typeof temporaryDirectory !== 'string' ||
      !path.isAbsolute(temporaryDirectory)
    )
      fail('Private recovery directory creation failed');
    root = fs.mkdtempSync(
      path.join(temporaryDirectory, `${ROOT_PREFIX}${runId}-`),
    );
    fs.chmodSync(root, 0o700);
    root = fs.realpathSync(root);
    verifyPrivateRoot(root);
  } catch {
    if (root) {
      try {
        fs.rmdirSync(root);
      } catch {
        /* preserve unexpected private contents */
      }
    }
    fail('Private recovery directory creation failed');
  }
  const manifestPath = path.join(root, MANIFEST_NAME);
  const state = {
    root,
    manifestPath,
    manifest: makeManifest(runId, `${ROOT_PREFIX}${runId}`),
    pending: new Set(),
    finalizing: false,
  };
  try {
    writeManifest(state);
  } catch {
    try {
      fs.rmdirSync(root);
    } catch {
      /* preserve failed private storage */
    }
    fail('Private recovery manifest creation failed');
  }
  const context = contextFor(state);
  activeRoots.set(root, state);
  return context;
}

function validateResource(value) {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 3 &&
    (value.id === null ||
      (typeof value.id === 'string' && /^[a-f\d]{64}$/.test(value.id))) &&
    typeof value.uncertain === 'boolean' &&
    typeof value.absent === 'boolean' &&
    !(value.uncertain && value.absent)
  );
}

function validateDiagnostic(value) {
  if (
    !isPlainObject(value) ||
    !STAGES.has(value.stage) ||
    !REASONS.has(value.reason)
  )
    return false;
  const keys = Object.keys(value);
  if (
    keys.some(
      (key) =>
        !['stage', 'reason', 'exitStatus', 'nodeCode', 'sqlState'].includes(
          key,
        ),
    )
  )
    return false;
  return (
    (value.exitStatus === undefined ||
      (Number.isInteger(value.exitStatus) &&
        value.exitStatus >= 0 &&
        value.exitStatus <= 255)) &&
    (value.nodeCode === undefined || NODE_CODES.has(value.nodeCode)) &&
    (value.sqlState === undefined || SQLSTATES.has(value.sqlState))
  );
}

function validateManifest(value) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  const manifestVersion =
    (value.version === 1 &&
      keys.length === MANIFEST_V1_KEYS.length &&
      MANIFEST_V1_KEYS.every((key) => keys.includes(key))) ||
    (value.version === 2 &&
      keys.length === MANIFEST_V1_KEYS.length + 1 &&
      [...MANIFEST_V1_KEYS, 'artifacts'].every((key) => keys.includes(key)));
  if (
    !manifestVersion ||
    typeof value.runId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.runId,
    ) ||
    value.name !== `${ROOT_PREFIX}${value.runId}` ||
    (value.imageId !== null &&
      (typeof value.imageId !== 'string' ||
        !/^sha256:[a-f\d]{64}$/.test(value.imageId))) ||
    !validateResource(value.container) ||
    !validateResource(value.network) ||
    typeof value.proofSucceeded !== 'boolean' ||
    typeof value.cleanupConfirmed !== 'boolean' ||
    !Array.isArray(value.diagnostics) ||
    value.diagnostics.length > MAX_DIAGNOSTICS ||
    !value.diagnostics.every(validateDiagnostic)
  )
    return false;
  if (
    value.version === 2 &&
    (!isPlainObject(value.artifacts) ||
      Object.keys(value.artifacts).length !== Object.keys(ARTIFACTS).length ||
      !Object.keys(ARTIFACTS).every((kind) =>
        validateArtifactState(kind, value.artifacts[kind]),
      ))
  )
    return false;
  if (
    (value.container.id !== null && value.imageId === null) ||
    (value.cleanupConfirmed &&
      !RESOURCE_KINDS.every(
        (kind) => value[kind].absent && !value[kind].uncertain,
      ))
  )
    return false;
  return true;
}

function validateArtifactState(kind, value) {
  if (value === null) return true;
  if (
    !isPlainObject(value) ||
    Object.keys(value).length !== 4 ||
    !['state', 'dev', 'ino', 'size'].every((key) => Object.hasOwn(value, key))
  )
    return false;
  if (value.state === 'intent')
    return value.dev === null && value.ino === null && value.size === null;
  const maxBytes = ARTIFACTS[kind].maxBytes;
  return (
    ['owned', 'complete'].includes(value.state) &&
    Number.isSafeInteger(value.dev) &&
    value.dev >= 0 &&
    Number.isSafeInteger(value.ino) &&
    value.ino >= 0 &&
    Number.isInteger(value.size) &&
    value.size > 0 &&
    value.size <= maxBytes
  );
}

function openRecoveryContext(root) {
  verifyPrivateRoot(root);
  const activeState = activeRoots.get(root);
  if (activeState) return contextFor(activeState);
  const manifestPath = path.join(root, MANIFEST_NAME);
  let manifest;
  let manifestIdentity;
  try {
    const stat = fs.lstatSync(manifestPath);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      (currentUid() !== undefined && stat.uid !== currentUid()) ||
      stat.size > MAX_MANIFEST_BYTES
    )
      fail('Private recovery manifest required');
    const descriptor = fs.openSync(
      manifestPath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = fs.fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        (opened.mode & 0o777) !== 0o600 ||
        (currentUid() !== undefined && opened.uid !== currentUid()) ||
        opened.size > MAX_MANIFEST_BYTES ||
        opened.dev !== stat.dev ||
        opened.ino !== stat.ino
      )
        fail('Private recovery manifest required');
      manifestIdentity = { dev: opened.dev, ino: opened.ino };
      manifest = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    fail('Private recovery manifest required');
  }
  if (!validateManifest(manifest)) fail('Invalid training proof recovery data');
  if (!rootMatchesRunId(root, manifest.runId))
    fail('Recovery directory does not match its run identity');
  if (manifest.version === 1)
    manifest = { ...manifest, version: 2, artifacts: emptyArtifactState() };
  const state = {
    root,
    manifestPath,
    manifest,
    manifestIdentity,
    pending: new Set(),
    finalizing: false,
  };
  verifyArtifactRecords(state);
  activeRoots.set(root, state);
  return contextFor(state);
}

function verifyArtifactRecords(state) {
  for (const kind of Object.keys(ARTIFACTS)) {
    const record = state.manifest.artifacts[kind];
    const filename = path.join(state.root, ARTIFACTS[kind].filename);
    let stat;
    try {
      stat = fs.lstatSync(filename);
    } catch (error) {
      if (error && error.code === 'ENOENT' && record?.state !== 'complete')
        continue;
      fail('Private artifact identity changed');
    }
    if (
      !record ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (currentUid() !== undefined && stat.uid !== currentUid()) ||
      stat.size > ARTIFACTS[kind].maxBytes ||
      (record.state !== 'intent' &&
        (stat.dev !== record.dev || stat.ino !== record.ino)) ||
      (record.state === 'complete' && stat.size !== record.size)
    )
      fail('Private artifact identity changed');
  }
}

function readRecoveryState(context) {
  const state = getState(context);
  return Object.freeze(JSON.parse(JSON.stringify(state.manifest)));
}

function validatePreparedArtifacts(context) {
  const state = getState(context);
  try {
    if (
      state.finalizing ||
      state.pending.size !== 0 ||
      state.manifest.proofSucceeded ||
      state.manifest.cleanupConfirmed
    )
      fail('Prepared PostgreSQL artifacts are unavailable');
    verifyPrivateRoot(state.root);
    const records = state.manifest.artifacts;
    const paths = {};
    for (const [kind, filename] of [
      ['proof_sql', 'proof.sql'],
      ['postgres_env', 'postgres.env'],
    ]) {
      const record = records[kind];
      const artifactPath = path.join(state.root, filename);
      const stat = fs.lstatSync(artifactPath);
      if (
        !record ||
        record.state !== 'complete' ||
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o777) !== 0o600 ||
        (currentUid() !== undefined && stat.uid !== currentUid()) ||
        stat.dev !== record.dev ||
        stat.ino !== record.ino ||
        stat.size !== record.size ||
        stat.size <= 0 ||
        stat.size > ARTIFACTS[kind].maxBytes
      )
        fail('Prepared PostgreSQL artifacts are unavailable');
      const noFollow = fs.constants.O_NOFOLLOW ?? 0;
      const descriptor = fs.openSync(
        artifactPath,
        fs.constants.O_RDONLY | noFollow,
      );
      try {
        const opened = fs.fstatSync(descriptor);
        if (
          !opened.isFile() ||
          opened.nlink !== 1 ||
          (opened.mode & 0o777) !== 0o600 ||
          (currentUid() !== undefined && opened.uid !== currentUid()) ||
          opened.dev !== record.dev ||
          opened.ino !== record.ino ||
          opened.size !== record.size
        )
          fail('Prepared PostgreSQL artifacts are unavailable');
      } finally {
        fs.closeSync(descriptor);
      }
      paths[kind] = artifactPath;
    }
    return Object.freeze({
      proofSql: paths.proof_sql,
      postgresEnv: paths.postgres_env,
    });
  } catch {
    fail('Prepared PostgreSQL artifacts are unavailable');
  }
}

function writePrivateArtifact(context, kind, content) {
  const state = getState(context);
  verifyPrivateRoot(state.root);
  const artifact =
    typeof kind === 'string' && Object.hasOwn(ARTIFACTS, kind)
      ? ARTIFACTS[kind]
      : undefined;
  if (
    state.finalizing ||
    !artifact ||
    typeof content !== 'string' ||
    content.length === 0 ||
    content.length > artifact.maxBytes
  )
    fail('Private artifact write failed');
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length === 0 || bytes.length > artifact.maxBytes)
    fail('Private artifact write failed');
  const previous = state.manifest.artifacts[kind];
  if (previous !== null) fail('Private artifact write failed');

  state.manifest.artifacts[kind] = {
    state: 'intent',
    dev: null,
    ino: null,
    size: null,
  };
  try {
    writeManifest(state);
  } catch {
    fail('Private artifact write failed');
  }

  const filename = path.join(state.root, artifact.filename);
  let descriptor;
  try {
    descriptor = fs.openSync(filename, 'wx', 0o600);
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o777) !== 0o600 ||
      (currentUid() !== undefined && opened.uid !== currentUid())
    )
      fail('Private artifact write failed');

    const directory = fs.openSync(state.root, 'r');
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }

    const owned = {
      state: 'owned',
      dev: opened.dev,
      ino: opened.ino,
      size: bytes.length,
    };
    state.manifest.artifacts[kind] = owned;
    writeManifest(state);

    const written = fs.writeSync(descriptor, bytes, 0, bytes.length, 0);
    if (written !== bytes.length) fail('Private artifact write failed');
    fs.fsyncSync(descriptor);
    const completed = fs.fstatSync(descriptor);
    if (
      completed.dev !== owned.dev ||
      completed.ino !== owned.ino ||
      completed.size !== bytes.length ||
      completed.nlink !== 1 ||
      (completed.mode & 0o777) !== 0o600 ||
      (currentUid() !== undefined && completed.uid !== currentUid())
    )
      fail('Private artifact write failed');

    state.manifest.artifacts[kind] = { ...owned, state: 'complete' };
    try {
      writeManifest(state);
    } catch {
      state.manifest.artifacts[kind] = owned;
      fail('Private artifact write failed');
    }
  } catch {
    fail('Private artifact write failed');
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        /* preserve the generic artifact result */
      }
    }
  }
}

function readOnce(value, key) {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  )
    return undefined;
  try {
    return value[key];
  } catch {
    return undefined;
  }
}

function snapshotError(error) {
  const code = readOnce(error, 'code');
  const status = readOnce(error, 'status');
  const exitCode = readOnce(error, 'exitCode');
  const sqlState = readOnce(error, 'sqlState');
  const stderr = readOnce(error, 'stderr');
  return {
    code: typeof code === 'string' && code.length <= 32 ? code : undefined,
    status,
    exitCode,
    sqlState:
      typeof sqlState === 'string' && sqlState.length === 5
        ? sqlState
        : undefined,
    stderr:
      typeof stderr === 'string' && stderr.length <= 2048 ? stderr : undefined,
  };
}

function diagnosticFromSnapshot(stage, snapshot, forcedReason) {
  if (!STAGES.has(stage)) fail('Unknown training proof diagnostic stage');
  const diagnostic = { stage, reason: forcedReason ?? 'operation_failed' };
  const exitStatus =
    Number.isInteger(snapshot.status) &&
    snapshot.status >= 0 &&
    snapshot.status <= 255
      ? snapshot.status
      : Number.isInteger(snapshot.exitCode) &&
          snapshot.exitCode >= 0 &&
          snapshot.exitCode <= 255
        ? snapshot.exitCode
        : undefined;
  if (exitStatus !== undefined) diagnostic.exitStatus = exitStatus;
  const code = typeof snapshot.code === 'string' ? snapshot.code : undefined;
  const sqlState = SQLSTATES.has(snapshot.sqlState)
    ? snapshot.sqlState
    : SQLSTATES.has(code)
      ? code
      : undefined;
  if (sqlState) diagnostic.sqlState = sqlState;
  const nodeCode = NODE_CODES.has(code) ? code : undefined;
  if (nodeCode) diagnostic.nodeCode = nodeCode;
  if (!forcedReason) {
    if (sqlState) diagnostic.reason = 'sqlstate';
    else if (nodeCode) diagnostic.reason = 'node_error';
    else if (exitStatus !== undefined) diagnostic.reason = 'exit_status';
  }
  return Object.freeze(diagnostic);
}

function storeDiagnostic(state, diagnostic) {
  state.manifest.diagnostics.push({ ...diagnostic });
  if (state.manifest.diagnostics.length > MAX_DIAGNOSTICS)
    state.manifest.diagnostics.shift();
  writeManifest(state);
}

function reportFailure(context, stage, error) {
  const state = getState(context);
  const diagnostic = diagnosticFromSnapshot(stage, snapshotError(error));
  storeDiagnostic(state, diagnostic);
  return diagnostic;
}

function recordKnownFailure(state, stage, reason) {
  if (!REASONS.has(reason)) fail('Unknown training proof failure category');
  const diagnostic = diagnosticFromSnapshot(stage, {}, reason);
  try {
    storeDiagnostic(state, diagnostic);
  } catch {
    /* preserve existing recovery data */
  }
  return diagnostic;
}

function bindImageIdentity(context, imageId) {
  const state = getState(context);
  if (typeof imageId !== 'string' || !/^sha256:[a-f\d]{64}$/.test(imageId))
    fail('Immutable PostgreSQL image identity required');
  if (state.manifest.imageId && state.manifest.imageId !== imageId)
    fail('PostgreSQL image identity cannot be changed');
  const previous = state.manifest.imageId;
  state.manifest.imageId = imageId;
  try {
    writeManifest(state);
  } catch {
    state.manifest.imageId = previous;
    fail('PostgreSQL image identity persistence failed');
  }
}

function captureCreation(context, kind, create, { signal } = {}) {
  const state = getState(context);
  if (
    !RESOURCE_KINDS.includes(kind) ||
    typeof create !== 'function' ||
    state.finalizing ||
    (kind === 'container' && !state.manifest.imageId)
  )
    return Promise.reject(
      new Error('Training resource creation is not permitted'),
    );
  const resource = state.manifest[kind];
  if (resource.id || resource.uncertain)
    return Promise.reject(
      new Error('Training resource creation already tracked'),
    );
  resource.uncertain = true;
  resource.absent = false;
  try {
    writeManifest(state);
  } catch {
    return Promise.reject(
      new Error('Training resource creation was not started'),
    );
  }

  let resolveOperation;
  let rejectOperation;
  const operation = new Promise((resolve, reject) => {
    resolveOperation = resolve;
    rejectOperation = reject;
  });
  const task = operation
    .then((id) => {
      if (typeof id !== 'string' || !/^[a-f\d]{64}$/.test(id))
        throw new Error('Invalid resource observation');
      resource.id = id;
      writeManifest(state);
      resource.uncertain = false;
      resource.absent = false;
      writeManifest(state);
      return id;
    })
    .catch((error) => {
      const snapshot = snapshotError(error);
      const stage =
        kind === 'container' ? 'container_create' : 'network_create';
      const diagnostic = diagnosticFromSnapshot(stage, snapshot);
      try {
        storeDiagnostic(state, diagnostic);
      } catch {
        /* retain earlier uncertainty */
      }
      throw new Error('Training resource creation failed');
    });
  state.pending.add(task);
  try {
    resolveOperation(create({ signal }));
  } catch (error) {
    rejectOperation(error);
  }
  return task.finally(() => state.pending.delete(task));
}

function exactLabels(labels, state) {
  if (!isPlainObject(labels)) return false;
  const keys = Object.keys(labels).sort();
  const expected = [OWNER_LABEL, RUN_LABEL].sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index]) &&
    labels[OWNER_LABEL] === OWNER_VALUE &&
    labels[RUN_LABEL] === state.manifest.runId
  );
}

function targetAbsent(snapshot, kind, target) {
  if (snapshot.status !== 1 || typeof snapshot.stderr !== 'string')
    return false;
  const message = snapshot.stderr.trim().toLowerCase();
  const wanted = target.toLowerCase();
  if (kind === 'container') {
    return (
      message === `error: no such object: ${wanted}` ||
      message === `error response from daemon: no such container: ${wanted}`
    );
  }
  return (
    message === `error response from daemon: network ${wanted} not found` ||
    message === `error: no such network: ${wanted}`
  );
}

function persistAbsent(state, kind) {
  const resource = state.manifest[kind];
  resource.uncertain = false;
  resource.absent = true;
  writeManifest(state);
}

async function inspectResource(state, kind, execute) {
  const resource = state.manifest[kind];
  const target = resource.id ?? state.manifest.name;
  let output;
  try {
    output = await execute(
      kind === 'container'
        ? ['inspect', '--type', 'container', target]
        : ['network', 'inspect', target],
      { timeout: CLEANUP_COMMAND_TIMEOUT_MS, signal: undefined },
    );
  } catch (error) {
    const snapshot = snapshotError(error);
    if (targetAbsent(snapshot, kind, target)) {
      persistAbsent(state, kind);
      return undefined;
    }
    storeDiagnostic(
      state,
      diagnosticFromSnapshot('resource_inspect', snapshot),
    );
    fail('Training resource inspection failed');
  }

  let rows;
  try {
    if (typeof output !== 'string' || output.length > 64 * 1024)
      fail('Invalid training resource observation');
    rows = JSON.parse(output);
  } catch {
    recordKnownFailure(state, 'resource_inspect', 'invalid_inspection');
    fail('Invalid training resource observation');
  }
  if (!Array.isArray(rows) || rows.length !== 1 || !isPlainObject(rows[0])) {
    recordKnownFailure(state, 'resource_inspect', 'invalid_inspection');
    fail('Invalid training resource observation');
  }
  const row = rows[0];
  const idValid = typeof row.Id === 'string' && /^[a-f\d]{64}$/.test(row.Id);
  const matches =
    kind === 'container'
      ? idValid &&
        (!resource.id || row.Id === resource.id) &&
        row.Name === `/${state.manifest.name}` &&
        row.Image === state.manifest.imageId &&
        isPlainObject(row.Config) &&
        exactLabels(row.Config.Labels, state)
      : idValid &&
        (!resource.id || row.Id === resource.id) &&
        row.Name === state.manifest.name &&
        exactLabels(row.Labels, state);
  if (!matches) {
    recordKnownFailure(state, 'resource_inspect', 'ownership_mismatch');
    fail('Training resource ownership mismatch');
  }
  if (!resource.id || resource.uncertain) {
    resource.id = row.Id;
    resource.uncertain = false;
    resource.absent = false;
    writeManifest(state);
  }
  if (kind === 'network') {
    if (!isPlainObject(row.Containers)) {
      recordKnownFailure(state, 'resource_inspect', 'invalid_inspection');
      fail('Invalid training network observation');
    }
    if (Object.keys(row.Containers).length > 0) {
      recordKnownFailure(state, 'resource_inspect', 'foreign_network_members');
      fail('Training network has unexpected members');
    }
  }
  return row;
}

async function removeAndConfirm(state, kind, execute) {
  const resource = state.manifest[kind];
  if (!resource.id && !resource.uncertain) return;
  const row = await inspectResource(state, kind, execute);
  if (!row) return;
  const id = resource.id;
  try {
    await execute(
      kind === 'container' ? ['rm', '-f', id] : ['network', 'rm', id],
      { timeout: CLEANUP_COMMAND_TIMEOUT_MS, signal: undefined },
    );
  } catch (error) {
    storeDiagnostic(
      state,
      diagnosticFromSnapshot('resource_remove', snapshotError(error)),
    );
  }
  const remaining = await inspectResource(state, kind, execute);
  if (remaining) {
    recordKnownFailure(state, 'resource_remove', 'resource_present');
    fail('Training resource remains after cleanup');
  }
}

async function reconcileOwnedResources(context, { execute } = {}) {
  const state = getState(context);
  if (typeof execute !== 'function')
    fail('Synthetic resource executor required');
  // The adapter must honor this independent bound and never forward an aborted proof signal.
  state.finalizing = true;
  await Promise.allSettled([...state.pending]);
  for (const kind of ['container', 'network'])
    await removeAndConfirm(state, kind, execute);
  const confirmed = RESOURCE_KINDS.every((kind) => {
    const resource = state.manifest[kind];
    return resource.absent && !resource.uncertain;
  });
  state.manifest.cleanupConfirmed = confirmed;
  writeManifest(state);
  return confirmed;
}

function disposePrivateStorage(state) {
  verifyPrivateRoot(state.root);
  for (const kind of Object.keys(ARTIFACTS)) {
    const record = state.manifest.artifacts[kind];
    if (record && record.state !== 'complete')
      fail('Private artifact ownership is uncertain');
    if (record && !validateArtifactState(kind, record))
      fail('Private artifact identity changed');
    if (
      record?.state === 'complete' &&
      !fs.existsSync(path.join(state.root, ARTIFACTS[kind].filename))
    )
      fail('Private artifact identity changed');
  }
  const entries = fs.readdirSync(state.root);
  const validated = [];
  for (const name of entries) {
    const artifactKind = Object.keys(ARTIFACTS).find(
      (kind) => ARTIFACTS[kind].filename === name,
    );
    if (name !== MANIFEST_NAME && !artifactKind)
      fail('Unexpected recovery storage entry');
    const target = path.join(state.root, name);
    const stat = fs.lstatSync(target);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      (currentUid() !== undefined && stat.uid !== currentUid())
    )
      fail('Private recovery file required');
    if (name === MANIFEST_NAME) {
      if (
        !state.manifestIdentity ||
        stat.dev !== state.manifestIdentity.dev ||
        stat.ino !== state.manifestIdentity.ino
      )
        fail('Private recovery manifest identity changed');
    } else {
      const record = state.manifest.artifacts[artifactKind];
      if (
        !record ||
        record.state !== 'complete' ||
        stat.dev !== record.dev ||
        stat.ino !== record.ino ||
        stat.size !== record.size ||
        stat.size > ARTIFACTS[artifactKind].maxBytes
      )
        fail('Private artifact identity changed');
    }
    validated.push({ name, dev: stat.dev, ino: stat.ino });
  }
  validated.sort(
    (left, right) =>
      Number(left.name === MANIFEST_NAME) -
      Number(right.name === MANIFEST_NAME),
  );
  for (const { name, dev, ino } of validated) {
    const target = path.join(state.root, name);
    const current = fs.lstatSync(target);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== dev ||
      current.ino !== ino
    )
      fail('Private recovery inventory changed');
    fs.unlinkSync(target);
  }
  fs.rmdirSync(state.root);
  activeRoots.delete(state.root);
}

async function finalizeRecovery(
  context,
  { execute, proofSucceeded = false } = {},
) {
  const state = getState(context);
  state.finalizing = true;
  await Promise.allSettled([...state.pending]);
  let cleanupConfirmed = false;
  try {
    cleanupConfirmed = await reconcileOwnedResources(context, { execute });
  } catch {
    cleanupConfirmed = false;
  }
  state.manifest.proofSucceeded = proofSucceeded === true;
  state.manifest.cleanupConfirmed = cleanupConfirmed;
  let persisted = false;
  try {
    writeManifest(state);
    persisted = true;
  } catch {
    recordKnownFailure(state, 'cleanup', 'operation_failed');
  }
  const resourcesCreated =
    state.manifest.imageId !== null &&
    RESOURCE_KINDS.every((kind) => state.manifest[kind].id !== null);
  const eligible =
    proofSucceeded === true &&
    cleanupConfirmed &&
    resourcesCreated &&
    persisted;
  let disposed = false;
  if (eligible) {
    try {
      disposePrivateStorage(state);
      disposed = true;
    } catch {
      recordKnownFailure(state, 'cleanup', 'operation_failed');
    }
  }
  return Object.freeze({
    passed: eligible && disposed,
    proofSucceeded: proofSucceeded === true,
    cleanupConfirmed,
    recoveryRetained: !disposed,
    diagnostics: Object.freeze(
      state.manifest.diagnostics.map((diagnostic) =>
        Object.freeze({ ...diagnostic }),
      ),
    ),
  });
}

module.exports = {
  bindImageIdentity,
  captureCreation,
  createRecoveryContext,
  finalizeRecovery,
  openRecoveryContext,
  readRecoveryState,
  reconcileOwnedResources,
  reportFailure,
  validatePreparedArtifacts,
  writePrivateArtifact,
};
