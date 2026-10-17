const fs = require('node:fs');
const path = require('node:path');
const OWNER = 'nina.pharmacy-redis.owner';
const RUN = 'nina.pharmacy-redis.run';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function createResourceContext({ runId, imageId, root }) {
  check(
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(runId) &&
      /^sha256:[\da-f]{64}$/.test(imageId),
    'Explicit Redis run/image identity required',
  );
  try {
    const stat = fs.lstatSync(root);
    check(
      path.isAbsolute(root) &&
        path.basename(root).startsWith('nina-pharmacy-redis-') &&
        fs.realpathSync(root) === root &&
        stat.isDirectory() &&
        stat.uid === process.getuid() &&
        process.getuid() > 0 &&
        (stat.mode & 0o777) === 0o700,
      'Private Redis resource context required',
    );
  } catch {
    throw new Error('Private Redis resource context required');
  }
  return Object.freeze({
    runId,
    imageId,
    root,
    name: `nina-pharmacy-redis-${runId}`,
  });
}

function isResourceAbsent(error, kind, target) {
  const messages =
    kind === 'container'
      ? [
          `Error: No such object: ${target}`,
          `Error response from daemon: No such container: ${target}`,
        ]
      : [
          `Error response from daemon: network ${target} not found`,
          `Error: No such network: ${target}`,
        ];
  return (
    error.status === 1 &&
    typeof error.stderr === 'string' &&
    messages.includes(error.stderr.trim())
  );
}

function ownedResourceId(context, kind, row, expectedId) {
  const labels = kind === 'container' ? row?.Config?.Labels : row?.Labels;
  check(
    row &&
      /^[\da-f]{64}$/.test(row.Id) &&
      (!expectedId || row.Id === expectedId) &&
      row.Name === (kind === 'container' ? '/' : '') + context.name &&
      JSON.stringify(labels) ===
        JSON.stringify({ [OWNER]: 'nina-suite', [RUN]: context.runId }) &&
      (kind !== 'container' ||
        (row.Image === context.imageId &&
          row.Config.Image === 'redis:7-alpine')),
    'Redis resource ownership mismatch',
  );
  return row.Id;
}

module.exports = { createResourceContext, ownedResourceId, isResourceAbsent };
