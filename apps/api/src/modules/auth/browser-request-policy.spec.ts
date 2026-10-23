import { describe, expect, it } from '@jest/globals';
import { BrowserRequestPolicy } from './browser-request-policy';

const ORIGIN = 'https://nina.example.test';
const fields = ['Origin', 'Content-Type', 'X-NINA-CSRF-Protection'] as const;
const policy = new BrowserRequestPolicy(ORIGIN);

function request(overrides: Record<string, unknown> = {}) {
  return {
    method: 'POST',
    rawHeaders: [
      'Origin',
      ORIGIN,
      'Content-Type',
      'application/json',
      'X-NINA-CSRF-Protection',
      '1',
    ],
    ...overrides,
  };
}

function withHeader(name: string, value: unknown) {
  const rawHeaders: unknown[] = request().rawHeaders;
  const index = rawHeaders.indexOf(name);
  if (index === -1) rawHeaders.push(name, value);
  else rawHeaders[index + 1] = value;
  return request({ rawHeaders });
}

describe('BrowserRequestPolicy (unregistered)', () => {
  it.each([
    'application/json',
    'APPLICATION/JSON',
    'application/json;charset=utf-8',
    'Application/Json ; CHARSET = UTF-8',
    'application/json\t;\tcharset\t=\tutf-8',
  ])('admits a valid POST with %j', (contentType) => {
    expect(
      policy.allowsAuthenticationPost(withHeader('Content-Type', contentType)),
    ).toBe(true);
  });

  it.each([
    ORIGIN,
    'https://192.0.2.1',
    'https://[2001:db8::1]',
    'https://nina.example.test:8443',
  ])('requires and admits its exact canonical HTTPS origin %j', (origin) => {
    expect(
      new BrowserRequestPolicy(origin).allowsAuthenticationPost(
        withHeader('Origin', origin),
      ),
    ).toBe(true);
  });

  it('admits mixed-case names, optional same-origin metadata and ordinary duplicate headers', () => {
    const rawHeaders = request().rawHeaders.map((value, index) =>
      index % 2 === 0 ? value.toLowerCase() : value,
    );
    rawHeaders.push(
      'sEc-FeTcH-sItE',
      'same-origin',
      'Accept',
      '*/*',
      'accept',
      'application/json',
    );
    expect(policy.allowsAuthenticationPost(request({ rawHeaders }))).toBe(true);
  });

  it.each([
    undefined,
    null,
    1,
    {},
    [],
    new String(ORIGIN),
    '',
    '*',
    'https://*.example.test',
    'http://nina.example.test',
    'https://nina.example.test/',
    'https://nina.example.test/path',
    'https://nina.example.test?x',
    'https://nina.example.test#x',
    'https://user:password@nina.example.test',
    'https://NINA.example.test',
    'https://nina.example.test:443',
    ` ${ORIGIN}`,
    `${ORIGIN}\n`,
    `${ORIGIN},https://other.example.test`,
    'https://192.0.2.001',
    'https://[2001:0db8::1]',
  ])(
    'rejects noncanonical or invalid configuration %j generically',
    (origin) => {
      expect(() => new BrowserRequestPolicy(origin)).toThrow(
        'Invalid browser request policy configuration',
      );
    },
  );

  it.each([undefined, null, false, 1, 'POST', [], {}, { method: 'POST' }])(
    'denies malformed request %j',
    (input) => {
      expect(policy.allowsAuthenticationPost(input)).toBe(false);
    },
  );

  it.each(['GET', 'HEAD', 'OPTIONS', 'PUT', 'post', ' POST', 'POST ', null, 1])(
    'denies method %j',
    (method) => {
      expect(policy.allowsAuthenticationPost(request({ method }))).toBe(false);
    },
  );

  it.each([
    undefined,
    null,
    {},
    'Origin',
    [],
    ['Origin'],
    ['Origin', ORIGIN, 'Content-Type'],
    ['Origin', ORIGIN, 1, 'value'],
    ['Origin', [ORIGIN]],
    ['Origin', null],
    ['Origin', ORIGIN, '', 'value'],
    ['Origin', ORIGIN, 'Bad Name', 'value'],
  ])('denies malformed rawHeaders %j', (rawHeaders) => {
    expect(policy.allowsAuthenticationPost(request({ rawHeaders }))).toBe(
      false,
    );
  });

  it('does not substitute a normalized map, Referer, Host or forwarded headers', () => {
    const input = request({
      rawHeaders: undefined,
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-nina-csrf-protection': '1',
      },
    });
    expect(policy.allowsAuthenticationPost(input)).toBe(false);
    const rawHeaders = request().rawHeaders.slice(2);
    rawHeaders.push(
      'Referer',
      `${ORIGIN}/login`,
      'Host',
      'nina.example.test',
      'X-Forwarded-Host',
      'nina.example.test',
      'X-Forwarded-Proto',
      'https',
      'Sec-Fetch-Site',
      'same-origin',
    );
    expect(policy.allowsAuthenticationPost(request({ rawHeaders }))).toBe(
      false,
    );
  });

  it.each(fields)(
    'denies a missing %s even with same-origin metadata',
    (name) => {
      const rawHeaders = request().rawHeaders;
      rawHeaders.splice(rawHeaders.indexOf(name), 2);
      rawHeaders.push('Sec-Fetch-Site', 'same-origin');
      expect(policy.allowsAuthenticationPost(request({ rawHeaders }))).toBe(
        false,
      );
    },
  );

  it.each([...fields, 'Sec-Fetch-Site'])(
    'denies identical and differently cased duplicate %s',
    (name) => {
      const input =
        name === 'Sec-Fetch-Site' ? withHeader(name, 'same-origin') : request();
      const value = input.rawHeaders[input.rawHeaders.indexOf(name) + 1];
      for (const duplicateName of [
        name,
        name.toLowerCase(),
        name.toUpperCase(),
      ]) {
        expect(
          policy.allowsAuthenticationPost(
            request({
              rawHeaders: [...input.rawHeaders, duplicateName, value],
            }),
          ),
        ).toBe(false);
      }
    },
  );

  it.each([
    '',
    'null',
    'https://other.example.test',
    'http://nina.example.test',
    `${ORIGIN}:8443`,
    `${ORIGIN}/`,
    `${ORIGIN}.evil.test`,
    'https://nina-example.test',
    ` ${ORIGIN}`,
    `${ORIGIN} `,
    `${ORIGIN}\r\n`,
    `${ORIGIN}, ${ORIGIN}`,
    `${ORIGIN} ${ORIGIN}`,
  ])('denies Origin %j without normalization', (origin) => {
    expect(policy.allowsAuthenticationPost(withHeader('Origin', origin))).toBe(
      false,
    );
  });

  it.each(['', '0', 'true', ' 1', '1 ', '1,1', '1\t', '1\r\n', 1, null])(
    'denies marker %j',
    (marker) => {
      expect(
        policy.allowsAuthenticationPost(
          withHeader('X-NINA-CSRF-Protection', marker),
        ),
      ).toBe(false);
    },
  );

  it.each([
    '',
    'text/plain',
    'application/x-www-form-urlencoded',
    'multipart/form-data',
    ' application/json',
    'application/json ',
    'application/json\t',
    'application/json\n',
    'application/json\r\n',
    'application/\tjson',
    'application/json; charset="utf-8"',
    'application/json; charset=ascii',
    'application/json; charset=utf-8 ',
    'application/json; charset=utf-8\n',
    'application/json; charset=utf-8; charset=utf-8',
    'application/json; boundary=x',
    'application/json; charset=utf-8; x=y',
    'application/json,application/json',
    'application/json;',
    'application/json; char\tset=utf-8',
    'application/json; charset=utf\t-8',
    'application/json\u0000',
    'application/json\u000b',
    'application/json\u007f',
    'application/json;\r\ncharset=utf-8',
  ])(
    'denies Content-Type outside the narrow JSON grammar %j',
    (contentType) => {
      expect(
        policy.allowsAuthenticationPost(
          withHeader('Content-Type', contentType),
        ),
      ).toBe(false);
    },
  );

  it.each([
    'same-site',
    'cross-site',
    'none',
    '',
    'SAME-ORIGIN',
    ' same-origin',
    'same-origin ',
    'same-origin,same-origin',
    'same-origin\n',
  ])('denies Sec-Fetch-Site %j', (site) => {
    expect(
      policy.allowsAuthenticationPost(withHeader('Sec-Fetch-Site', site)),
    ).toBe(false);
  });

  it('denies throwing accessors and proxies without propagating errors', () => {
    const throwing = () => {
      throw new Error('untrusted accessor');
    };
    expect(
      policy.allowsAuthenticationPost({
        get method() {
          return throwing();
        },
      }),
    ).toBe(false);
    expect(
      policy.allowsAuthenticationPost({
        method: 'POST',
        get rawHeaders() {
          return throwing();
        },
      }),
    ).toBe(false);
    expect(
      policy.allowsAuthenticationPost(new Proxy({}, { get: throwing })),
    ).toBe(false);
  });

  it('does not inspect the body or change supplied headers', () => {
    const input = request();
    Object.freeze(input.rawHeaders);
    Object.defineProperty(input, 'body', {
      get() {
        throw new Error('body must not be read');
      },
    });
    expect(policy.allowsAuthenticationPost(input)).toBe(true);
    expect(input.rawHeaders).toEqual(request().rawHeaders);
  });
});
