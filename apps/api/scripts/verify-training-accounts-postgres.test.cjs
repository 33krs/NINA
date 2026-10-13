const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, describe, it } = require('node:test');
const {
  bindImageIdentity,
  captureCreation,
  createRecoveryContext,
  finalizeRecovery,
  openRecoveryContext,
  reconcileOwnedResources,
  readRecoveryState,
  reportFailure,
  writePrivateArtifact,
  validatePreparedArtifacts,
} = require('./verify-training-accounts-postgres.cjs');

const IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const CONTAINER_ID = 'b'.repeat(64);
const NETWORK_ID = 'c'.repeat(64);
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots)
    fs.rmSync(root, { recursive: true, force: true });
});

function createContext() {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'training-proof-test-'),
  );
  temporaryRoots.add(temporaryDirectory);
  return createRecoveryContext({ temporaryDirectory });
}

function resourceRows(context, { foreignNetworkMember = false } = {}) {
  return {
    container: {
      Id: CONTAINER_ID,
      Name: `/${context.name}`,
      Image: IMAGE_ID,
      Config: { Labels: context.labels },
    },
    network: {
      Id: NETWORK_ID,
      Name: context.name,
      Labels: context.labels,
      Containers: foreignNetworkMember ? { foreign: { Name: 'other' } } : {},
    },
  };
}

function dockerFailure(stderr, status = 1) {
  return Object.assign(new Error('synthetic private subprocess details'), {
    status,
    stderr,
  });
}

function fakeDocker(context, rows = resourceRows(context), options = {}) {
  const calls = [];
  const executionOptions = [];
  const present = { container: true, network: true };
  const execute = async (args, executionOptionsForCall) => {
    calls.push([...args]);
    executionOptions.push(executionOptionsForCall);
    if (args[0] === 'inspect' && args[1] === '--type') {
      const target = args[3];
      if (
        !present.container ||
        ![rows.container.Id, context.name].includes(target)
      )
        throw dockerFailure(`Error: No such object: ${target}`);
      return JSON.stringify([options.containerObservation ?? rows.container]);
    }
    if (args[0] === 'network' && args[1] === 'inspect') {
      const target = args[2];
      if (
        !present.network ||
        ![rows.network.Id, rows.network.Name].includes(target)
      )
        throw dockerFailure(
          `Error response from daemon: network ${target} not found`,
        );
      return JSON.stringify([options.networkObservation ?? rows.network]);
    }
    if (args[0] === 'rm' && args[1] === '-f') {
      if (options.removeContainerError) throw options.removeContainerError;
      assert.equal(args[2], rows.container.Id);
      present.container = false;
      return '';
    }
    if (args[0] === 'network' && args[1] === 'rm') {
      if (options.removeNetworkError) throw options.removeNetworkError;
      assert.equal(args[2], rows.network.Id);
      present.network = false;
      return '';
    }
    throw new Error('Unexpected synthetic Docker operation');
  };
  return { calls, execute, executionOptions, present };
}

async function captureOwnedPair(context, world = fakeDocker(context)) {
  bindImageIdentity(context, IMAGE_ID);
  await captureCreation(context, 'network', async () => NETWORK_ID);
  await captureCreation(context, 'container', async () => CONTAINER_ID);
  return world;
}

