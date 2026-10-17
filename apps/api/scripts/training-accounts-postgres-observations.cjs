const MAX_OBSERVATION_BYTES = 256 * 1024;
const IMAGE_TAG = 'postgres:15-alpine';
const PGDATA = '/var/lib/postgresql/data';
const ARCHITECTURES = new Set(['amd64', 'arm64']);

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

module.exports = { validateTrainingPostgresImage };
