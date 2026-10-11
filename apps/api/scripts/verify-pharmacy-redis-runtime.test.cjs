const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRedisProof } = require('./verify-pharmacy-redis-runtime.cjs');
const { privateRedisFixture } = require('./pharmacy-redis-test-fixture.cjs');

function fixture(t) {
  const data = privateRedisFixture(t);
  const { proof, configFile, input } = data;
  const runId = proof.runId;
  const name = proof.networkName;
  const labels = {
    'nina.pharmacy-redis.owner': 'nina-suite',
    'nina.pharmacy-redis.run': runId,
  };
  const ports = { '6379/tcp': [{ HostIp: '127.0.0.1', HostPort: '49152' }] };
  const container = {
    Id: proof.containerId,
    Image: proof.imageId,
    Name: '/' + name,
    State: { Status: 'running' },
    Config: {
      Image: proof.image,
      User: `${process.getuid()}:${process.getgid()}`,
      Labels: { ...labels },
      Cmd: ['redis-server', '/run/nina-redis.conf'],
      Entrypoint: ['docker-entrypoint.sh'],
      Env: ['PATH=/usr/bin'],
    },
    HostConfig: {
      NetworkMode: name,
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      Binds: [`${configFile}:/run/nina-redis.conf:ro`],
      Tmpfs: {
        '/data': `rw,noexec,nosuid,size=16m,uid=${process.getuid()},gid=${process.getgid()}`,
      },
      PortBindings: structuredClone(ports),
    },
    Mounts: [
      {
        Type: 'bind',
        Source: configFile,
        Destination: '/run/nina-redis.conf',
        RW: false,
      },
    ],
    NetworkSettings: {
      Ports: structuredClone(ports),
      Networks: { [name]: { NetworkID: proof.networkId } },
    },
  };
  const network = {
    Id: proof.networkId,
    Name: name,
    Driver: 'bridge',
    Internal: false,
    Labels: { ...labels },
    Containers: { [proof.containerId]: {} },
  };
  const observations = { container, network };
  return {
    ...data,
    container,
    network,
    observations,
    validate: () => validateRedisProof(input, observations),
  };
}

test('rejects a container identity not bound to the run before permitting runtime use', (t) => {
  const f = fixture(t);
  f.container.Id = 'unrelated-container';
  assert.throws(f.validate, /Redis container identity mismatch/);
});

for (const [name, mutate] of [
  [
    'image identity',
    (f) => {
      f.container.Image = 'sha256:' + 'd'.repeat(64);
    },
  ],
  [
    'container name',
    (f) => {
      f.container.Name = '/other';
    },
  ],
  [
    'stopped container',
    (f) => {
      f.container.State.Status = 'exited';
    },
  ],
  [
    'image reference',
    (f) => {
      f.container.Config.Image = 'redis:latest';
    },
  ],
  [
    'root user',
    (f) => {
      f.container.Config.User = '0:0';
    },
  ],
  [
    'container owner label',
    (f) => {
      f.container.Config.Labels['nina.pharmacy-redis.owner'] = 'other';
    },
  ],
  [
    'container run label',
    (f) => {
      f.container.Config.Labels['nina.pharmacy-redis.run'] = 'other';
    },
  ],
  [
    'command secret',
    (f) => {
      f.container.Config.Cmd.push(f.password);
    },
  ],
  [
    'entrypoint',
    (f) => {
      f.container.Config.Entrypoint = ['sh'];
    },
  ],
  [
    'environment secret',
    (f) => {
      f.container.Config.Env.push('PASSWORD=' + f.password);
    },
  ],
  [
    'host network',
    (f) => {
      f.container.HostConfig.NetworkMode = 'host';
    },
  ],
  [
    'writable root',
    (f) => {
      f.container.HostConfig.ReadonlyRootfs = false;
    },
  ],
  [
    'capabilities',
    (f) => {
      f.container.HostConfig.CapDrop = [];
    },
  ],
  [
    'security options',
    (f) => {
      f.container.HostConfig.SecurityOpt = [];
    },
  ],
  [
    'config bind source',
    (f) => {
      f.container.HostConfig.Binds = ['/other:/run/nina-redis.conf:ro'];
    },
  ],
  [
    'persistent data',
    (f) => {
      f.container.HostConfig.Tmpfs = {};
    },
  ],
  [
    'writable config',
    (f) => {
      f.container.Mounts[0].RW = true;
    },
  ],
  [
    'unrelated extra bind',
    (f) => {
      f.container.Mounts.push({
        Type: 'bind',
        Source: '/other',
        Destination: '/other',
        RW: false,
      });
    },
  ],
  [
    'persistent volume',
    (f) => {
      f.container.Mounts.push({ Type: 'volume', Destination: '/data' });
    },
  ],
  [
    'wildcard binding',
    (f) => {
      f.container.HostConfig.PortBindings['6379/tcp'][0].HostIp = '0.0.0.0';
    },
  ],
  [
    'unexpected published port',
    (f) => {
      f.container.NetworkSettings.Ports['6379/tcp'][0].HostPort = '49153';
    },
  ],
  [
    'second exposed port',
    (f) => {
      f.container.NetworkSettings.Ports['1234/tcp'] = [];
    },
  ],
  [
    'second network',
    (f) => {
      f.container.NetworkSettings.Networks.other = {};
    },
  ],
  [
    'container network ID',
    (f) => {
      Object.values(f.container.NetworkSettings.Networks)[0].NetworkID =
        'other';
    },
  ],
  [
    'network identity',
    (f) => {
      f.network.Id = 'other';
    },
  ],
  [
    'network name',
    (f) => {
      f.network.Name = 'other';
    },
  ],
  [
    'network driver',
    (f) => {
      f.network.Driver = 'host';
    },
  ],
  [
    'internal network',
    (f) => {
      f.network.Internal = true;
    },
  ],
  [
    'network label',
    (f) => {
      f.network.Labels['nina.pharmacy-redis.run'] = 'other';
    },
  ],
  [
    'another network member',
    (f) => {
      f.network.Containers.other = {};
    },
  ],
  [
    'missing owned member',
    (f) => {
      f.network.Containers = {};
    },
  ],
])
  test(`rejects unsafe Docker observation: ${name}`, (t) => {
    const f = fixture(t);
    mutate(f);
    assert.throws(f.validate);
  });

test('accepts only an optional matching tmpfs mount alongside the readonly config', (t) => {
  const f = fixture(t);
  f.container.Mounts.push({ Type: 'tmpfs', Destination: '/data', RW: true });
  assert.equal(f.validate().redisUrl, f.proof.redisUrl);
});

for (const privileged of [true, undefined]) {
  test(`rejects enabled or missing privileged mode: ${privileged}`, (t) => {
    const f = fixture(t);
    f.container.HostConfig.Privileged = privileged;
    assert.throws(f.validate, /Redis host isolation mismatch/);
  });
}
