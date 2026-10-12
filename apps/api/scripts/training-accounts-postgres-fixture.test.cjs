'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { it } = require('node:test');

const MODULE_PATH = path.join(
  __dirname,
  'training-accounts-postgres-fixture.cjs',
);
const SOURCE = fs.readFileSync(MODULE_PATH, 'utf8');
const MIGRATION_RELATIVE_PATH =
  'prisma/migrations/20261012190000_add_training_accounts/migration.sql';
const FAILURE = { message: 'Training account fixture preparation failed' };

function makeRoot(content = 'CREATE TABLE synthetic;\n') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'training-migration-'));
  const migration = path.join(root, MIGRATION_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(migration), { recursive: true });
  fs.writeFileSync(migration, content, { mode: 0o600 });
  return { root, migration };
}

function loadReader(root, overrides = {}) {
  const fileSystem = new Proxy(fs, {
    get(target, key) {
      if (Object.hasOwn(overrides, key)) return overrides[key];
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const module = { exports: {} };
  const load = (specifier) => {
    if (specifier === 'node:fs') return fileSystem;
    if (specifier === 'node:path') return path;
    throw new Error('Unexpected dependency');
  };
  const filename = MODULE_PATH;
  const wrapper = vm.runInNewContext(
    `(function (require, module, exports, __filename, __dirname) { ${SOURCE}\n})`,
    { Buffer },
    { filename },
  );
  wrapper(load, module, module.exports, filename, path.join(root, 'scripts'));
  return module.exports;
}

function removeRoot(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

it('reads the fixed migration as bounded canonical UTF-8 without a path input', () => {
  const { root } = makeRoot('CREATE TABLE safe_fixture;\n');
  try {
    const reader = loadReader(root).readTrainingAccountMigration;
    assert.equal(reader.length, 0);
    assert.equal(reader('/untrusted/path'), 'CREATE TABLE safe_fixture;\n');
  } finally {
    removeRoot(root);
  }
});

it('contains migration read failures behind the fixed failure message', () => {
  const fixture = loadReader(os.tmpdir(), {
    realpathSync() {
      throw new Error('synthetic private filesystem detail');
    },
  });
  assert.throws(fixture.readTrainingAccountMigration, FAILURE);
});

it('rejects symbolic links and multiple-link migration files', () => {
  const linked = makeRoot('CREATE TABLE linked;\n');
  const outside = path.join(linked.root, 'outside.sql');
  fs.writeFileSync(outside, 'CREATE TABLE outside;\n');
  fs.unlinkSync(linked.migration);
  fs.symlinkSync(outside, linked.migration);
  try {
    assert.throws(
      loadReader(linked.root).readTrainingAccountMigration,
      FAILURE,
    );
  } finally {
    removeRoot(linked.root);
  }

  const hardlinked = makeRoot('CREATE TABLE hardlink;\n');
  fs.linkSync(hardlinked.migration, path.join(hardlinked.root, 'second.sql'));
  try {
    assert.throws(
      loadReader(hardlinked.root).readTrainingAccountMigration,
      FAILURE,
    );
  } finally {
    removeRoot(hardlinked.root);
  }
});

it('rejects oversized and ill-formed UTF-8 source bytes', () => {
  const oversized = makeRoot('x'.repeat(16 * 1024 + 1));
  try {
    assert.throws(
      loadReader(oversized.root).readTrainingAccountMigration,
      FAILURE,
    );
  } finally {
    removeRoot(oversized.root);
  }

  const malformed = makeRoot();
  fs.writeFileSync(malformed.migration, Buffer.from([0xff]));
  try {
    assert.throws(
      loadReader(malformed.root).readTrainingAccountMigration,
      FAILURE,
    );
  } finally {
    removeRoot(malformed.root);
  }
});

it('rejects file identity changes between canonical checks and descriptor reads', () => {
  const { root } = makeRoot('CREATE TABLE identity;\n');
  const overrides = {
    fstatSync(descriptor) {
      const stat = fs.fstatSync(descriptor);
      return Object.assign(Object.create(stat), { ino: stat.ino + 1 });
    },
  };
  try {
    assert.throws(
      loadReader(root, overrides).readTrainingAccountMigration,
      FAILURE,
    );
  } finally {
    removeRoot(root);
  }
});
