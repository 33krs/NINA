const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { redisConfiguration } = require('./verify-pharmacy-redis-proof.cjs');

function privateRedisFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nina-pharmacy-redis-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runId = crypto.randomUUID();
  const name = `nina-pharmacy-redis-${runId}`;
  const password = crypto.randomBytes(32).toString('hex');
  const configFile = path.join(root, 'redis.conf');
  const proofFile = path.join(root, 'redis-proof.json');
  const proof = {
    runId,
    suite: 'pharmacy-redis',
    owner: 'nina-suite',
    image: 'redis:7-alpine',
    imageId: 'sha256:' + 'a'.repeat(64),
    containerId: 'b'.repeat(64),
    networkId: 'c'.repeat(64),
    networkName: name,
    port: 49152,
    redisUrl: `redis://:${password}@127.0.0.1:49152/0`,
  };
  fs.writeFileSync(configFile, redisConfiguration(password), { mode: 0o600 });
  const write = () =>
    fs.writeFileSync(proofFile, JSON.stringify(proof), { mode: 0o600 });
  write();
  return {
    root,
    proofFile,
    configFile,
    password,
    proof,
    input: { runId, proofFile },
    write,
  };
}

module.exports = { privateRedisFixture };
