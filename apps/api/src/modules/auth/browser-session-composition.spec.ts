import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import * as prismaModule from '../../prisma/prisma.service';
import { Server, Socket } from 'node:net';
import console from 'node:console';
import { AccessCredentialService } from './access-credential.service';
import { CredentialAuthenticationService } from './credential-authentication.service';
import { SessionService } from './session.service';
import { SessionCreationService } from './session-creation.service';
import { RefreshRotationService } from './refresh-rotation.service';
import { RefreshSessionRevocationService } from './refresh-session-revocation.service';
import * as loginModule from './browser-login.handler';
import * as refreshModule from './browser-refresh.handler';
import * as logoutModule from './browser-logout.handler';
import {
  createBrowserSessionHandlers,
  type BrowserSessionCompositionConfig,
} from './browser-session-composition';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = {
  id: '10000000-0000-4000-8000-000000000001',
  username: 'composition-fixture',
  role: 'STUDENT' as const,
  authVersion: 3,
};
const sessionId = '20000000-0000-4000-8000-000000000002';

function config(): BrowserSessionCompositionConfig {
  return {
    attemptPolicy: {
      windowMs: 60_000,
      maxAttemptsPerUsername: 20,
      maxAttemptsGlobal: 20,
      maxTrackedUsernames: 20,
    },
    canonicalOrigin: 'https://nina.example',
    jsonLimits: { maxBytes: 2048, readTimeoutMs: 1000 },
    cookieConfig: { accessMaxAgeSeconds: 60, refreshMaxAgeSeconds: 3600 },
    accessCredentialConfig: {
      ...keys,
      issuer: 'composition-fixture',
      audience: 'composition-browser',
      lifetimeSeconds: 60,
    },
  };
}

function fixture() {
  const database = {
    $transaction: jest
      .fn<() => Promise<unknown>>()
      .mockRejectedValue(new Error('No database')),
    user: { findUnique: jest.fn<() => Promise<unknown>>() },
  };
  const prisma = database as unknown as PrismaService;
  const login: RequestHandler = jest.fn();
  const refresh: RequestHandler = jest.fn();
  const logout: RequestHandler = jest.fn();
  const loginFactory = jest
    .spyOn(loginModule, 'createBrowserLoginHandler')
    .mockReturnValue(login);
  const refreshFactory = jest
    .spyOn(refreshModule, 'createBrowserRefreshHandler')
    .mockReturnValue(refresh);
  const logoutFactory = jest
    .spyOn(logoutModule, 'createBrowserLogoutHandler')
    .mockReturnValue(logout);
  const settings = config();
  const handlers = createBrowserSessionHandlers(prisma, settings);
  return {
    database,
    prisma,
    settings,
    handlers,
    login,
    refresh,
    logout,
    loginFactory,
    refreshFactory,
    logoutFactory,
  };
}

afterEach(() => jest.restoreAllMocks());

