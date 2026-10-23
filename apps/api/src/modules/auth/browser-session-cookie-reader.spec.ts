import { Buffer } from 'node:buffer';
import { describe, expect, it } from '@jest/globals';
import { BrowserSessionCookieReader } from './browser-session-cookie-reader';

const ACCESS_NAME = '__Host-nina-access';
const REFRESH_NAME = '__Host-nina-refresh';
const ACCESS = 'synthetic.header.signature';
const REFRESH = Buffer.alloc(32, 7).toString('base64url');
const accessPair = `${ACCESS_NAME}=${ACCESS}`;
const refreshPair = `${REFRESH_NAME}=${REFRESH}`;
const read = (value: unknown) => new BrowserSessionCookieReader().read(value);
const request = (value: string) => ({ rawHeaders: ['Cookie', value] });
const empty = { accessToken: null, refreshToken: null };
const throwing = () => {
  throw new Error('Synthetic unavailable property');
};

describe('BrowserSessionCookieReader internal extraction only', () => {
  it.each([
    [accessPair, { ...empty, accessToken: ACCESS }],
    [refreshPair, { ...empty, refreshToken: REFRESH }],
    [
      `${accessPair}; ${refreshPair}`,
      { accessToken: ACCESS, refreshToken: REFRESH },
    ],
    [
      `${refreshPair};${accessPair}`,
      { accessToken: ACCESS, refreshToken: REFRESH },
    ],
    [
      `other=;   ${refreshPair}; flag=x=y%21`,
      { ...empty, refreshToken: REFRESH },
    ],
    ['other=; other=two', empty],
    [`__host-nina-access=${ACCESS}; ${ACCESS_NAME}-other=${ACCESS}`, empty],
    [`__HOST-nina-refresh=${REFRESH}`, empty],
    ["other=!#$%&'()*+-./:<=>?@[]^_`{|}~", empty],
  ])('extracts only exact credential names from %s', (value, expected) => {
    expect(read(request(value))).toEqual(expected);
  });

  it.each(['Cookie', 'cookie', 'cOoKiE'])(
    'accepts header-name casing %s',
    (name) => {
      expect(
        read({ rawHeaders: ['Host', 'synthetic.invalid', name, refreshPair] }),
      ).toEqual({ ...empty, refreshToken: REFRESH });
    },
  );

  it('distinguishes absent cookies from malformed input without fallback', () => {
    expect(read({ rawHeaders: [] })).toEqual(empty);
    expect(
      read({
        rawHeaders: ['Authorization', ACCESS],
        headers: { cookie: accessPair },
        body: { refreshToken: REFRESH },
        query: { refreshToken: REFRESH },
      }),
    ).toEqual(empty);
    expect(read({ headers: { cookie: accessPair } })).toBeNull();
  });

  it.each([
    null,
    undefined,
    false,
    1,
    'request',
    [],
    {},
    { rawHeaders: null },
    { rawHeaders: {} },
    { rawHeaders: ['Cookie'] },
    { rawHeaders: [['Cookie', accessPair]] },
    { rawHeaders: [1, accessPair] },
    { rawHeaders: ['Cookie', null] },
    { rawHeaders: ['Cookie', []] },
    { rawHeaders: ['Cookie', accessPair, 'Other', 1] },
    { rawHeaders: ['Cookie ', accessPair] },
    { rawHeaders: ['', accessPair] },
    { rawHeaders: ['bad:name', accessPair] },
    { rawHeaders: ['Host\n', 'ignored'] },
  ])('denies malformed request/header shapes: %p', (value) => {
    expect(read(value)).toBeNull();
  });

  it.each([
    '',
    ' ',
    'a',
    '=value',
    ';a=b',
    'a=b;',
    'a=b;;c=d',
    'a=b;   ',
    'a=b ',
    'a =b',
    'a= b',
    'a=b; c =d',
    'a=b;\tc=d',
    'a="b"',
    'a=b\\c',
    'a=b,c=d',
    'a=b\r\nc=d',
    'a=b\u0000',
    'a=b\u007f',
    'a=é',
    'a=\t',
    'é=b',
  ])('denies malformed Cookie syntax: %p', (value) => {
    expect(read(request(value))).toBeNull();
    expect(read(request(`${refreshPair}; ${value}`))).toBeNull();
  });

  it('rejects leading header spaces without rejecting permitted separator spaces', () => {
    expect(read(request(` ${refreshPair}`))).toBeNull();
    expect(read(request(`other=value;   ${refreshPair}`))).toEqual({
      ...empty,
      refreshToken: REFRESH,
    });
  });

  it.each(['Cookie', 'COOKIE', 'cOoKiE'])(
    'denies duplicate Cookie field %s',
    (name) => {
      for (const second of [accessPair, refreshPair, 'unrelated=value']) {
        expect(
          read({ rawHeaders: ['Cookie', accessPair, name, second] }),
        ).toBeNull();
      }
    },
  );

  it.each([
    [accessPair, accessPair],
    [accessPair, `${ACCESS_NAME}=other.value.signature`],
    [refreshPair, refreshPair],
    [
      refreshPair,
      `${REFRESH_NAME}=${Buffer.alloc(32, 8).toString('base64url')}`,
    ],
  ])('denies repeated NINA names regardless of order: %s', (first, second) => {
    expect(read(request(`${first}; ${second}`))).toBeNull();
    expect(read(request(`${second}; ${first}`))).toBeNull();
  });

  it.each([
    '',
    'one',
    'one.two',
    '.two.three',
    'one..three',
    'one.two.',
    'one.two.three.four',
    'one.two.three=',
    'one.two.%73ignature',
    'one.two.+signature',
    'one.two./signature',
    'one.two.sig nature',
  ])(
    'rejects malformed access without returning valid refresh: %p',
    (value) => {
      expect(
        read(request(`${ACCESS_NAME}=${value}; ${refreshPair}`)),
      ).toBeNull();
    },
  );

  it.each([
    '',
    'a'.repeat(42),
    'a'.repeat(44),
    `${REFRESH}=`,
    `${REFRESH.slice(0, -1)}+`,
    `${REFRESH.slice(0, -1)}_`,
    `${REFRESH.slice(0, -1)}F`,
    `%${REFRESH.slice(1)}`,
  ])(
    'rejects malformed refresh without returning valid access: %p',
    (value) => {
      expect(
        read(request(`${accessPair}; ${REFRESH_NAME}=${value}`)),
      ).toBeNull();
    },
  );

  it.each([0, 1, 2, 3, 255])(
    'accepts canonical refresh trailing bits for byte %i',
    (byte) => {
      const token = Buffer.alloc(32, byte).toString('base64url');
      expect(read(request(`${REFRESH_NAME}=${token}`))).toEqual({
        ...empty,
        refreshToken: token,
      });
    },
  );

  it('accepts exactly 8192 ASCII Cookie bytes and denies 8193 without truncation', () => {
    const prefix = `${refreshPair}; other=`;
    const value = prefix + 'x'.repeat(8192 - prefix.length);
    expect(Buffer.byteLength(value, 'ascii')).toBe(8192);
    expect(read(request(value))).toEqual({ ...empty, refreshToken: REFRESH });
    expect(read(request(`${value}x`))).toBeNull();
  });

  it('accepts exactly 4096 access characters and denies 4097 independently of header size', () => {
    const token = `a.b.${'c'.repeat(4092)}`;
    expect(token.length).toBe(4096);
    expect(read(request(`${ACCESS_NAME}=${token}`))).toEqual({
      ...empty,
      accessToken: token,
    });
    expect(
      read(request(`${ACCESS_NAME}=${token}c; ${refreshPair}`)),
    ).toBeNull();
  });

  it('fails closed when property access or proxy operations throw', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const headers = ['Cookie', accessPair];
    Object.defineProperty(headers, 1, { get: throwing });
    for (const input of [
      revoked.proxy,
      {
        get rawHeaders() {
          return throwing();
        },
      },
      { rawHeaders: headers },
      new Proxy({}, { has: throwing }),
    ]) {
      expect(() => read(input)).not.toThrow();
      expect(read(input)).toBeNull();
    }
  });

  it('does not mutate inputs or retain caller-owned/returned snapshots', () => {
    const reader = new BrowserSessionCookieReader();
    const headers = Object.freeze(['Cookie', `${accessPair}; ${refreshPair}`]);
    const input = Object.freeze({ rawHeaders: headers });
    const first = reader.read(input);
    const second = reader.read(input);
    expect(first).toEqual({ accessToken: ACCESS, refreshToken: REFRESH });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(input.rawHeaders).toBe(headers);
    expect(headers).toEqual(['Cookie', `${accessPair}; ${refreshPair}`]);
    expect(reader.read({ rawHeaders: [] })).toEqual(empty);
  });
});
