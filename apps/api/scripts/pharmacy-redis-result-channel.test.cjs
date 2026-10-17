const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_RECORD_BYTES,
  decodeResult,
  encodeResult,
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
