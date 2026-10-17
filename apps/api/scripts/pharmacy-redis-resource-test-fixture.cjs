const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  createResourceContext,
} = require('./pharmacy-redis-resource-identity.cjs');

function resourceFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nina-pharmacy-redis-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const context = createResourceContext({
    runId: crypto.randomUUID(),
    imageId: 'sha256:' + 'a'.repeat(64),
    root,
  });
  const containerId = 'b'.repeat(64);
  const networkId = 'c'.repeat(64);
  const labels = {
    'nina.pharmacy-redis.owner': 'nina-suite',
    'nina.pharmacy-redis.run': context.runId,
  };
  const rows = {
    container: {
      Id: containerId,
      Name: '/' + context.name,
      Image: context.imageId,
      Config: { Image: 'redis:7-alpine', Labels: { ...labels } },
      State: { Status: 'created' },
    },
    network: {
      Id: networkId,
      Name: context.name,
      Labels: { ...labels },
      Containers: {},
    },
  };
  return { root, context, containerId, networkId, rows };
}

module.exports = { resourceFixture };
