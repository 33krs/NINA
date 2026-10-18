import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import * as crypto from 'node:crypto';
import { setImmediate as scheduleImmediate } from 'node:timers';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { hashPassword, verifyPassword } from './password-hash';

jest.mock('node:crypto', () => {
  const nodeCrypto =
    jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...nodeCrypto, scrypt: jest.fn(nodeCrypto.scrypt) };
});

const scrypt = jest.mocked(crypto.scrypt);
const actualScrypt =
  jest.requireActual<typeof import('node:crypto')>('node:crypto').scrypt;
const createSyntheticInput = (size = 24): string =>
  randomBytes(size).toString('base64url');

describe('password hash foundation', () => {
  afterEach(() => {
    scrypt.mockReset();
    scrypt.mockImplementation(actualScrypt);
  });

  it('hashes and verifies an unchanged password with the fixed versioned format', async () => {
    const password = createSyntheticInput();
    const hash = await hashPassword(password);

    expect(hash).toMatch(
      /^\$nina\$scrypt\$v=1\$N=131072,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/,
    );
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword(createSyntheticInput(), hash)).resolves.toBe(
      false,
    );
  });

  it('uses a fresh salt for each hash of the same input', async () => {
    const password = createSyntheticInput();
    const first = await hashPassword(password);
    const second = await hashPassword(password);

    expect(first).not.toBe(second);
    await expect(verifyPassword(password, first)).resolves.toBe(true);
    await expect(verifyPassword(password, second)).resolves.toBe(true);
  });

  it('preserves whitespace and Unicode without trimming or normalization', async () => {
    const password = ` ${createSyntheticInput()} e\u0301 \u{1f642}`;
    const hash = await hashPassword(password);

    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword(password.trim(), hash)).resolves.toBe(false);
    await expect(
      verifyPassword(password.replace('e\u0301', '\u00e9'), hash),
    ).resolves.toBe(false);
  });

  it.each([
    ['high surrogate', `${createSyntheticInput()}\ud800`],
    ['low surrogate', `${createSyntheticInput()}\udc00`],
    [
      'mixed lone surrogate',
      `${createSyntheticInput()}\ud800${createSyntheticInput()}`,
    ],
  ])(
    'rejects ill-formed Unicode with a %s before KDF work',
    async (_kind, input) => {
      const validHash = await hashPassword(createSyntheticInput());
      const scrypt = jest.mocked(crypto.scrypt);
      scrypt.mockClear();

      await expect(hashPassword(input)).rejects.toThrow(
        'Invalid password input',
      );
      await expect(verifyPassword(input, validHash)).resolves.toBe(false);
      expect(scrypt).not.toHaveBeenCalled();
    },
  );

  it('rejects password lengths outside the documented policy without KDF work', async () => {
    scrypt.mockClear();
    const tooShort = createSyntheticInput(10);
    const tooLong = createSyntheticInput(100);

    await expect(hashPassword(tooShort)).rejects.toThrow(
      'Invalid password input',
    );
    await expect(hashPassword(tooLong)).rejects.toThrow(
      'Invalid password input',
    );
    await expect(
      verifyPassword(tooShort, createSyntheticInput()),
    ).resolves.toBe(false);
    expect(scrypt).not.toHaveBeenCalled();
  });

  it('rejects malformed and hostile stored hashes before KDF work', async () => {
    const password = createSyntheticInput();
    const validHash = await hashPassword(password);
    scrypt.mockClear();
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const makeNoncanonical = (encoded: string): string => {
      const finalValue = alphabet.indexOf(encoded.at(-1) ?? '');
      return `${encoded.slice(0, -1)}${alphabet[finalValue | 1]}`;
    };
    const fields = validHash.split('$');
    const noncanonicalSalt = [...fields];
    noncanonicalSalt[5] = makeNoncanonical(fields[5]);
    const noncanonicalKey = [...fields];
    noncanonicalKey[6] = makeNoncanonical(fields[6]);
    const malformed = [
      '',
      '$nina$scrypt$v=9$N=131072,r=8,p=1$' +
        'a'.repeat(22) +
        '$' +
        'b'.repeat(86),
      validHash.replace('N=131072,r=8,p=1', 'N=1,r=1,p=1'),
      noncanonicalSalt.join('$'),
      noncanonicalKey.join('$'),
      validHash + 'x'.repeat(300),
    ];

    for (const hash of malformed)
      await expect(verifyPassword(password, hash)).resolves.toBe(false);
    await expect(verifyPassword(password, null)).resolves.toBe(false);
    expect(scrypt).not.toHaveBeenCalled();
  });

  it('bounds active and queued KDF operations and releases permits after callback failures', async () => {
    const callbacks: Array<(error: Error | null, key: Buffer) => void> = [];
    scrypt.mockClear();
    const controlledScrypt = (...args: unknown[]): void => {
      const callback = args[4] as (error: Error, key: Buffer) => void;
      callbacks.push((error, key) =>
        callback(error as Error, Buffer.from(key)),
      );
    };
    scrypt.mockImplementation(
      controlledScrypt as unknown as typeof crypto.scrypt,
    );
    const input = createSyntheticInput();
    const requests = Array.from({ length: 19 }, () => hashPassword(input));

    await expect(requests[18]).rejects.toThrow(
      'Password hashing capacity exceeded',
    );
    expect(scrypt).toHaveBeenCalledTimes(2);

    callbacks.shift()?.(
      new Error('synthetic callback failure'),
      Buffer.alloc(64),
    );
    callbacks.shift()?.(null, Buffer.alloc(64, 0x5a));
    await expect(requests[0]).rejects.toThrow('Password hashing failed');
    await expect(requests[1]).resolves.toMatch(/^\$nina\$scrypt\$/);
    await new Promise<void>((resolve) => scheduleImmediate(resolve));
    expect(scrypt).toHaveBeenCalledTimes(4);

    let completed = 2;
    while (completed < 18) {
      const activeCallbacks = callbacks.splice(0);
      expect(activeCallbacks).toHaveLength(2);
      for (const callback of activeCallbacks)
        callback(null, Buffer.alloc(64, 0x5a));
      completed += activeCallbacks.length;
      await new Promise<void>((resolve) => scheduleImmediate(resolve));
    }
    await expect(Promise.all(requests.slice(2, 18))).resolves.toHaveLength(16);
    expect(scrypt).toHaveBeenCalledTimes(18);
  });
});
