const test = require('node:test');
const assert = require('node:assert/strict');
const { main } = require('./verify-pharmacy-dispensing.cjs');

test('missing runner opt-in rejects before client loading or connections', async () => {
  let loads = 0;
  await assert.rejects(
    main({}, undefined, () => {
      loads++;
    }),
    /opt-in/,
  );
  assert.equal(loads, 0);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ownedConfig } = require('./verify-pharmacy-dispensing.cjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nina-odontogram-pg15-'));
  const runId = '11111111-1111-4111-8111-111111111111';
  const proof = {
    suite: 'pharmacy-dispensing',
    owner: 'nina-suite',
    runId,
    image: 'postgres:15-alpine',
    imageId: 'sha256:' + 'a'.repeat(64),
    containerId: 'b'.repeat(64),
    networkId: 'c'.repeat(64),
    networkName: 'nina-odontogram-pg15-' + runId.slice(0, 12),
    auth: 'isolated-scram',
    networkIsolated: true,
    networkMembers: 1,
    publishedHost: '127.0.0.1',
    publishedPort: 49152,
    database: 'nina_' + runId.replaceAll('-', '').slice(0, 16),
    user: 'nina_' + runId.replaceAll('-', '').slice(16, 28),
  };
  const proofFile = path.join(root, 'container-proof.json');
  fs.writeFileSync(proofFile, JSON.stringify(proof), { mode: 0o600 });
  const clientPath = path.join(root, 'isolated-client', 'index.js');
  fs.mkdirSync(path.dirname(clientPath));
  fs.writeFileSync(clientPath, 'throw new Error("fixture must never load");');
  const password = 'd'.repeat(64); // Dummy guard fixture, never a database credential.
  const env = {
    NINA_PHARMACY_DISPENSING_PG15: '1',
    NINA_ODONTOGRAM_PG15_TESTS: '1',
    NINA_ODONTOGRAM_PG15_RUN_ID: runId,
    NINA_ODONTOGRAM_PG15_PROOF_FILE: proofFile,
    NINA_ODONTOGRAM_PG15_PRISMA_CLIENT: clientPath,
    DATABASE_URL: `postgresql://${proof.user}:${password}@127.0.0.1:49152/${proof.database}?schema=public`,
  };
  const container = {
    Id: proof.containerId,
    Name: '/' + proof.networkName,
    Image: proof.imageId,
    State: { Status: 'running' },
    Config: {
      Image: proof.image,
      Labels: {
        'nina.odontogram-postgres15.owner': 'nina-suite',
        'nina.odontogram-postgres15.run': runId,
      },
      Env: [
        `POSTGRES_USER=${proof.user}`,
        `POSTGRES_DB=${proof.database}`,
        `POSTGRES_PASSWORD=${password}`,
        'POSTGRES_HOST_AUTH_METHOD=scram-sha-256',
        'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
      ],
    },
    HostConfig: {
      NetworkMode: proof.networkName,
      Tmpfs: { '/var/lib/postgresql/data': 'rw' },
    },
    Mounts: [],
    NetworkSettings: {
      Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] },
      Networks: { [proof.networkName]: { NetworkID: proof.networkId } },
    },
  };
  const network = {
    Id: proof.networkId,
    Name: proof.networkName,
    Internal: false,
    Labels: { ...container.Config.Labels },
    Containers: { [proof.containerId]: {} },
  };
  const calls = [];
  const inspect = async (args) => {
    calls.push(args);
    return [args[0] === 'network' ? network : container];
  };
  return {
    root,
    env,
    proofFile,
    clientPath,
    container,
    network,
    calls,
    inspect,
  };
}

test('valid startup binding inspects exact IDs without loading a client', async () => {
  const f = fixture();
  try {
    const config = await ownedConfig(f.env, f.inspect);
    assert.equal(config.clientPath, f.clientPath);
    assert.deepEqual(f.calls, [
      ['inspect', f.container.Id],
      ['network', 'inspect', f.network.Id],
    ]);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

for (const [name, mutate] of [
  [
    'wrong run opt-in',
    (f) => {
      f.env.NINA_ODONTOGRAM_PG15_TESTS = '0';
    },
  ],
  [
    'wrong datasource host',
    (f) => {
      f.env.DATABASE_URL = f.env.DATABASE_URL.replace(
        '127.0.0.1',
        'remote.invalid',
      );
    },
  ],
  [
    'wrong password',
    (f) => {
      f.env.DATABASE_URL = f.env.DATABASE_URL.replace(
        'd'.repeat(64),
        'e'.repeat(64),
      );
    },
  ],
  [
    'external client',
    (f) => {
      f.env.NINA_ODONTOGRAM_PG15_PRISMA_CLIENT = '/nonexistent/client.js';
    },
  ],
  [
    'linked client',
    (f) => {
      fs.unlinkSync(f.clientPath);
      fs.symlinkSync(__filename, f.clientPath);
    },
  ],
  [
    'public root',
    (f) => {
      fs.chmodSync(f.root, 0o755);
    },
  ],
  [
    'public proof',
    (f) => {
      fs.chmodSync(f.proofFile, 0o644);
    },
  ],
  [
    'root env file',
    (f) => {
      fs.writeFileSync(path.join(f.root, '.env'), '');
    },
  ],
  [
    'schema env file',
    (f) => {
      fs.mkdirSync(path.join(f.root, 'prisma'));
      fs.writeFileSync(path.join(f.root, 'prisma', '.env'), '');
    },
  ],
  [
    'wrong proof run',
    (f) => {
      const proof = JSON.parse(fs.readFileSync(f.proofFile));
      proof.runId = 'foreign';
      fs.writeFileSync(f.proofFile, JSON.stringify(proof));
    },
  ],
  [
    'foreign labels',
    (f) => {
      f.container.Config.Labels['nina.odontogram-postgres15.run'] = 'foreign';
    },
  ],
  [
    'wrong image identity',
    (f) => {
      f.container.Image = 'foreign';
    },
  ],
  [
    'nonloopback port',
    (f) => {
      f.container.NetworkSettings.Ports['5432/tcp'][0].HostIp = '0.0.0.0';
    },
  ],
  [
    'bind mount',
    (f) => {
      f.container.Mounts.push({ Type: 'bind', Destination: '/private' });
    },
  ],
  [
    'foreign network label',
    (f) => {
      f.network.Labels['nina.odontogram-postgres15.owner'] = 'foreign';
    },
  ],
  [
    'additional network member',
    (f) => {
      f.network.Containers.foreign = {};
    },
  ],
]) {
  test(`${name} refuses before client construction or connection`, async () => {
    const f = fixture();
    let loads = 0;
    let connections = 0;
    try {
      mutate(f);
      await assert.rejects(
        main(f.env, f.inspect, () => {
          loads++;
          return {
            PrismaClient: class {
              constructor() {
                connections++;
              }
            },
          };
        }),
      );
      assert.equal(loads, 0);
      assert.equal(connections, 0);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  });
}
