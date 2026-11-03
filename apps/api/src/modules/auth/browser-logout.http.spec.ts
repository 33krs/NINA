import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { Request, Response } from 'express';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import * as jwt from 'jsonwebtoken';
import {
  AccessCredentialService,
  type VerifiedAccessSession,
} from './access-credential.service';
import { BrowserSessionCookies } from './browser-session-cookies';
import { BrowserSessionCookieReader } from './browser-session-cookie-reader';
import {
  createBrowserLogoutHandler,
  type BrowserLogoutConfig,
} from './browser-logout.handler';
import type { RefreshSessionRevocationService } from './refresh-session-revocation.service';
import type { SessionService } from './session.service';

const ORIGIN = 'https://nina.test';
const SID = '11111111-1111-4111-8111-111111111111';
const OTHER_SID = '33333333-3333-4333-8333-333333333333';
const account = {
  id: '22222222-2222-4222-8222-222222222222',
  username: 'learner',
  role: 'STUDENT' as const,
  authVersion: 2,
};
const REFRESH = randomBytes(32).toString('base64url');
const OTHER_REFRESH = randomBytes(32).toString('base64url');
const cookie = (token = REFRESH) => `__Host-nina-refresh=${token}`;
const config: BrowserLogoutConfig = {
  canonicalOrigin: ORIGIN,
  jsonLimits: { maxBytes: 64, readTimeoutMs: 100 },
  cookieConfig: { accessMaxAgeSeconds: 60, refreshMaxAgeSeconds: 3600 },
};
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const FAULT = {
  NONE: 'none',
  HEADER: 'header',
  REMOVE: 'remove',
  DISPATCH: 'dispatch',
  NO_STORE: 'no-store',
} as const;
type Fault = (typeof FAULT)[keyof typeof FAULT];

