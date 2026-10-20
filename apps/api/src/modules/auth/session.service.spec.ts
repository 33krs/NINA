import { Prisma, UserRole } from '@prisma/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedAccount } from './credential-authentication.service';
import { SessionService } from './session.service';

const owner = 'a24e8a50-0cf1-4e7a-8d60-c504a9025c8d';
const id = 'b24e8a50-0cf1-4e7a-8d60-c504a9025c8d';
const other = 'c24e8a50-0cf1-4e7a-8d60-c504a9025c8d';
const now = new Date('2030-01-01T12:00:00.000Z');
const expiry = new Date('2030-01-02T12:00:00.000Z');
const identity: AuthenticatedAccount = {
  id: owner,
  username: 'synthetic.user',
  role: UserRole.STUDENT,
  authVersion: 2,
};
const currentAccount = { ...identity, isActive: true };

interface SessionRow {
  userId: string;
  authVersion: number;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  user: typeof currentAccount;
}

function session(extra: Partial<SessionRow> = {}): SessionRow {
  return {
    userId: owner,
    authVersion: 2,
    createdAt: new Date(now.getTime() - 1000),
    expiresAt: expiry,
    revokedAt: null,
    user: currentAccount,
    ...extra,
  };
}

const options = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  maxWait: 2000,
  timeout: 5000,
};

