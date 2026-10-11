const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: pause } = require('node:timers/promises');

// Only the guarded child supplies already-owned clients/services; this module loads none.
async function verifyLease({ client, first, second, key }) {
  await client.connect();
  const commands = client.withCommandOptions({ timeout: 1500 });
  assert.match(
    await commands.info('server'),
    /^redis_version:7\.\d+\.\d+\r?$/m,
    'Redis 7 required',
  );
  const owner = crypto.randomUUID();
  const successor = crypto.randomUUID();
  assert.equal(await commands.get(key), null, 'Fresh fixture key required');
  const acquiredAt = performance.now();
  assert.equal(await first.acquire(key, owner), true);
  assert.equal(await second.acquire(key, successor), false);
  assert.equal(await commands.get(key), owner);
  const ttl = await commands.pTTL(key);
  assert.ok(
    ttl > 0 &&
      ttl <= 10000 &&
      ttl >= 10000 - (performance.now() - acquiredAt) - 100,
    'Production ten-second lease required',
  );
  await second.release(key, successor);
  assert.equal(await commands.get(key), owner, 'Wrong owner must not release');
  await first.release(key, owner);
  assert.equal(await commands.get(key), null, 'Owner release must delete');
  const naturalStartedAt = performance.now();
  assert.equal(await first.acquire(key, owner), true);
  const expiresBy = naturalStartedAt + 15000;
  while (true) {
    assert.ok(
      performance.now() < expiresBy,
      'Natural expiry deadline exceeded',
    );
    const remaining = await commands.pTTL(key);
    const value = await commands.get(key);
    if (remaining === -2 && value === null) {
      assert.ok(
        performance.now() - naturalStartedAt >= 9900,
        'Natural expiry before production lease',
      );
      break;
    }
    // Expiry can occur between PTTL and GET; never require a fixed sleep.
    assert.ok(remaining >= 0 && remaining <= 10000, 'Expiring lease required');
    assert.ok(value === owner || value === null, 'Unexpected lease owner');
    await pause(25);
  }
  assert.equal(await second.acquire(key, successor), true);
  await first.release(key, owner);
  assert.equal(
    await commands.get(key),
    successor,
    'Stale owner must preserve successor',
  );
  await second.release(key, successor);
  assert.equal(await commands.get(key), null, 'Successor release must delete');
}

module.exports = { verifyLease };