interface HttpResult {
  readonly status: number | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function signedAccess(sessionId = SID, offset = 0, version = 2) {
  const iat = Math.floor(Date.now() / 1000) + offset;
  return jwt.sign(
    {
      sub: account.id,
      sid: sessionId,
      authVersion: version,
      iat,
      exp: iat + 60,
    },
    keys.privateKey,
    {
      algorithm: 'RS256',
      issuer: 'nina-test',
      audience: 'nina-browser',
      header: { alg: 'RS256', typ: 'nina-access+jwt' },
    },
  );
}

describe('isolated browser logout HTTP composition', () => {
  let app: NestExpressApplication;
  let port: number;
  let fault: Fault;
  let latestRequest: Request;
  let latestResponse: Response;
  let downstream: number;
  let events: string[];
  const clients = new Set<ClientRequest>();
  const refreshRevoke = jest.fn<RefreshSessionRevocationService['revoke']>();
  const revoke = jest.fn<SessionService['revoke']>();
  const validate = jest.fn<SessionService['validate']>();
  const verifySession = jest.fn<AccessCredentialService['verifySession']>();
  const access = new AccessCredentialService(
    { validate, revoke } as unknown as SessionService,
    {
      ...keys,
      issuer: 'nina-test',
      audience: 'nina-browser',
      lifetimeSeconds: 60,
    },
  );
  const services = {
    refresh: { revoke: refreshRevoke },
    access: { verifySession },
    sessions: { revoke },
  };

  function open(headers: OutgoingHttpHeaders = {}, method = 'POST') {
    let client!: ClientRequest;
    const fields: OutgoingHttpHeaders = {
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'X-NINA-CSRF-Protection': '1',
      Cookie: cookie(),
      ...headers,
    };
    for (const name of Object.keys(fields))
      if (fields[name] === undefined) delete fields[name];
    const result = new Promise<HttpResult>((resolve, reject) => {
      client = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: `/synthetic-logout?sessionId=${OTHER_SID}`,
          method,
          headers: fields,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('error', reject);
          response.once('aborted', () => reject(new Error('Synthetic abort')));
          response.once('end', () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      clients.add(client);
      client.once('error', reject);
      client.setTimeout(1500, () =>
        client.destroy(new Error('Synthetic client timeout')),
      );
    });
    return { client, result };
  }
  async function send(
    body: string | Buffer = '{}',
    headers: OutgoingHttpHeaders = {},
    method = 'POST',
  ) {
    const exchange = open(headers, method);
    exchange.client.end(body);
    return exchange.result;
  }
  function rejected(result: HttpResult, status: number) {
    expect(result.status).toBe(status);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['set-cookie']).toBeUndefined();
    for (const value of [REFRESH, OTHER_REFRESH, SID, OTHER_SID, account.id])
      expect(result.body.includes(value)).toBe(false);
    expect(downstream).toBe(0);
  }
  function success(result: HttpResult) {
    expect(result.status).toBe(204);
    expect(result.body).toBe('');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['set-cookie']).toEqual([
      '__Host-nina-access=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      '__Host-nina-refresh=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ]);
    expect(downstream).toBe(0);
  }

  beforeAll(async () => {
    const module = await Test.createTestingModule({}).compile();
    app = module.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    app.use((request: Request, response: Response, next: () => void) => {
      latestRequest = request;
      latestResponse = response;
      const setHeader = response.setHeader.bind(response);
      Object.defineProperty(response, 'setHeader', {
        value: (...args: Parameters<Response['setHeader']>) => {
          const name = args[0].toLowerCase();
          if (fault === FAULT.NO_STORE && name === 'cache-control')
            throw new Error('Synthetic no-store failure');
          if (
            (fault === FAULT.HEADER || fault === FAULT.REMOVE) &&
            name === 'set-cookie'
          ) {
            setHeader(
              args[0],
              Array.isArray(args[1]) ? args[1].slice(0, 1) : args[1],
            );
            throw new Error('Synthetic partial header failure');
          }
          return setHeader(...args);
        },
      });
      if (fault === FAULT.REMOVE)
        Object.defineProperty(response, 'removeHeader', {
          value: () => {
            throw new Error('Synthetic removal failure');
          },
        });
      if (fault === FAULT.DISPATCH)
        Object.defineProperty(response, 'end', {
          value: () => {
            throw new Error('Synthetic dispatch failure');
          },
        });
      next();
    });
    app.use('/synthetic-logout', createBrowserLogoutHandler(services, config));
    app.use((_request: Request, response: Response) => {
      downstream++;
      response.status(599).end();
    });
    await app.init();
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    fault = FAULT.NONE;
    downstream = 0;
    events = [];
    refreshRevoke.mockReset().mockImplementation(async () => {
      events.push('refresh');
      return true;
    });
    revoke.mockReset().mockImplementation(async () => {
      events.push('session');
      return true;
    });
    validate.mockReset().mockImplementation(async () => {
      events.push('validate');
      return account;
    });
    verifySession.mockReset().mockImplementation(async (token) => {
      events.push('verify');
      return access.verifySession(token);
    });
  });
  afterEach(() => {
    for (const client of clients) client.destroy();
    clients.clear();
    jest.restoreAllMocks();
  });
  afterAll(async () => app?.close());

  it('settles refresh-only revocation before deleting both cookies', async () => {
    success(await send());
    expect(refreshRevoke.mock.calls[0].length).toBe(1);
    expect(refreshRevoke).toHaveBeenCalledWith(REFRESH);
    expect(refreshRevoke).toHaveBeenCalledTimes(1);
    expect(verifySession).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
    expect(events).toEqual(['refresh']);
  });
  it('settles access-only owner revocation before deleting both cookies', async () => {
    success(
      await send('{}', { Cookie: `__Host-nina-access=${signedAccess()}` }),
    );
    expect(events).toEqual(['verify', 'validate', 'session']);
    expect(validate).toHaveBeenCalledWith(SID, account.id, 2);
    expect(revoke).toHaveBeenCalledWith(SID, account.id);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(refreshRevoke).not.toHaveBeenCalled();
  });

  it('passes only a canonically verified companion binding to refresh revocation', async () => {
    const token = signedAccess();
    success(
      await send('{}', { Cookie: `__Host-nina-access=${token}; ${cookie()}` }),
    );
    expect(verifySession).toHaveBeenCalledWith(token);
    expect(refreshRevoke).toHaveBeenCalledWith(REFRESH, {
      sessionId: SID,
      account,
    });
    expect(events).toEqual(['verify', 'validate', 'refresh']);
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each(['expired', 'invalid-signature', 'unverifiable', 'inactive'])(
    'uses refresh alone when the companion is %s, without trusting its claims',
    async (kind) => {
      let token = signedAccess();
      if (kind === 'expired') token = signedAccess(OTHER_SID, -120);
      if (kind === 'invalid-signature') {
        const parts = token.split('.');
        parts[2] = randomBytes(256).toString('base64url');
        token = parts.join('.');
      }
      if (kind === 'unverifiable') token = 'a.b.c';
      if (kind === 'inactive') validate.mockResolvedValue(null);
      success(
        await send('{}', {
          Cookie: `__Host-nina-access=${token}; ${cookie()}`,
        }),
      );
      expect(verifySession).toHaveBeenCalledTimes(1);
      expect(refreshRevoke.mock.calls[0].length).toBe(1);
      expect(refreshRevoke).toHaveBeenCalledWith(REFRESH);
      expect(revoke).not.toHaveBeenCalled();
      if (kind !== 'inactive') expect(validate).not.toHaveBeenCalled();
    },
  );

  it.each(['session', 'owner', 'version'])(
    'preserves a verified %s mismatch for atomic refresh denial',
    async (kind) => {
      const binding: VerifiedAccessSession = {
        sessionId: kind === 'session' ? OTHER_SID : SID,
        account: {
          ...account,
          id: kind === 'owner' ? OTHER_SID : account.id,
          authVersion: kind === 'version' ? 3 : 2,
        },
      };
      validate.mockResolvedValue(binding.account);
      refreshRevoke.mockImplementation(
        async (_token, expected) =>
          expected?.sessionId === SID &&
          expected.account.id === account.id &&
          expected.account.authVersion === 2,
      );
      rejected(
        await send('{}', {
          Cookie: `__Host-nina-access=${signedAccess(binding.sessionId, 0, binding.account.authVersion)}; ${cookie()}`,
        }),
        401,
      );
      expect(refreshRevoke).toHaveBeenCalledWith(REFRESH, binding);
      expect(revoke).not.toHaveBeenCalled();
    },
  );

  it.each<[string, OutgoingHttpHeaders]>([
    ['GET', {}],
    ['POST', { Origin: 'https://other.test' }],
    ['POST', { Origin: 'http://nina.test' }],
    ['POST', { Origin: undefined }],
    ['POST', { Origin: [ORIGIN, ORIGIN] }],
    ['POST', { 'X-NINA-CSRF-Protection': undefined }],
    ['POST', { 'X-NINA-CSRF-Protection': '0' }],
    ['POST', { 'Content-Type': 'text/plain' }],
    ['POST', { 'Sec-Fetch-Site': 'cross-site' }],
  ])(
    'denies admission before parser, cookie reader and services (case %#)',
    async (method, headers) => {
      const read = jest.spyOn(BrowserSessionCookieReader.prototype, 'read');
      rejected(
        await send('{', { ...headers, 'Content-Length': '10000' }, method),
        403,
      );
      expect(Reflect.has(latestRequest, 'body')).toBe(false);
      expect(read).not.toHaveBeenCalled();
      expect(verifySession).not.toHaveBeenCalled();
      expect(refreshRevoke).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    },
  );

  it.each<[string | Buffer, OutgoingHttpHeaders, number]>([
    ['', {}, 400],
    ['null', {}, 400],
    ['[]', {}, 400],
    ['""', {}, 400],
    ['{"sessionId":"ignored"}', {}, 400],
    ['{"ownerId":"ignored"}', {}, 400],
    ['{"refreshToken":"ignored"}', {}, 400],
    [String.raw`{"x":1,"\u0078":2}`, {}, 400],
    ['{', {}, 400],
    [Buffer.from([0xff]), {}, 400],
    ['x'.repeat(65), {}, 413],
    ['{}', { 'Content-Encoding': 'gzip' }, 415],
  ])(
    'denies body before cookie extraction or verification (case %#)',
    async (body, headers, status) => {
      const read = jest.spyOn(BrowserSessionCookieReader.prototype, 'read');
      rejected(await send(body, headers), status);
      expect(read).not.toHaveBeenCalled();
      expect(verifySession).not.toHaveBeenCalled();
      expect(refreshRevoke).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    },
  );

  it('bounds incomplete body reads without starting services', async () => {
    const exchange = open({ 'Transfer-Encoding': 'chunked' });
    exchange.client.write('{');
    rejected(await exchange.result, 408);
    expect(verifySession).not.toHaveBeenCalled();
    expect(refreshRevoke).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each([
    'absent',
    'unrelated',
    'malformed-refresh',
    'malformed-access',
    'duplicate-refresh',
    'duplicate-access',
    'duplicate-header',
    'noncanonical-refresh',
    'quoted',
    'lookalike',
  ])(
    'rejects absent or ambiguous credentials without identity fallback: %s',
    async (kind) => {
      const valid = signedAccess();
      const fields: Record<string, OutgoingHttpHeaders['Cookie']> = {
        absent: undefined,
        unrelated: 'other=value',
        'malformed-refresh': `__Host-nina-refresh=invalid; __Host-nina-access=${valid}`,
        'malformed-access': `${cookie()}; __Host-nina-access=invalid`,
        'duplicate-refresh': `${cookie()}; ${cookie()}`,
        'duplicate-access': `${cookie()}; __Host-nina-access=${valid}; __Host-nina-access=${valid}`,
        'duplicate-header': [cookie(), cookie()],
        'noncanonical-refresh': `${cookie()}=`,
        quoted: `__Host-nina-refresh="${REFRESH}"`,
        lookalike: `__host-nina-refresh=${REFRESH}`,
      };
      rejected(
        await send('{}', {
          Cookie: fields[kind],
          Authorization: `Bearer ${valid}`,
          'X-Session-Id': SID,
        }),
        401,
      );
      expect(verifySession).not.toHaveBeenCalled();
      expect(refreshRevoke).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    },
  );

  it.each(['expired', 'invalid', 'future', 'inactive'])(
    'requires canonical current access when refresh is absent: %s',
    async (kind) => {
      let token = signedAccess();
      if (kind === 'expired') token = signedAccess(SID, -120);
      if (kind === 'future') token = signedAccess(SID, 120);
      if (kind === 'invalid') token = 'a.b.c';
      if (kind === 'inactive') validate.mockResolvedValue(null);
      rejected(
        await send('{}', { Cookie: `__Host-nina-access=${token}` }),
        401,
      );
      expect(refreshRevoke).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    },
  );

  it.each([
    'refresh-false',
    'refresh-throw',
    'session-false',
    'session-throw',
    'verify-throw',
  ])(
    'fails closed without retries, fallback or deletion after %s',
    async (kind) => {
      const clear = jest.spyOn(BrowserSessionCookies.prototype, 'clear');
      const logs = [
        jest.spyOn(console, 'log'),
        jest.spyOn(console, 'warn'),
        jest.spyOn(console, 'error'),
      ];
      const throws = kind.endsWith('throw');
      const selected = kind.startsWith('refresh') ? refreshRevoke : revoke;
      if (kind === 'verify-throw')
        verifySession.mockRejectedValue(
          new Error('Synthetic dependency failure'),
        );
      else if (throws)
        selected.mockRejectedValue(new Error('Synthetic uncertain settlement'));
      else selected.mockResolvedValue(false);
      const result = await send('{}', {
        Cookie:
          `__Host-nina-access=${signedAccess()}` +
          (kind.startsWith('session') ? '' : `; ${cookie()}`),
      });
      rejected(result, throws ? 500 : 401);
      expect(result.body).toBe('{"message":"Authentication failed"}');
      expect(clear).not.toHaveBeenCalled();
      if (kind === 'verify-throw') {
        expect(refreshRevoke).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
      } else {
        expect(selected).toHaveBeenCalledTimes(1);
        expect(
          kind.startsWith('refresh') ? revoke : refreshRevoke,
        ).not.toHaveBeenCalled();
      }
      for (const log of logs) expect(log).not.toHaveBeenCalled();
    },
  );

  it('denies a consumed refresh even with valid access; a distinct refresh remains independent', async () => {
    const unused = new Set([REFRESH, OTHER_REFRESH]);
    refreshRevoke.mockImplementation(
      async (token) => typeof token === 'string' && unused.delete(token),
    );
    const headers = {
      Cookie: `__Host-nina-access=${signedAccess()}; ${cookie()}`,
    };
    success(await send('{}', headers));
    rejected(await send('{}', headers), 401);
    success(await send('{}', { Cookie: cookie(OTHER_REFRESH) }));
    expect(refreshRevoke).toHaveBeenCalledTimes(3);
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each(['refresh', 'session'])(
    'awaits affirmative %s settlement before clearing',
    async (stage) => {
      const gate = deferred<boolean>();
      const began = deferred<void>();
      const selected = stage === 'refresh' ? refreshRevoke : revoke;
      selected.mockImplementation(() => {
        began.resolve();
        return gate.promise;
      });
      const clear = jest.spyOn(BrowserSessionCookies.prototype, 'clear');
      const exchange = open(
        stage === 'session'
          ? { Cookie: `__Host-nina-access=${signedAccess()}` }
          : {},
      );
      const outcome = exchange.result;
      exchange.client.end('{}');
      try {
        expect(
          await Promise.race([
            began.promise.then(() => true),
            outcome.then(() => false),
          ]),
        ).toBe(true);
        expect(clear).not.toHaveBeenCalled();
        expect(latestResponse.getHeader('Set-Cookie')).toBeUndefined();
        expect(latestResponse.writableEnded).toBe(false);
      } finally {
        gate.resolve(true);
      }
      success(await outcome);
      expect(clear).toHaveBeenCalledTimes(1);
    },
  );

  it('removes a partially buffered deletion pair without another revocation', async () => {
    fault = FAULT.HEADER;
    rejected(await send(), 500);
    expect(latestResponse.getHeader('Set-Cookie')).toBeUndefined();
    expect(refreshRevoke).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
  });
  it.each([FAULT.REMOVE, FAULT.DISPATCH, FAULT.NO_STORE])(
    'destroys unsafe responses without later side effects: %s',
    async (value) => {
      fault = value;
      await expect(send()).rejects.toThrow();
      expect(latestResponse.destroyed).toBe(true);
      expect(refreshRevoke).toHaveBeenCalledTimes(
        value === FAULT.NO_STORE ? 0 : 1,
      );
      expect(revoke).not.toHaveBeenCalled();
      expect(verifySession).not.toHaveBeenCalled();
      expect(downstream).toBe(0);
    },
  );
  it('reports deletion serialization failure without undoing or retrying revocation', async () => {
    jest
      .spyOn(BrowserSessionCookies.prototype, 'clear')
      .mockImplementation(() => {
        throw new Error('Synthetic serialization failure');
      });
    rejected(await send(), 500);
    expect(refreshRevoke).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
  });

  it.each(['verify', 'refresh', 'session'])(
    'stops new work and deletion after disconnect during %s',
    async (stage) => {
      const began = deferred<void>();
      const verification = deferred<VerifiedAccessSession | null>();
      const settlement = deferred<boolean>();
      if (stage === 'verify')
        verifySession.mockImplementation(() => {
          began.resolve();
          return verification.promise;
        });
      else
        (stage === 'refresh' ? refreshRevoke : revoke).mockImplementation(
          () => {
            began.resolve();
            return settlement.promise;
          },
        );
      const clear = jest.spyOn(BrowserSessionCookies.prototype, 'clear');
      const exchange = open({
        Cookie:
          `__Host-nina-access=${signedAccess()}` +
          (stage === 'session' ? '' : `; ${cookie()}`),
      });
      const outcome = exchange.result.catch(() => null);
      exchange.client.end('{}');
      try {
        expect(
          await Promise.race([
            began.promise.then(() => true),
            outcome.then(() => false),
          ]),
        ).toBe(true);
        const closed = new Promise<void>((resolve) =>
          latestResponse.once('close', resolve),
        );
        exchange.client.destroy();
        await closed;
      } finally {
        exchange.client.destroy();
        verification.resolve({ sessionId: SID, account });
        settlement.resolve(true);
      }
      await new Promise<void>((resolve) => globalThis.setImmediate(resolve));
      await outcome;
      expect(refreshRevoke).toHaveBeenCalledTimes(stage === 'refresh' ? 1 : 0);
      expect(revoke).toHaveBeenCalledTimes(stage === 'session' ? 1 : 0);
      expect(clear).not.toHaveBeenCalled();
      expect(latestResponse.getHeader('Set-Cookie')).toBeUndefined();
      expect(downstream).toBe(0);
    },
  );
});
