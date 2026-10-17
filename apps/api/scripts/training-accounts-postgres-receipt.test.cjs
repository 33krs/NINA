const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { it } = require('node:test');
const {
  parseTrainingAccountSqlReceipt,
  trainingAccountSqlCheckpoint,
} = require('./training-accounts-postgres-receipt.cjs');

const ASSERTIONS = [
  'table_empty_before',
  'role_enum_values',
  'role_has_no_default',
  'username_c_collation',
  'valid_username_boundaries',
  'explicit_roles_and_defaults',
  'table_empty_after',
  'table_empty_after_rollback',
];
const REJECTIONS = [
  ['role_default', '23502'],
  ['username_null', '23502'],
  ['username_noncanonical', '23514'],
  ['username_too_short', '23514'],
  ['auth_version_negative', '23514'],
  ['username_duplicate', '23505'],
];

function validRecords(runId) {
  return [
    ...ASSERTIONS.slice(0, 6).map((checkpoint) =>
      trainingAccountSqlCheckpoint(runId, checkpoint),
    ),
    ...REJECTIONS.map(([checkpoint]) =>
      trainingAccountSqlCheckpoint(runId, checkpoint),
    ),
    ...ASSERTIONS.slice(6).map((checkpoint) =>
      trainingAccountSqlCheckpoint(runId, checkpoint),
    ),
    trainingAccountSqlCheckpoint(runId, 'proof_complete'),
  ];
}

function line(record) {
  return record.slice("SELECT '".length, -"' AS proof_record;".length);
}

it('emits only fixed nonsecret SQL checkpoints for the closed protocol', () => {
  const runId = crypto.randomUUID();
  const records = validRecords(runId);
  assert.equal(records.length, 15);
  assert.ok(
    records.every((record) =>
      record.startsWith("SELECT 'NINA_TRAINING_PG_V1|"),
    ),
  );
  assert.ok(records.every((record) => record.endsWith("' AS proof_record;")));
  assert.throws(
    () => trainingAccountSqlCheckpoint(runId, 'caller-controlled'),
    { message: 'Invalid training-account SQL checkpoint' },
  );
  assert.throws(
    () => trainingAccountSqlCheckpoint('not-a-run-id', 'proof_complete'),
    { message: 'Invalid training-account SQL checkpoint' },
  );
});

it('parses the ordered 15-record receipt into frozen fixed metadata', () => {
  const runId = crypto.randomUUID();
  const result = parseTrainingAccountSqlReceipt(
    `${validRecords(runId).map(line).join('\n')}\n`,
    runId,
    0,
  );
  assert.deepEqual(result, {
    runId,
    assertionCount: 8,
    rejectionCount: 6,
    assertions: ASSERTIONS,
    expectedRejections: REJECTIONS.map(([checkpoint, sqlState]) => ({
      checkpoint,
      sqlState,
    })),
    complete: true,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.assertions), true);
  assert.equal(Object.isFrozen(result.expectedRejections), true);
  assert.ok(result.expectedRejections.every(Object.isFrozen));
  assert.equal(JSON.stringify(result).includes(runId), true);
});

it('rejects each missing, duplicate, or reordered record', () => {
  const runId = crypto.randomUUID();
  const records = validRecords(runId).map(line);
  const invalid = [];
  records.forEach((_, index) => {
    invalid.push(records.filter((__, current) => current !== index));
    const duplicate = [...records];
    duplicate[index] = duplicate[index === 0 ? 1 : 0];
    invalid.push(duplicate);
    const reordered = [...records];
    [reordered[index], reordered[(index + 1) % records.length]] = [
      reordered[(index + 1) % records.length],
      reordered[index],
    ];
    invalid.push(reordered);
  });
  for (const candidate of invalid)
    assert.throws(
      () => parseTrainingAccountSqlReceipt(candidate.join('\n'), runId, 0),
      { message: 'Invalid training-account SQL receipt' },
    );
});

it('rejects foreign runs, bad states, unknown names, and malformed output', () => {
  const runId = crypto.randomUUID();
  const records = validRecords(runId).map(line);
  const wrongRun = records.map((record) =>
    record.replace(runId, crypto.randomUUID()),
  );
  const wrongState = [...records];
  wrongState[8] = wrongState[8].replace('|23514', '|23502');
  const unknown = [...records];
  unknown[0] = unknown[0].replace('table_empty_before', 'unexpected');
  for (const text of [
    wrongRun.join('\n'),
    wrongState.join('\n'),
    unknown.join('\n'),
    `${records.join('\n')}\n\n`,
    `${records[0]}\r\n${records.slice(1).join('\n')}`,
    `${records.join('\n')}\nextra`,
  ])
    assert.throws(() => parseTrainingAccountSqlReceipt(text, runId, 0), {
      message: 'Invalid training-account SQL receipt',
    });
});

it('requires numeric zero exit, canonical run identity, and bounded UTF-8 stdout', () => {
  const runId = crypto.randomUUID();
  const valid = validRecords(runId).map(line).join('\n');
  for (const [stdout, expectedRunId, exitStatus] of [
    [valid, runId.toUpperCase(), 0],
    [valid, runId, '0'],
    [valid, runId, 1],
    [`${valid}\n${'x'.repeat(8192)}`, runId, 0],
    [`${valid}\n\ud800`, runId, 0],
  ])
    assert.throws(
      () => parseTrainingAccountSqlReceipt(stdout, expectedRunId, exitStatus),
      { message: 'Invalid training-account SQL receipt' },
    );
});
