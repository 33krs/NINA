import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { PrismaService } from '../../prisma/prisma.service';
import type { VerifiedAccessSession } from './access-credential.service';
import { RefreshSessionRevocationService } from './refresh-session-revocation.service';

jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof import('node:crypto')>('node:crypto'),
  randomBytes: jest.fn(),
}));
const raw = Buffer.alloc(32, 5).toString('base64url');
const tokenHash = createHash('sha256').update(raw).digest('hex');
const now = Date.parse('2030-01-01T12:00:00.000Z');
const expiry = now + 60_000;
const sid = '11111111-1111-4111-8111-111111111111';
const owner = '22222222-2222-4222-8222-222222222222';
const tokenId = '33333333-3333-4333-8333-333333333333';

interface AccountRow {
  id: string;
  isActive: boolean;
  authVersion: number;
}
interface SessionRow {
  id: string;
  userId: string;
  authVersion: number;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  user: AccountRow;
}
interface TokenRow {
  id: string;
  sessionId: string;
  createdAt: Date;
  expiresAt: Date | null;
  consumedAt: Date | null;
  session: SessionRow;
}
function stored(expiresAt: Date | null = new Date(expiry)): TokenRow {
  return {
    id: tokenId,
    sessionId: sid,
    createdAt: new Date(now - 500),
    expiresAt,
    consumedAt: null,
    session: {
      id: sid,
      userId: owner,
      authVersion: 2,
      createdAt: new Date(now - 1000),
      expiresAt: expiresAt === null ? null : new Date(expiresAt),
      revokedAt: null,
      user: { id: owner, isActive: true, authVersion: 2 },
    },
  };
}
function binding(): VerifiedAccessSession {
  return {
    sessionId: sid,
    account: {
      id: owner,
      authVersion: 2,
      username: 'synthetic',
      role: 'STUDENT',
    },
  };
}

