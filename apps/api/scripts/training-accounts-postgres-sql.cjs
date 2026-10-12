const MAX_SQL_BYTES = 16 * 1024;
const MAX_HASH_LENGTH = 256;
const PASSWORD_HASH_PATTERN =
  /^\$nina\$scrypt\$v=1\$N=131072,r=8,p=1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ASSERTIONS = Object.freeze([
  'table_empty_before',
  'role_enum_values',
  'role_has_no_default',
  'username_c_collation',
  'valid_username_boundaries',
  'explicit_roles_and_defaults',
  'table_empty_after',
  'table_empty_after_rollback',
]);

const EXPECTED_REJECTIONS = Object.freeze(
  [
    ['role_default', '23502'],
    ['username_null', '23502'],
    ['username_noncanonical', '23514'],
    ['username_too_short', '23514'],
    ['auth_version_negative', '23514'],
    ['username_duplicate', '23505'],
  ].map(([checkpoint, sqlState]) => Object.freeze({ checkpoint, sqlState })),
);

function invalidInput() {
  throw new Error('Invalid training-account assertion input');
}

function snapshotInputs(value) {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      invalidInput();
    const passwordHash = value.passwordHash;
    const runId = value.runId;
    if (
      typeof passwordHash !== 'string' ||
      passwordHash.length > MAX_HASH_LENGTH ||
      typeof runId !== 'string' ||
      !UUID_PATTERN.test(runId)
    )
      invalidInput();

    const match = PASSWORD_HASH_PATTERN.exec(passwordHash);
    if (!match) invalidInput();
    const salt = Buffer.from(match[1], 'base64url');
    const key = Buffer.from(match[2], 'base64url');
    if (
      salt.length !== 16 ||
      key.length !== 64 ||
      salt.toString('base64url') !== match[1] ||
      key.toString('base64url') !== match[2]
    )
      invalidInput();

    return { passwordHash, runId };
  } catch {
    invalidInput();
  }
}

function expectedRejection({ checkpoint, sqlState }, statement) {
  return `DO $${checkpoint}$
BEGIN
  BEGIN
    ${statement}
    RAISE EXCEPTION 'Expected constraint rejection' USING ERRCODE = 'P0001';
  EXCEPTION
    WHEN SQLSTATE '${sqlState}' THEN NULL;
  END;
END
$${checkpoint}$;`;
}