describe('training account PostgreSQL recovery foundation', () => {
  it('returns only exact validated paths for both complete private artifacts', () => {
    const context = createContext();
    writePrivateArtifact(context, 'proof_sql', 'SELECT 1;');
    writePrivateArtifact(context, 'postgres_env', 'POSTGRES_DB=synthetic\n');

    const prepared = validatePreparedArtifacts(context);

    assert.deepEqual(prepared, {
      proofSql: path.join(context.root, 'proof.sql'),
      postgresEnv: path.join(context.root, 'postgres.env'),
    });
    assert.equal(Object.isFrozen(prepared), true);
  });

  it('refuses incomplete, replaced, or foreign recovery artifacts', () => {
    const incomplete = createContext();
    writePrivateArtifact(incomplete, 'proof_sql', 'SELECT 1;');
    assert.throws(() => validatePreparedArtifacts(incomplete));

    const replaced = createContext();
    writePrivateArtifact(replaced, 'proof_sql', 'SELECT 1;');
    writePrivateArtifact(replaced, 'postgres_env', 'POSTGRES_DB=synthetic\n');
    fs.unlinkSync(path.join(replaced.root, 'proof.sql'));
    fs.writeFileSync(path.join(replaced.root, 'proof.sql'), 'SELECT 1;');
    fs.chmodSync(path.join(replaced.root, 'proof.sql'), 0o600);
    assert.throws(() => validatePreparedArtifacts(replaced));

    const foreign = Object.freeze({ ...replaced });
    assert.throws(() => validatePreparedArtifacts(foreign));
  });

  it('revalidates the canonical root and rejects linked artifact files', () => {
    const aliased = createContext();
    writePrivateArtifact(aliased, 'proof_sql', 'SELECT 1;');
    writePrivateArtifact(aliased, 'postgres_env', 'POSTGRES_DB=synthetic\n');
    const movedRoot = `${aliased.root}-moved`;
    fs.renameSync(aliased.root, movedRoot);
    fs.symlinkSync(movedRoot, aliased.root);
    assert.throws(() => validatePreparedArtifacts(aliased));

    const linked = createContext();
    writePrivateArtifact(linked, 'proof_sql', 'SELECT 1;');
    writePrivateArtifact(linked, 'postgres_env', 'POSTGRES_DB=synthetic\n');
    fs.linkSync(
      path.join(linked.root, 'proof.sql'),
      path.join(path.dirname(linked.root), 'foreign-proof-link'),
    );
    assert.throws(() => validatePreparedArtifacts(linked));
  });

  it('creates fresh immutable run identity and private recovery files', () => {
    const first = createContext();
    const second = createContext();
    const rootInfo = fs.statSync(first.root);
    const manifestInfo = fs.statSync(first.manifestPath);

    assert.notEqual(first.runId, second.runId);
    assert.match(first.runId, /^[0-9a-f-]{36}$/);
    assert.equal(first.name, `nina-training-postgres-${first.runId}`);
    assert.equal(rootInfo.mode & 0o777, 0o700);
    assert.equal(manifestInfo.mode & 0o777, 0o600);
    assert.ok(Object.isFrozen(first));
    assert.ok(Object.isFrozen(first.labels));
    assert.throws(() => openRecoveryContext(path.join(first.root, '..')));
  });

  it('writes only fixed private artifacts and persists non-content identity metadata', () => {
    const context = createContext();
    const proof = 'SELECT 1;';
    const environment = 'PGHOST=127.0.0.1\n';

    writePrivateArtifact(context, 'proof_sql', proof);
    writePrivateArtifact(context, 'postgres_env', environment);

    for (const [name, content] of [
      ['proof.sql', proof],
      ['postgres.env', environment],
    ]) {
      const filename = path.join(context.root, name);
      const stat = fs.lstatSync(filename);
      assert.equal(stat.isFile(), true);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.nlink, 1);
      assert.equal(stat.mode & 0o777, 0o600);
      assert.equal(fs.readFileSync(filename, 'utf8'), content);
    }

    const manifestText = fs.readFileSync(context.manifestPath, 'utf8');
    assert.equal(manifestText.includes(proof), false);
    assert.equal(manifestText.includes(environment), false);
    assert.deepEqual(Object.keys(readRecoveryState(context).artifacts).sort(), [
      'postgres_env',
      'proof_sql',
    ]);
  });

  it('rejects a symlink-replaced recovery root before persisting artifact intent', () => {
    const context = createContext();
    const originalRoot = context.root;
    const movedRoot = `${originalRoot}-moved`;
    const manifest = fs.readFileSync(context.manifestPath);
    fs.renameSync(originalRoot, movedRoot);
    fs.symlinkSync(movedRoot, originalRoot);

    assert.throws(
      () => writePrivateArtifact(context, 'proof_sql', 'SELECT 1;'),
      /Private recovery directory required/,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(movedRoot, 'recovery.json')),
      manifest,
    );
    assert.equal(fs.existsSync(path.join(movedRoot, 'proof.sql')), false);
  });

  it('rejects forged contexts, unknown kinds, invalid content, and duplicate writes', () => {
    const context = createContext();
    const write = () => writePrivateArtifact(context, 'proof_sql', 'SELECT 1;');
    assert.throws(() => writePrivateArtifact({}, 'proof_sql', 'x'));
    assert.throws(() => writePrivateArtifact(context, '../recovery.json', 'x'));
    assert.throws(() =>
      writePrivateArtifact(context, 'proof_sql', Buffer.from('x')),
    );
    assert.throws(() =>
      writePrivateArtifact(context, 'proof_sql', 'x'.repeat(16 * 1024 + 1)),
    );
    assert.throws(() =>
      writePrivateArtifact(context, 'postgres_env', 'x'.repeat(4 * 1024 + 1)),
    );
    assert.throws(() =>
      writePrivateArtifact(context, 'proof_sql', '💡'.repeat(5 * 1024)),
    );
    write();
    assert.throws(write);
  });

  it('retains an exclusive-create collision without adopting its file', async () => {
    const context = createContext();
    const world = await captureOwnedPair(context);
    const filename = path.join(context.root, 'proof.sql');
    fs.writeFileSync(filename, 'foreign evidence', { mode: 0o600, flag: 'wx' });
    assert.throws(
      () => writePrivateArtifact(context, 'proof_sql', 'SELECT 1;'),
      /Private artifact write failed/,
    );
    assert.equal(fs.readFileSync(filename, 'utf8'), 'foreign evidence');
    assert.equal(
      readRecoveryState(context).artifacts.proof_sql.state,
      'intent',
    );
    const result = await finalizeRecovery(context, {
      execute: world.execute,
      proofSucceeded: true,
    });
    assert.equal(result.passed, false);
    assert.equal(result.recoveryRetained, true);
    assert.equal(fs.readFileSync(filename, 'utf8'), 'foreign evidence');
  });

  it('reopens artifact identity after a fresh module load', () => {
    const context = createContext();
    writePrivateArtifact(context, 'proof_sql', 'SELECT 1;');
    writePrivateArtifact(context, 'postgres_env', 'PGHOST=127.0.0.1\n');
    const modulePath =
      require.resolve('./verify-training-accounts-postgres.cjs');
    delete require.cache[modulePath];
    const reopenedModule = require('./verify-training-accounts-postgres.cjs');
    const reopened = reopenedModule.openRecoveryContext(context.root);
    assert.deepEqual(
      reopenedModule.readRecoveryState(reopened).artifacts.proof_sql,
      readRecoveryState(context).artifacts.proof_sql,
    );
    assert.deepEqual(
      reopenedModule.readRecoveryState(reopened).artifacts.postgres_env,
      readRecoveryState(context).artifacts.postgres_env,
    );
  });

  it('opens legacy version-one manifests as empty artifact inventories without adoption', () => {
    const context = createContext();
    const legacy = JSON.parse(fs.readFileSync(context.manifestPath, 'utf8'));
    legacy.version = 1;
    delete legacy.artifacts;
    fs.writeFileSync(context.manifestPath, JSON.stringify(legacy), {
      mode: 0o600,
    });

    const modulePath =
      require.resolve('./verify-training-accounts-postgres.cjs');
    delete require.cache[modulePath];
    const reopenedModule = require('./verify-training-accounts-postgres.cjs');
    const reopened = reopenedModule.openRecoveryContext(context.root);
    const state = reopenedModule.readRecoveryState(reopened);
    assert.equal(state.version, 2);
    assert.deepEqual(state.artifacts, {
      proof_sql: null,
      postgres_env: null,
    });
    reopenedModule.writePrivateArtifact(reopened, 'proof_sql', 'SELECT 1;');
    assert.equal(
      reopenedModule.readRecoveryState(reopened).artifacts.proof_sql.state,
      'complete',
    );
  });

  it('rejects a changed completed artifact when reopening its recovery root', () => {
    const context = createContext();
    writePrivateArtifact(context, 'proof_sql', 'SELECT 1;');
    const artifact = path.join(context.root, 'proof.sql');
    fs.unlinkSync(artifact);
    fs.writeFileSync(artifact, 'replacement', { mode: 0o600, flag: 'wx' });

    const modulePath =
      require.resolve('./verify-training-accounts-postgres.cjs');
    delete require.cache[modulePath];
    const reopenedModule = require('./verify-training-accounts-postgres.cjs');
    assert.throws(
      () => reopenedModule.openRecoveryContext(context.root),
      /Private artifact identity changed/,
    );
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'replacement');
  });

  it('writes artifact contents with one bounded filesystem write', () => {
    const context = createContext();
    const originalWriteSync = fs.writeSync;
    let writes = 0;
    fs.writeSync = (...args) => {
      writes++;
      return originalWriteSync(...args);
    };
    try {
      writePrivateArtifact(context, 'proof_sql', 'SELECT 1;');
    } finally {
      fs.writeSync = originalWriteSync;
    }
    assert.equal(writes, 1);
  });

  it('retains incomplete artifact intent after durable metadata persistence fails', async () => {
    const context = createContext();
    const originalRename = fs.renameSync;
    let manifestRenames = 0;
    fs.renameSync = function (source, destination) {
      if (destination === context.manifestPath && ++manifestRenames === 3)
        throw new Error('synthetic manifest failure');
      return originalRename.call(this, source, destination);
    };
    try {
      assert.throws(
        () => writePrivateArtifact(context, 'proof_sql', 'SELECT 1;'),
        /Private artifact write failed/,
      );
    } finally {
      fs.renameSync = originalRename;
    }
    const filename = path.join(context.root, 'proof.sql');
    assert.equal(fs.existsSync(filename), true);

    const modulePath =
      require.resolve('./verify-training-accounts-postgres.cjs');
    delete require.cache[modulePath];
    const reopenedModule = require('./verify-training-accounts-postgres.cjs');
    const reopened = reopenedModule.openRecoveryContext(context.root);
    assert.equal(
      reopenedModule.readRecoveryState(reopened).artifacts.proof_sql.state,
      'owned',
    );
    const world = fakeDocker(context);
    const result = await reopenedModule.finalizeRecovery(reopened, {
      execute: world.execute,
      proofSucceeded: true,
    });
    assert.equal(result.passed, false);
    assert.equal(result.recoveryRetained, true);
    assert.equal(fs.existsSync(filename), true);
  });

  it('retains a persisted creation intent after reopening an interrupted write', async () => {
    const context = createContext();
    const world = await captureOwnedPair(context);
    const manifest = JSON.parse(fs.readFileSync(context.manifestPath, 'utf8'));
    manifest.artifacts.proof_sql = {
      state: 'intent',
      dev: null,
      ino: null,
      size: null,
    };
    fs.writeFileSync(context.manifestPath, JSON.stringify(manifest), {
      mode: 0o600,
    });

    const modulePath =
      require.resolve('./verify-training-accounts-postgres.cjs');
    delete require.cache[modulePath];
    const reopenedModule = require('./verify-training-accounts-postgres.cjs');
    const reopened = reopenedModule.openRecoveryContext(context.root);
    const result = await reopenedModule.finalizeRecovery(reopened, {
      execute: world.execute,
      proofSucceeded: true,
    });
    assert.equal(result.passed, false);
    assert.equal(result.recoveryRetained, true);
    assert.equal(fs.existsSync(context.manifestPath), true);
    assert.equal(fs.existsSync(path.join(context.root, 'proof.sql')), false);
  });

  it('reopens only a valid private recovery manifest', async () => {
    const context = createContext();
    const reopened = openRecoveryContext(context.root);
    assert.equal(reopened.runId, context.runId);
    assert.equal(readRecoveryState(reopened).version, 2);
    assert.throws(() => openRecoveryContext(os.tmpdir()));
    const forged = { ...context };
    assert.throws(() =>
      captureCreation(forged, 'network', async () => NETWORK_ID),
    );
  });

  it('snapshots hostile diagnostic fields once and persists only allowlisted data', () => {
    const context = createContext();
    const reads = { code: 0, status: 0, sqlState: 0, stderr: 0, message: 0 };
    const error = {};
    Object.defineProperties(error, {
      code: {
        get() {
          reads.code++;
          return 'private-node-code';
        },
      },
      status: {
        get() {
          reads.status++;
          return 999;
        },
      },
      sqlState: {
        get() {
          reads.sqlState++;
          return 'secret-sqlstate';
        },
      },
      stderr: {
        get() {
          reads.stderr++;
          return 'secret stderr contents';
        },
      },
      message: {
        get() {
          reads.message++;
          return 'private message';
        },
      },
    });

    const diagnostic = reportFailure(context, 'sql_assertion', error);
    const persisted = fs.readFileSync(context.manifestPath, 'utf8');
    assert.deepEqual(diagnostic, {
      stage: 'sql_assertion',
      reason: 'operation_failed',
    });
    assert.deepEqual(reads, {
      code: 1,
      status: 1,
      sqlState: 1,
      stderr: 1,
      message: 0,
    });
    assert.doesNotMatch(
      persisted,
      /private-node-code|secret-sqlstate|secret stderr|private message/,
    );
    assert.throws(() => reportFailure(context, 'untrusted stage', error));
  });

  it('uses one immutable snapshot when diagnostic getters change between reads', () => {
    const context = createContext();
    let reads = 0;
    const error = Object.defineProperty({}, 'code', {
      get() {
        reads++;
        return reads === 1 ? 'EPERM' : 'secret-changing-code';
      },
    });
    const diagnostic = reportFailure(context, 'resource_inspect', error);
    assert.deepEqual(diagnostic, {
      stage: 'resource_inspect',
      reason: 'node_error',
      nodeCode: 'EPERM',
    });
    assert.equal(reads, 1);
    assert.doesNotMatch(
      fs.readFileSync(context.manifestPath, 'utf8'),
      /secret-changing-code/,
    );
  });

  it('records only approved SQLSTATE, bounded exit status, or allowlisted node codes', () => {
    const context = createContext();
    assert.deepEqual(
      reportFailure(context, 'sql_assertion', { code: '23514', status: 2 }),
      {
        stage: 'sql_assertion',
        reason: 'sqlstate',
        sqlState: '23514',
        exitStatus: 2,
      },
    );
    assert.deepEqual(
      reportFailure(context, 'image_inspect', { code: 'EPERM', status: 256 }),
      { stage: 'image_inspect', reason: 'node_error', nodeCode: 'EPERM' },
    );
  });

  it('accepts only the fixed fixture-preparation diagnostic stages', () => {
    const context = createContext();
    for (const stage of [
      'fixture_source_read',
      'fixture_helper_load',
      'fixture_hash',
      'fixture_sql_build',
      'fixture_sql_write',
      'fixture_env_write',
    ]) {
      assert.equal(
        reportFailure(context, stage, new Error('private detail')).stage,
        stage,
      );
    }
    assert.throws(() =>
      reportFailure(
        context,
        'fixture_sql_execute',
        new Error('private detail'),
      ),
    );
  });

  it('persists creation uncertainty before invoking the operation and the exact ID before returning', async () => {
    const context = createContext();
    let beforeCall;
    await captureCreation(context, 'network', async () => {
      beforeCall = readRecoveryState(context).network.uncertain;
      return NETWORK_ID;
    });
    assert.equal(beforeCall, true);
    assert.deepEqual(readRecoveryState(context).network, {
      id: NETWORK_ID,
      uncertain: false,
      absent: false,
    });
  });

  it('registers synchronous creation callbacks before reentrant reconciliation', async () => {
    const context = createContext();
    let cleanupStarted = false;
    const execute = async (args) => {
      cleanupStarted = true;
      const target = args.at(-1);
      throw Object.assign(new Error('synthetic target absence'), {
        status: 1,
        stderr: `Error response from daemon: network ${target} not found`,
      });
    };
    let finishCreation;
    let reconciling;
    const creation = captureCreation(context, 'network', () => {
      reconciling = reconcileOwnedResources(context, {
        execute,
      });
      return new Promise((resolve) => {
        finishCreation = () => resolve(NETWORK_ID);
      });
    });
    const creationResultPromise = creation.then(
      () => 'succeeded',
      () => readRecoveryState(context).diagnostics[0]?.reason,
    );

    await new Promise((resolve) => setImmediate(resolve));
    const cleanupStartedBeforeSettlement = cleanupStarted;
    finishCreation();
    const creationResult = await creationResultPromise;
    assert.equal(creationResult, 'succeeded');
    assert.equal(await reconciling, true);
    assert.equal(cleanupStartedBeforeSettlement, false);
    assert.equal(cleanupStarted, true);
  });

  it('shares in-flight creation state when reopening a private root', async () => {
    const context = createContext();
    const world = fakeDocker(context);
    let finishCreation;
    const creation = captureCreation(
      context,
      'network',
      () =>
        new Promise((_resolve, reject) => {
          finishCreation = () =>
            reject(new Error('synthetic creation failure'));
        }),
    );
    const reopened = openRecoveryContext(context.root);
    assert.equal(reopened.runId, context.runId);
    const finalizing = finalizeRecovery(reopened, {
      execute: world.execute,
      proofSucceeded: false,
    });

    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(
        world.calls.filter(
          (args) =>
            args[0] === 'rm' || (args[0] === 'network' && args[1] === 'rm'),
        ),
        [],
      );
    } finally {
      finishCreation();
    }
    await assert.rejects(creation, /Training resource creation failed/);
    const result = await finalizing;
    assert.equal(result.cleanupConfirmed, true);
  });

  it('retains and reopens an exact ID when durable persistence fails after creation', async () => {
    const context = createContext();
    const rename = fs.renameSync;
    let manifestRenames = 0;
    fs.renameSync = function (source, destination) {
      if (destination === context.manifestPath && ++manifestRenames === 2)
        throw Object.assign(new Error('private persistence detail'), {
          code: 'EIO',
        });
      return rename.call(this, source, destination);
    };
    try {
      await assert.rejects(
        captureCreation(context, 'network', async () => NETWORK_ID),
        /Training resource creation failed/,
      );
    } finally {
      fs.renameSync = rename;
    }
    const reopened = openRecoveryContext(context.root);
    assert.deepEqual(readRecoveryState(reopened).network, {
      id: NETWORK_ID,
      uncertain: true,
      absent: false,
    });

    const world = fakeDocker(reopened);
    const result = await finalizeRecovery(reopened, {
      execute: world.execute,
      proofSucceeded: false,
    });
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.recoveryRetained, true);
    assert.equal(world.present.network, false);
  });

  it('accepts an exact case-insensitive absence for the inspected target only', async () => {
    const context = createContext();
    const world = await captureOwnedPair(context);
    world.present.container = false;
    const execute = world.execute;
    world.execute = async (args, executionOptionsForCall) => {
      if (args[0] === 'inspect' && args[1] === '--type')
        throw dockerFailure(
          `error response from daemon: NO SUCH CONTAINER: ${args[3]}`,
        );
      return execute(args, executionOptionsForCall);
    };
    const result = await finalizeRecovery(context, {
      execute: world.execute,
      proofSucceeded: false,
    });
    assert.equal(result.passed, false);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.recoveryRetained, true);
    assert.equal(world.present.network, false);
    assert.ok(world.executionOptions.length > 0);
    assert.ok(
      world.executionOptions.every(
        (options) => options.timeout === 5_000 && options.signal === undefined,
      ),
    );
  });

  it('removes a response-lost owned container before its network and retains failed-proof evidence', async () => {
    const context = createContext();
    bindImageIdentity(context, IMAGE_ID);
    const rows = resourceRows(context);
    const world = fakeDocker(context, rows);
    await captureCreation(context, 'network', async () => NETWORK_ID);
    await assert.rejects(
      captureCreation(context, 'container', async () => {
        world.present.container = true;
        throw dockerFailure('synthetic response lost with private output');
      }),
      /Training resource creation failed/,
    );
    const result = await finalizeRecovery(context, {
      execute: world.execute,
      proofSucceeded: false,
    });

    assert.equal(result.passed, false);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.recoveryRetained, true);
    const removed = world.calls.filter(
      (args) => args[0] === 'rm' || (args[0] === 'network' && args[1] === 'rm'),
    );
    assert.deepEqual(removed, [
      ['rm', '-f', CONTAINER_ID],
      ['network', 'rm', NETWORK_ID],
    ]);
    assert.equal(readRecoveryState(context).container.id, CONTAINER_ID);
    assert.doesNotMatch(
      fs.readFileSync(context.manifestPath, 'utf8'),
      /private output/,
    );
  });

  it('refuses image or ownership mismatches without deleting the observed container', async () => {
    const mutations = [
      (row) => {
        row.Image = `sha256:${'d'.repeat(64)}`;
      },
      (row, context) => {
        row.Name = `/other-${context.name}`;
      },
      (row, context) => {
        row.Config.Labels = {
          ...context.labels,
          'nina.training-postgres.run': 'other-run',
        };
      },
      (row, context) => {
        row.Config.Labels = { ...context.labels, unexpected: 'label' };
      },
    ];
    for (const mutate of mutations) {
      const context = createContext();
      const rows = resourceRows(context);
      mutate(rows.container, context);
      const world = await captureOwnedPair(context, fakeDocker(context, rows));
      const result = await finalizeRecovery(context, {
        execute: world.execute,
        proofSucceeded: true,
      });
      assert.equal(result.passed, false);
      assert.equal(result.cleanupConfirmed, false);
      assert.equal(
        world.calls.some((args) => args[0] === 'rm'),
        false,
      );
      assert.equal(result.recoveryRetained, true);
    }
  });

  it('refuses network name or run-label mismatches before network removal', async () => {
    for (const mutate of [
      (row, context) => {
        row.Name = `other-${context.name}`;
      },
      (row, context) => {
        row.Labels = {
          ...context.labels,
          'nina.training-postgres.run': 'other-run',
        };
      },
    ]) {
      const context = createContext();
      const rows = resourceRows(context);
      mutate(rows.network, context);
      const world = await captureOwnedPair(context, fakeDocker(context, rows));
      const result = await finalizeRecovery(context, {
        execute: world.execute,
        proofSucceeded: false,
      });
      assert.equal(result.passed, false);
      assert.equal(result.cleanupConfirmed, false);
      assert.equal(
        world.calls.some((args) => args[0] === 'network' && args[1] === 'rm'),
        false,
      );
    }
  });

  it('refuses to remove a network that still has a foreign member', async () => {
    const context = createContext();
    const world = await captureOwnedPair(
      context,
      fakeDocker(
        context,
        resourceRows(context, { foreignNetworkMember: true }),
      ),
    );
    const result = await finalizeRecovery(context, {
      execute: world.execute,
      proofSucceeded: false,
    });
    assert.equal(result.passed, false);
    assert.equal(result.cleanupConfirmed, false);
    assert.equal(
      world.calls.some((args) => args[0] === 'network' && args[1] === 'rm'),
      false,
    );
    assert.equal(result.recoveryRetained, true);
  });

  it('fails closed on malformed inspection shapes and daemon permission failures', async (t) => {
    for (const observation of ['null', '[]', '[null]', '[[]]', '[{},{}]']) {
      await t.test(`inspection ${observation}`, async () => {
        const context = createContext();
        const world = await captureOwnedPair(context);
        world.execute = async (args) => {
          if (args[0] === 'inspect') return observation;
          throw new Error('unexpected removal');
        };
        const result = await finalizeRecovery(context, {
          execute: world.execute,
          proofSucceeded: true,
        });
        assert.equal(result.passed, false);
        assert.equal(result.cleanupConfirmed, false);
        assert.equal(result.recoveryRetained, true);
      });
    }

    const context = createContext();
    const world = await captureOwnedPair(context);
    world.execute = async () => {
      throw dockerFailure('permission denied');
    };
    const result = await finalizeRecovery(context, {
      execute: world.execute,
      proofSucceeded: true,
    });
    assert.equal(result.passed, false);
    assert.equal(result.recoveryRetained, true);

    const unrelatedAbsenceContext = createContext();
    const unrelatedAbsence = await captureOwnedPair(unrelatedAbsenceContext);
    unrelatedAbsence.execute = async (args) => {
      if (args[0] === 'inspect')
        throw dockerFailure('Error: No such object: unrelated-target');
      throw new Error('unexpected operation');
    };
    const unrelatedAbsenceResult = await finalizeRecovery(
      unrelatedAbsenceContext,
      {
        execute: unrelatedAbsence.execute,
        proofSucceeded: false,
      },
    );
    assert.equal(unrelatedAbsenceResult.cleanupConfirmed, false);
    assert.equal(unrelatedAbsenceResult.recoveryRetained, true);

    const networkMalformedContext = createContext();
    const networkMalformed = await captureOwnedPair(networkMalformedContext);
    let containerPresent = true;
    networkMalformed.execute = async (args) => {
      if (args[0] === 'inspect' && args[1] === '--type' && containerPresent)
        return JSON.stringify([
          resourceRows(networkMalformedContext).container,
        ]);
      if (args[0] === 'inspect' && args[1] === '--type')
        throw dockerFailure(`Error: No such object: ${args[3]}`);
      if (args[0] === 'rm') {
        containerPresent = false;
        return '';
      }
      if (args[0] === 'network' && args[1] === 'inspect') return '[null]';
      throw new Error('unexpected operation');
    };
    const networkMalformedResult = await finalizeRecovery(
      networkMalformedContext,
      {
        execute: networkMalformed.execute,
        proofSucceeded: false,
      },
    );
    assert.equal(networkMalformedResult.cleanupConfirmed, false);
    assert.equal(networkMalformedResult.recoveryRetained, true);
  });

  it('accepts a failed removal only after independently confirming target absence', async () => {
    const context = createContext();
    const world = await captureOwnedPair(context);
    world.execute = async (args) => {
      if (args[0] === 'rm') throw dockerFailure('private remove details', 1);
      if (args[0] === 'network' && args[1] === 'rm')
        throw dockerFailure('private remove details', 1);
      if (args[0] === 'inspect')
        throw dockerFailure(`Error: No such object: ${args.at(-1)}`);
      if (args[0] === 'network' && args[1] === 'inspect')
        throw dockerFailure(`Error: No such network: ${args.at(-1)}`);
      throw new Error('unexpected operation');
    };
    const result = await finalizeRecovery(context, {
      execute: world.execute,
      proofSucceeded: false,
    });
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.passed, false);
    assert.equal(result.recoveryRetained, true);
    assert.doesNotMatch(
      fs.readFileSync(context.manifestPath, 'utf8'),
      /private remove details/,
    );
  });

  it('retains recovery state when a failed removal leaves the owned resource present', async () => {
    const context = createContext();
    const world = await captureOwnedPair(context);
    world.execute = async (args) => {
      if (args[0] === 'rm') throw dockerFailure('private remove failure', 1);
      if (args[0] === 'inspect' && args[1] === '--type')
        return JSON.stringify([resourceRows(context).container]);
      throw new Error('unexpected operation');
    };
    const result = await finalizeRecovery(context, {
      execute: world.execute,
      proofSucceeded: true,
    });
    assert.equal(result.passed, false);
    assert.equal(result.cleanupConfirmed, false);
    assert.equal(result.recoveryRetained, true);
    assert.match(
      fs.readFileSync(context.manifestPath, 'utf8'),
      /resource_present/,
    );
    assert.doesNotMatch(
      fs.readFileSync(context.manifestPath, 'utf8'),
      /private remove failure/,
    );
  });

  it('waits for cancelled in-flight creation to settle before cleanup', async () => {
    const context = createContext();
    bindImageIdentity(context, IMAGE_ID);
    const controller = new AbortController();
    const rows = resourceRows(context);
    const world = fakeDocker(context, rows);
    await captureCreation(context, 'network', async () => NETWORK_ID);
    let finishCreation;
    const creation = captureCreation(
      context,
      'container',
      ({ signal }) =>
        new Promise((resolve, reject) => {
          finishCreation = () => {
            if (signal.aborted) reject(new Error('cancelled'));
            else resolve(CONTAINER_ID);
          };
        }),
      { signal: controller.signal },
    );
    const settled = creation.catch(() => undefined);
    controller.abort();
    const finalizing = finalizeRecovery(context, {
      execute: world.execute,
      proofSucceeded: false,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(world.calls.length, 0);
    finishCreation();
    await settled;
    const result = await finalizing;
    assert.equal(result.cleanupConfirmed, true);
    assert.deepEqual(
      world.calls.filter(
        (args) =>
          args[0] === 'rm' || (args[0] === 'network' && args[1] === 'rm'),
      ),
      [
        ['rm', '-f', CONTAINER_ID],
        ['network', 'rm', NETWORK_ID],
      ],
    );
  });

  it('retains both private artifacts whenever proof has not succeeded', async () => {
    const context = createContext();
    const world = await captureOwnedPair(context);
    writePrivateArtifact(context, 'proof_sql', 'SELECT 1;');
    writePrivateArtifact(context, 'postgres_env', 'PGHOST=127.0.0.1\n');
    const result = await finalizeRecovery(context, {
      execute: world.execute,
      proofSucceeded: false,
    });
    assert.equal(result.passed, false);
    assert.equal(result.recoveryRetained, true);
    assert.equal(fs.existsSync(path.join(context.root, 'proof.sql')), true);
    assert.equal(fs.existsSync(path.join(context.root, 'postgres.env')), true);
  });

  it('retains both private artifacts whenever owned-resource cleanup is incomplete', async () => {
    const context = createContext();
    const world = await captureOwnedPair(
      context,
      fakeDocker(context, resourceRows(context), {
        removeContainerError: new Error('synthetic removal failure'),
      }),
    );
    writePrivateArtifact(context, 'proof_sql', 'SELECT 1;');
    writePrivateArtifact(context, 'postgres_env', 'PGHOST=127.0.0.1\n');
    const result = await finalizeRecovery(context, {
      execute: world.execute,
      proofSucceeded: true,
    });
    assert.equal(result.passed, false);
    assert.equal(result.cleanupConfirmed, false);
    assert.equal(result.recoveryRetained, true);
    assert.equal(fs.existsSync(path.join(context.root, 'proof.sql')), true);
    assert.equal(fs.existsSync(path.join(context.root, 'postgres.env')), true);
  });

  it('validates the full private inventory before its first unlink', async () => {
    const context = createContext();
    const world = await captureOwnedPair(context);
    writePrivateArtifact(context, 'proof_sql', 'SELECT 1;');
    const foreignPath = path.join(context.root, 'foreign.bin');
    fs.writeFileSync(foreignPath, 'foreign', { mode: 0o600, flag: 'wx' });
    const originalUnlink = fs.unlinkSync;
    let unlinks = 0;
    fs.unlinkSync = (...args) => {
      unlinks++;
      return originalUnlink(...args);
    };
    let result;
    try {
      result = await finalizeRecovery(context, {
        execute: world.execute,
        proofSucceeded: true,
      });
    } finally {
      fs.unlinkSync = originalUnlink;
    }
    assert.equal(unlinks, 0);
    assert.equal(result.passed, false);
    assert.equal(result.recoveryRetained, true);
    assert.equal(fs.existsSync(context.manifestPath), true);
    assert.equal(fs.existsSync(path.join(context.root, 'proof.sql')), true);
    assert.equal(fs.existsSync(foreignPath), true);
  });

  it('refuses to dispose an artifact replaced by a symlink or hard link', async () => {
    for (const replacement of ['symlink', 'hardlink']) {
      const context = createContext();
      const world = await captureOwnedPair(context);
      writePrivateArtifact(context, 'proof_sql', 'SELECT 1;');
      const artifact = path.join(context.root, 'proof.sql');
      const outside = path.join(
        path.dirname(context.root),
        `${replacement}.bin`,
      );
      fs.writeFileSync(outside, 'foreign replacement', {
        mode: 0o600,
        flag: 'wx',
      });
      fs.unlinkSync(artifact);
      if (replacement === 'symlink') fs.symlinkSync(outside, artifact);
      else fs.linkSync(outside, artifact);

      const result = await finalizeRecovery(context, {
        execute: world.execute,
        proofSucceeded: true,
      });
      assert.equal(result.passed, false);
      assert.equal(result.recoveryRetained, true);
      assert.equal(fs.existsSync(context.manifestPath), true);
      assert.equal(fs.readFileSync(outside, 'utf8'), 'foreign replacement');
    }
  });

  it('refuses a same-name replacement with a different file identity', async () => {
    const context = createContext();
    const world = await captureOwnedPair(context);
    writePrivateArtifact(context, 'proof_sql', 'SELECT 1;');
    const artifact = path.join(context.root, 'proof.sql');
    fs.unlinkSync(artifact);
    fs.writeFileSync(artifact, 'foreign replacement', {
      mode: 0o600,
      flag: 'wx',
    });

    const result = await finalizeRecovery(context, {
      execute: world.execute,
      proofSucceeded: true,
    });
    assert.equal(result.passed, false);
    assert.equal(result.recoveryRetained, true);
    assert.equal(fs.readFileSync(artifact, 'utf8'), 'foreign replacement');
    assert.equal(fs.existsSync(context.manifestPath), true);
  });

  it('passes and disposes private evidence only after proof success and confirmed cleanup', async () => {
    const context = createContext();
    const world = await captureOwnedPair(context);
    writePrivateArtifact(context, 'proof_sql', 'SELECT 1;');
    writePrivateArtifact(context, 'postgres_env', 'PGHOST=127.0.0.1\n');
    const result = await finalizeRecovery(context, {
      execute: world.execute,
      proofSucceeded: true,
    });
    assert.equal(result.passed, true);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.recoveryRetained, false);
    assert.equal(fs.existsSync(context.root), false);
    assert.equal(world.present.container, false);
    assert.equal(world.present.network, false);
  });
});
