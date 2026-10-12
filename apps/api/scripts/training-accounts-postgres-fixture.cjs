'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MIGRATION_RELATIVE_PATH =
  'prisma/migrations/20261012190000_add_training_accounts/migration.sql';
const MAX_MIGRATION_BYTES = 16 * 1024;

function privateFailure() {
  throw new Error('Training account fixture preparation failed');
}

function readCanonicalFile(filename, maximumBytes) {
  if (
    path.resolve(filename) !== filename ||
    fs.realpathSync(filename) !== filename
  )
    privateFailure();

  const entry = fs.lstatSync(filename);
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    entry.nlink !== 1 ||
    entry.size <= 0 ||
    entry.size > maximumBytes
  )
    privateFailure();

  const descriptor = fs.openSync(
    filename,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino ||
      opened.size !== entry.size ||
      opened.size > maximumBytes
    )
      privateFailure();

    const bytes = fs.readFileSync(descriptor);
    const final = fs.fstatSync(descriptor);
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length !== opened.size ||
      bytes.length > maximumBytes ||
      final.dev !== opened.dev ||
      final.ino !== opened.ino ||
      final.size !== opened.size
    )
      privateFailure();
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) privateFailure();
    return text;
  } finally {
    fs.closeSync(descriptor);
  }
}

function readTrainingAccountMigration() {
  try {
    const apiRoot = path.resolve(__dirname, '..');
    return readCanonicalFile(
      path.join(apiRoot, MIGRATION_RELATIVE_PATH),
      MAX_MIGRATION_BYTES,
    );
  } catch {
    privateFailure();
  }
}

module.exports = { readTrainingAccountMigration };
