const MAX_STDOUT_BYTES = 8 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ASSERTIONS = Object.freeze([
  'table_empty_before',
  'role_enum_values',
  'role_has_no_default',
  'username_c_collation',
  'valid_username_boundaries',
  'explicit_roles_and_defaults',
  'table_empty_after',
  'table_empty_after_rollback',
]);
const REJECTIONS = Object.freeze(
  [
    ['role_default', '23502'],
    ['username_null', '23502'],
    ['username_noncanonical', '23514'],
    ['username_too_short', '23514'],
    ['auth_version_negative', '23514'],
    ['username_duplicate', '23505'],
  ].map(([checkpoint, sqlState]) => Object.freeze({ checkpoint, sqlState })),
);
const RECORDS = Object.freeze([
  ...ASSERTIONS.slice(0, 6).map((checkpoint) =>
    Object.freeze({ type: 'assert', checkpoint, state: '-' }),
  ),
  ...REJECTIONS.map(({ checkpoint, sqlState }) =>
    Object.freeze({ type: 'reject', checkpoint, state: sqlState }),
  ),
  ...ASSERTIONS.slice(6).map((checkpoint) =>
    Object.freeze({ type: 'assert', checkpoint, state: '-' }),
  ),
  Object.freeze({ type: 'complete', checkpoint: 'proof_complete', state: '-' }),
]);

function invalidReceipt() {
  throw new Error('Invalid training-account SQL receipt');
}

function canonicalRunId(runId) {
  return typeof runId === 'string' && UUID_PATTERN.test(runId);
}

function recordText(runId, { type, checkpoint, state }) {
  return `NINA_TRAINING_PG_V1|${runId}|${type}|${checkpoint}|${state}`;
}

function trainingAccountSqlCheckpoint(runId, checkpoint) {
  if (arguments.length !== 2 || !canonicalRunId(runId))
    throw new Error('Invalid training-account SQL checkpoint');
  const record = RECORDS.find(
    (candidate) => candidate.checkpoint === checkpoint,
  );
  if (!record) throw new Error('Invalid training-account SQL checkpoint');
  return `SELECT '${recordText(runId, record)}' AS proof_record;`;
}

function parseTrainingAccountSqlReceipt(stdout, runId, exitStatus) {
  if (
    arguments.length !== 3 ||
    typeof stdout !== 'string' ||
    !canonicalRunId(runId) ||
    exitStatus !== 0
  )
    invalidReceipt();

  if (stdout.length > MAX_STDOUT_BYTES) invalidReceipt();
  const bytes = Buffer.from(stdout, 'utf8');
  if (
    bytes.length > MAX_STDOUT_BYTES ||
    bytes.toString('utf8') !== stdout ||
    stdout.includes('\r')
  )
    invalidReceipt();

  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  const lines = body.split('\n');
  if (
    lines.length !== RECORDS.length ||
    lines.some((line) => line.length === 0)
  )
    invalidReceipt();

  for (let index = 0; index < RECORDS.length; index++) {
    const fields = lines[index].split('|');
    const expected = RECORDS[index];
    if (
      fields.length !== 5 ||
      fields[0] !== 'NINA_TRAINING_PG_V1' ||
      fields[1] !== runId ||
      fields[2] !== expected.type ||
      fields[3] !== expected.checkpoint ||
      fields[4] !== expected.state
    )
      invalidReceipt();
  }

  return Object.freeze({
    runId,
    assertionCount: ASSERTIONS.length,
    rejectionCount: REJECTIONS.length,
    assertions: ASSERTIONS,
    expectedRejections: REJECTIONS,
    complete: true,
  });
}

module.exports = {
  trainingAccountSqlCheckpoint,
  parseTrainingAccountSqlReceipt,
};
