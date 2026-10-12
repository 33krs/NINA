const fs = require('node:fs');

const MAX_RECORD_BYTES = 4096;
const SAFE_PHASES = new Set([
  'proof_read',
  'container_inspect',
  'network_inspect',
  'proof_validate',
  'adapter_load',
  'client_setup',
  'lease',
  'cleanup',
]);
const SAFE_CHECKPOINTS = new Set([
  'proof_input',
  'container_inspect',
  'network_inspect',
  'proof_validation',
  'adapter_resolution',
  'client_setup',
  'lease',
  'client_cleanup',
  'client_connect',
  'command_options',
  'redis_version',
  'owner_tokens',
  'fresh_key',
  'first_acquire',
  'competing_acquire',
  'initial_owner',
  'first_lease_ttl',
  'wrong_owner_release',
  'owner_after_wrong_release',
  'owner_release',
  'key_after_owner_release',
  'natural_acquire',
  'natural_deadline',
  'natural_ttl',
  'natural_owner',
  'natural_expiry_duration',
  'successor_acquire',
  'stale_owner_release',
  'successor_after_stale_release',
  'successor_release',
  'key_after_successor_release',
]);
const SAFE_CATEGORIES = new Set([
  'assertion_failed',
  'operation_failed',
  'cleanup_failed',
]);
const SAFE_VALUES = new Set([
  'redis7',
  'other_version',
  'missing',
  'occupied',
  'true',
  'false',
  'owner_match',
  'owner_missing',
  'owner_other',
  'owner_match_or_missing',
  'ttl_below_min',
  'ttl_in_range',
  'ttl_expired',
  'ttl_invalid',
  'ttl_over_max',
  'before_deadline',
  'deadline_reached',
  'duration_sufficient',
  'duration_short',
  'unavailable',
  'success',
  'failed',
  'fulfilled',
]);
const DIAGNOSTIC_FIELDS = [
  'phase',
  'checkpoint',
  'category',
  'actual',
  'expected',
];

function exactKeys(value, expected) {
  try {
    return (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === expected.length &&
      expected.every((key) => Object.hasOwn(value, key))
    );
  } catch {
    return false;
  }
}

function snapshotDiagnostic(diagnostic) {
  try {
    if (!exactKeys(diagnostic, DIAGNOSTIC_FIELDS)) return null;
    const snapshot = {
      phase: diagnostic.phase,
      checkpoint: diagnostic.checkpoint,
      category: diagnostic.category,
      actual: diagnostic.actual,
      expected: diagnostic.expected,
    };
    return SAFE_PHASES.has(snapshot.phase) &&
      SAFE_CHECKPOINTS.has(snapshot.checkpoint) &&
      SAFE_CATEGORIES.has(snapshot.category) &&
      SAFE_VALUES.has(snapshot.actual) &&
      SAFE_VALUES.has(snapshot.expected)
      ? snapshot
      : null;
  } catch {
    return null;
  }
}

function snapshotDiagnostics(diagnostics) {
  try {
    if (
      !Array.isArray(diagnostics) ||
      diagnostics.length < 1 ||
      diagnostics.length > 2
    )
      return null;
    const snapshot = [];
    for (let index = 0; index < diagnostics.length; index++) {
      const item = snapshotDiagnostic(diagnostics[index]);
      if (!item) return null;
      snapshot.push(item);
    }
    return snapshot;
  } catch {
    return null;
  }
}

function validateDiagnostics(diagnostics) {
  return snapshotDiagnostics(diagnostics) !== null;
}

function snapshotResult(result) {
  try {
    if (result === null || typeof result !== 'object' || Array.isArray(result))
      return null;
    const version = result.version;
    const kind = result.result;
    if (version !== 1) return null;
    if (
      kind === 'passed' &&
      exactKeys(result, ['version', 'result', 'redis_major', 'lease_ms'])
    ) {
      const redisMajor = result.redis_major;
      const leaseMs = result.lease_ms;
      return redisMajor === 7 && leaseMs === 10000
        ? {
            version,
            result: kind,
            redis_major: redisMajor,
            lease_ms: leaseMs,
          }
        : null;
    }
    if (
      kind === 'failed' &&
      exactKeys(result, ['version', 'result', 'diagnostics'])
    ) {
      const diagnostics = snapshotDiagnostics(result.diagnostics);
      return diagnostics ? { version, result: kind, diagnostics } : null;
    }
    return null;
  } catch {
    return null;
  }
}

function encodeResult(result) {
  const snapshot = snapshotResult(result);
  if (!snapshot) throw new Error('Invalid Redis result record');
  const bytes = Buffer.from(`${JSON.stringify(snapshot)}\n`, 'utf8');
  if (bytes.byteLength > MAX_RECORD_BYTES)
    throw new Error('Redis result record exceeded its size limit');
  return bytes;
}

function decodeResult(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.byteLength === 0 ||
    bytes.byteLength > MAX_RECORD_BYTES
  )
    throw new Error('Invalid Redis result channel');
  const text = bytes.toString('utf8');
  if (
    !Buffer.from(text, 'utf8').equals(bytes) ||
    !text.endsWith('\n') ||
    text.slice(0, -1).includes('\n')
  )
    throw new Error('Invalid Redis result channel');
  let result;
  try {
    result = JSON.parse(text.slice(0, -1));
  } catch {
    throw new Error('Invalid Redis result channel');
  }
  const snapshot = snapshotResult(result);
  if (!snapshot || !encodeResult(snapshot).equals(bytes))
    throw new Error('Invalid Redis result channel');
  return snapshot;
}

function writeResult(result, write = (bytes) => fs.writeSync(3, bytes)) {
  try {
    write(encodeResult(result));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  MAX_RECORD_BYTES,
  decodeResult,
  encodeResult,
  snapshotDiagnostics,
  validateDiagnostics,
  writeResult,
};
