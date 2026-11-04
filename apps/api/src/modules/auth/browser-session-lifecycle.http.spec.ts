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
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import {
  request,
  type ClientRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { AccessCredentialService } from './access-credential.service';
import {
  createBrowserLoginHandler,
  type BrowserLoginConfig,
} from './browser-login.handler';
import { createBrowserRefreshHandler } from './browser-refresh.handler';
import { createBrowserLogoutHandler } from './browser-logout.handler';
import type { RefreshRotationService } from './refresh-rotation.service';
import type { RefreshSessionRevocationService } from './refresh-session-revocation.service';
import type {
  CreatedSession,
  SessionCreationService,
} from './session-creation.service';
import type { SessionService } from './session.service';

const ORIGIN = 'https://nina.test';
const PATH = {
  LOGIN: '/synthetic-login',
  REFRESH: '/synthetic-refresh',
  LOGOUT: '/synthetic-logout',
} as const;
const config: BrowserLoginConfig = {
  canonicalOrigin: ORIGIN,
  jsonLimits: { maxBytes: 256, readTimeoutMs: 100 },
  cookieConfig: { accessMaxAgeSeconds: 60, refreshMaxAgeSeconds: 3600 },
};

interface SessionState {
  readonly created: CreatedSession;
  revoked: boolean;
}
interface RefreshState {
  readonly session: SessionState;
  consumed: boolean;
}
interface Pair {
  readonly access: string;
  readonly refresh: string;
  readonly cookie: string;
}
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

// These shared doubles model only handler composition, not database transactions.
describe('isolated shared browser session HTTP lifecycle', () => {
  let app: NestExpressApplication;
  let port: number;
  let access: AccessCredentialService;
  let username: string;
  let password: string;
  let account: CreatedSession['account'];
  let revocationGate: ReturnType<typeof deferred<boolean>> | undefined;
  let revocationEntered: ReturnType<typeof deferred<void>>;
  let events: string[];
  let downstream: number;
  const sessions = new Map<string, SessionState>();
  const refreshes = new Map<string, RefreshState>();
  const clients = new Set<ClientRequest>();
  const create = jest.fn<SessionCreationService['create']>();
  const validate = jest.fn<SessionService['validate']>();
  const revoke = jest.fn<SessionService['revoke']>();
  const rotate = jest.fn<RefreshRotationService['rotate']>();
  const revokeRefresh = jest.fn<RefreshSessionRevocationService['revoke']>();
  const issue = jest.fn<AccessCredentialService['issue']>();

  function successor(session: SessionState): CreatedSession {
    const refreshToken = randomBytes(32).toString('base64url');
    refreshes.set(refreshToken, { session, consumed: false });
    return { ...session.created, refreshToken };
  }

  function send(
    path: string,
    cookie?: string,
    headers: OutgoingHttpHeaders = {},
  ) {
    const fields: OutgoingHttpHeaders = {
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'X-NINA-CSRF-Protection': '1',
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    };
    for (const name of Object.keys(fields))
      if (fields[name] === undefined) delete fields[name];
    return new Promise<HttpResult>((resolve, reject) => {
      const client = request(
        { host: '127.0.0.1', port, path, method: 'POST', headers: fields },
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
      client.once('close', () => clients.delete(client));
      client.once('error', reject);
      client.setTimeout(1500, () =>
        client.destroy(new Error('Synthetic client timeout')),
      );
      client.end(
        path === PATH.LOGIN ? JSON.stringify({ username, password }) : '{}',
      );
    });
  }

  function responseContract(result: HttpResult, status: number) {
    expect(result.status).toBe(status);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body).toBe(
      status === 204 ? '' : '{"message":"Authentication failed"}',
    );
    expect(downstream).toBe(0);
    if (status !== 204) expect(result.headers['set-cookie']).toBeUndefined();
  }

  function pair(result: HttpResult): Pair {
    responseContract(result, 204);
    const fields = result.headers['set-cookie'];
    expect(fields).toHaveLength(2);
    for (const field of fields!) {
      expect(field).toContain('; Path=/; HttpOnly; Secure; SameSite=Strict');
      expect(field).not.toContain('Domain=');
    }
    const cookies = fields!.map((field) => field.split(';')[0]);
    expect(cookies[0]).toMatch(/^__Host-nina-access=.+/);
    expect(cookies[1]).toMatch(/^__Host-nina-refresh=.+/);
    return {
      access: cookies[0].slice('__Host-nina-access='.length),
      refresh: cookies[1].slice('__Host-nina-refresh='.length),
      cookie: cookies.join('; '),
    };
  }

  beforeAll(async () => {
    access = new AccessCredentialService(
      { validate } as unknown as SessionService,
      {
        ...generateKeyPairSync('rsa', { modulusLength: 2048 }),
        issuer: 'nina-test',
        audience: 'nina-test-browser',
        lifetimeSeconds: 60,
      },
    );
    const module = await Test.createTestingModule({}).compile();
    app = module.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    app.use((req: Request, res: Response, next: () => void) => {
      if (req.path === PATH.LOGOUT) {
        const setHeader = res.setHeader.bind(res);
        res.setHeader = (...args: Parameters<Response['setHeader']>) => {
          if (args[0].toLowerCase() === 'set-cookie') events.push('clear-pair');
          return setHeader(...args);
        };
      }
      next();
    });
    app.use(
      PATH.LOGIN,
      createBrowserLoginHandler(
        { creation: { create }, access: { issue }, sessions: { revoke } },
        config,
      ),
    );
    app.use(
      PATH.REFRESH,
      createBrowserRefreshHandler(
        { rotation: { rotate }, access: { issue } },
        config,
      ),
    );
    app.use(
      PATH.LOGOUT,
      createBrowserLogoutHandler(
        { refresh: { revoke: revokeRefresh }, sessions: { revoke }, access },
        config,
      ),
    );
    app.use((_req: Request, res: Response) => {
      downstream++;
      res.status(599).end();
    });
    await app.init();
    await app.listen(0, '127.0.0.1');
    port = (app.getHttpServer().address() as AddressInfo).port;
  });

  beforeEach(() => {
    sessions.clear();
    refreshes.clear();
    events = [];
    downstream = 0;
    revocationGate = undefined;
    revocationEntered = deferred<void>();
    username = randomBytes(12).toString('hex');
    password = randomBytes(24).toString('base64url');
    account = { id: randomUUID(), username, role: 'STUDENT', authVersion: 2 };
    create.mockReset().mockImplementation(async (user, secret, expiresAt) => {
      if (user !== username || secret !== password || expiresAt !== null)
        return null;
      const created: CreatedSession = {
        id: randomUUID(),
        account,
        expiresAt: null,
        refreshToken: randomBytes(32).toString('base64url'),
      };
      const session = { created, revoked: false };
      sessions.set(created.id, session);
      refreshes.set(created.refreshToken, { session, consumed: false });
      return created;
    });
    validate.mockReset().mockImplementation(async (id, owner, version) => {
      const state = typeof id === 'string' ? sessions.get(id) : undefined;
      return state &&
        !state.revoked &&
        owner === account.id &&
        version === account.authVersion
        ? account
        : null;
    });
    revoke.mockReset().mockImplementation(async (id, owner) => {
      const state = typeof id === 'string' ? sessions.get(id) : undefined;
      if (!state || owner !== account.id) return false;
      state.revoked = true;
      return true;
    });
    rotate.mockReset().mockImplementation(async (token) => {
      const state =
        typeof token === 'string' ? refreshes.get(token) : undefined;
      if (!state || state.consumed || state.session.revoked) return null;
      state.consumed = true;
      return successor(state.session);
    });
    revokeRefresh.mockReset().mockImplementation(async (token, binding) => {
      const state =
        typeof token === 'string' ? refreshes.get(token) : undefined;
      if (!state || state.consumed || state.session.revoked) return false;
      if (
        binding &&
        (binding.sessionId !== state.session.created.id ||
          binding.account.id !== account.id ||
          binding.account.authVersion !== account.authVersion)
      )
        return false;
      events.push('revoke-entered');
      revocationEntered.resolve();
      if (revocationGate && !(await revocationGate.promise)) return false;
      state.consumed = true;
      state.session.revoked = true;
      events.push('revoked');
      return true;
    });
    issue.mockReset().mockImplementation((...args) => access.issue(...args));
  });

  afterEach(() => {
    revocationGate?.resolve(false);
    for (const client of clients) client.destroy();
    clients.clear();
    jest.restoreAllMocks();
  });
  afterAll(async () => app?.close());

  it('shares login, rotation, replay denial and revocation while another session stays independent', async () => {
    const initial = pair(await send(PATH.LOGIN));
    const other = pair(await send(PATH.LOGIN));
    const binding = await access.verifySession(initial.access);
    expect(binding).not.toBeNull();
    expect(create).toHaveBeenNthCalledWith(1, username, password, null);
    const rotated = pair(await send(PATH.REFRESH, initial.cookie));
    expect(rotated.refresh).not.toBe(initial.refresh);
    expect(refreshes.get(initial.refresh)?.consumed).toBe(true);
    expect(refreshes.get(rotated.refresh)?.consumed).toBe(false);
    expect(await access.verifySession(rotated.access)).toEqual(binding);
    const issued = issue.mock.calls.length;
    const validated = validate.mock.calls.length;
    responseContract(await send(PATH.REFRESH, initial.cookie), 401);
    expect(validate).toHaveBeenCalledTimes(validated);
    responseContract(await send(PATH.LOGOUT, initial.cookie), 401);
    expect(rotate).toHaveBeenCalledTimes(2);
    expect(revokeRefresh).toHaveBeenCalledTimes(1);
    expect(revokeRefresh).toHaveBeenLastCalledWith(initial.refresh, binding);
    expect(revoke).not.toHaveBeenCalled();
    expect(issue).toHaveBeenCalledTimes(issued);
    expect(events).toEqual([]);
    expect(sessions.get(binding!.sessionId)?.revoked).toBe(false);
    expect(refreshes.get(rotated.refresh)?.consumed).toBe(false);
    expect(refreshes.get(other.refresh)?.consumed).toBe(false);
    expect(await access.verify(other.access)).toEqual(account);

    const loggedOut = await send(PATH.LOGOUT, rotated.cookie);
    responseContract(loggedOut, 204);
    expect(loggedOut.headers['set-cookie']).toHaveLength(2);
    expect(events).toEqual(['revoke-entered', 'revoked', 'clear-pair']);
    expect(await access.verify(initial.access)).toBeNull();
    expect(await access.verify(rotated.access)).toBeNull();
    responseContract(await send(PATH.REFRESH, rotated.cookie), 401);
    responseContract(await send(PATH.LOGOUT, rotated.cookie), 401);
    responseContract(
      await send(PATH.LOGOUT, `__Host-nina-access=${rotated.access}`),
      401,
    );
    expect(revoke).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(2);
    const independent = pair(await send(PATH.REFRESH, other.cookie));
    expect(await access.verify(independent.access)).toEqual(account);
    expect(refreshes.get(independent.refresh)?.session.revoked).toBe(false);
    expect(events.filter((event) => event === 'clear-pair')).toHaveLength(1);
  });

  it.each(['missing', 'expired'])(
    'logs out with %s access and current refresh, clearing only after settlement',
    async (mode) => {
      const current = pair(await send(PATH.LOGIN));
      if (mode === 'expired') {
        const later = Date.now() + 61000;
        jest.spyOn(Date, 'now').mockReturnValue(later);
        expect(await access.verify(current.access)).toBeNull();
      }
      revocationGate = deferred<boolean>();
      const cookie =
        mode === 'missing'
          ? `__Host-nina-refresh=${current.refresh}`
          : current.cookie;
      const pending = send(PATH.LOGOUT, cookie);
      await revocationEntered.promise;
      expect(events).toEqual(['revoke-entered']);
      expect(refreshes.get(current.refresh)?.consumed).toBe(false);
      revocationGate.resolve(true);
      const result = await pending;
      responseContract(result, 204);
      expect(events).toEqual(['revoke-entered', 'revoked', 'clear-pair']);
      expect(revokeRefresh).toHaveBeenCalledTimes(1);
      expect(revokeRefresh).toHaveBeenCalledWith(current.refresh);
      expect(result.headers['set-cookie']).toEqual([
        '__Host-nina-access=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
        '__Host-nina-refresh=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      ]);
      expect(create).toHaveBeenCalledTimes(1);
      expect(issue).toHaveBeenCalledTimes(1);
      expect(rotate).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      responseContract(await send(PATH.LOGOUT, cookie), 401);
      expect(revokeRefresh).toHaveBeenCalledTimes(2);
    },
  );

  it('does not clear, renew, retry or fall back after nonaffirmative refresh revocation', async () => {
    const current = pair(await send(PATH.LOGIN));
    revocationGate = deferred<boolean>();
    const pending = send(PATH.LOGOUT, current.cookie);
    await revocationEntered.promise;
    revocationGate.resolve(false);
    responseContract(await pending, 401);
    expect(events).toEqual(['revoke-entered']);
    expect(revokeRefresh).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
    expect(rotate).not.toHaveBeenCalled();
    expect(issue).toHaveBeenCalledTimes(1);
    expect(await access.verify(current.access)).toEqual(account);
    expect(refreshes.get(current.refresh)?.consumed).toBe(false);
  });

  describe.each(Object.values(PATH))(
    '%s admission with shared services',
    (path) => {
      it.each([
        { Origin: 'https://untrusted.test' },
        { 'X-NINA-CSRF-Protection': undefined },
      ])('denies %j before session effects', async (headers) => {
        const current = pair(await send(PATH.LOGIN));
        const counts = [
          create.mock.calls.length,
          issue.mock.calls.length,
          validate.mock.calls.length,
        ];
        responseContract(await send(path, current.cookie, headers), 403);
        expect([
          create.mock.calls.length,
          issue.mock.calls.length,
          validate.mock.calls.length,
        ]).toEqual(counts);
        expect(rotate).not.toHaveBeenCalled();
        expect(revokeRefresh).not.toHaveBeenCalled();
        expect(revoke).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        expect(refreshes.get(current.refresh)?.consumed).toBe(false);
      });
    },
  );
});
