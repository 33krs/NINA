const fs = require('node:fs');
const path = require('node:path');

const IMAGE = 'redis:7-alpine';
function check(condition, message) {
  // Never include rejected proof/configuration values in diagnostics.
  if (!condition) throw new Error(message);
}

function same(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), message);
}

function privatePath(file, directory) {
  try {
    const stats = fs.lstatSync(file);
    check(
      !stats.isSymbolicLink() &&
        (directory ? stats.isDirectory() : stats.isFile()) &&
        (stats.mode & 0o777) === (directory ? 0o700 : 0o600) &&
        stats.uid === process.getuid() &&
        fs.realpathSync(file) === file,
      'Invalid private path',
    );
  } catch {
    throw new Error(
      'Private Redis proof paths must be canonical, owned and restricted',
    );
  }
}

function redisConfiguration(password) {
  check(/^[\da-f]{64}$/.test(password), 'Fresh Redis credential required');
  return [
    'bind 0.0.0.0',
    'port 6379',
    'protected-mode yes',
    'daemonize no',
    'save ""',
    'appendonly no',
    'dir /data',
    'logfile ""',
    `requirepass ${password}`,
    '',
  ].join('\n');
}

// Import-only private-file contract. This reader does not validate Docker
// observations or authorize loading a Redis client.
function readRedisProof({ runId, proofFile }) {
  check(
    typeof process.getuid === 'function' && process.getuid() > 0,
    'Unprivileged Unix ownership checks required',
  );
  check(
    typeof proofFile === 'string' && path.isAbsolute(proofFile),
    'Absolute private Redis proof required',
  );
  const root = path.dirname(proofFile);
  const configFile = path.join(root, 'redis.conf');
  check(
    path.basename(root).startsWith('nina-pharmacy-redis-') &&
      proofFile === path.join(root, 'redis-proof.json'),
    'Redis proof must belong to runner temporary storage',
  );
  privatePath(root, true);
  privatePath(proofFile, false);
  privatePath(configFile, false);
  same(
    fs.readdirSync(root).sort(),
    ['redis-proof.json', 'redis.conf'],
    'Unexpected Redis private directory contents',
  );
  let proof;
  try {
    proof = JSON.parse(fs.readFileSync(proofFile, 'utf8'));
  } catch {
    throw new Error('Invalid Redis proof document');
  }
  check(proof && typeof proof === 'object', 'Invalid Redis proof document');
  check(
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(runId) &&
      proof.runId === runId &&
      proof.suite === 'pharmacy-redis' &&
      proof.owner === 'nina-suite' &&
      proof.image === IMAGE &&
      /^sha256:[\da-f]{64}$/.test(proof.imageId) &&
      /^[\da-f]{64}$/.test(proof.containerId) &&
      /^[\da-f]{64}$/.test(proof.networkId),
    'Redis run identity mismatch',
  );
  const name = `nina-pharmacy-redis-${runId}`;
  check(proof.networkName === name, 'Redis network name mismatch');
  check(
    Number.isInteger(proof.port) && proof.port > 0 && proof.port <= 65535,
    'Invalid Redis loopback port',
  );
  let password;
  try {
    password = new URL(proof.redisUrl).password;
  } catch {
    throw new Error('Invalid Redis datasource');
  }
  check(
    proof.redisUrl === `redis://:${password}@127.0.0.1:${proof.port}/0`,
    'Redis datasource binding mismatch',
  );
  check(
    fs.readFileSync(configFile, 'utf8') === redisConfiguration(password),
    'Redis authentication or persistence configuration mismatch',
  );
  return Object.freeze({
    root,
    configFile,
    proof: Object.freeze(proof),
    redisUrl: proof.redisUrl,
  });
}

module.exports = { readRedisProof, redisConfiguration };
