import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
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
import { RefreshRotationService } from './refresh-rotation.service';

jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof import('node:crypto')>('node:crypto'),
  randomBytes: jest.fn(),
}));
const random = randomBytes as unknown as jest.MockedFunction<
  (size: number) => Buffer
>;
const raw = Buffer.alloc(32, 5).toString('base64url');
const successor = Buffer.alloc(32, 7).toString('base64url');
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const now = new Date('2030-01-01T12:00:00.000Z');
const expiry = new Date('2030-01-02T12:00:00.000Z');
const id = 'b24e8a50-0cf1-4e7a-8d60-c504a9025c8d';
const identity: AuthenticatedAccount = {
  id: 'a24e8a50-0cf1-4e7a-8d60-c504a9025c8d',
  username: 'synthetic.user',
  role: UserRole.INSTRUCTOR,
  authVersion: 2,
};
interface Account extends AuthenticatedAccount {
  isActive: boolean;
}
interface SessionRow {
  id: string;
  userId: string;
  authVersion: number;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  user: Account;
}
interface TokenRow {
  id: string;
  sessionId: string;
  createdAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
  session: SessionRow;
}
function persisted(): TokenRow {
  return {
    id: 'd24e8a50-0cf1-4e7a-8d60-c504a9025c8d',
    sessionId: id,
    createdAt: new Date(now.getTime() - 500),
    expiresAt: expiry,
    consumedAt: null,
    session: {
      id,
      userId: identity.id,
      authVersion: 2,
      createdAt: new Date(now.getTime() - 1000),
      expiresAt: expiry,
      revokedAt: null,
      user: { ...identity, isActive: true },
    },
  };
}

