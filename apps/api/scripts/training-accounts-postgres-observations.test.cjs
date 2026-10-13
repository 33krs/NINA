const assert = require('node:assert/strict');
const { it } = require('node:test');
const {
  validateTrainingPostgresImage,
} = require('./training-accounts-postgres-observations.cjs');

function image(overrides = {}) {
  return {
    Id: `sha256:${'a'.repeat(64)}`,
    RepoTags: ['postgres:15-alpine'],
    Os: 'linux',
    Architecture: 'amd64',
    Config: {
      Env: [
        'PATH=/usr/local/bin',
        'PG_MAJOR=15',
        'PG_VERSION=15.19',
        'PGDATA=/var/lib/postgresql/data',
      ],
      Entrypoint: ['docker-entrypoint.sh'],
      Cmd: ['postgres'],
      User: '',
    },
    ...overrides,
  };
}

function observe(value, architecture = 'amd64') {
  return validateTrainingPostgresImage(JSON.stringify(value), architecture);
}

it('returns only frozen safe metadata for one compatible official-tag observation', () => {
  const observed = observe(image());
  assert.deepEqual(observed, {
    imageId: `sha256:${'a'.repeat(64)}`,
    architecture: 'amd64',
    major: '15',
    version: '15.19',
  });
  assert.equal(Object.isFrozen(observed), true);
});

it('accepts only the explicit supported architecture and matching expectation', () => {
  const arm = image({ Architecture: 'arm64' });
  assert.equal(observe(arm, 'arm64').architecture, 'arm64');
  for (const expected of ['x64', 'arm64v8', 'amd64;secret']) {
    assert.throws(() => observe(image(), expected), {
      message: 'Training-account PostgreSQL image observation rejected',
    });
  }
  assert.throws(() => observe(arm, 'amd64'));
});

it('rejects malformed, oversized, non-object, and multi-image observations generically', () => {
  for (const source of [
    '',
    '{secret-shaped bad JSON',
    'null',
    '[]',
    '1',
    ' '.repeat(262145),
  ]) {
    assert.throws(() => validateTrainingPostgresImage(source, 'amd64'), {
      message: 'Training-account PostgreSQL image observation rejected',
    });
  }
  assert.throws(() => observe([image()]));
  const withUnreturnedMetadata = observe({
    ...image(),
    leaked: 'synthetic-secret-value',
  });
  assert.equal(Object.hasOwn(withUnreturnedMetadata, 'leaked'), false);
});

it('rejects wrong identity, tag, operating system, and architecture metadata', () => {
  const base = image();
  const cases = [
    { ...base, Id: 'sha256:ABC' },
    { ...base, Id: 'a'.repeat(64) },
    { ...base, RepoTags: ['postgres:15'] },
    { ...base, Os: 'windows' },
    { ...base, Architecture: 's390x' },
  ];
  for (const value of cases) assert.throws(() => observe(value));
});

it('rejects missing, malformed, duplicate, conflicting, or wrong PostgreSQL config metadata', () => {
  const base = image();
  const cases = [
    {
      ...base,
      Config: {
        ...base.Config,
        Env: ['PG_VERSION=15.19', 'PGDATA=/var/lib/postgresql/data'],
      },
    },
    {
      ...base,
      Config: { ...base.Config, Env: [...base.Config.Env, 'PG_MAJOR=15'] },
    },
    {
      ...base,
      Config: { ...base.Config, Env: [...base.Config.Env, 'PG_VERSION=15.18'] },
    },
    {
      ...base,
      Config: { ...base.Config, Env: [...base.Config.Env, 'PGDATA='] },
    },
    {
      ...base,
      Config: { ...base.Config, Env: [...base.Config.Env, 'PG_VERSION=18.1'] },
    },
    {
      ...base,
      Config: {
        ...base.Config,
        Env: [...base.Config.Env, 'PGDATA=/var/lib/postgresql/18/docker'],
      },
    },
    { ...base, Config: { ...base.Config, Entrypoint: ['/custom-entrypoint'] } },
    { ...base, Config: { ...base.Config, Cmd: ['bash'] } },
    { ...base, Config: { ...base.Config, User: 'postgres' } },
  ];
  for (const value of cases) assert.throws(() => observe(value));
});

it('does not disclose rejected source content or expected-architecture input', () => {
  const secret = 'synthetic-observation-secret';
  const source = JSON.stringify({
    ...image(),
    Config: {
      ...image().Config,
      Env: [...image().Config.Env, `PG_VERSION=${secret}`],
    },
  });
  assert.throws(
    () => validateTrainingPostgresImage(source, 'amd64'),
    (error) => {
      assert.equal(
        error.message,
        'Training-account PostgreSQL image observation rejected',
      );
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});
