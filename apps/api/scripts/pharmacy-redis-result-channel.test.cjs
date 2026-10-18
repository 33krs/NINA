const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  MAX_RECORD_BYTES,
  decodeResult,
  encodeResult,
  runScenarioChild,
  writeResult,
} = require('./pharmacy-redis-result-channel.cjs');

const passed = {
  version: 1,
  result: 'passed',
  redis_major: 7,
  lease_ms: 10000,
};
const failed = {
  version: 1,
  result: 'failed',
  diagnostics: [
    {
      phase: 'lease',
      checkpoint: 'competing_acquire',
      category: 'assertion_failed',
      actual: 'true',
      expected: 'false',
    },
  ],
};
const target = path.join(__dirname, 'verify-pharmacy-redis-scenarios.cjs');

function childHarness({
  record,
  status = 0,
  signal = null,
  hang = false,
  omitStream = false,
  ignoreTerm = false,
} = {}) {
  const calls = [];
  let activeChild;
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    activeChild = child;
    child.pid = 1234;
    child.stdio = [
      null,
      null,
      null,
      ...(omitStream ? [] : [new EventEmitter()]),
    ];
    child.kill = (terminationSignal) => {
      calls.push({ terminationSignal });
      setImmediate(() => child.emit('close', null, terminationSignal));
      return true;
    };
    setImmediate(() => {
      if (record !== undefined && record !== null && child.stdio[3])
        child.stdio[3].emit(
          'data',
          Buffer.isBuffer(record) ? record : encodeResult(record),
        );
      if (!hang) child.emit('close', status, signal);
    });
    return child;
  };
  const killProcess = (pid, terminationSignal) => {
    calls.push({ pid, terminationSignal });
    if (!ignoreTerm || terminationSignal === 'SIGKILL')
      setImmediate(() => activeChild.emit('close', null, terminationSignal));
  };
  return { calls, spawn, killProcess };
}

test('encodes one bounded newline record and decodes exact success schema', () => {
  const bytes = encodeResult(passed);
  assert.equal(bytes.byteLength <= MAX_RECORD_BYTES, true);
  assert.equal(bytes.toString('utf8').endsWith('\n'), true);
  assert.deepEqual(decodeResult(bytes), passed);
});

test('writes one validated record and rejects unsafe payloads without output', () => {
  const chunks = [];
  assert.equal(
    writeResult(passed, (bytes) => chunks.push(bytes)),
    true,
  );
  assert.deepEqual(decodeResult(chunks[0]), passed);
  assert.equal(
    writeResult({ ...passed, result: 'PRIVATE' }, () => assert.fail()),
    false,
  );
});

test('snapshots version and diagnostic primitives before validating and writing', () => {
  let versionReads = 0;
  const changingVersion = { ...passed };
  Object.defineProperty(changingVersion, 'version', {
    enumerable: true,
    get() {
      versionReads++;
      return versionReads === 1 ? 1 : 99;
    },
  });
  let written;
  assert.equal(
    writeResult(changingVersion, (bytes) => (written = bytes)),
    true,
  );
  assert.deepEqual(decodeResult(written), passed);
  assert.equal(versionReads, 1);

  let phaseReads = 0;
  const changingDiagnostic = { ...failed.diagnostics[0] };
  Object.defineProperty(changingDiagnostic, 'phase', {
    enumerable: true,
    get() {
      phaseReads++;
      return phaseReads === 1 ? 'lease' : 'SYNTHETIC_SECRET_SENTINEL';
    },
  });
  written = undefined;
  assert.equal(
    writeResult(
      { ...failed, diagnostics: [changingDiagnostic] },
      (bytes) => (written = bytes),
    ),
    true,
  );
  assert.deepEqual(decodeResult(written), failed);
  assert.equal(phaseReads, 1);
  assert.doesNotMatch(written.toString('utf8'), /SYNTHETIC_SECRET_SENTINEL/);
});

test('rejects throwing record accessors with generic errors and no channel write', () => {
  const hostile = { ...passed };
  Object.defineProperty(hostile, 'version', {
    enumerable: true,
    get() {
      throw Error('SYNTHETIC_ACCESSOR_SECRET');
    },
  });
  assert.throws(() => encodeResult(hostile), {
    message: 'Invalid Redis result record',
  });
  let writes = 0;
  assert.equal(
    writeResult(hostile, () => writes++),
    false,
  );
  assert.equal(writes, 0);
});

