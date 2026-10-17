const { performance } = require('node:perf_hooks');
const {
  run,
  dockerArgs,
  createPossiblyOwned,
} = require('./verify-odontogram-postgres.cjs');
const trackers = new WeakMap();
const {
  createResourceContext,
  ownedResourceId,
  isResourceAbsent,
} = require('./pharmacy-redis-resource-identity.cjs');

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function createResourceTracker(input) {
  const context = createResourceContext(input);
  const tracker = Object.freeze({});
  trackers.set(tracker, { ...context, pending: 0 });
  return tracker;
}

function stateOf(tracker) {
  const state = trackers.get(tracker);
  check(state, 'Known Redis resource tracker required');
  return state;
}

// Only the future orchestrator supplies its own bounded creation operation.
// The callback never establishes removal authority: inspected identity does.
async function captureCreation(tracker, kind, create) {
  const state = stateOf(tracker);
  check(
    ['container', 'network'].includes(kind) && typeof create === 'function',
    'Known Redis creation operation required',
  );
  check(
    !state[kind] && !state[kind + 'Uncertain'],
    'Redis creation already tracked',
  );
  state.pending++;
  try {
    return await createPossiblyOwned(state, kind + 'Uncertain', async () => {
      const output = await create();
      check(
        typeof output === 'string' && /^[\da-f]{64}$/.test(output.trim()),
        'Exact Redis resource ID required',
      );
      state[kind] = output.trim();
      return state[kind];
    });
  } catch {
    throw new Error('Redis resource creation failed');
  } finally {
    state.pending--;
  }
}

async function reconcileResources(tracker, { timeoutMs = 30000 } = {}) {
  const state = stateOf(tracker);
  check(!state.pending, 'Redis creation must settle before cleanup');
  check(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000,
    'Bounded Redis cleanup deadline required',
  );
  const deadline = performance.now() + timeoutMs;
  // Cleanup gets its own deadline, never an already-aborted creation signal.
  const execute = async (args) => {
    const remaining = Math.floor(deadline - performance.now());
    check(remaining > 0, 'Redis cleanup deadline exceeded');
    return run('/usr/bin/docker', dockerArgs(args), {
      env: { PATH: '/usr/bin:/bin', HOME: state.root },
      timeout: Math.min(5000, remaining),
    });
  };
  const inspect = async (kind, target) => {
    let output;
    try {
      output = await execute(
        kind === 'container'
          ? ['inspect', '--type', 'container', target]
          : ['network', 'inspect', target],
      );
    } catch (error) {
      if (isResourceAbsent(error, kind, target)) return undefined;
      throw new Error('Redis resource inspection failed');
    }
    let rows;
    try {
      rows = JSON.parse(output);
    } catch {
      throw new Error('Invalid Redis resource observation');
    }
    check(
      Array.isArray(rows) && rows.length === 1,
      'One Redis resource observation required',
    );
    check(
      rows[0] !== null &&
        typeof rows[0] === 'object' &&
        !Array.isArray(rows[0]),
      'Invalid Redis resource observation',
    );
    return rows[0];
  };
  for (const kind of ['container', 'network']) {
    if (!state[kind] && !state[kind + 'Uncertain']) continue;
    const target = state[kind] ?? state.name;
    const row = await inspect(kind, target);
    if (row === undefined) {
      state[kind] = undefined;
      state[kind + 'Uncertain'] = false;
      continue;
    }
    const id = ownedResourceId(state, kind, row, state[kind]);
    state[kind] = id;
    if (kind === 'network')
      check(
        row.Containers &&
          typeof row.Containers === 'object' &&
          !Array.isArray(row.Containers) &&
          Object.keys(row.Containers).length === 0,
        'Redis network still has members; refusing removal',
      );
    // A failed remove may still have succeeded in the daemon. Absence decides.
    try {
      await execute(
        kind === 'container' ? ['rm', '-f', id] : ['network', 'rm', id],
      );
    } catch {
      /* Inspect below; never claim cleanup from the remove exit alone. */
    }
    check(
      (await inspect(kind, id)) === undefined,
      'Redis resource still present after removal',
    );
    state[kind] = undefined;
    state[kind + 'Uncertain'] = false;
  }
}

module.exports = { createResourceTracker, captureCreation, reconcileResources };
