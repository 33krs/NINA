const {
  readRecoveryState,
  validatePreparedArtifacts,
} = require('./verify-training-accounts-postgres.cjs');

const MAX_OBSERVATION_BYTES = 256 * 1024;
const MAX_NETWORK_OBSERVATION_BYTES = 64 * 1024;
const MAX_CONTAINER_OBSERVATION_BYTES = 256 * 1024;
const IMAGE_TAG = 'postgres:15-alpine';
const PGDATA = '/var/lib/postgresql/data';
const ARCHITECTURES = new Set(['amd64', 'arm64']);
const OWNER_LABEL = 'nina.training-postgres.owner';
const RUN_LABEL = 'nina.training-postgres.run';
const OWNER_VALUE = 'nina-suite';
const PROOF_PATH = '/run/nina-proof/proof.sql';
const TMPFS = Object.freeze({
  '/tmp': 'rw,noexec,nosuid,size=16m',
  '/run/postgresql': 'rw,noexec,nosuid,size=16m',
  [PGDATA]: 'rw,noexec,nosuid,size=256m',
});
const ENDPOINT_KEYS = Object.freeze([
  'Name',
  'EndpointID',
  'MacAddress',
  'IPv4Address',
  'IPv6Address',
]);

function rejectObservation() {
  throw new Error('Training-account PostgreSQL image observation rejected');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedStringArray(value, maxItems, maxLength) {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === 'string' && item.length <= maxLength)
  );
}

function readPostgresMetadata(environment) {
  if (!boundedStringArray(environment, 4096, 8192)) rejectObservation();
  const values = new Map();
  const recognized = new Set(['PG_MAJOR', 'PG_VERSION', 'PGDATA']);
  for (const entry of environment) {
    const separator = entry.indexOf('=');
    const key = separator < 0 ? entry : entry.slice(0, separator);
    if (!recognized.has(key)) continue;
    if (separator < 0 || values.has(key)) rejectObservation();
    values.set(key, entry.slice(separator + 1));
  }
  if (
    values.size !== recognized.size ||
    values.get('PG_MAJOR') !== '15' ||
    !/^15\.(?:0|[1-9]\d{0,2})$/.test(values.get('PG_VERSION')) ||
    values.get('PGDATA') !== PGDATA
  )
    rejectObservation();
  return values;
}

function validateTrainingPostgresImage(imageJson, expectedArchitecture) {
  if (
    typeof imageJson !== 'string' ||
    Buffer.byteLength(imageJson, 'utf8') > MAX_OBSERVATION_BYTES ||
    typeof expectedArchitecture !== 'string' ||
    !ARCHITECTURES.has(expectedArchitecture)
  )
    rejectObservation();

  let image;
  try {
    image = JSON.parse(imageJson);
  } catch {
    rejectObservation();
  }
  if (
    !isRecord(image) ||
    typeof image.Id !== 'string' ||
    !/^sha256:[a-f\d]{64}$/.test(image.Id) ||
    !boundedStringArray(image.RepoTags, 128, 256) ||
    !image.RepoTags.includes(IMAGE_TAG) ||
    image.Os !== 'linux' ||
    image.Architecture !== expectedArchitecture ||
    !isRecord(image.Config) ||
    !Array.isArray(image.Config.Entrypoint) ||
    image.Config.Entrypoint.length !== 1 ||
    image.Config.Entrypoint[0] !== 'docker-entrypoint.sh' ||
    !Array.isArray(image.Config.Cmd) ||
    image.Config.Cmd.length !== 1 ||
    image.Config.Cmd[0] !== 'postgres' ||
    image.Config.User !== ''
  )
    rejectObservation();

  const metadata = readPostgresMetadata(image.Config.Env);
  return Object.freeze({
    imageId: image.Id,
    architecture: image.Architecture,
    major: metadata.get('PG_MAJOR'),
    version: metadata.get('PG_VERSION'),
  });
}

function rejectNetworkObservation() {
  throw new Error('Training-account PostgreSQL network observation rejected');
}

function exactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function validateNetworkMembers(inspection, state, phase) {
  if (!isRecord(inspection.Containers)) rejectNetworkObservation();
  const memberIds = Object.keys(inspection.Containers);
  if (memberIds.length > 64) rejectNetworkObservation();

  const containerId = state.container.id;
  const containerRegistered =
    typeof containerId === 'string' && /^[a-f\d]{64}$/.test(containerId);
  if (
    typeof state.container.uncertain !== 'boolean' ||
    typeof state.container.absent !== 'boolean' ||
    state.container.uncertain ||
    (containerRegistered && state.container.absent) ||
    (!containerRegistered && !state.container.absent)
  )
    rejectNetworkObservation();

  for (const memberId of memberIds) {
    const member = inspection.Containers[memberId];
    if (
      !/^[a-f\d]{64}$/.test(memberId) ||
      !exactKeys(member, ENDPOINT_KEYS) ||
      ENDPOINT_KEYS.some(
        (key) => typeof member[key] !== 'string' || member[key].length > 256,
      )
    )
      rejectNetworkObservation();
  }

  if (phase === 'running') {
    if (
      !containerRegistered ||
      memberIds.length !== 1 ||
      memberIds[0] !== containerId ||
      inspection.Containers[containerId].Name !== state.name
    )
      rejectNetworkObservation();
  } else if (memberIds.length > 0) {
    if (
      !containerRegistered ||
      memberIds.length !== 1 ||
      memberIds[0] !== containerId ||
      inspection.Containers[containerId].Name !== state.name
    )
      rejectNetworkObservation();
  }

  return memberIds.length;
}

function validateTrainingPostgresNetwork(context, networkJson, phase) {
  let state;
  try {
    state = readRecoveryState(context);
  } catch {
    rejectNetworkObservation();
  }
  if (
    typeof networkJson !== 'string' ||
    Buffer.byteLength(networkJson, 'utf8') > MAX_NETWORK_OBSERVATION_BYTES ||
    !['created', 'running'].includes(phase) ||
    !isRecord(state.network) ||
    !isRecord(state.container) ||
    typeof state.runId !== 'string' ||
    typeof state.name !== 'string' ||
    context.name !== state.name ||
    state.proofSucceeded !== false ||
    state.cleanupConfirmed !== false ||
    typeof state.network.id !== 'string' ||
    !/^[a-f\d]{64}$/.test(state.network.id) ||
    state.network.uncertain !== false ||
    state.network.absent !== false
  )
    rejectNetworkObservation();

  let inspection;
  try {
    inspection = JSON.parse(networkJson);
  } catch {
    rejectNetworkObservation();
  }
  if (
    !isRecord(inspection) ||
    inspection.Id !== state.network.id ||
    inspection.Name !== state.name ||
    inspection.Driver !== 'bridge' ||
    inspection.Internal !== true ||
    !exactKeys(inspection.Labels, [OWNER_LABEL, RUN_LABEL]) ||
    inspection.Labels[OWNER_LABEL] !== OWNER_VALUE ||
    inspection.Labels[RUN_LABEL] !== state.runId
  )
    rejectNetworkObservation();

  const memberCount = validateNetworkMembers(inspection, state, phase);
  return Object.freeze({
    name: state.name,
    phase,
    driver: 'bridge',
    internal: true,
    memberCount,
  });
}

function rejectIsolationObservation() {
  throw new Error('Training-account PostgreSQL isolation observation rejected');
}

function rejectMountObservation() {
  throw new Error('Training-account PostgreSQL mount observation rejected');
}

function noPublishedPorts(value) {
  if (value === null) return true;
  if (!isRecord(value) || Object.keys(value).length !== 0) return false;
  return true;
}

function validateActualMounts(mounts, proofSql) {
  if (!Array.isArray(mounts) || mounts.length > 8) return false;
  let proofMounts = 0;
  const tmpfsDestinations = new Set();
  for (const mount of mounts) {
    if (
      !isRecord(mount) ||
      Object.keys(mount).some(
        (key) =>
          ![
            'Type',
            'Name',
            'Source',
            'Destination',
            'Driver',
            'Mode',
            'RW',
            'Propagation',
          ].includes(key),
      )
    )
      return false;
    if (mount.Type === 'bind') {
      if (
        mount.Source !== proofSql ||
        mount.Destination !== PROOF_PATH ||
        mount.RW !== false ||
        (mount.Propagation !== undefined &&
          ![
            '',
            'private',
            'rprivate',
            'shared',
            'rshared',
            'slave',
            'rslave',
          ].includes(mount.Propagation)) ||
        (mount.Mode !== undefined &&
          (typeof mount.Mode !== 'string' ||
            !/(?:^|,)ro(?:,|$)/.test(mount.Mode)))
      )
        return false;
      proofMounts += 1;
      if (proofMounts > 1) return false;
      continue;
    }
    if (mount.Type === 'tmpfs') {
      const destination = mount.Destination;
      if (
        typeof destination !== 'string' ||
        !Object.hasOwn(TMPFS, destination) ||
        tmpfsDestinations.has(destination) ||
        mount.RW !== true ||
        (mount.Mode !== undefined && mount.Mode !== TMPFS[destination])
      )
        return false;
      tmpfsDestinations.add(destination);
      continue;
    }
    // Named/anonymous volumes and unrecognized bind types are never allowed.
    return false;
  }
  return proofMounts === 1;
}

