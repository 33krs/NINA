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
import { BrowserLoginInputReader } from './browser-login-input-reader';
import { BrowserSessionCookies } from './browser-session-cookies';
import {
  createBrowserLoginHandler,
  type BrowserLoginConfig,
} from './browser-login.handler';
import type {
  CreatedSession,
  SessionCreationService,
} from './session-creation.service';
import type { SessionService } from './session.service';

const ORIGIN = 'https://nina.test';
const SID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const SECOND_SID = '33333333-3333-4333-8333-333333333333';
const account = {
  id: OWNER,
  username: 'learner',
  role: 'STUDENT' as const,
  authVersion: 2,
};
const REFRESH = Buffer.alloc(32, 1).toString('base64url');
const BODY = JSON.stringify({
  username: ' learner ',
  password: ' exact password ',
});
const config: BrowserLoginConfig = {
  canonicalOrigin: ORIGIN,
  jsonLimits: { maxBytes: 256, readTimeoutMs: 100 },
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

function created(id = SID): CreatedSession {
  return { id, account, expiresAt: null, refreshToken: REFRESH };
}

describe('isolated browser login HTTP composition', () => {
  let app: NestExpressApplication;
  let port: number;
  let fault: Fault;
  let latestRequest: Request;
  let latestResponse: Response;
  let downstream: number;
  let events: string[];
  const clients = new Set<ClientRequest>();
  const create = jest.fn<SessionCreationService['create']>();
  const issue = jest.fn<AccessCredentialService['issue']>();
  const revoke = jest.fn<SessionService['revoke']>();
  const validate = jest.fn<SessionService['validate']>();
  const services = {
    creation: { create },
    access: { issue },
    sessions: { revoke },
  };
  const access = new AccessCredentialService(
    { validate } as unknown as SessionService,
    {
      ...keys,
      issuer: 'nina-test',
      audience: 'nina-test-browser',
      lifetimeSeconds: 60,
    },
  );

  function open(headers: OutgoingHttpHeaders = {}, method = 'POST') {
    let client!: ClientRequest;
    const fields: OutgoingHttpHeaders = {
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'X-NINA-CSRF-Protection': '1',
      ...headers,
    };
    for (const name of Object.keys(fields))
      if (fields[name] === undefined) delete fields[name];
    const result = new Promise<HttpResult>((resolve, reject) => {
      client = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/synthetic-login',
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
    body: string | Buffer = BODY,
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
    expect(result.body).not.toContain('password');
    expect(result.body).not.toContain(REFRESH);
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
      if (fault === FAULT.HEADER || fault === FAULT.REMOVE) {
        Object.defineProperty(response, 'setHeader', {
          value: (...args: Parameters<Response['setHeader']>) => {
            const result = setHeader(...args);
            if (args[0].toLowerCase() === 'set-cookie')
              throw new Error('Synthetic header failure');
            return result;
          },
        });
      }
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
    app.use('/synthetic-login', createBrowserLoginHandler(services, config));
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
    events = [];
    fault = FAULT.NONE;
    downstream = 0;
    create.mockReset().mockImplementation(async () => {
      events.push('create');
      return created();
    });
    issue.mockReset().mockImplementation(async (...args) => {
      events.push('issue');
      return access.issue(...args);
    });
    validate.mockReset().mockImplementation(async () => {
      events.push('validate');
      return account;
    });
    revoke.mockReset().mockResolvedValue(true);
  });
  afterEach(() => {
    for (const client of clients) client.destroy();
    clients.clear();
    jest.restoreAllMocks();
  });
  afterAll(async () => app?.close());

  it('issues a session-bound pair only after null-expiry creation and online validation', async () => {
    const result = await send();
    expect(result.status).toBe(204);
    expect(result.body).toBe('');
    expect(result.headers['cache-control']).toBe('no-store');
    expect(create).toHaveBeenCalledWith(' learner ', ' exact password ', null);
    expect(issue).toHaveBeenCalledWith(SID, OWNER, 2);
    expect(validate).toHaveBeenCalledWith(SID, OWNER, 2);
    expect(events).toEqual(['create', 'issue', 'validate']);
    const fields = result.headers['set-cookie'];
    expect(fields).toHaveLength(2);
    expect(fields![0]).toMatch(
      /^__Host-nina-access=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=60$/,
    );
    expect(fields![1]).toBe(
      `__Host-nina-refresh=${REFRESH}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=3600`,
    );
    expect(
      await access.verify(
        fields![0].split(';')[0].slice('__Host-nina-access='.length),
      ),
    ).toEqual(account);
    await new Promise<void>((resolve) => globalThis.setImmediate(resolve));
    expect(revoke).not.toHaveBeenCalled();
    expect(downstream).toBe(0);
  });

  it.each<[string, OutgoingHttpHeaders]>([
    ['GET', {}],
    ['POST', { Origin: 'https://other.test' }],
    ['POST', { Origin: undefined }],
    ['POST', { 'X-NINA-CSRF-Protection': undefined }],
    ['POST', { 'X-NINA-CSRF-Protection': '0' }],
    ['POST', { Origin: [ORIGIN, ORIGIN] }],
    ['POST', { 'Sec-Fetch-Site': 'cross-site' }],
  ])(
    'denies admission before body or services: %s %j',
    async (method, headers) => {
      const input = jest.spyOn(BrowserLoginInputReader.prototype, 'read');
      rejected(
        await send('{', { ...headers, 'Content-Length': '10000' }, method),
        403,
      );
      expect(Reflect.has(latestRequest, 'body')).toBe(false);
      expect(input).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(issue).not.toHaveBeenCalled();
    },
  );

  it.each<[string | Buffer, OutgoingHttpHeaders, number]>([
    ['null', {}, 400],
    ['{"username":"x"}', {}, 400],
    ['{"username":"x","password":"y","extra":true}', {}, 400],
    [String.raw`{"username":"x","\u0075sername":"y","password":"z"}`, {}, 400],
    ['{', {}, 400],
    [Buffer.from([0xff]), {}, 400],
    ['x'.repeat(257), {}, 413],
    [BODY, { 'Content-Encoding': 'gzip' }, 415],
  ])(
    'rejects invalid body before creation: %s',
    async (body, headers, status) => {
      rejected(await send(body, headers), status);
      expect(create).not.toHaveBeenCalled();
      expect(issue).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    },
  );

  it('rejects an unfinished body at the explicit read deadline', async () => {
    const exchange = open({ 'Transfer-Encoding': 'chunked' });
    exchange.client.write('{');
    rejected(await exchange.result, 408);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'does not invent cleanup after creation null/throw (%s)',
    async (throws) => {
      if (throws)
        create.mockRejectedValue(new Error('Synthetic creation failure'));
      else create.mockResolvedValue(null);
      rejected(await send(), throws ? 500 : 401);
      expect(create).toHaveBeenCalledTimes(1);
      expect(issue).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    },
  );

  it.each([
    'null',
    'throw',
    'serialization',
    'serialization-throw',
    'inactive',
  ])('fails closed and cleans one known session: %s', async (failure) => {
    if (failure === 'null') issue.mockResolvedValue(null);
    if (failure === 'throw')
      issue.mockRejectedValue(new Error('Synthetic issue failure'));
    if (failure === 'serialization') issue.mockResolvedValue('invalid');
    if (failure === 'serialization-throw')
      jest
        .spyOn(BrowserSessionCookies.prototype, 'issue')
        .mockImplementation(() => {
          throw new Error('Synthetic serialization failure');
        });
    if (failure === 'inactive') validate.mockResolvedValue(null);
    rejected(await send(), 500);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(SID, OWNER);
  });

  it.each([false, true])(
    'contains failed cleanup without retry (%s)',
    async (throws) => {
      issue.mockResolvedValue(null);
      if (throws)
        revoke.mockRejectedValue(new Error('Synthetic cleanup failure'));
      else revoke.mockResolvedValue(false);
      rejected(await send(), 500);
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledTimes(1);
    },
  );

  it('removes a buffered cookie pair if its header write throws', async () => {
    fault = FAULT.HEADER;
    rejected(await send(), 500);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(latestResponse.getHeader('Set-Cookie')).toBeUndefined();
  });

  it('destroys the response if buffered cookies cannot be removed', async () => {
    fault = FAULT.REMOVE;
    await expect(send()).rejects.toThrow();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(latestResponse.destroyed).toBe(true);
  });

  it('does not compensate once response dispatch has been attempted', async () => {
    fault = FAULT.DISPATCH;
    await expect(send()).rejects.toThrow();
    expect(revoke).not.toHaveBeenCalled();
    expect(latestResponse.destroyed).toBe(true);
  });

  it.each(['create', 'issue'])(
    'cleans a known session after disconnect during %s',
    async (stage) => {
      const began = deferred<void>();
      const release = deferred<CreatedSession | null>();
      const token = deferred<string | null>();
      const cleaned = deferred<void>();
      if (stage === 'create')
        create.mockImplementation(() => {
          began.resolve();
          return release.promise;
        });
      else
        issue.mockImplementation(() => {
          began.resolve();
          return token.promise;
        });
      revoke.mockImplementation(async () => {
        cleaned.resolve();
        return true;
      });
      const exchange = open();
      exchange.client.end(BODY);
      const outcome = exchange.result.catch(() => null);
      const started = await Promise.race([
        began.promise.then(() => true),
        outcome.then(() => false),
      ]);
      expect(started).toBe(true);
      const closed = new Promise<void>((resolve) =>
        latestResponse.once('close', resolve),
      );
      exchange.client.destroy();
      await closed;
      release.resolve(created());
      token.resolve('a.b.c');
      await cleaned.promise;
      await outcome;
      expect(revoke).toHaveBeenCalledTimes(1);
      expect(revoke).toHaveBeenCalledWith(SID, OWNER);
      if (stage === 'create') expect(issue).not.toHaveBeenCalled();
      expect(latestResponse.getHeader('Set-Cookie')).toBeUndefined();
      expect(downstream).toBe(0);
    },
  );

  it('keeps concurrent requests isolated without second responses or continuation', async () => {
    create.mockImplementation(async (username) =>
      created(username === 'second' ? SECOND_SID : SID),
    );
    const results = await Promise.all([
      send(),
      send(JSON.stringify({ username: 'second', password: 'other' })),
    ]);
    expect(results.map((result) => result.status)).toEqual([204, 204]);
    const tokens = results.map(
      (result) => result.headers['set-cookie']![0].split(';')[0],
    );
    expect(tokens[0]).not.toBe(tokens[1]);
    expect(issue).toHaveBeenCalledWith(SID, OWNER, 2);
    expect(issue).toHaveBeenCalledWith(SECOND_SID, OWNER, 2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(issue).toHaveBeenCalledTimes(2);
    expect(downstream).toBe(0);
    expect(revoke).not.toHaveBeenCalled();
  });
});
