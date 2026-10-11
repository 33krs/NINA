const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verifyLease } = require('./verify-pharmacy-redis-lease.cjs');
const { readRedisProof } = require('./verify-pharmacy-redis-proof.cjs');
const { validateRedisProof } = require('./verify-pharmacy-redis-runtime.cjs');
const { run, dockerArgs } = require('./verify-odontogram-postgres.cjs');

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

async function main(input) {
  const privateConfig = readRedisProof(input);
  const container = await inspect(privateConfig, [
    'inspect',
    privateConfig.proof.containerId,
  ]);
  const network = await inspect(privateConfig, [
    'network',
    'inspect',
    privateConfig.proof.networkId,
  ]);
  const config = validateRedisProof(input, { container, network });
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
  const clients = [];
  const services = [];
  try {
    for (let index = 0; index < 2; index++) {
      const client = createPharmacyRedis(config.redisUrl);
      clients.push(client);
      services.push(new PharmacyLockService(client));
    }
    await verifyLease({
      client: clients[0],
      first: services[0],
      second: services[1],
      key: `pharmacy:prescription:${config.proof.runId}`,
    });
  } finally {
    const cleanup = await Promise.allSettled(
      clients.map(async (client, index) => {
        try {
          services[index]?.onModuleDestroy();
        } finally {
          if (client.isOpen) client.destroy();
        }
      }),
    );
    assert.ok(
      cleanup.every((result) => result.status === 'fulfilled'),
      'Owned client cleanup failed',
    );
  }
  console.log('PHARMACY_REDIS_SCENARIOS_PASSED redis_major=7 lease_ms=10000');
}

if (require.main === module)
  Promise.resolve()
    .then(() => main(parseArguments(process.argv.slice(2))))
    .catch(() => {
      console.error('PHARMACY_REDIS_SCENARIOS_FAILED');
      process.exitCode = 1;
    });

module.exports = { main, parseArguments };
