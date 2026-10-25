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
import { generateKeyPairSync } from 'node:crypto';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccessCredentialService } from './access-credential.service';
import { BrowserSessionCookies } from './browser-session-cookies';
import { BrowserSessionCookieReader } from './browser-session-cookie-reader';
import {
  createBrowserRefreshHandler,
  type BrowserRefreshConfig,
} from './browser-refresh.handler';
import type {
  RefreshRotationService,
  RotatedSession,
} from './refresh-rotation.service';
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
const REFRESH = Buffer.alloc(32, 1).toString('base64url');
const SUCCESSOR = Buffer.alloc(32, 2).toString('base64url');
const OTHER = Buffer.alloc(32, 3).toString('base64url');
const OTHER_SUCCESSOR = Buffer.alloc(32, 4).toString('base64url');
const cookie = (token = REFRESH) => `__Host-nina-refresh=${token}`;
const config: BrowserRefreshConfig = {
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

function rotated(id = SID, refreshToken = SUCCESSOR): RotatedSession {
  return { id, account, expiresAt: null, refreshToken };
}

describe('isolated browser refresh HTTP composition', () => {
  let app: NestExpressApplication;
  let port: number;
  let fault: Fault;
  let latestRequest: Request;
  let latestResponse: Response;
  let downstream: number;
  let events: string[];
  const clients = new Set<ClientRequest>();
  const rotate = jest.fn<RefreshRotationService['rotate']>();
  const issue = jest.fn<AccessCredentialService['issue']>();
  const validate = jest.fn<SessionService['validate']>();
  const revoke = jest.fn<SessionService['revoke']>();
  const access = new AccessCredentialService(
    { validate, revoke } as unknown as SessionService,
    {
      ...keys,
      issuer: 'nina-test',
      audience: 'nina-browser',
      lifetimeSeconds: 60,
    },
  );
  const services = { rotation: { rotate }, access: { issue } };

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
          path: `/synthetic-refresh?refreshToken=${REFRESH}`,
          method,
          headers: fields,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('error', reject);
          response.once('aborted', () =>
            reject(new Error('Synthetic response aborted')),
          );
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
    expect(result.body).not.toContain(REFRESH);
    expect(result.body).not.toContain(SUCCESSOR);
    expect(result.body).not.toContain(SID);
    expect(result.body).not.toContain(account.id);
    expect(revoke).not.toHaveBeenCalled();
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
      if (fault === FAULT.HEADER || fault === FAULT.REMOVE)
        Object.defineProperty(response, 'setHeader', {
          value: (...args: Parameters<Response['setHeader']>) => {
            if (args[0].toLowerCase() !== 'set-cookie')
              return setHeader(...args);
            // Simulate a setter that buffers only one credential before throwing.
            setHeader(
              args[0],
              Array.isArray(args[1]) ? args[1].slice(0, 1) : args[1],
            );
            throw new Error('Synthetic header failure');
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
    app.use(
      '/synthetic-refresh',
      createBrowserRefreshHandler(services, config),
    );
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
    rotate.mockReset().mockImplementation(async () => {
      events.push('rotate');
      return rotated();
    });
    issue.mockReset().mockImplementation(async (...args) => {
      events.push('issue');
      return access.issue(...args);
    });
    validate.mockReset().mockImplementation(async () => {
      events.push('validate');
      return account;
    });
  });
  afterEach(() => {
    for (const client of clients) client.destroy();
    clients.clear();
    jest.restoreAllMocks();
  });
  afterAll(async () => app?.close());

  it('rotates a refresh-only cookie, issues from trusted identity and validates the new access online', async () => {
    const result = await send();
    expect(result.status).toBe(204);
    expect(result.body).toBe('');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(rotate).toHaveBeenCalledWith(REFRESH);
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(issue).toHaveBeenCalledWith(SID, account.id, 2);
    expect(validate).toHaveBeenCalledWith(SID, account.id, 2);
    expect(events).toEqual(['rotate', 'issue', 'validate']);
    const fields = result.headers['set-cookie'];
    expect(fields).toHaveLength(2);
    expect(fields![0]).toMatch(
      /^__Host-nina-access=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=60$/,
    );
    expect(fields![1]).toBe(
      `${cookie(SUCCESSOR)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`,
    );
    expect(
      await access.verify(
        fields![0].split(';')[0].slice('__Host-nina-access='.length),
      ),
    ).toEqual(account);
    expect(revoke).not.toHaveBeenCalled();
    expect(downstream).toBe(0);
  });

  it('does not require authentication of an unrelated syntactically valid access cookie', async () => {
    const verify = jest.spyOn(access, 'verify');
    expect(
      (await send('{}', { Cookie: `__Host-nina-access=a.b.c; ${cookie()}` }))
        .status,
    ).toBe(204);
    expect(verify).not.toHaveBeenCalled();
    expect(issue).toHaveBeenCalledWith(SID, account.id, 2);
  });

  it.each<[string, OutgoingHttpHeaders]>([
    ['GET', {}],
    ['POST', { Origin: 'https://other.test' }],
    ['POST', { Origin: undefined }],
    ['POST', { 'X-NINA-CSRF-Protection': undefined }],
    ['POST', { Origin: [ORIGIN, ORIGIN] }],
    ['POST', { 'Sec-Fetch-Site': 'cross-site' }],
  ])(
    'denies admission before body/cookie/services: %s %j',
    async (method, headers) => {
      const read = jest.spyOn(BrowserSessionCookieReader.prototype, 'read');
      rejected(
        await send('{', { ...headers, 'Content-Length': '10000' }, method),
        403,
      );
      expect(Reflect.has(latestRequest, 'body')).toBe(false);
      expect(read).not.toHaveBeenCalled();
      expect(rotate).not.toHaveBeenCalled();
      expect(issue).not.toHaveBeenCalled();
    },
  );

  it.each<[string | Buffer, OutgoingHttpHeaders, number]>([
    ['null', {}, 400],
    ['[]', {}, 400],
    ['""', {}, 400],
    ['{"refreshToken":"ignored"}', {}, 400],
    [String.raw`{"x":1,"\u0078":2}`, {}, 400],
    ['{', {}, 400],
    [Buffer.from([0xff]), {}, 400],
    ['x'.repeat(65), {}, 413],
    ['{}', { 'Content-Encoding': 'gzip' }, 415],
  ])(
    'rejects invalid body without rotation: %s',
    async (body, headers, status) => {
      rejected(await send(body, headers), status);
      expect(rotate).not.toHaveBeenCalled();
      expect(issue).not.toHaveBeenCalled();
    },
  );

  it('enforces the body-read deadline before rotation', async () => {
    const exchange = open({ 'Transfer-Encoding': 'chunked' });
    exchange.client.write('{');
    rejected(await exchange.result, 408);
    expect(rotate).not.toHaveBeenCalled();
  });

  it.each<OutgoingHttpHeaders>([
    { Cookie: undefined, Authorization: `Bearer ${REFRESH}` },
    { Cookie: '__Host-nina-refresh=invalid' },
    { Cookie: `${cookie()}; ${cookie()}` },
    { Cookie: `${cookie()}; __Host-nina-access=invalid` },
  ])(
    'denies missing/malformed cookie envelopes without fallback: %j',
    async (headers) => {
      rejected(await send('{}', headers), 401);
      expect(rotate).not.toHaveBeenCalled();
      expect(issue).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'denies rotation null/throw without retry or issuance (%s)',
    async (throws) => {
      if (throws)
        rotate.mockRejectedValue(new Error('Synthetic rotation failure'));
      else rotate.mockResolvedValue(null);
      rejected(await send(), throws ? 500 : 401);
      expect(rotate).toHaveBeenCalledTimes(1);
      expect(issue).not.toHaveBeenCalled();
    },
  );

  it.each([
    'null',
    'throw',
    'serialization',
    'serialization-throw',
    'inactive',
  ])(
    'never compensates an existing rotated session after %s',
    async (failure) => {
      if (failure === 'null') issue.mockResolvedValue(null);
      if (failure === 'throw')
        issue.mockRejectedValue(new Error('Synthetic issuance failure'));
      if (failure === 'serialization') issue.mockResolvedValue('invalid');
      if (failure === 'serialization-throw')
        jest
          .spyOn(BrowserSessionCookies.prototype, 'issue')
          .mockImplementation(() => {
            throw new Error('Synthetic serialization failure');
          });
      if (failure === 'inactive') validate.mockResolvedValue(null);
      rejected(await send(), 500);
      expect(rotate).toHaveBeenCalledTimes(1);
      expect(issue).toHaveBeenCalledTimes(1);
    },
  );

  it('removes even a partially buffered credential pair after header failure', async () => {
    fault = FAULT.HEADER;
    rejected(await send(), 500);
    expect(latestResponse.getHeader('Set-Cookie')).toBeUndefined();
  });

  it.each([FAULT.REMOVE, FAULT.DISPATCH])(
    'destroys ambiguous/unremovable responses without retry: %s',
    async (value) => {
      fault = value;
      await expect(send()).rejects.toThrow();
      expect(latestResponse.destroyed).toBe(true);
      expect(rotate).toHaveBeenCalledTimes(1);
      expect(issue).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled();
    },
  );

  it.each(['rotate', 'issue'])(
    'does not compensate or continue after disconnect during %s',
    async (stage) => {
      const began = deferred<void>();
      const release = deferred<RotatedSession | null>();
      const token = deferred<string | null>();
      if (stage === 'rotate')
        rotate.mockImplementation(() => {
          began.resolve();
          return release.promise;
        });
      else
        issue.mockImplementation(() => {
          began.resolve();
          return token.promise;
        });
      const exchange = open();
      exchange.client.end('{}');
      const outcome = exchange.result.catch(() => null);
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
      release.resolve(rotated());
      token.resolve('a.b.c');
      await new Promise<void>((resolve) => globalThis.setImmediate(resolve));
      await outcome;
      if (stage === 'rotate') expect(issue).not.toHaveBeenCalled();
      expect(rotate).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled();
      expect(latestResponse.getHeader('Set-Cookie')).toBeUndefined();
      expect(downstream).toBe(0);
    },
  );

  it('denies a consumed token but accepts its successor with a stateful rotation double', async () => {
    const unused = new Set([REFRESH]);
    rotate.mockImplementation(async (value) => {
      if (typeof value !== 'string' || !unused.delete(value)) return null;
      unused.add(value === REFRESH ? SUCCESSOR : OTHER);
      return rotated(SID, value === REFRESH ? SUCCESSOR : OTHER);
    });
    expect((await send()).status).toBe(204);
    rejected(await send(), 401);
    expect((await send('{}', { Cookie: cookie(SUCCESSOR) })).status).toBe(204);
    expect(rotate).toHaveBeenCalledTimes(3);
    expect(issue).toHaveBeenCalledTimes(2);
    expect(revoke).not.toHaveBeenCalled();
  });

  it('keeps concurrent same-token winner/loser and another session isolated', async () => {
    const unused = new Set([REFRESH, OTHER]);
    rotate.mockImplementation(async (value) => {
      if (typeof value !== 'string' || !unused.delete(value)) return null;
      return rotated(
        value === OTHER ? OTHER_SID : SID,
        value === OTHER ? OTHER_SUCCESSOR : SUCCESSOR,
      );
    });
    const results = await Promise.all([
      send(),
      send(),
      send('{}', { Cookie: cookie(OTHER) }),
    ]);
    expect(
      results
        .slice(0, 2)
        .map((result) => result.status)
        .sort(),
    ).toEqual([204, 401]);
    rejected(
      results.find((result) => result.status === 401)!,
      401,
    );
    expect(results[2].status).toBe(204);
    const successes = results.filter((result) => result.status === 204);
    expect(successes[0].headers['set-cookie']![1]).toContain(SUCCESSOR);
    expect(successes[1].headers['set-cookie']![1]).toContain(OTHER_SUCCESSOR);
    expect(successes[0].headers['set-cookie']).not.toEqual(
      successes[1].headers['set-cookie'],
    );
    expect(issue).toHaveBeenCalledWith(SID, account.id, 2);
    expect(issue).toHaveBeenCalledWith(OTHER_SID, account.id, 2);
    expect(rotate).toHaveBeenCalledTimes(3);
    expect(issue).toHaveBeenCalledTimes(2);
    expect(downstream).toBe(0);
  });
});