function validateMountSettings(container, proofSql) {
  const host = container.HostConfig;
  if (
    !isRecord(host) ||
    !exactKeys(host.Tmpfs, Object.keys(TMPFS)) ||
    Object.keys(TMPFS).some(
      (destination) => host.Tmpfs[destination] !== TMPFS[destination],
    ) ||
    !Array.isArray(host.Mounts) ||
    host.Mounts.length !== 1
  )
    return false;

  const plannedMount = host.Mounts[0];
  if (
    !isRecord(plannedMount) ||
    Object.keys(plannedMount).some(
      (key) =>
        ![
          'Type',
          'Source',
          'Target',
          'ReadOnly',
          'Consistency',
          'BindOptions',
          'VolumeOptions',
          'TmpfsOptions',
        ].includes(key),
    ) ||
    plannedMount.Type !== 'bind' ||
    plannedMount.Source !== proofSql ||
    plannedMount.Target !== PROOF_PATH ||
    plannedMount.ReadOnly !== true ||
    (plannedMount.Consistency !== undefined &&
      !['', 'default'].includes(plannedMount.Consistency)) ||
    ['BindOptions', 'VolumeOptions', 'TmpfsOptions'].some(
      (key) =>
        plannedMount[key] !== undefined &&
        plannedMount[key] !== null &&
        (!isRecord(plannedMount[key]) ||
          Object.keys(plannedMount[key]).length !== 0),
    )
  )
    return false;

  return validateActualMounts(container.Mounts, proofSql);
}

function validateTrainingPostgresMounts(context, containerJson) {
  let artifacts;
  try {
    artifacts = validatePreparedArtifacts(context);
  } catch {
    rejectMountObservation();
  }
  if (
    typeof containerJson !== 'string' ||
    Buffer.byteLength(containerJson, 'utf8') > MAX_CONTAINER_OBSERVATION_BYTES
  )
    rejectMountObservation();
  let container;
  try {
    container = JSON.parse(containerJson);
  } catch {
    rejectMountObservation();
  }
  if (
    !isRecord(container) ||
    !validateMountSettings(container, artifacts.proofSql)
  )
    rejectMountObservation();
  return Object.freeze({
    proofMountReadonly: true,
    temporaryFileSystems: 3,
  });
}

