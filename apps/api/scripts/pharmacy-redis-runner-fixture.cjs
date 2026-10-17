const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { redisConfiguration } = require('./verify-pharmacy-redis-proof.cjs');
const IMAGE = 'redis:7-alpine';
const IMAGE_ID =
  'sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';

// File/argument preparation only: no Docker inspection, execution or client loading.
function createRedisFixture() {
  assert.ok(
    typeof process.getuid === 'function' && process.getuid() > 0,
    'Unprivileged Unix fixture required',
  );
  const root = fs.mkdtempSync('/tmp/nina-pharmacy-redis-');
  const runId = crypto.randomUUID();
  const name = `nina-pharmacy-redis-${runId}`;
  const configFile = path.join(root, 'redis.conf');
  const proofFile = path.join(root, 'redis-proof.json');
  const password = crypto.randomBytes(32).toString('hex');
  // Docker must bind this explicit port or fail; no existing-service probe.
  const port = crypto.randomInt(49152, 65536);
  const redactions = [password];
  const labels = [
    '--label',
    'nina.pharmacy-redis.owner=nina-suite',
    '--label',
    `nina.pharmacy-redis.run=${runId}`,
  ];
  const dispose = () => {
    for (const file of [proofFile, configFile]) {
      try {
        fs.unlinkSync(file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    fs.rmdirSync(root);
  };
  try {
    fs.chmodSync(root, 0o700);
    fs.writeFileSync(configFile, redisConfiguration(password), {
      mode: 0o600,
      flag: 'wx',
    });
  } catch {
    dispose();
    throw Error('Private Redis fixture preparation failed');
  }
  return Object.freeze({
    root,
    runId,
    name,
    configFile,
    proofFile,
    redactions,
    environment: Object.freeze({ PATH: '/usr/bin:/bin', HOME: root }),
    networkArgs: () => ['network', 'create', ...labels, name],
    containerArgs: () => [
      'create',
      '--pull=never',
      '--name',
      name,
      '--network',
      name,
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--tmpfs',
      `/data:rw,noexec,nosuid,size=16m,uid=${process.getuid()},gid=${process.getgid()}`,
      '--volume',
      `${configFile}:/run/nina-redis.conf:ro`,
      '--publish',
      `127.0.0.1:${port}:6379`,
      ...labels,
      IMAGE,
      'redis-server',
      '/run/nina-redis.conf',
    ],
    writeProof(containerId, networkId) {
      assert.ok(
        /^[\da-f]{64}$/.test(containerId) && /^[\da-f]{64}$/.test(networkId),
        'Exact Redis proof resource IDs required',
      );
      const redisUrl = `redis://:${password}@127.0.0.1:${port}/0`;
      fs.writeFileSync(
        proofFile,
        JSON.stringify({
          runId,
          suite: 'pharmacy-redis',
          owner: 'nina-suite',
          image: IMAGE,
          imageId: IMAGE_ID,
          containerId,
          networkId,
          networkName: name,
          port,
          redisUrl,
        }),
        { mode: 0o600, flag: 'wx' },
      );
      redactions.push(redisUrl);
      return { runId, proofFile };
    },
    dispose,
  });
}
module.exports = { createRedisFixture, IMAGE, IMAGE_ID };
