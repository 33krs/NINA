const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const {
  buildTrainingAccountAssertions,
} = require('./training-accounts-postgres-sql.cjs');

const MIGRATION_PATH = path.join(
  __dirname,
  '..',
  'prisma',
  'migrations',
  '20261012190000_add_training_accounts',
  'migration.sql',
);

function inputs() {
  const salt = crypto.randomBytes(16).toString('base64url');
  const key = crypto.randomBytes(64).toString('base64url');
  return {
    passwordHash: `$nina$scrypt$v=1$N=131072,r=8,p=1$${salt}$${key}`,
    runId: crypto.randomUUID(),
  };
}

describe('training-account PostgreSQL assertion SQL builder', () => {
  it('matches the existing password hash encoding and canonical UUID contract', () => {
    const valid = inputs();
    assert.equal(
      buildTrainingAccountAssertions(valid).sql.includes(valid.passwordHash),
      true,
    );

    for (const passwordHash of [
      `${valid.passwordHash}=`,
      valid.passwordHash.replace('$N=131072', '$N=1'),
      valid.passwordHash.replace(/([A-Za-z0-9_-]{22})\$/, '$1=$'),
    ]) {
      assert.throws(
        () => buildTrainingAccountAssertions({ ...valid, passwordHash }),
        /Invalid training-account assertion input/,
      );
    }
    assert.throws(
      () =>
        buildTrainingAccountAssertions({
          ...valid,
          runId: valid.runId.toUpperCase(),
        }),
      /Invalid training-account assertion input/,
    );
  });

  it('reads input fields once and rejects throwing or changing getters safely', () => {
    const valid = inputs();
    let hashReads = 0;
    const changing = {
      runId: valid.runId,
      get passwordHash() {
        hashReads++;
        return hashReads === 1 ? valid.passwordHash : 'private-changing-value';
      },
    };
    const built = buildTrainingAccountAssertions(changing);
    assert.equal(hashReads, 1);
    assert.equal(built.sql.includes('private-changing-value'), false);

    let runIdReads = 0;
    const changingRunId = {
      passwordHash: valid.passwordHash,
      get runId() {
        runIdReads++;
        return runIdReads === 1 ? valid.runId : "'; SELECT 1; --";
      },
    };
    const runIdBuilt = buildTrainingAccountAssertions(changingRunId);
    assert.equal(runIdReads, 1);
    assert.equal(runIdBuilt.sql.includes("'; SELECT 1; --"), false);

    const throwing = Object.defineProperty({}, 'runId', {
      get() {
        throw new Error('private getter details');
      },
    });
    assert.throws(
      () => buildTrainingAccountAssertions(throwing),
      (error) =>
        error.message === 'Invalid training-account assertion input' &&
        !error.message.includes('private'),
    );
  });

  it('returns bounded transaction SQL and fixed metadata for migration invariants', () => {
    const result = buildTrainingAccountAssertions(inputs());
    const migration = fs.readFileSync(MIGRATION_PATH, 'utf8');
    const expected = [
      'BEGIN;',
      'ROLLBACK;',
      '23502',
      '23505',
      '23514',
      'UserRole',
      'INSTRUCTOR',
      'STUDENT',
      'username_collation',
      'pg_enum_row.enumlabel',
      'pg_collation_row.collname',
      'authVersion',
      'isActive',
      'createdAt',
    ];

    assert.equal(result.sql.length <= 16 * 1024, true);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.assertions), true);
    assert.equal(Object.isFrozen(result.expectedRejections), true);
    for (const token of expected)
      assert.equal(result.sql.includes(token), true);
    assert.equal(result.sql.includes('passwordHash'), true);
    assert.equal(result.sql.includes('COMMIT;'), false);
    assert.equal(result.sql.includes('CREATE TABLE'), false);
    assert.equal(result.sql.includes('DELETE FROM "User";'), false);
    assert.equal(result.sql.includes('WHERE "id" IN ('), true);
    assert.equal(migration.includes('"role" "UserRole" NOT NULL,'), true);
    assert.equal(
      migration.includes('"username" VARCHAR(32) COLLATE "C" NOT NULL,'),
      true,
    );
    assert.equal(
      migration.includes('"updatedAt" TIMESTAMP(3) NOT NULL,'),
      true,
    );
    assert.equal(
      migration.includes('"isActive" BOOLEAN NOT NULL DEFAULT true,'),
      true,
    );
    assert.equal(
      migration.includes('"authVersion" INTEGER NOT NULL DEFAULT 0,'),
      true,
    );
    assert.equal(
      migration.includes(
        '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,',
      ),
      true,
    );
    assert.equal(
      migration.includes('CREATE UNIQUE INDEX "User_username_key"'),
      true,
    );

    assert.deepEqual(
      result.expectedRejections.map(({ checkpoint, sqlState }) => [
        checkpoint,
        sqlState,
      ]),
      [
        ['role_default', '23502'],
        ['username_null', '23502'],
        ['username_noncanonical', '23514'],
        ['username_too_short', '23514'],
        ['auth_version_negative', '23514'],
        ['username_duplicate', '23505'],
      ],
    );
    assert.deepEqual(result.assertions, [
      'table_empty_before',
      'role_enum_values',
      'role_has_no_default',
      'username_c_collation',
      'valid_username_boundaries',
      'explicit_roles_and_defaults',
      'table_empty_after',
      'table_empty_after_rollback',
    ]);

    const rollback = result.sql.indexOf('ROLLBACK;');
    const afterRollback = result.sql.indexOf(
      '$training_account_post_rollback_empty$',
    );
    assert.equal(rollback >= 0, true);
    assert.equal(afterRollback > rollback, true);
    assert.equal(
      result.sql.includes(
        'Training account table must remain empty after rollback',
      ),
      true,
    );
  });

  it('exposes fixed checkpoint names without embedding caller values in metadata', () => {
    const valid = inputs();
    const result = buildTrainingAccountAssertions(valid);
    const metadata = JSON.stringify({
      assertions: result.assertions,
      expectedRejections: result.expectedRejections,
    });

    assert.equal(metadata.includes(valid.passwordHash), false);
    assert.equal(metadata.includes(valid.runId), false);
    assert.equal(result.assertions.length > 0, true);
    assert.equal(
      result.assertions.every(
        (checkpoint) =>
          typeof checkpoint === 'string' && /^[a-z_]+$/.test(checkpoint),
      ),
      true,
    );
  });
});
