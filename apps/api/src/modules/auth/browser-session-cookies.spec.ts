import { Buffer } from 'node:buffer';
import { describe, expect, it } from '@jest/globals';
import {
  BrowserSessionCookies,
  type BrowserSessionCookieConfig,
} from './browser-session-cookies';

const CONFIG = { accessMaxAgeSeconds: 300, refreshMaxAgeSeconds: 34560000 };
const ACCESS = 'synthetic.header.signature';
const REFRESH = Buffer.alloc(32, 7).toString('base64url');
const ATTRIBUTES = '; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=';
const credentials = () => ({ accessToken: ACCESS, refreshToken: REFRESH });
const policy = () => new BrowserSessionCookies(CONFIG);
const throwing = () => {
  throw new Error('Synthetic unavailable property');
};

function revokedProxy(): object {
  const proxy = Proxy.revocable({}, {});
  proxy.revoke();
  return proxy.proxy;
}

describe('BrowserSessionCookies internal serialization only', () => {
  it('returns two separate access-first fields with fixed host security attributes', () => {
    expect(policy().issue(credentials())).toEqual([
      `__Host-nina-access=${ACCESS}${ATTRIBUTES}300`,
      `__Host-nina-refresh=${REFRESH}${ATTRIBUTES}34560000`,
    ]);
  });

  it.each([1, 900])(
    'accepts access Max-Age boundary %s',
    (accessMaxAgeSeconds) => {
      const fields = new BrowserSessionCookies({
        ...CONFIG,
        accessMaxAgeSeconds,
      }).issue(credentials());
      expect(fields?.[0]).toContain(`Max-Age=${accessMaxAgeSeconds}`);
    },
  );

  it.each([1, 34560000])(
    'accepts refresh Max-Age boundary %s',
    (refreshMaxAgeSeconds) => {
      const fields = new BrowserSessionCookies({
        ...CONFIG,
        refreshMaxAgeSeconds,
      }).issue(credentials());
      expect(fields?.[1]).toContain(`Max-Age=${refreshMaxAgeSeconds}`);
    },
  );

  const invalidNumbers = [
    undefined,
    null,
    '1',
    true,
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    -Infinity,
    {},
    [],
  ];
  it.each(invalidNumbers.map((value) => [value]))(
    'rejects invalid access age %p',
    (accessMaxAgeSeconds) => {
      expect(
        () =>
          new BrowserSessionCookies({
            ...CONFIG,
            accessMaxAgeSeconds,
          } as BrowserSessionCookieConfig),
      ).toThrow('Invalid browser session cookie configuration');
    },
  );
  it.each(invalidNumbers.map((value) => [value]))(
    'rejects invalid refresh age %p',
    (refreshMaxAgeSeconds) => {
      expect(
        () =>
          new BrowserSessionCookies({
            ...CONFIG,
            refreshMaxAgeSeconds,
          } as BrowserSessionCookieConfig),
      ).toThrow('Invalid browser session cookie configuration');
    },
  );
  it.each(
    [
      undefined,
      null,
      [],
      {},
      1,
      'config',
      { ...CONFIG, accessMaxAgeSeconds: 901 },
      { ...CONFIG, refreshMaxAgeSeconds: 34560001 },
    ].map((value) => [value]),
  )(
    'fails generically for unavailable or malformed configuration %p',
    (config) => {
      expect(
        () => new BrowserSessionCookies(config as BrowserSessionCookieConfig),
      ).toThrow(new Error('Invalid browser session cookie configuration'));
    },
  );

  it('denies throwing property access without leaking the original exception', () => {
    for (const field of ['accessMaxAgeSeconds', 'refreshMaxAgeSeconds']) {
      const config = { ...CONFIG };
      Object.defineProperty(config, field, { get: throwing });
      expect(() => new BrowserSessionCookies(config)).toThrow(
        new Error('Invalid browser session cookie configuration'),
      );
    }
    for (const field of ['accessToken', 'refreshToken']) {
      const input = credentials();
      Object.defineProperty(input, field, { get: throwing });
      expect(policy().issue(input)).toBeNull();
    }
  });

  it('denies revoked proxies without exposing their errors', () => {
    expect(
      () =>
        new BrowserSessionCookies(revokedProxy() as BrowserSessionCookieConfig),
    ).toThrow(new Error('Invalid browser session cookie configuration'));
    expect(policy().issue(revokedProxy())).toBeNull();
  });

  it('snapshots configuration primitives and does not modify the caller', () => {
    const config = { ...CONFIG };
    const cookies = new BrowserSessionCookies(config);
    config.accessMaxAgeSeconds = 900;
    config.refreshMaxAgeSeconds = 1;
    expect(cookies.issue(credentials())).toEqual(policy().issue(credentials()));
    expect(config).toEqual({
      accessMaxAgeSeconds: 900,
      refreshMaxAgeSeconds: 1,
    });
    expect(
      new BrowserSessionCookies(Object.freeze({ ...CONFIG })).issue(
        credentials(),
      ),
    ).toEqual(policy().issue(credentials()));
  });

  it('reads constructor values once before retaining independent primitives', () => {
    let reads = 0;
    const cookies = new BrowserSessionCookies({
      get accessMaxAgeSeconds() {
        reads += 1;
        return 300;
      },
      refreshMaxAgeSeconds: 34560000,
    });
    cookies.issue(credentials());
    cookies.clear();
    expect(reads).toBe(1);
  });

  it.each(['a.b.c', '_-._-._-', 'A0.z9.-_'])(
    'accepts only JWT-shaped syntax, not authentication: %s',
    (accessToken) => {
      expect(policy().issue({ ...credentials(), accessToken })?.[0]).toBe(
        `__Host-nina-access=${accessToken}${ATTRIBUTES}300`,
      );
    },
  );

  const invalidTokens = [
    undefined,
    null,
    1,
    true,
    {},
    [],
    new String('a.b.c'),
    '',
    'a.b',
    'a.b.c.d',
    '.b.c',
    'a..c',
    'a.b.',
    'a=.b.c',
    'a.b.c\n',
    'a.b.c\r',
    'a.b.c\r\nSet-Cookie: injected=1',
    'a.b.c ',
    ' a.b.c',
    'a.b.\tc',
    'a.b.c\0',
    'a.b.é',
    'a.b.%63',
    'a.b.c;',
    'a.b.c,',
    'a.b.c"',
    'a.b.c\\',
  ];
  it.each(invalidTokens.map((value) => [value]))(
    'denies malformed access value without a partial pair: %p',
    (accessToken) => {
      expect(policy().issue({ ...credentials(), accessToken })).toBeNull();
    },
  );
  it.each(
    [
      undefined,
      null,
      1,
      true,
      {},
      [],
      new String(REFRESH),
      '',
      REFRESH.slice(1),
      `${REFRESH}A`,
      `${REFRESH}=`,
      `${REFRESH.slice(0, -1)}B`, // Valid alphabet/length, noncanonical trailing bits.
      `${REFRESH.slice(0, -1)}+`,
      `${REFRESH.slice(0, -1)}/`,
      `${REFRESH.slice(0, -1)}\n`,
      `${REFRESH.slice(0, -1)}\r`,
      `${REFRESH.slice(0, -1)} `,
      `${REFRESH.slice(0, -1)}é`,
      `${REFRESH.slice(0, -1)};`,
      `${REFRESH.slice(0, -1)}"`,
      `${REFRESH.slice(0, -1)}%`,
    ].map((value) => [value]),
  )(
    'denies malformed refresh value without a partial pair: %p',
    (refreshToken) => {
      expect(policy().issue({ ...credentials(), refreshToken })).toBeNull();
    },
  );

  it.each(
    [undefined, null, 1, true, 'credentials', [], {}].map((value) => [value]),
  )(
    'denies malformed or throwing credentials without leaking errors: %p',
    (input) => {
      expect(policy().issue(input)).toBeNull();
    },
  );

  it.each([4096, 4097])('enforces complete field byte boundary %s', (bytes) => {
    const overhead = Buffer.byteLength(`__Host-nina-access=${ATTRIBUTES}300`);
    const accessToken = `a.b.${'x'.repeat(bytes - overhead - 4)}`;
    const result = policy().issue({ ...credentials(), accessToken });
    if (bytes === 4096) {
      expect(result).not.toBeNull();
      expect(Buffer.byteLength(result![0], 'ascii')).toBe(4096);
    } else {
      expect(result).toBeNull();
    }
  });

  it('accounts for configured age digits in the complete field budget', () => {
    const overhead = Buffer.byteLength(`__Host-nina-access=${ATTRIBUTES}1`);
    const input = {
      ...credentials(),
      accessToken: `a.b.${'x'.repeat(4096 - overhead - 4)}`,
    };
    expect(
      new BrowserSessionCookies({ ...CONFIG, accessMaxAgeSeconds: 1 }).issue(
        input,
      ),
    ).not.toBeNull();
    expect(policy().issue(input)).toBeNull();
  });

  it('bounds huge inputs and preserves frozen credentials', () => {
    expect(
      policy().issue({ ...credentials(), accessToken: 'x'.repeat(100000) }),
    ).toBeNull();
    expect(
      policy().issue({ ...credentials(), refreshToken: 'x'.repeat(100000) }),
    ).toBeNull();
    const input = Object.freeze(credentials());
    const before = { ...input };
    expect(policy().issue(input)).not.toBeNull();
    expect(input).toEqual(before);
  });

  it('returns matching empty deletion fields without credential inputs', () => {
    expect(policy().clear()).toEqual([
      `__Host-nina-access=${ATTRIBUTES}0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
      `__Host-nina-refresh=${ATTRIBUTES}0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    ]);
  });

  it('does not retain returned arrays or couple deletion to prior issuance', () => {
    const cookies = policy();
    const first = cookies.clear();
    const expected = [...first];
    expect(cookies.clear()).not.toBe(first);
    (first as unknown as string[])[0] = 'caller-mutated';
    expect(cookies.clear()).toEqual(expected);
    const issued = cookies.issue(credentials())!;
    (issued as unknown as string[])[0] = 'caller-mutated';
    expect(cookies.issue(credentials())).toEqual(policy().issue(credentials()));
    expect(cookies.issue(null)).toBeNull();
    expect(cookies.clear()).toEqual(expected);
  });
});
