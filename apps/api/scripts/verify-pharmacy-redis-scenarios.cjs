const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyLease } = require('./verify-pharmacy-redis-lease.cjs');
const { readRedisProof } = require('./verify-pharmacy-redis-proof.cjs');
const { writeResult } = require('./pharmacy-redis-result-channel.cjs');
const { validateRedisProof } = require('./verify-pharmacy-redis-runtime.cjs');
const { run, dockerArgs } = require('./verify-odontogram-postgres.cjs');
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

function emitDiagnostic(diagnostic, diagnostics) {
  let snapshot;
  try {
    snapshot = {
      phase: diagnostic.phase,
      checkpoint: diagnostic.checkpoint,
      category: diagnostic.category,
      actual: diagnostic.actual,
      expected: diagnostic.expected,
    };
  } catch {
    return false;
  }
  if (
    !SAFE_PHASES.has(snapshot.phase) ||
    !SAFE_CHECKPOINTS.has(snapshot.checkpoint) ||
    !SAFE_CATEGORIES.has(snapshot.category) ||
    !SAFE_VALUES.has(snapshot.actual) ||
    !SAFE_VALUES.has(snapshot.expected)
  )
    return false;
  diagnostics.push(snapshot);
  console.error(
    `PHARMACY_REDIS_DIAGNOSTIC phase=${snapshot.phase} checkpoint=${snapshot.checkpoint} category=${snapshot.category} actual=${snapshot.actual} expected=${snapshot.expected}`,
  );
  return true;
}

function parseArguments(args) {
  assert.ok(
    args.length === 2 &&
      args[0].startsWith('--run-id=') &&
      args[1].startsWith('--proof-file='),
    'Explicit run ID and private proof arguments required',
  );
  return { runId: args[0].slice(9), proofFile: args[1].slice(13) };
}

async function inspect(config, args) {
  const output = await run('/usr/bin/docker', dockerArgs(args), {
    env: { PATH: '/usr/bin:/bin', HOME: config.root },
    timeout: 5000,
    redactions: [config.redisUrl, new URL(config.redisUrl).password],
  });
  const rows = JSON.parse(output);
  assert.ok(
    Array.isArray(rows) && rows.length === 1,
    'One owned observation required',
  );
  return rows[0];
}

async function main(input, onTerminalResult) {
  let phase = 'proof_read';
  let diagnosticEmitted = false;
  let failed = false;
  let failure;
  const diagnostics = [];
  const clients = [];
  const services = [];
  try {
    const privateConfig = readRedisProof(input);
    phase = 'container_inspect';
    const container = await inspect(privateConfig, [
      'inspect',
      privateConfig.proof.containerId,
    ]);
    phase = 'network_inspect';
    const network = await inspect(privateConfig, [
      'network',
      'inspect',
      privateConfig.proof.networkId,
    ]);
    phase = 'proof_validate';
    const config = validateRedisProof(input, { container, network });
    phase = 'adapter_load';
    const adapter = path.resolve(
      __dirname,
      '../dist/modules/pharmacy/pharmacy-lock.service.js',
    );
    assert.equal(
      fs.realpathSync(adapter),
      adapter,
      'Canonical compiled adapter required',
    );
    const { createPharmacyRedis, PharmacyLockService } = require(adapter);
    phase = 'client_setup';
    for (let index = 0; index < 2; index++) {
      const client = createPharmacyRedis(config.redisUrl);
      clients.push(client);
      services.push(new PharmacyLockService(client));
    }
    phase = 'lease';
    await verifyLease({
      client: clients[0],
      first: services[0],
      second: services[1],
      key: `pharmacy:prescription:${config.proof.runId}`,
      onDiagnostic: (diagnostic) => {
        diagnosticEmitted =
          emitDiagnostic(diagnostic, diagnostics) || diagnosticEmitted;
      },
    });
  } catch (error) {
    failed = true;
    failure = error;
    if (!diagnosticEmitted) {
      const checkpoint = {
        proof_read: 'proof_input',
        container_inspect: 'container_inspect',
        network_inspect: 'network_inspect',
        proof_validate: 'proof_validation',
        adapter_load: 'adapter_resolution',
        client_setup: 'client_setup',
        lease: 'lease',
      }[phase];
      diagnosticEmitted = emitDiagnostic(
        {
          phase,
          checkpoint,
          category: 'operation_failed',
          actual: 'unavailable',
          expected: 'success',
        },
        diagnostics,
      );
    }
  }
  phase = 'cleanup';
  const cleanup = await Promise.allSettled(
    clients.map(async (client, index) => {
      try {
        services[index]?.onModuleDestroy();
      } finally {
        if (client.isOpen) client.destroy();
      }
    }),
  );
  try {
    assert.ok(
      cleanup.every((result) => result.status === 'fulfilled'),
      'Owned client cleanup failed',
    );
  } catch (error) {
    emitDiagnostic(
      {
        phase: 'cleanup',
        checkpoint: 'client_cleanup',
        category: 'cleanup_failed',
        actual: 'failed',
        expected: 'fulfilled',
      },
      diagnostics,
    );
    failed = true;
    failure = error;
  }
  const publishResult = (result) => {
    try {
      onTerminalResult?.(result);
    } catch {
      // The result channel never changes assertion or cleanup outcomes.
    }
  };
  if (failed) {
    publishResult({ version: 1, result: 'failed', diagnostics });
    throw failure;
  }
  publishResult({
    version: 1,
    result: 'passed',
    redis_major: 7,
    lease_ms: 10000,
  });
  console.log('PHARMACY_REDIS_SCENARIOS_PASSED redis_major=7 lease_ms=10000');
}

if (require.main === module)
  Promise.resolve()
    .then(() =>
      main(parseArguments(process.argv.slice(2)), (result) =>
        writeResult(result),
      ),
    )
    .catch(() => {
      console.error('PHARMACY_REDIS_SCENARIOS_FAILED');
      process.exitCode = 1;
    });

module.exports = { main, parseArguments };
