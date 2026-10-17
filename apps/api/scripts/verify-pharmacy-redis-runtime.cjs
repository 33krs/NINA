const { readRedisProof } = require('./verify-pharmacy-redis-proof.cjs');
const OWNER_LABEL = 'nina.pharmacy-redis.owner';
const RUN_LABEL = 'nina.pharmacy-redis.run';
const CONFIG_TARGET = '/run/nina-redis.conf';
const IMAGE = 'redis:7-alpine';

function check(condition, message) {
  // Never include rejected proof/configuration values in diagnostics.
  if (!condition) throw new Error(message);
}

function same(actual, expected, message) {
  check(JSON.stringify(actual) === JSON.stringify(expected), message);
}

// Import-only Docker observation guard. The future owned orchestrator must
// inspect both objects using the pinned socket before loading any Redis client.
function validateRedisProof(input, { container, network }) {
  const config = readRedisProof(input);
  const { proof, configFile } = config;
  const runId = proof.runId;
  const name = proof.networkName;
  const password = new URL(config.redisUrl).password;
  const labels = { [OWNER_LABEL]: 'nina-suite', [RUN_LABEL]: runId };
  check(
    container?.Id === proof.containerId &&
      container.Image === proof.imageId &&
      container.Name === '/' + name &&
      container.State?.Status === 'running' &&
      container.Config?.Image === IMAGE &&
      container.Config.User === `${process.getuid()}:${process.getgid()}`,
    'Redis container identity mismatch',
  );
  same(container.Config.Labels, labels, 'Redis container labels mismatch');
  same(
    container.Config.Cmd,
    ['redis-server', CONFIG_TARGET],
    'Redis command mismatch',
  );
  same(
    container.Config.Entrypoint,
    ['docker-entrypoint.sh'],
    'Redis entrypoint mismatch',
  );
  check(
    Array.isArray(container.Config.Env) &&
      container.Config.Env.every((entry) => !entry.includes(password)),
    'Redis credential must remain in private files',
  );
  const host = container.HostConfig;
  check(
    host?.NetworkMode === name &&
      host.ReadonlyRootfs === true &&
      host.Privileged === false,
    'Redis host isolation mismatch',
  );
  same(host.CapDrop, ['ALL'], 'Redis capabilities mismatch');
  same(
    host.SecurityOpt,
    ['no-new-privileges'],
    'Redis security options mismatch',
  );
  same(
    host.Binds,
    [`${configFile}:${CONFIG_TARGET}:ro`],
    'Redis config mount mismatch',
  );
  same(
    host.Tmpfs,
    {
      '/data': `rw,noexec,nosuid,size=16m,uid=${process.getuid()},gid=${process.getgid()}`,
    },
    'Redis ephemeral storage mismatch',
  );
  const configMount = (mount) =>
    mount.Type === 'bind' &&
    mount.Source === configFile &&
    mount.Destination === CONFIG_TARGET &&
    mount.RW === false;
  check(
    Array.isArray(container.Mounts) &&
      container.Mounts.length >= 1 &&
      container.Mounts.length <= 2 &&
      container.Mounts.filter(configMount).length === 1 &&
      container.Mounts.every(
        (mount) =>
          configMount(mount) ||
          (mount.Type === 'tmpfs' && mount.Destination === '/data'),
      ),
    'Redis mounts must contain only owned config and ephemeral data',
  );
  const ports = {
    '6379/tcp': [{ HostIp: '127.0.0.1', HostPort: String(proof.port) }],
  };
  same(host.PortBindings, ports, 'Redis port binding mismatch');
  same(
    container.NetworkSettings?.Ports,
    ports,
    'Redis published port mismatch',
  );
  same(
    Object.keys(container.NetworkSettings?.Networks ?? {}),
    [name],
    'Redis network membership mismatch',
  );
  check(
    container.NetworkSettings.Networks[name].NetworkID === proof.networkId,
    'Redis network ID mismatch',
  );
  check(
    network?.Id === proof.networkId &&
      network.Name === name &&
      network.Driver === 'bridge' &&
      network.Internal === false,
    'Redis network identity mismatch',
  );
  same(network.Labels, labels, 'Redis network labels mismatch');
  same(
    Object.keys(network.Containers ?? {}),
    [proof.containerId],
    'Redis network must have only the owned container',
  );
  return config;
}

module.exports = { validateRedisProof };
