const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: pause } = require('node:timers/promises');
const {
  run,
  dockerArgs,
  createCancellation,
} = require('./verify-odontogram-postgres.cjs');
const {
  createRedisFixture,
  IMAGE,
  IMAGE_ID,
} = require('./pharmacy-redis-runner-fixture.cjs');
const { validateRedisProof } = require('./verify-pharmacy-redis-runtime.cjs');
const {
  createResourceTracker,
  captureCreation,
  reconcileResources,
} = require('./pharmacy-redis-resources.cjs');
const CHILD_PASS =
  'PHARMACY_REDIS_SCENARIOS_PASSED redis_major=7 lease_ms=10000';

async function waitForRedis(config, cancellation) {
  const adapter = path.resolve(
    __dirname,
    '../dist/modules/pharmacy/pharmacy-lock.service.js',
  );
  assert.equal(
    fs.realpathSync(adapter),
    adapter,
    'Canonical compiled adapter required',
  );
  const { createPharmacyRedis } = require(adapter);
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    cancellation.throwIfCancelled();
    const client = createPharmacyRedis(config.redisUrl);
    try {
      await client.connect();
      assert.equal(
        await client.withCommandOptions({ timeout: 1500 }).ping(),
        'PONG',
      );
      cancellation.throwIfCancelled();
      return;
    } catch {
      cancellation.throwIfCancelled();
    } finally {
      if (client.isOpen) client.destroy();
    }
    await pause(100, undefined, { signal: cancellation.signal });
  }
  throw Error('Owned Redis readiness timed out');
}

async function main(args = process.argv.slice(2)) {
  assert.ok(
    args.length === 1 && args[0] === '--isolated',
    'Explicit isolated Redis opt-in required',
  );
  assert.ok(
    typeof process.getuid === 'function' && process.getuid() > 0,
    'Unprivileged Unix runner required',
  );
  const fixture = createRedisFixture();
  const { root, runId, redactions, environment } = fixture;
  const cancellation = createCancellation();
  const onInt = () => cancellation.request('SIGINT');
  const onTerm = () => cancellation.request('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  const timer = setTimeout(onTerm, 600000);
  const docker = (args) =>
    run('/usr/bin/docker', dockerArgs(args), {
      env: environment,
      timeout: 15000,
      signal: cancellation.signal,
      guard: cancellation.throwIfCancelled,
      redactions,
    });
  let tracker;
  let networkId;
  let containerId;
  let failure;
  try {
    assert.equal(
      await docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE]),
      IMAGE_ID,
      'Pinned cached Redis image required; pulls disabled',
    );
    tracker = createResourceTracker({ runId, imageId: IMAGE_ID, root });
    cancellation.throwIfCancelled();
    networkId = await captureCreation(tracker, 'network', () =>
      docker(fixture.networkArgs()),
    );
    containerId = await captureCreation(tracker, 'container', () =>
      docker(fixture.containerArgs()),
    );
    await docker(['start', containerId]);
    const input = fixture.writeProof(containerId, networkId);
    const inspect = async (args) => {
      const rows = JSON.parse(await docker(args));
      assert.ok(
        Array.isArray(rows) && rows.length === 1,
        'One owned Redis observation required',
      );
      return rows[0];
    };
    const config = validateRedisProof(input, {
      container: await inspect(['inspect', '--type', 'container', containerId]),
      network: await inspect(['network', 'inspect', networkId]),
    });
    await waitForRedis(config, cancellation);
    const output = await run(
      process.execPath,
      [
        path.join(__dirname, 'verify-pharmacy-redis-scenarios.cjs'),
        `--run-id=${runId}`,
        `--proof-file=${input.proofFile}`,
      ],
      {
        env: environment,
        timeout: 60000,
        signal: cancellation.signal,
        guard: cancellation.throwIfCancelled,
        redactions,
      },
    );
    assert.equal(output, CHILD_PASS, 'Guarded Redis scenarios must complete');
  } catch {
    failure = Error('Isolated Redis verification failed');
  } finally {
    clearTimeout(timer);
    try {
      // All awaited creation/child processes have settled; cleanup has no aborted signal.
      if (tracker) await reconcileResources(tracker, { timeoutMs: 30000 });
      fixture.dispose();
      console.log(
        `PHARMACY_REDIS_CLEANUP_ASSERTED container_id=${containerId ?? 'none'} network_id=${networkId ?? 'none'}`,
      );
    } catch {
      failure = Error('Owned Redis cleanup failed');
      console.error(
        `PHARMACY_REDIS_RECOVERY_RETAINED run_id=${runId} directory=${root}`,
      );
    }
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    if (cancellation.exitCode) process.exitCode = cancellation.exitCode;
  }
  if (failure) throw failure;
  cancellation.throwIfCancelled();
  console.log(
    `PHARMACY_REDIS_SUITE_PASSED redis_major=7 lease_ms=10000 image_id=${IMAGE_ID}`,
  );
}

if (require.main === module)
  main().catch(() => {
    console.error('PHARMACY_REDIS_SUITE_FAILED');
    process.exitCode ||= 1;
  });
module.exports = { main };