test('accepts only an exact failure record with bounded allowlisted diagnostics', () => {
  assert.deepEqual(decodeResult(encodeResult(failed)), failed);
  for (const invalid of [
    { ...passed, extra: 'not allowed' },
    { ...passed, redis_major: 8 },
    { ...failed, diagnostics: [] },
    {
      ...failed,
      diagnostics: [
        ...failed.diagnostics,
        ...failed.diagnostics,
        ...failed.diagnostics,
      ],
    },
    {
      ...failed,
      diagnostics: [{ ...failed.diagnostics[0], actual: 'PRIVATE_SECRET' }],
    },
  ])
    assert.throws(() => encodeResult(invalid));
});

test('rejects missing, malformed, duplicate, oversized, extra, and noncanonical records', () => {
  const valid = encodeResult(passed);
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from('{bad}\n'),
    Buffer.concat([valid, valid]),
    Buffer.alloc(MAX_RECORD_BYTES + 1, 0x61),
    Buffer.from(`${valid.toString('utf8').slice(0, -1)} extra\n`),
    Buffer.from(
      '{"version":1,"version":1,"result":"passed","redis_major":7,"lease_ms":10000}\n',
    ),
  ])
    assert.throws(() => decodeResult(bytes));
});

test('spawns a fixed child with only FD3 as a result channel and ignores logs', async () => {
  const { calls, spawn, killProcess } = childHarness({ record: passed });
  const result = await runScenarioChild({
    runId: '12345678-1234-1234-1234-123456789abc',
    proofFile: '/private/proof.json',
    env: {},
    spawnImpl: spawn,
    killProcess,
    timeout: 1000,
  });
  assert.deepEqual(result, passed);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [
    target,
    '--run-id=12345678-1234-1234-1234-123456789abc',
    '--proof-file=/private/proof.json',
  ]);
  assert.deepEqual(calls[0].options.stdio, [
    'ignore',
    'ignore',
    'ignore',
    'pipe',
  ]);
  assert.equal(calls[0].options.detached, process.platform !== 'win32');
});

test('rejects a success record with a nonzero or signaled process exit', async () => {
  for (const exit of [{ status: 3 }, { status: null, signal: 'SIGTERM' }]) {
    const { spawn, killProcess } = childHarness({ record: passed, ...exit });
    await assert.rejects(
      runScenarioChild({
        runId: 'id',
        proofFile: '/proof',
        spawnImpl: spawn,
        killProcess,
        timeout: 1000,
      }),
    );
  }
});

test('missing FD3 fails closed and waits for child close', async () => {
  const { calls, spawn, killProcess } = childHarness({
    hang: true,
    omitStream: true,
  });
  await assert.rejects(
    runScenarioChild({
      runId: 'id',
      proofFile: '/proof',
      spawnImpl: spawn,
      killProcess,
      timeout: 1000,
    }),
  );
  assert.equal(
    calls.some((call) => call.terminationSignal === 'SIGTERM'),
    true,
  );
});

test('rejects an allowlisted child failure while preserving only its safe diagnostics', async () => {
  const { spawn, killProcess } = childHarness({ record: failed, status: 1 });
  await assert.rejects(
    runScenarioChild({
      runId: 'id',
      proofFile: '/proof',
      spawnImpl: spawn,
      killProcess,
      timeout: 1000,
    }),
    (error) => {
      assert.equal(error.status, 1);
      assert.deepEqual(error.diagnostics, failed.diagnostics);
      return true;
    },
  );
});

test('cancellation and deadline terminate the process group and settle before rejection', async () => {
  const controller = new AbortController();
  const cancelled = childHarness({ hang: true });
  const cancelTask = runScenarioChild({
    runId: 'id',
    proofFile: '/proof',
    spawnImpl: cancelled.spawn,
    killProcess: cancelled.killProcess,
    signal: controller.signal,
    timeout: 1000,
  });
  controller.abort();
  await assert.rejects(cancelTask);
  assert.deepEqual(
    cancelled.calls
      .filter((call) => call.terminationSignal)
      .map((call) => call.terminationSignal),
    ['SIGTERM', 'SIGKILL'],
  );

  const timed = childHarness({ hang: true });
  await assert.rejects(
    runScenarioChild({
      runId: 'id',
      proofFile: '/proof',
      spawnImpl: timed.spawn,
      killProcess: timed.killProcess,
      timeout: 5,
    }),
  );
  assert.equal(
    timed.calls.some((call) => call.terminationSignal === 'SIGTERM'),
    true,
  );

  const escalated = childHarness({ hang: true, ignoreTerm: true });
  await assert.rejects(
    runScenarioChild({
      runId: 'id',
      proofFile: '/proof',
      spawnImpl: escalated.spawn,
      killProcess: escalated.killProcess,
      timeout: 5,
    }),
  );
  assert.deepEqual(
    escalated.calls
      .filter((call) => call.terminationSignal)
      .map((call) => call.terminationSignal),
    ['SIGTERM', 'SIGKILL'],
  );
});