describe('unregistered internal refresh rotation without automatic revocation', () => {
  const forbidden = jest.fn<() => never>();
  const forbiddenWrites = {
    create: forbidden,
    update: forbidden,
    updateMany: forbidden,
    upsert: forbidden,
    delete: forbidden,
    deleteMany: forbidden,
  };
  const tx = {
    user: forbiddenWrites,
    authSession: forbiddenWrites,
    refreshToken: {
      findUnique: jest.fn<(query: unknown) => Promise<TokenRow | null>>(),
      updateMany: jest.fn<(query: unknown) => Promise<{ count: number }>>(),
      create: jest.fn<(query: unknown) => Promise<{ id: string }>>(),
      update: forbidden,
      upsert: forbidden,
      delete: forbidden,
      deleteMany: forbidden,
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
  let service: RefreshRotationService;
  let log: jest.SpiedFunction<typeof globalThis.console.log>;
  let warn: jest.SpiedFunction<typeof globalThis.console.warn>;
  let error: jest.SpiedFunction<typeof globalThis.console.error>;
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    forbidden.mockImplementation(() => {
      throw new Error('Forbidden persistence mutation');
    });
    log = jest.spyOn(globalThis.console, 'log');
    warn = jest.spyOn(globalThis.console, 'warn');
    error = jest.spyOn(globalThis.console, 'error');
    random.mockReturnValue(Buffer.alloc(32, 7));
    tx.refreshToken.findUnique.mockResolvedValue(persisted());
    tx.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    tx.refreshToken.create.mockResolvedValue({ id: 'synthetic-successor-row' });
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    service = new RefreshRotationService(prisma as unknown as PrismaService);
  });
  afterEach(() => {
    try {
      expect(forbidden).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });

  it('atomically consumes by row/session and stores one digest-only same-expiry successor', async () => {
    await expect(service.rotate(raw)).resolves.toEqual({
      id,
      account: identity,
      expiresAt: expiry,
      refreshToken: successor,
    });
    expect(random).toHaveBeenCalledWith(32);
    expect(tx.refreshToken.findUnique).toHaveBeenCalledWith({
      where: { tokenHash: digest(raw) },
      select: {
        id: true,
        sessionId: true,
        createdAt: true,
        expiresAt: true,
        consumedAt: true,
        session: {
          select: {
            id: true,
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
        },
      },
    });
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { id: persisted().id, sessionId: id, consumedAt: null },
      data: { consumedAt: now },
    });
    expect(tx.refreshToken.create).toHaveBeenCalledWith({
      data: {
        sessionId: id,
        tokenHash: digest(successor),
        createdAt: now,
        expiresAt: expiry,
      },
      select: { id: true },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 2000,
      timeout: 5000,
    });
    expect(tx.refreshToken.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.refreshToken.create.mock.invocationCallOrder[0],
    );
    const persistedCalls = JSON.stringify([
      tx.refreshToken.findUnique.mock.calls,
      tx.refreshToken.updateMany.mock.calls,
      tx.refreshToken.create.mock.calls,
    ]);
    expect(persistedCalls).not.toContain(raw);
    expect(persistedCalls).not.toContain(successor);
  });

  it.each([
    undefined,
    null,
    1,
    '',
    `${raw}=`,
    `${raw}\n`,
    raw.slice(1),
    `${raw.slice(0, -1)}B`,
    '!'.repeat(43),
  ])(
    'rejects malformed/noncanonical input before database work: %p',
    async (input) => {
      await expect(service.rotate(input)).resolves.toBeNull();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    },
  );

  it('denies a missing digest without attempting consumption or insertion', async () => {
    tx.refreshToken.findUnique.mockResolvedValue(null);
    await expect(service.rotate(raw)).resolves.toBeNull();
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    expect(tx.refreshToken.create).not.toHaveBeenCalled();
  });

  const denials: Array<[string, (row: TokenRow) => void]> = [
    [
      'consumed reuse',
      (row) => {
        row.consumedAt = now;
      },
    ],
    [
      'wrong joined session',
      (row) => {
        row.sessionId = identity.id;
      },
    ],
    [
      'wrong joined owner',
      (row) => {
        row.session.userId = id;
      },
    ],
    [
      'inactive account',
      (row) => {
        row.session.user.isActive = false;
      },
    ],
    [
      'version mismatch',
      (row) => {
        row.session.user = { ...row.session.user, authVersion: 3 };
      },
    ],
    [
      'negative version',
      (row) => {
        row.session.authVersion = -1;
        row.session.user = { ...row.session.user, authVersion: -1 };
      },
    ],
    [
      'fractional version',
      (row) => {
        row.session.authVersion = 2.5;
        row.session.user = { ...row.session.user, authVersion: 2.5 };
      },
    ],
    [
      'out-of-range version',
      (row) => {
        row.session.authVersion = 2147483648;
        row.session.user = { ...row.session.user, authVersion: 2147483648 };
      },
    ],
    [
      'revoked session',
      (row) => {
        row.session.revokedAt = now;
      },
    ],
    [
      'expired boundary',
      (row) => {
        row.expiresAt = row.session.expiresAt = now;
      },
    ],
    [
      'expiry mismatch',
      (row) => {
        row.expiresAt = new Date(expiry.getTime() - 1);
      },
    ],
    [
      'invalid token creation',
      (row) => {
        row.createdAt = new Date(NaN);
      },
    ],
    [
      'invalid session creation',
      (row) => {
        row.session.createdAt = new Date(NaN);
      },
    ],
    [
      'invalid token expiry',
      (row) => {
        row.expiresAt = new Date(NaN);
      },
    ],
    [
      'invalid session expiry',
      (row) => {
        row.session.expiresAt = new Date(NaN);
      },
    ],
    [
      'future token creation',
      (row) => {
        row.createdAt = expiry;
      },
    ],
    [
      'future session creation',
      (row) => {
        row.session.createdAt = expiry;
      },
    ],
    [
      'token predates session',
      (row) => {
        row.createdAt = new Date(row.session.createdAt.getTime() - 1);
      },
    ],
  ];
  it.each(denials)(
    'denies %s without writes or recovery issuance',
    async (_name, change) => {
      const row = persisted();
      change(row);
      tx.refreshToken.findUnique.mockResolvedValue(row);
      await expect(service.rotate(raw)).resolves.toBeNull();
      expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(tx.refreshToken.create).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.refreshToken.findUnique).toHaveBeenCalledTimes(1);
    },
  );

  it.each([0, 2])(
    'denies conditional consumption count %p without a successor or retry',
    async (count) => {
      tx.refreshToken.updateMany.mockResolvedValue({ count });
      await expect(service.rotate(raw)).resolves.toBeNull();
      expect(tx.refreshToken.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.refreshToken.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['random', 'lookup', 'consume', 'insert', 'transaction', 'commit'])(
    'denies %s failure without retry, leaked material or automatic revocation',
    async (dependency) => {
      const failure = new Error('synthetic private diagnostic');
      if (dependency === 'random')
        random.mockImplementation(() => {
          throw failure;
        });
      if (dependency === 'lookup')
        tx.refreshToken.findUnique.mockRejectedValue(failure);
      if (dependency === 'consume')
        tx.refreshToken.updateMany.mockRejectedValue(failure);
      if (dependency === 'insert')
        tx.refreshToken.create.mockRejectedValue(failure);
      if (dependency === 'transaction')
        prisma.$transaction.mockRejectedValue(failure);
      if (dependency === 'commit')
        prisma.$transaction.mockImplementation(async (callback) => {
          await callback(tx);
          throw failure;
        });
      await expect(service.rotate(raw)).resolves.toBeNull();
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.refreshToken.findUnique.mock.calls.length).toBeLessThanOrEqual(
        1,
      );
      expect(tx.refreshToken.updateMany.mock.calls.length).toBeLessThanOrEqual(
        1,
      );
      expect(tx.refreshToken.create.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );

  it('denies material if expiration passes while committing', async () => {
    prisma.$transaction.mockImplementation(async (callback) => {
      const result = await callback(tx);
      jest.setSystemTime(expiry);
      return result;
    });
    await expect(service.rotate(raw)).resolves.toBeNull();
    expect(tx.refreshToken.create).toHaveBeenCalledTimes(1);
  });

  it('does not resolve raw successor material before commit', async () => {
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
    const pending = service.rotate(raw).then((result) => {
      resolved = true;
      return result;
    });
    await Promise.race([callbackFinished, pending]);
    expect(resolved).toBe(false);
    release();
    expect((await pending)?.refreshToken).toBe(successor);
  });
});