describe('inactive browser session composition', () => {
  it('returns the existing handlers with one complete, shared real service graph', () => {
    const f = fixture();
    expect(f.handlers).toEqual({
      login: f.login,
      refresh: f.refresh,
      logout: f.logout,
    });
    expect(f.loginFactory).toHaveBeenCalledTimes(1);
    expect(f.refreshFactory).toHaveBeenCalledTimes(1);
    expect(f.logoutFactory).toHaveBeenCalledTimes(1);
    const [login, loginConfig] = f.loginFactory.mock.calls[0];
    const [refresh, refreshConfig] = f.refreshFactory.mock.calls[0];
    const [logout, logoutConfig] = f.logoutFactory.mock.calls[0];
    expect(login.creation).toBeInstanceOf(SessionCreationService);
    expect(login.sessions).toBeInstanceOf(SessionService);
    expect(login.access).toBeInstanceOf(AccessCredentialService);
    expect(refresh.rotation).toBeInstanceOf(RefreshRotationService);
    expect(logout.refresh).toBeInstanceOf(RefreshSessionRevocationService);
    expect(refresh.access).toBe(login.access);
    expect(logout.access).toBe(login.access);
    expect(logout.sessions).toBe(login.sessions);
    expect(loginConfig).toBe(f.settings);
    expect(loginConfig.attemptPolicy).toBe(f.settings.attemptPolicy);
    expect(refreshConfig).toBe(f.settings);
    expect(logoutConfig).toBe(f.settings);
    expect(f.database.$transaction).not.toHaveBeenCalled();
    expect(f.database.user.findUnique).not.toHaveBeenCalled();
  });

  it('connects creation to real credentials and every database service to the supplied client', async () => {
    const f = fixture();
    const [login] = f.loginFactory.mock.calls[0];
    const [refresh] = f.refreshFactory.mock.calls[0];
    const [logout] = f.logoutFactory.mock.calls[0];
    const authenticate = jest
      .spyOn(CredentialAuthenticationService.prototype, 'authenticate')
      .mockResolvedValue(account);
    const password = randomBytes(24).toString('base64url');
    const created = {
      id: sessionId,
      account,
      expiresAt: null,
      refreshToken: randomBytes(32).toString('base64url'),
    };
    f.database.$transaction.mockResolvedValueOnce(created);
    await expect(
      login.creation.create(account.username, password, null),
    ).resolves.toEqual(created);
    expect(authenticate).toHaveBeenCalledWith(account.username, password);
    expect(authenticate).toHaveBeenCalledTimes(1);
    const credentials = authenticate.mock.contexts[0];
    expect(credentials).toBeInstanceOf(CredentialAuthenticationService);
    if (!(credentials instanceof CredentialAuthenticationService))
      throw new Error('Missing credential service');
    authenticate.mockRestore();
    f.database.user.findUnique.mockRejectedValueOnce(new Error('No database'));
    await expect(
      credentials.authenticate(account.username, password),
    ).resolves.toBeNull();
    expect(f.database.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { username: account.username },
      }),
    );
    expect(f.database.$transaction).toHaveBeenCalledTimes(1);

    // These settlement stubs prove client wiring, not execution of database callbacks.
    f.database.$transaction.mockResolvedValueOnce(created);
    await expect(
      refresh.rotation.rotate(created.refreshToken),
    ).resolves.toEqual(created);
    expect(f.database.$transaction).toHaveBeenCalledTimes(2);
    f.database.$transaction.mockResolvedValueOnce(true);
    await expect(logout.refresh.revoke(created.refreshToken)).resolves.toBe(
      true,
    );
    expect(f.database.$transaction).toHaveBeenCalledTimes(3);
    f.database.$transaction.mockResolvedValueOnce(true);
    await expect(login.sessions.revoke(sessionId, account.id)).resolves.toBe(
      true,
    );
    expect(f.database.$transaction).toHaveBeenCalledTimes(4);
  });

  it('uses the shared online session validator for issuance and logout verification', async () => {
    const f = fixture();
    const [login] = f.loginFactory.mock.calls[0];
    const [logout] = f.logoutFactory.mock.calls[0];
    const validate = jest
      .spyOn(SessionService.prototype, 'validate')
      .mockResolvedValue(account);
    const token = await login.access.issue(
      sessionId,
      account.id,
      account.authVersion,
    );
    expect(typeof token).toBe('string');
    await expect(logout.access.verifySession(token)).resolves.toEqual({
      sessionId,
      account,
    });
    expect(validate).toHaveBeenCalledTimes(2);
    expect(validate.mock.contexts).toEqual([login.sessions, login.sessions]);
    expect(validate).toHaveBeenNthCalledWith(
      1,
      sessionId,
      account.id,
      account.authVersion,
    );
    expect(validate).toHaveBeenNthCalledWith(
      2,
      sessionId,
      account.id,
      account.authVersion,
    );
    validate.mockRestore();
    f.database.$transaction.mockResolvedValueOnce({ account, expiresAt: null });
    await expect(
      login.access.issue(sessionId, account.id, account.authVersion),
    ).resolves.toEqual(expect.any(String));
    expect(f.database.$transaction).toHaveBeenCalledTimes(1);
  });

  it('constructs real handlers without touching the client, lifecycle, network or logs', () => {
    const touched = jest.fn<(property: string | symbol) => void>();
    const prisma = new Proxy({} as PrismaService, {
      get(_target, property) {
        touched(property);
        throw new Error('Client access during composition');
      },
    });
    const connect = jest.spyOn(PrismaService.prototype, '$connect');
    const disconnect = jest.spyOn(PrismaService.prototype, '$disconnect');
    const init = jest.spyOn(PrismaService.prototype, 'onModuleInit');
    const destroy = jest.spyOn(PrismaService.prototype, 'onModuleDestroy');
    const unexpected = () => {
      throw new Error('Unexpected composition side effect');
    };
    const construct = jest
      .spyOn(prismaModule, 'PrismaService')
      .mockImplementation(unexpected);
    const listen = jest
      .spyOn(Server.prototype, 'listen')
      .mockImplementation(unexpected);
    const network = jest
      .spyOn(Socket.prototype, 'connect')
      .mockImplementation(unexpected);
    const logs = [
      jest.spyOn(console, 'log'),
      jest.spyOn(console, 'info'),
      jest.spyOn(console, 'warn'),
      jest.spyOn(console, 'error'),
      jest.spyOn(console, 'debug'),
      jest.spyOn(console, 'trace'),
    ];
    const handlers = createBrowserSessionHandlers(prisma, config());
    expect(Object.keys(handlers)).toEqual(['login', 'refresh', 'logout']);
    for (const handler of Object.values(handlers))
      expect(typeof handler).toBe('function');
    for (const effect of [
      touched,
      construct,
      connect,
      disconnect,
      init,
      destroy,
      listen,
      network,
      ...logs,
    ]) {
      expect(effect).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['missing configuration', undefined],
    ['null configuration', null],
    ['missing login attempt policy', { ...config(), attemptPolicy: undefined }],
    [
      'invalid login attempt policy',
      {
        ...config(),
        attemptPolicy: { ...config().attemptPolicy, maxAttemptsGlobal: 0 },
      },
    ],
    ['missing origin', { ...config(), canonicalOrigin: undefined }],
    ['HTTP origin', { ...config(), canonicalOrigin: 'http://nina.example' }],
    [
      'origin with path',
      { ...config(), canonicalOrigin: 'https://nina.example/path' },
    ],
    ['missing JSON limits', { ...config(), jsonLimits: undefined }],
    [
      'zero byte limit',
      { ...config(), jsonLimits: { maxBytes: 0, readTimeoutMs: 1000 } },
    ],
    [
      'unbounded timeout',
      { ...config(), jsonLimits: { maxBytes: 2048, readTimeoutMs: Infinity } },
    ],
    ['missing cookie configuration', { ...config(), cookieConfig: undefined }],
    [
      'invalid cookie lifetime',
      {
        ...config(),
        cookieConfig: { accessMaxAgeSeconds: 901, refreshMaxAgeSeconds: 3600 },
      },
    ],
    [
      'missing RS256 configuration',
      { ...config(), accessCredentialConfig: undefined },
    ],
    [
      'missing private key',
      {
        ...config(),
        accessCredentialConfig: {
          ...config().accessCredentialConfig,
          privateKey: undefined,
        },
      },
    ],
    [
      'invalid access lifetime',
      {
        ...config(),
        accessCredentialConfig: {
          ...config().accessCredentialConfig,
          lifetimeSeconds: 0,
        },
      },
    ],
    [
      'missing issuer',
      {
        ...config(),
        accessCredentialConfig: {
          ...config().accessCredentialConfig,
          issuer: undefined,
        },
      },
    ],
    [
      'missing audience',
      {
        ...config(),
        accessCredentialConfig: {
          ...config().accessCredentialConfig,
          audience: undefined,
        },
      },
    ],
    [
      'mismatched keys',
      {
        ...config(),
        accessCredentialConfig: {
          ...config().accessCredentialConfig,
          publicKey: generateKeyPairSync('rsa', { modulusLength: 2048 })
            .publicKey,
        },
      },
    ],
  ])(
    'rejects %s with real primitive validation and no client access',
    (_label, input) => {
      const touched = jest.fn();
      const prisma = new Proxy({} as PrismaService, {
        get() {
          touched();
          throw new Error('Unexpected client access');
        },
      });
      expect(() =>
        createBrowserSessionHandlers(
          prisma,
          input as BrowserSessionCompositionConfig,
        ),
      ).toThrow();
      expect(touched).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing client instead of inventing a Prisma lifecycle', () => {
    expect(() =>
      createBrowserSessionHandlers(
        undefined as unknown as PrismaService,
        config(),
      ),
    ).toThrow();
  });
});