function buildTrainingAccountAssertions(input) {
  const { passwordHash, runId } = snapshotInputs(input);
  const compactRunId = runId.replaceAll('-', '');
  const minimumUsername = `n${compactRunId.slice(0, 2)}`;
  const maximumUsername = `u_${compactRunId.slice(0, 12)}${'x'.repeat(18)}`;
  const ordinaryUsername = `nina_${compactRunId.slice(0, 12)}`;
  const updatedAt = "TIMESTAMP '2000-01-01 00:00:00'";
  const insert = (id, username, role) =>
    `INSERT INTO "User" ("id", "username", "passwordHash", "role", "updatedAt")\n` +
    `VALUES (${id}, '${username}', '${passwordHash}', '${role}', ${updatedAt});`;
  const idFor = (purpose) => `md5('${runId}:${purpose}')::uuid`;
  const rejectionSql = EXPECTED_REJECTIONS.map((expectation) => {
    const id = idFor(expectation.checkpoint);
    let statement;
    switch (expectation.checkpoint) {
      case 'role_default':
        statement =
          `INSERT INTO "User" ("id", "username", "passwordHash", "updatedAt")\n` +
          `VALUES (${id}, 'role_${compactRunId.slice(0, 12)}', '${passwordHash}', ${updatedAt});`;
        break;
      case 'username_null':
        statement =
          `INSERT INTO "User" ("id", "username", "passwordHash", "role", "updatedAt")\n` +
          `VALUES (${id}, NULL, '${passwordHash}', 'STUDENT', ${updatedAt});`;
        break;
      case 'username_noncanonical':
        statement = insert(id, 'Invalid', 'STUDENT');
        break;
      case 'username_too_short':
        statement = insert(id, 'ab', 'STUDENT');
        break;
      case 'auth_version_negative':
        statement =
          `INSERT INTO "User" ("id", "username", "passwordHash", "role", "authVersion", "updatedAt")\n` +
          `VALUES (${id}, 'negative_${compactRunId.slice(0, 12)}', '${passwordHash}', 'STUDENT', -1, ${updatedAt});`;
        break;
      case 'username_duplicate':
        statement = insert(id, minimumUsername, 'INSTRUCTOR');
        break;
      default:
        invalidInput();
    }
    return expectedRejection(expectation, statement);
  });

  const sql = `BEGIN;
DO $training_account_assertions$
DECLARE
  role_labels text[];
  username_collation text;
  role_default text;
BEGIN
  IF EXISTS (SELECT 1 FROM "User") THEN
    RAISE EXCEPTION 'Training account table must start empty' USING ERRCODE = 'P0001';
  END IF;

  SELECT array_agg(pg_enum_row.enumlabel::text ORDER BY pg_enum_row.enumsortorder)
    INTO role_labels
    FROM pg_type AS pg_type_row
    JOIN pg_enum AS pg_enum_row ON pg_enum_row.enumtypid = pg_type_row.oid
    JOIN pg_namespace AS ns ON ns.oid = pg_type_row.typnamespace
   WHERE ns.nspname = current_schema() AND pg_type_row.typname = 'UserRole';
  IF role_labels IS DISTINCT FROM ARRAY['ADMIN', 'INSTRUCTOR', 'STUDENT']::text[] THEN
    RAISE EXCEPTION 'Training-account roles do not match' USING ERRCODE = 'P0001';
  END IF;

  SELECT column_info.column_default INTO role_default
    FROM information_schema.columns AS column_info
   WHERE column_info.table_schema = current_schema()
     AND column_info.table_name = 'User' AND column_info.column_name = 'role';
  IF role_default IS NOT NULL THEN
    RAISE EXCEPTION 'Training-account role must not have a default' USING ERRCODE = 'P0001';
  END IF;

  SELECT pg_collation_row.collname INTO username_collation
    FROM pg_attribute AS pg_attribute_row
    JOIN pg_class AS pg_class_row ON pg_class_row.oid = pg_attribute_row.attrelid
    JOIN pg_namespace AS ns ON ns.oid = pg_class_row.relnamespace
    JOIN pg_collation AS pg_collation_row ON pg_collation_row.oid = pg_attribute_row.attcollation
   WHERE ns.nspname = current_schema()
     AND pg_class_row.relname = 'User' AND pg_attribute_row.attname = 'username'
     AND pg_attribute_row.attnum > 0 AND NOT pg_attribute_row.attisdropped;
  IF username_collation IS DISTINCT FROM 'C' THEN
    RAISE EXCEPTION 'Username collation must be C' USING ERRCODE = 'P0001';
  END IF;
END
$training_account_assertions$;

${insert(`'${runId}'::uuid`, minimumUsername, 'STUDENT')}
${insert(idFor('administrator'), maximumUsername, 'ADMIN')}
${insert(idFor('instructor'), ordinaryUsername, 'INSTRUCTOR')}

DO $training_account_valid_rows$
BEGIN
  IF (SELECT count(*) FROM "User") <> 3
     OR NOT EXISTS (SELECT 1 FROM "User" WHERE "username" = '${minimumUsername}')
     OR NOT EXISTS (SELECT 1 FROM "User" WHERE char_length("username") = 32)
     OR EXISTS (SELECT 1 FROM "User" WHERE NOT "isActive" OR "authVersion" <> 0 OR "createdAt" IS NULL)
     OR EXISTS (SELECT 1 FROM "User" WHERE "updatedAt" <> ${updatedAt}) THEN
    RAISE EXCEPTION 'Valid training-account defaults or username boundaries failed' USING ERRCODE = 'P0001';
  END IF;
END
$training_account_valid_rows$;

${rejectionSql.join('\n\n')}

DELETE FROM "User"
 WHERE "id" IN (
   '${runId}'::uuid,
   ${idFor('administrator')},
   ${idFor('instructor')}
 );
DO $training_account_final_empty$
BEGIN
  IF EXISTS (SELECT 1 FROM "User") THEN
    RAISE EXCEPTION 'Training account table must end empty' USING ERRCODE = 'P0001';
  END IF;
END
$training_account_final_empty$;
ROLLBACK;
DO $training_account_post_rollback_empty$
BEGIN
  IF EXISTS (SELECT 1 FROM "User") THEN
    RAISE EXCEPTION 'Training account table must remain empty after rollback' USING ERRCODE = 'P0001';
  END IF;
END
$training_account_post_rollback_empty$;
`;
  if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) invalidInput();

  return Object.freeze({
    sql,
    assertions: ASSERTIONS,
    expectedRejections: EXPECTED_REJECTIONS,
  });
}

module.exports = { buildTrainingAccountAssertions };