describe('internal refresh-authenticated current-session revocation', () => {
  const forbidden = jest.fn<() => never>();
  const forbiddenWrites = {
    create: forbidden,
    createMany: forbidden,
    update: forbidden,
    updateMany: forbidden,
    upsert: forbidden,
    delete: forbidden,
    deleteMany: forbidden,
  };
  const tx = {
    user: forbiddenWrites,
    refreshToken: {
      ...forbiddenWrites,
      findUnique: jest.fn<(query: unknown) => Promise<TokenRow | null>>(),
      updateMany: jest.fn<(query: unknown) => Promise<{ count: number }>>(),
    },
    authSession: {
      ...forbiddenWrites,
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
  let service: RefreshSessionRevocationService;
  let returned: number;
  let aborted: unknown[];
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    for (const method of ['log', 'warn', 'error'] as const)
      jest.spyOn(globalThis.console, method);
    forbidden.mockImplementation(() => {
      throw new Error('Forbidden persistence operation');
    });
    tx.refreshToken.findUnique.mockResolvedValue(stored());
    tx.refreshToken.updateMany.mockResolvedValue({ count: 1 });
    tx.authSession.updateMany.mockResolvedValue({ count: 1 });
    returned = 0;
    aborted = [];
    prisma.$transaction.mockImplementation(async (callback) => {
      try {
        const result = await callback(tx);
        returned += 1;
        return result;
      } catch (error) {
        aborted.push(error);
        throw error;
      }
    });
    service = new RefreshSessionRevocationService(
      prisma as unknown as PrismaService,
    );
  });
  afterEach(() => {
    try {
      expect(forbidden).not.toHaveBeenCalled();
      expect(randomBytes).not.toHaveBeenCalled();
      if (tx.refreshToken.updateMany.mock.calls.length === 0)
        expect(tx.authSession.updateMany).not.toHaveBeenCalled();
      for (const method of ['log', 'warn', 'error'] as const)
        expect(globalThis.console[method]).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
      jest.restoreAllMocks();
    }
  });

  it.each([null, new Date(expiry)])(
    'revokes a valid current refresh session: %p',
    async (expiresAt) => {
      tx.refreshToken.findUnique.mockResolvedValue(stored(expiresAt));
      expect(await service.revoke(raw)).toBe(true);
      expect(tx.refreshToken.findUnique).toHaveBeenCalledWith({
        where: { tokenHash },
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
              user: { select: { id: true, isActive: true, authVersion: true } },
            },
          },
        },
      });
      expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { id: tokenId, sessionId: sid, consumedAt: null },
        data: { consumedAt: new Date(now) },
      });
      expect(tx.authSession.updateMany).toHaveBeenCalledWith({
        where: { id: sid, userId: owner, authVersion: 2, revokedAt: null },
        data: { revokedAt: new Date(now) },
      });
      expect(
        tx.refreshToken.updateMany.mock.invocationCallOrder[0],
      ).toBeLessThan(tx.authSession.updateMany.mock.invocationCallOrder[0]);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 2000,
        timeout: 5000,
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.refreshToken.findUnique).toHaveBeenCalledTimes(1);
      expect(tx.refreshToken.updateMany).toHaveBeenCalledTimes(1);
      expect(tx.authSession.updateMany).toHaveBeenCalledTimes(1);
      expect(returned).toBe(1);
    },
  );

  it.each([0, 2147483647])(
    'accepts bounded version %i and equal initial creation timestamps',
    async (authVersion) => {
      const row = stored();
      row.createdAt = new Date(row.session.createdAt);
      row.session.authVersion = row.session.user.authVersion = authVersion;
      tx.refreshToken.findUnique.mockResolvedValueOnce(row);
      expect(await service.revoke(raw)).toBe(true);
    },
  );

  it.each([
    undefined,
    null,
    false,
    1,
    {},
    [],
    '',
    raw.slice(1),
    raw + '=',
    'A'.repeat(42) + 'B',
    'é'.repeat(43),
    raw + '\n',
  ])('rejects malformed refresh before persistence: %#', async (value) => {
    expect(await service.revoke(value)).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  const denials: Array<[string, (row: TokenRow) => void]> = [
    [
      'consumed',
      (r) => {
        r.consumedAt = new Date(now);
      },
    ],
    [
      'missing consumption state',
      (r) => {
        Object.assign(r, { consumedAt: undefined });
      },
    ],
    [
      'revoked',
      (r) => {
        r.session.revokedAt = new Date(now);
      },
    ],
    [
      'missing revocation state',
      (r) => {
        Object.assign(r.session, { revokedAt: undefined });
      },
    ],
    [
      'session linkage',
      (r) => {
        r.sessionId = owner;
      },
    ],
    [
      'owner linkage',
      (r) => {
        r.session.userId = sid;
      },
    ],
    [
      'inactive',
      (r) => {
        r.session.user.isActive = false;
      },
    ],
    [
      'truthy activity',
      (r) => {
        Object.assign(r.session.user, { isActive: 1 });
      },
    ],
    [
      'version mismatch',
      (r) => {
        r.session.user.authVersion = 3;
      },
    ],
    [
      'negative version',
      (r) => {
        r.session.authVersion = r.session.user.authVersion = -1;
      },
    ],
    [
      'fractional version',
      (r) => {
        r.session.authVersion = r.session.user.authVersion = 1.5;
      },
    ],
    [
      'oversized version',
      (r) => {
        r.session.authVersion = r.session.user.authVersion = 2147483648;
      },
    ],
    [
      'string version',
      (r) => {
        Object.assign(r.session, { authVersion: '2' });
        Object.assign(r.session.user, { authVersion: '2' });
      },
    ],
    [
      'token id',
      (r) => {
        r.id = 'invalid';
      },
    ],
    [
      'session id',
      (r) => {
        r.sessionId = r.session.id = 'invalid';
      },
    ],
    [
      'owner id',
      (r) => {
        r.session.userId = r.session.user.id = 'invalid';
      },
    ],
    [
      'future creation',
      (r) => {
        r.createdAt = new Date(now + 1);
      },
    ],
    [
      'creation ordering',
      (r) => {
        r.createdAt = new Date(now - 2000);
      },
    ],
    [
      'invalid token date',
      (r) => {
        r.createdAt = new Date(NaN);
      },
    ],
    [
      'invalid session date',
      (r) => {
        r.session.createdAt = new Date(NaN);
      },
    ],
    [
      'missing joined session',
      (r) => {
        Object.assign(r, { session: null });
      },
    ],
  ];
  it.each(denials)(
    'denies %s in finite and null expiry modes',
    async (_name, change) => {
      for (const expiresAt of [null, new Date(expiry)]) {
        const row = stored(expiresAt);
        change(row);
        tx.refreshToken.findUnique.mockResolvedValueOnce(row);
        expect(await service.revoke(raw)).toBe(false);
      }
      expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
      expect(tx.authSession.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    undefined,
    'date',
    expiry,
    false,
    {},
    new Date(NaN),
    { getTime: () => expiry },
  ])('denies malformed expiry combinations: %#', async (value) => {
    for (const [tokenExpiry, sessionExpiry] of [
      [value, value],
      [value, null],
      [null, value],
    ]) {
      const row = stored();
      Object.assign(row, { expiresAt: tokenExpiry });
      Object.assign(row.session, { expiresAt: sessionExpiry });
      tx.refreshToken.findUnique.mockResolvedValueOnce(row);
      expect(await service.revoke(raw)).toBe(false);
    }
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
  });
  it.each([
    [null, new Date(expiry)],
    [new Date(expiry), null],
    [new Date(expiry), new Date(expiry + 1)],
    [new Date(now), new Date(now)],
    [new Date(now - 1), new Date(now - 1)],
  ])(
    'denies mixed, unequal or expired expiry: %#',
    async (tokenExpiry, sessionExpiry) => {
      const row = stored(tokenExpiry);
      row.session.expiresAt = sessionExpiry;
      tx.refreshToken.findUnique.mockResolvedValueOnce(row);
      expect(await service.revoke(raw)).toBe(false);
      expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    },
  );

  it('denies an unknown digest without writes', async () => {
    tx.refreshToken.findUnique.mockResolvedValueOnce(null);
    expect(await service.revoke(raw)).toBe(false);
    expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
  });
  it('uses an already verified binding only as an additional constraint', async () => {
    expect(await service.revoke(raw, binding())).toBe(true);
    expect(tx.refreshToken.findUnique.mock.calls[0][0]).toMatchObject({
      where: { tokenHash },
    });
  });
  it.each(['session', 'owner', 'version'])(
    'denies a mismatched verified %s before writes',
    async (field) => {
      const expected = binding();
      if (field === 'session') Object.assign(expected, { sessionId: owner });
      if (field === 'owner') Object.assign(expected.account, { id: sid });
      if (field === 'version')
        Object.assign(expected.account, { authVersion: 3 });
      expect(await service.revoke(raw, expected)).toBe(false);
      expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each([
    undefined,
    null,
    false,
    {},
    [],
    { sessionId: sid, account: null },
    { sessionId: sid, account: [] },
    { sessionId: 'invalid', account: binding().account },
    { sessionId: sid, account: { id: owner, authVersion: '2' } },
  ])('does not ignore a supplied malformed binding: %#', async (value) => {
    expect(await service.revoke(raw, value as VerifiedAccessSession)).toBe(
      false,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('does not let a binding authenticate a missing refresh token', async () => {
    expect(await service.revoke(undefined, binding())).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it.each([-1, 1.5, 2147483648])(
    'rejects an unbounded binding version before lookup: %p',
    async (authVersion) => {
      const expected = binding();
      Object.assign(expected.account, { authVersion });
      expect(await service.revoke(raw, expected)).toBe(false);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it('rejects a throwing binding without persistence', async () => {
    const expected = Object.defineProperty({}, 'sessionId', {
      get: () => {
        throw new Error('private input');
      },
    });
    expect(await service.revoke(raw, expected as VerifiedAccessSession)).toBe(
      false,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(
    ['claim', 'session'].flatMap((operation) =>
      [0, 2].map((count) => ({ operation, count })),
    ),
  )(
    'requests transaction abort for $operation count $count',
    async ({ operation, count }) => {
      if (operation === 'claim')
        tx.refreshToken.updateMany.mockResolvedValueOnce({ count });
      else tx.authSession.updateMany.mockResolvedValueOnce({ count });
      expect(await service.revoke(raw)).toBe(false);
      expect(returned).toBe(0);
      expect(aborted).toHaveLength(1);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      if (operation === 'claim')
        expect(tx.authSession.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each(['lookup', 'claim', 'session', 'transaction', 'commit'])(
    'denies %s errors without retry or a success claim',
    async (phase) => {
      const failure = new Error('private infrastructure detail');
      if (phase === 'lookup')
        tx.refreshToken.findUnique.mockRejectedValueOnce(failure);
      if (phase === 'claim')
        tx.refreshToken.updateMany.mockRejectedValueOnce(failure);
      if (phase === 'session')
        tx.authSession.updateMany.mockRejectedValueOnce(failure);
      if (phase === 'transaction')
        prisma.$transaction.mockRejectedValueOnce(failure);
      if (phase === 'commit')
        prisma.$transaction.mockImplementationOnce(async (callback) => {
          await callback(tx);
          throw failure;
        });
      expect(await service.revoke(raw)).toBe(false);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.refreshToken.findUnique.mock.calls.length).toBeLessThanOrEqual(
        1,
      );
      expect(tx.refreshToken.updateMany.mock.calls.length).toBeLessThanOrEqual(
        1,
      );
      expect(tx.authSession.updateMany.mock.calls.length).toBeLessThanOrEqual(
        1,
      );
      if (phase === 'claim' || phase === 'session')
        expect(aborted).toHaveLength(1);
    },
  );

  it.each([NaN, Infinity, -Infinity, 1e30])(
    'rejects an invalid initial clock: %p',
    async (time) => {
      jest.spyOn(Date, 'now').mockReturnValue(time);
      expect(await service.revoke(raw)).toBe(false);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
  it.each(
    ['lookup', 'claim', 'session', 'settlement'].flatMap((phase) =>
      [expiry, now - 1, NaN].map((time) => ({ phase, time })),
    ),
  )(
    'denies $phase clock $time without claiming post-settlement rollback',
    async ({ phase, time }) => {
      const move = () => {
        jest.spyOn(Date, 'now').mockReturnValue(time);
      };
      if (phase === 'lookup')
        tx.refreshToken.findUnique.mockImplementationOnce(async () => {
          move();
          return stored();
        });
      if (phase === 'claim')
        tx.refreshToken.updateMany.mockImplementationOnce(async () => {
          move();
          return { count: 1 };
        });
      if (phase === 'session')
        tx.authSession.updateMany.mockImplementationOnce(async () => {
          move();
          return { count: 1 };
        });
      if (phase === 'settlement')
        prisma.$transaction.mockImplementationOnce(async (callback) => {
          const result = await callback(tx);
          returned += 1;
          move();
          return result;
        });
      expect(await service.revoke(raw)).toBe(false);
      if (phase !== 'settlement') {
        expect(returned).toBe(0);
        expect(aborted).toHaveLength(1);
      } else {
        expect(returned).toBe(1);
        expect(aborted).toHaveLength(0);
      }
      if (phase === 'lookup')
        expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
      if (phase === 'claim')
        expect(tx.authSession.updateMany).not.toHaveBeenCalled();
    },
  );
  it('retains explicit null expiry through large clock advancement', async () => {
    tx.refreshToken.findUnique.mockResolvedValueOnce(stored(null));
    tx.refreshToken.updateMany.mockImplementationOnce(async () => {
      jest.setSystemTime(now + 10 * 365 * 86400000);
      return { count: 1 };
    });
    expect(await service.revoke(raw)).toBe(true);
  });
  it('snapshots binding, owner, version and expiry before mutation across awaits', async () => {
    const expected = binding();
    const row = stored();
    tx.refreshToken.findUnique.mockImplementationOnce(async () => {
      Object.assign(expected.account, { id: sid, authVersion: 3 });
      return row;
    });
    tx.refreshToken.updateMany.mockImplementationOnce(async () => {
      Object.assign(row.session, { id: owner, userId: sid, authVersion: 3 });
      row.expiresAt!.setTime(now);
      row.session.expiresAt!.setTime(now);
      return { count: 1 };
    });
    expect(await service.revoke(raw, expected)).toBe(true);
    expect(tx.authSession.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: sid, userId: owner, authVersion: 2 },
    });
  });
  it('keeps different concurrent credential and owner scopes independent', async () => {
    const otherRaw = Buffer.alloc(32, 7).toString('base64url');
    const other = stored(null);
    other.id = '44444444-4444-4444-8444-444444444444';
    other.sessionId = other.session.id = '55555555-5555-4555-8555-555555555555';
    other.session.userId = other.session.user.id =
      '66666666-6666-4666-8666-666666666666';
    other.session.authVersion = other.session.user.authVersion = 3;
    tx.refreshToken.findUnique
      .mockResolvedValueOnce(stored())
      .mockResolvedValueOnce(other);
    expect(
      await Promise.all([service.revoke(raw), service.revoke(otherRaw)]),
    ).toEqual([true, true]);
    expect(tx.refreshToken.findUnique).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          tokenHash: createHash('sha256').update(otherRaw).digest('hex'),
        },
      }),
    );
    expect(
      tx.authSession.updateMany.mock.calls.map(([query]) => query),
    ).toEqual(
      expect.arrayContaining([
        {
          where: { id: sid, userId: owner, authVersion: 2, revokedAt: null },
          data: { revokedAt: new Date(now) },
        },
        {
          where: {
            id: other.sessionId,
            userId: other.session.userId,
            authVersion: 3,
            revokedAt: null,
          },
          data: { revokedAt: new Date(now) },
        },
      ]),
    );
    expect(tx.authSession.updateMany).toHaveBeenCalledTimes(2);
  });
  it('waits for transaction settlement rather than callback completion', async () => {
    let release!: () => void;
    let entered!: () => void;
    const committing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callbackDone = new Promise<void>((resolve) => {
      entered = resolve;
    });
    prisma.$transaction.mockImplementationOnce(async (callback) => {
      const result = await callback(tx);
      entered();
      await committing;
      return result;
    });
    let settled = false;
    const pending = service.revoke(raw).then((result) => {
      settled = true;
      return result;
    });
    await Promise.race([callbackDone, pending]);
    try {
      expect(settled).toBe(false);
    } finally {
      release();
    }
    expect(await pending).toBe(true);
  });
});
