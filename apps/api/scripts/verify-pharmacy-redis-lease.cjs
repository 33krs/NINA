const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: pause } = require('node:timers/promises');

// Only the guarded child supplies already-owned clients/services; this module loads none.
function safeTtl(value) {
  if (!Number.isInteger(value)) return 'ttl_invalid';
  if (value === -2) return 'ttl_expired';
  if (value < 0) return 'ttl_invalid';
  if (value < 9900) return 'ttl_below_min';
  if (value <= 10000) return 'ttl_in_range';
  return 'ttl_over_max';
}

function safeOwner(value, owner) {
  if (value === owner) return 'owner_match';
  if (value === null) return 'owner_missing';
  return 'owner_other';
}

async function verifyLease({
  client,
  first,
  second,
  key,
  onDiagnostic = () => {},
}) {
  let checkpoint = 'client_connect';
  let assertionReported = false;
  const reportAssertion = (category, actual, expected) => {
    assertionReported = true;
    onDiagnostic({
      phase: 'lease',
      checkpoint,
      category,
      actual,
      expected,
    });
  };
  const check = (category, actual, expected, assertion) => {
    try {
      assertion();
    } catch (error) {
      reportAssertion(category, actual, expected);
      throw error;
    }
  };

  try {
    await client.connect();
    checkpoint = 'command_options';
    const commands = client.withCommandOptions({ timeout: 1500 });
    checkpoint = 'redis_version';
    const info = await commands.info('server');
    check(
      'assertion_failed',
      /^redis_version:7\.\d+\.\d+\r?$/m.test(info) ? 'redis7' : 'other_version',
      'redis7',
      () =>
        assert.match(
          info,
          /^redis_version:7\.\d+\.\d+\r?$/m,
          'Redis 7 required',
        ),
    );
    checkpoint = 'owner_tokens';
    const owner = crypto.randomUUID();
    const successor = crypto.randomUUID();
    checkpoint = 'fresh_key';
    const initialValue = await commands.get(key);
    check(
      'assertion_failed',
      initialValue === null ? 'missing' : 'occupied',
      'missing',
      () => assert.equal(initialValue, null, 'Fresh fixture key required'),
    );
    const acquiredAt = performance.now();
    checkpoint = 'first_acquire';
    const firstAcquired = await first.acquire(key, owner);
    check(
      'assertion_failed',
      firstAcquired === true ? 'true' : 'false',
      'true',
      () => assert.equal(firstAcquired, true),
    );
    checkpoint = 'competing_acquire';
    const secondAcquired = await second.acquire(key, successor);
    check(
      'assertion_failed',
      secondAcquired === true ? 'true' : 'false',
      'false',
      () => assert.equal(secondAcquired, false),
    );
    checkpoint = 'initial_owner';
    const initialOwner = await commands.get(key);
    check(
      'assertion_failed',
      safeOwner(initialOwner, owner),
      'owner_match',
      () => assert.equal(initialOwner, owner),
    );
    checkpoint = 'first_lease_ttl';
    const ttl = await commands.pTTL(key);
    check('assertion_failed', safeTtl(ttl), 'ttl_in_range', () =>
      assert.ok(
        ttl > 0 &&
          ttl <= 10000 &&
          ttl >= 10000 - (performance.now() - acquiredAt) - 100,
        'Production ten-second lease required',
      ),
    );
    checkpoint = 'wrong_owner_release';
    await second.release(key, successor);
    checkpoint = 'owner_after_wrong_release';
    const ownerAfterWrongRelease = await commands.get(key);
    check(
      'assertion_failed',
      safeOwner(ownerAfterWrongRelease, owner),
      'owner_match',
      () =>
        assert.equal(
          ownerAfterWrongRelease,
          owner,
          'Wrong owner must not release',
        ),
    );
    checkpoint = 'owner_release';
    await first.release(key, owner);
    checkpoint = 'key_after_owner_release';
    const valueAfterOwnerRelease = await commands.get(key);
    check(
      'assertion_failed',
      valueAfterOwnerRelease === null ? 'missing' : 'occupied',
      'missing',
      () =>
        assert.equal(valueAfterOwnerRelease, null, 'Owner release must delete'),
    );
    checkpoint = 'natural_acquire';
    const naturalStartedAt = performance.now();
    const naturalAcquired = await first.acquire(key, owner);
    check(
      'assertion_failed',
      naturalAcquired === true ? 'true' : 'false',
      'true',
      () => assert.equal(naturalAcquired, true),
    );
    const expiresBy = naturalStartedAt + 15000;
    while (true) {
      checkpoint = 'natural_deadline';
      const beforeDeadline = performance.now() < expiresBy;
      check(
        'assertion_failed',
        beforeDeadline ? 'before_deadline' : 'deadline_reached',
        'before_deadline',
        () => assert.ok(beforeDeadline, 'Natural expiry deadline exceeded'),
      );
      checkpoint = 'natural_ttl';
      const remaining = await commands.pTTL(key);
      checkpoint = 'natural_owner';
      const value = await commands.get(key);
      if (remaining === -2 && value === null) {
        checkpoint = 'natural_expiry_duration';
        const productionLeaseElapsed =
          performance.now() - naturalStartedAt >= 9900;
        check(
          'assertion_failed',
          productionLeaseElapsed ? 'duration_sufficient' : 'duration_short',
          'duration_sufficient',
          () =>
            assert.ok(
              productionLeaseElapsed,
              'Natural expiry before production lease',
            ),
        );
        break;
      }
      // Expiry can occur between PTTL and GET; never require a fixed sleep.
      check('assertion_failed', safeTtl(remaining), 'ttl_in_range', () =>
        assert.ok(
          remaining >= 0 && remaining <= 10000,
          'Expiring lease required',
        ),
      );
      check(
        'assertion_failed',
        value === owner
          ? 'owner_match'
          : value === null
            ? 'owner_missing'
            : 'owner_other',
        'owner_match_or_missing',
        () =>
          assert.ok(
            value === owner || value === null,
            'Unexpected lease owner',
          ),
      );
      await pause(25);
    }
    checkpoint = 'successor_acquire';
    const successorAcquired = await second.acquire(key, successor);
    check(
      'assertion_failed',
      successorAcquired === true ? 'true' : 'false',
      'true',
      () => assert.equal(successorAcquired, true),
    );
    checkpoint = 'stale_owner_release';
    await first.release(key, owner);
    checkpoint = 'successor_after_stale_release';
    const successorValue = await commands.get(key);
    check(
      'assertion_failed',
      safeOwner(successorValue, successor),
      'owner_match',
      () =>
        assert.equal(
          successorValue,
          successor,
          'Stale owner must preserve successor',
        ),
    );
    checkpoint = 'successor_release';
    await second.release(key, successor);
    checkpoint = 'key_after_successor_release';
    const valueAfterSuccessorRelease = await commands.get(key);
    check(
      'assertion_failed',
      valueAfterSuccessorRelease === null ? 'missing' : 'occupied',
      'missing',
      () =>
        assert.equal(
          valueAfterSuccessorRelease,
          null,
          'Successor release must delete',
        ),
    );
  } catch (error) {
    if (!assertionReported)
      onDiagnostic({
        phase: 'lease',
        checkpoint,
        category: 'operation_failed',
        actual: 'unavailable',
        expected: 'success',
      });
    throw error;
  }
}

module.exports = { verifyLease };