describe('unregistered session validation', () => {
  const tx = {
    authSession: {
      findUnique: jest.fn<(query: unknown) => Promise<SessionRow | null>>(),
      updateMany: jest.fn<(query: unknown) => Promise<{ count: number }>>(),
    },
  };
  const prisma = {
    $transaction:
      jest.fn<
        (
          callback: (client: typeof tx) => Promise<unknown>,
          options: unknown,
        ) => Promise<unknown>
      >(),
  };
  let service: SessionService;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    tx.authSession.findUnique.mockResolvedValue(session());
    tx.authSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    service = new SessionService(prisma as unknown as PrismaService);
  });
  afterEach(() => {
    jest.useRealTimers();
    expect(tx.authSession.updateMany).not.toHaveBeenCalled();
  });

  it('validates in a consistent bounded snapshot and returns current role, not issued privileges', async () => {
    tx.authSession.findUnique.mockResolvedValue(
      session({ user: { ...currentAccount, role: UserRole.ADMIN } }),
    );
    await expect(service.validate(id, owner, 2)).resolves.toEqual({
      ...identity,
      role: UserRole.ADMIN,
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      options,
    );
    expect(tx.authSession.findUnique).toHaveBeenCalledWith({
      where: { id },
      select: {
        userId: true,
        authVersion: true,
        createdAt: true,
        expiresAt: true,
        revokedAt: true,
        user: {
          select: {
            id: true,
            username: true,
            role: true,
            isActive: true,
            authVersion: true,
          },
        },
      },
    });
  });

  it.each([
    ['', owner, 2],
    [id, '', 2],
    [id, owner, -1],
    [id, owner, 2.5],
    [id, owner, Infinity],
    [id, owner, 2147483648],
    [id, owner, '2'],
    [`${id}\n`, owner, 2],
    [id, owner.toUpperCase(), 2],
  ])(
    'rejects malformed internal claims before database access: %p %p %p',
    async (sessionId, ownerId, version) => {
      await expect(
        service.validate(sessionId, ownerId, version),
      ).resolves.toBeNull();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  const denied: Array<[string, SessionRow | null]> = [
    ['missing', null],
    ['wrong owner', session({ userId: other })],
    ['wrong issued version', session({ authVersion: 3 })],
    [
      'wrong joined account',
      session({ user: { ...currentAccount, id: other } }),
    ],
    [
      'disabled account',
      session({ user: { ...currentAccount, isActive: false } }),
    ],
    [
      'changed account version',
      session({ user: { ...currentAccount, authVersion: 3 } }),
    ],
    ['revoked', session({ revokedAt: now })],
    ['expiry boundary', session({ expiresAt: now })],
    ['expired', session({ expiresAt: new Date(now.getTime() - 1) })],
    ['future creation', session({ createdAt: expiry })],
    ['invalid creation', session({ createdAt: new Date(NaN) })],
    ['invalid expiry', session({ expiresAt: new Date(NaN) })],
  ];
  it.each(denied)('denies %s session state', async (_name, saved) => {
    tx.authSession.findUnique.mockResolvedValue(saved);
    await expect(service.validate(id, owner, 2)).resolves.toBeNull();
  });

  it('denies validation when expiration passes during transaction settlement', async () => {
    prisma.$transaction.mockImplementation(async (callback) => {
      const result = await callback(tx);
      jest.setSystemTime(expiry);
      return result;
    });
    await expect(service.validate(id, owner, 2)).resolves.toBeNull();
    expect(tx.authSession.findUnique).toHaveBeenCalledTimes(1);
  });

  const operations = [
    {
      name: 'validation',
      invoke: () => service.validate(id, owner, 2),
      success: identity,
      denied: null,
      failures: ['lookup', 'transaction', 'commit'],
    },
  ];
  describe.each(operations)(
    '$name transaction settlement',
    ({ invoke, success, denied, failures }) => {
      it('awaits commit before confirming success', async () => {
        let release!: () => void;
        let entered!: () => void;
        const committed = new Promise<void>((resolve) => {
          release = resolve;
        });
        const callbackFinished = new Promise<void>((resolve) => {
          entered = resolve;
        });
        prisma.$transaction.mockImplementation(async (callback) => {
          const result = await callback(tx);
          entered();
          await committed;
          return result;
        });
        let resolved = false;
        const pending = invoke().then((result) => {
          resolved = true;
          return result;
        });
        await Promise.race([callbackFinished, pending]);
        expect(resolved).toBe(false);
        release();
        await expect(pending).resolves.toEqual(success);
      });

      it.each(failures)(
        'denies %s failure without retry',
        async (dependency) => {
          const error = new Error('synthetic private diagnostic');
          if (dependency === 'lookup')
            tx.authSession.findUnique.mockRejectedValue(error);
          if (dependency === 'transaction')
            prisma.$transaction.mockRejectedValue(error);
          if (dependency === 'commit')
            prisma.$transaction.mockImplementation(async (callback) => {
              await callback(tx);
              throw error;
            });
          await expect(invoke()).resolves.toBe(denied);
          expect(prisma.$transaction).toHaveBeenCalledTimes(1);
          expect(
            tx.authSession.findUnique.mock.calls.length,
          ).toBeLessThanOrEqual(1);
          expect(tx.authSession.updateMany).not.toHaveBeenCalled();
        },
      );
    },
  );
});

describe('unregistered owner-scoped session revocation', () => {
  const saved: Pick<SessionRow, 'userId' | 'createdAt' | 'revokedAt'> = {
    userId: owner,
    createdAt: new Date(now.getTime() - 1000),
    revokedAt: null,
  };
  const tx = {
    authSession: {
      findUnique: jest.fn<(query: unknown) => Promise<typeof saved | null>>(),
      updateMany: jest.fn<(query: unknown) => Promise<{ count: number }>>(),
    },
  };
  const prisma = {
    $transaction:
      jest.fn<
        (
          callback: (client: typeof tx) => Promise<boolean>,
          options: unknown,
        ) => Promise<boolean>
      >(),
  };
  let service: SessionService;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    tx.authSession.findUnique.mockResolvedValue(saved);
    tx.authSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    service = new SessionService(prisma as unknown as PrismaService);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('conditionally revokes only the owned session and preserves the first timestamp on repeat', async () => {
    await expect(service.revoke(id, owner)).resolves.toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      options,
    );
    expect(tx.authSession.findUnique).toHaveBeenCalledWith({
      where: { id },
      select: { userId: true, createdAt: true, revokedAt: true },
    });
    expect(tx.authSession.updateMany).toHaveBeenCalledWith({
      where: { id, userId: owner, revokedAt: null },
      data: { revokedAt: now },
    });
    tx.authSession.findUnique.mockResolvedValue({ ...saved, revokedAt: now });
    jest.setSystemTime(expiry);
    await expect(service.revoke(id, owner)).resolves.toBe(true);
    expect(tx.authSession.updateMany).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, '', id.toUpperCase(), `${id}\n`, 1])(
    'rejects malformed session or owner ID before database access: %p',
    async (malformed) => {
      await expect(service.revoke(malformed, owner)).resolves.toBe(false);
      await expect(service.revoke(id, malformed)).resolves.toBe(false);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    { ...saved, userId: other },
    { ...saved, userId: other, revokedAt: now },
  ])(
    'does not write or confirm missing/foreign sessions, including revoked rows',
    async (row) => {
      tx.authSession.findUnique.mockResolvedValue(row);
      await expect(service.revoke(id, owner)).resolves.toBe(false);
      expect(tx.authSession.updateMany).not.toHaveBeenCalled();
    },
  );

  it('confirms an already-revoked owned session without rewriting its timestamp', async () => {
    tx.authSession.findUnique.mockResolvedValue({ ...saved, revokedAt: now });
    await expect(service.revoke(id, owner)).resolves.toBe(true);
    expect(tx.authSession.updateMany).not.toHaveBeenCalled();
  });

  it('clamps the timestamp to creation if the wall clock moves backward', async () => {
    jest.setSystemTime(new Date(saved.createdAt.getTime() - 1000));
    await expect(service.revoke(id, owner)).resolves.toBe(true);
    expect(tx.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { revokedAt: saved.createdAt } }),
    );
  });

  it('denies malformed persisted creation without attempting a write', async () => {
    tx.authSession.findUnique.mockResolvedValue({
      ...saved,
      createdAt: new Date(NaN),
    });
    await expect(service.revoke(id, owner)).resolves.toBe(false);
    expect(tx.authSession.updateMany).not.toHaveBeenCalled();
  });

  it.each([0, 2])(
    'denies a conditional update count of %p without retry',
    async (count) => {
      tx.authSession.updateMany.mockResolvedValue({ count });
      await expect(service.revoke(id, owner)).resolves.toBe(false);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.authSession.updateMany).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['lookup', 'write', 'transaction', 'commit'])(
    'denies %s errors without retry or diagnostic disclosure',
    async (dependency) => {
      const diagnostics = [
        jest.spyOn(globalThis.console, 'log'),
        jest.spyOn(globalThis.console, 'warn'),
        jest.spyOn(globalThis.console, 'error'),
      ];
      const error = new Error('synthetic private diagnostic');
      if (dependency === 'lookup')
        tx.authSession.findUnique.mockRejectedValue(error);
      if (dependency === 'write')
        tx.authSession.updateMany.mockRejectedValue(error);
      if (dependency === 'transaction')
        prisma.$transaction.mockRejectedValue(error);
      if (dependency === 'commit')
        prisma.$transaction.mockImplementation(async (callback) => {
          await callback(tx);
          throw error;
        });
      await expect(service.revoke(id, owner)).resolves.toBe(false);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.authSession.findUnique.mock.calls.length).toBeLessThanOrEqual(
        1,
      );
      expect(tx.authSession.updateMany.mock.calls.length).toBeLessThanOrEqual(
        1,
      );
      if (dependency === 'commit')
        expect(tx.authSession.updateMany).toHaveBeenCalledTimes(1);
      for (const diagnostic of diagnostics)
        expect(diagnostic).not.toHaveBeenCalled();
    },
  );

  it.each([null, now])(
    'waits for commit before confirming revocation state %p',
    async (revokedAt) => {
      tx.authSession.findUnique.mockResolvedValue({ ...saved, revokedAt });
      let release!: () => void;
      let entered!: () => void;
      const committed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const callbackFinished = new Promise<void>((resolve) => {
        entered = resolve;
      });
      prisma.$transaction.mockImplementation(async (callback) => {
        const result = await callback(tx);
        entered();
        await committed;
        return result;
      });
      let resolved = false;
      const pending = service.revoke(id, owner).then((result) => {
        resolved = true;
        return result;
      });
      await Promise.race([callbackFinished, pending]);
      expect(resolved).toBe(false);
      release();
      await expect(pending).resolves.toBe(true);
    },
  );
});
