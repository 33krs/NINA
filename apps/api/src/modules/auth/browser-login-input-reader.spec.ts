import { Buffer } from 'node:buffer';
import { describe, expect, it, jest } from '@jest/globals';
import { BrowserLoginInputReader } from './browser-login-input-reader';

const read = (body: unknown) => new BrowserLoginInputReader().read(body);
// Deliberately not an eligible account username or password.
const input = () => ({ username: ' Synthetic Input! ', password: 'test-only' });

describe('BrowserLoginInputReader internal transport extraction', () => {
  it('preserves both strings exactly in a fresh frozen snapshot', () => {
    const body = input();
    const descriptors = Object.getOwnPropertyDescriptors(body);
    const result = read(body);
    expect(result).toEqual(body);
    expect(result).not.toBe(body);
    expect(result).not.toBe(read(body));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.ownKeys(result!)).toEqual(['username', 'password']);
    expect(Object.getOwnPropertyDescriptors(body)).toEqual(descriptors);
    expect(Object.isFrozen(body)).toBe(false);
    body.password = 'changed-test-input';
    expect(result?.password).toBe('test-only');
    expect(Reflect.set(result!, 'password', 'replacement')).toBe(false);
  });

  it('accepts a null-prototype record with reversed key order', () => {
    const body: unknown = Object.assign(Object.create(null), {
      password: 'test-only',
      username: ' Synthetic Input! ',
    });
    expect(read(body)).toEqual(input());
  });

  it('accepts frozen data fields without modifying the input', () => {
    expect(read(Object.freeze(input()))).toEqual(input());
  });

  it.each([
    ['', ''],
    ['x', 'short'],
    ['  Mixed.Case  ', ' \t e\u0301 é 😀 \n'],
    ['\ud800', '\udfff'],
    ['😀'.repeat(64), 'test-only'],
  ])(
    'does not impose authentication eligibility for fixture %#',
    (username, password) => {
      expect(read({ username, password })).toEqual({ username, password });
    },
  );

  it.each([0, 127, 128])('accepts username length %i code units', (length) => {
    const body = { ...input(), username: 'x'.repeat(length) };
    expect(read(body)).toEqual(body);
  });

  it.each(['x'.repeat(129), '😀'.repeat(65)])(
    'denies oversized username fixture %#',
    (username) => {
      expect(read({ ...input(), username })).toBeNull();
    },
  );

  it.each([
    ['x'.repeat(1023), 1023],
    ['x'.repeat(1024), 1024],
    ['é'.repeat(512), 1024],
    ['😀'.repeat(256), 1024],
    ['€'.repeat(341) + 'x', 1024],
  ])('accepts bounded password fixture %#', (password, bytes) => {
    expect(Buffer.byteLength(password, 'utf8')).toBe(bytes);
    const body = { ...input(), password };
    expect(read(body)).toEqual(body);
  });

  it.each([
    'x'.repeat(1025),
    'é'.repeat(512) + 'x',
    '😀'.repeat(256) + 'x',
    '€'.repeat(342),
  ])('denies oversized password fixture %#', (password) => {
    expect(read({ ...input(), password })).toBeNull();
  });

  it('rejects the cheap password bound before byte counting', () => {
    const byteLength = jest.spyOn(Buffer, 'byteLength');
    try {
      const result = read({ ...input(), password: 'x'.repeat(1025) });
      const calls = byteLength.mock.calls.length;
      expect(result).toBeNull();
      expect(calls).toBe(0);
    } finally {
      byteLength.mockRestore();
    }
  });

  it.each([
    null,
    undefined,
    true,
    7,
    'body',
    Symbol('body'),
    [],
    [input()],
    new Date(0),
    new Map(),
    () => input(),
    {},
    { username: 'test-only' },
    { password: 'test-only' },
    { Username: 'test-only', password: 'test-only' },
    { ...input(), extra: true },
    { ...input(), [Symbol('extra')]: true },
  ])('denies unsupported body fixture %#', (body) => {
    expect(read(body)).toBeNull();
  });

  it.each(['username', 'password'])(
    'denies nonstring %s without coercion',
    (field) => {
      const toString = jest.fn(() => 'test-only');
      for (const value of [null, undefined, false, 1, [], {}, { toString }]) {
        expect(read({ ...input(), [field]: value })).toBeNull();
      }
      expect(toString).not.toHaveBeenCalled();
    },
  );

  it('rejects custom prototypes, inherited fields and class instances', () => {
    class SyntheticBody {
      username = 'test-only';
      password = 'test-only';
    }
    const inherited = Object.assign(Object.create({ username: 'test-only' }), {
      password: 'test-only',
    });
    const custom = Object.assign(Object.create({ extra: true }), input());
    expect(read(inherited)).toBeNull();
    expect(read(custom)).toBeNull();
    expect(read(new SyntheticBody())).toBeNull();
  });

  it.each(['username', 'password'])(
    'denies accessor %s without invoking it',
    (field) => {
      const get = jest.fn(() => {
        throw new Error('Synthetic getter');
      });
      const set = jest.fn();
      const body = Object.defineProperty(input(), field, {
        enumerable: true,
        get,
        set,
      });
      expect(read(body)).toBeNull();
      expect(get).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
    },
  );

  it.each(['username', 'password'])('denies nonenumerable %s', (field) => {
    const body = Object.defineProperty(input(), field, { enumerable: false });
    expect(read(body)).toBeNull();
  });

  it('denies even nonenumerable extra fields without invoking them', () => {
    const get = jest.fn(() => {
      throw new Error('Synthetic extra getter');
    });
    const body = Object.defineProperty(input(), 'extra', { get });
    expect(read(body)).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'])(
    'fails closed on throwing %s traps',
    (trap) => {
      const body = new Proxy(input(), {
        [trap]: () => {
          throw new Error('Synthetic trap failure');
        },
      });
      expect(read(body)).toBeNull();
    },
  );

  it('does not read credential properties through proxy get traps', () => {
    const get = jest.fn(() => {
      throw new Error('Unexpected value read');
    });
    const body = new Proxy(input(), { get });
    expect(read(body)).toEqual(input());
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects disappearing descriptors without partial success', () => {
    const body = new Proxy(input(), {
      getOwnPropertyDescriptor: (target, key) =>
        key === 'password'
          ? undefined
          : Reflect.getOwnPropertyDescriptor(target, key),
    });
    expect(read(body)).toBeNull();
  });

  it('fails closed on a revoked proxy', () => {
    const { proxy, revoke } = Proxy.revocable(input(), {});
    revoke();
    expect(read(proxy)).toBeNull();
  });
});