function validateContainerSettings(container, state, phase) {
  if (
    container.Id !== state.container.id ||
    container.Image !== state.imageId ||
    container.Name !== `/${state.name}` ||
    !isRecord(container.Config) ||
    container.Config.Image !== state.imageId ||
    !exactKeys(container.Config.Labels, [OWNER_LABEL, RUN_LABEL]) ||
    container.Config.Labels[OWNER_LABEL] !== OWNER_VALUE ||
    container.Config.Labels[RUN_LABEL] !== state.runId ||
    container.Config.User !== '0' ||
    !Array.isArray(container.Config.Entrypoint) ||
    container.Config.Entrypoint.length !== 1 ||
    container.Config.Entrypoint[0] !== 'docker-entrypoint.sh' ||
    !Array.isArray(container.Config.Cmd) ||
    container.Config.Cmd.length !== 1 ||
    container.Config.Cmd[0] !== 'postgres'
  )
    return false;

  const expectedRunning = phase === 'running';
  const expectedStatus = expectedRunning ? 'running' : 'created';
  const runtime = container.State;
  if (
    !isRecord(runtime) ||
    runtime.Status !== expectedStatus ||
    runtime.Running !== expectedRunning ||
    runtime.Paused !== false ||
    runtime.Restarting !== false ||
    runtime.Dead !== false
  )
    return false;

  const host = container.HostConfig;
  if (
    !isRecord(host) ||
    host.ReadonlyRootfs !== true ||
    host.Privileged !== false ||
    host.PublishAllPorts !== false ||
    !noPublishedPorts(host.PortBindings) ||
    host.NetworkMode !== state.network.id
  )
    return false;

  const networkSettings = container.NetworkSettings;
  if (
    !isRecord(networkSettings) ||
    !isRecord(networkSettings.Networks) ||
    !exactKeys(networkSettings.Networks, [state.name]) ||
    !isRecord(networkSettings.Networks[state.name]) ||
    networkSettings.Networks[state.name].NetworkID !== state.network.id ||
    !isRecord(networkSettings.Ports)
  )
    return false;
  const endpoint = networkSettings.Networks[state.name];
  if (
    endpoint.EndpointID !== undefined &&
    endpoint.EndpointID !== '' &&
    (typeof endpoint.EndpointID !== 'string' ||
      !/^[a-f\d]{64}$/.test(endpoint.EndpointID))
  )
    return false;
  if (expectedRunning && !/^[a-f\d]{64}$/.test(endpoint.EndpointID ?? ''))
    return false;

  // A null port mapping means exposed only inside the container; no host bind.
  for (const [port, bindings] of Object.entries(networkSettings.Ports)) {
    if (
      port !== '5432/tcp' ||
      (bindings !== null && (!Array.isArray(bindings) || bindings.length !== 0))
    )
      return false;
  }
  return true;
}

function validateTrainingPostgresIsolation(
  context,
  containerJson,
  networkJson,
  phase,
) {
  let state;
  let network;
  let mounts;
  try {
    state = readRecoveryState(context);
    validatePreparedArtifacts(context);
    network = validateTrainingPostgresNetwork(context, networkJson, phase);
    mounts = validateTrainingPostgresMounts(context, containerJson);
  } catch {
    rejectIsolationObservation();
  }
  if (
    typeof containerJson !== 'string' ||
    Buffer.byteLength(containerJson, 'utf8') >
      MAX_CONTAINER_OBSERVATION_BYTES ||
    !['created', 'running'].includes(phase) ||
    !isRecord(state.container) ||
    typeof state.container.id !== 'string' ||
    !/^[a-f\d]{64}$/.test(state.container.id) ||
    state.container.uncertain !== false ||
    state.container.absent !== false ||
    !isRecord(state.network) ||
    typeof state.network.id !== 'string' ||
    !/^[a-f\d]{64}$/.test(state.network.id) ||
    state.network.uncertain !== false ||
    state.network.absent !== false ||
    typeof state.imageId !== 'string' ||
    !/^sha256:[a-f\d]{64}$/.test(state.imageId) ||
    typeof state.runId !== 'string' ||
    typeof state.name !== 'string' ||
    context.name !== state.name ||
    state.proofSucceeded !== false ||
    state.cleanupConfirmed !== false ||
    network.phase !== phase
  )
    rejectIsolationObservation();

  let container;
  let networkInspection;
  try {
    container = JSON.parse(containerJson);
    networkInspection = JSON.parse(networkJson);
  } catch {
    rejectIsolationObservation();
  }
  if (
    !isRecord(container) ||
    !validateContainerSettings(container, state, phase)
  )
    rejectIsolationObservation();
  const networkMembers = networkInspection.Containers;
  if (Object.keys(networkMembers).length === 1) {
    const member = networkMembers[state.container.id];
    const endpoint = container.NetworkSettings.Networks[state.name];
    if (
      !member ||
      member.Name !== state.name ||
      (member.EndpointID !== '' &&
        endpoint.EndpointID !== '' &&
        member.EndpointID !== endpoint.EndpointID)
    )
      rejectIsolationObservation();
  }

  return Object.freeze({
    name: state.name,
    phase,
    containerId: state.container.id,
    networkId: state.network.id,
    imageId: state.imageId,
    networkMemberCount: network.memberCount,
    readonlyRootfs: true,
    proofMountReadonly: mounts.proofMountReadonly,
    hostPortsPublished: false,
  });
}

module.exports = {
  validateTrainingPostgresImage,
  validateTrainingPostgresNetwork,
  validateTrainingPostgresMounts,
  validateTrainingPostgresIsolation,
};
