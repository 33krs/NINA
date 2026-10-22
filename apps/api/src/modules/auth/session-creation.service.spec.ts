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
import type {
  AuthenticatedAccount,
  CredentialAuthenticationService,
} from './credential-authentication.service';
import {
  SessionCreationService,
  type CreatedSession,
} from './session-creation.service';

jest.mock('node:crypto', () => ({
  ...jest.requireActual<typeof import('node:crypto')>('node:crypto'),
  randomBytes: jest.fn(),
}));

const random = randomBytes as unknown as jest.MockedFunction<
  (size: number) => Buffer
>;
const owner = 'a24e8a50-0cf1-4e7a-8d60-c504a9025c8d';
const id = 'b24e8a50-0cf1-4e7a-8d60-c504a9025c8d';
const other = 'c24e8a50-0cf1-4e7a-8d60-c504a9025c8d';
const now = new Date('2030-01-01T12:00:00.000Z');
const expiry = new Date('2030-01-02T12:00:00.000Z');

interface Account extends AuthenticatedAccount {
  isActive: boolean;
}

function account(extra: Partial<Account> = {}): Account {
  return {
    id: owner,
    username: 'synthetic.user',
    role: UserRole.STUDENT,
    authVersion: 2,
    isActive: true,
    ...extra,
  };
}

function identity() {
  return {
    id: owner,
    username: 'synthetic.user',
    role: UserRole.STUDENT,
    authVersion: 2,
  };
}

describe('unregistered internal session creation', () => {
  const tx = {
    user: {
      findUnique: jest.fn<(query: unknown) => Promise<Account | null>>(),
    },
    authSession: {
      create: jest.fn<(query: unknown) => Promise<{ id: string }>>(),
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
  const credentials = {
    authenticate:
      jest.fn<
        (
          username: unknown,
          password: unknown,
        ) => Promise<AuthenticatedAccount | null>
      >(),
  };
  let service: SessionCreationService;
  const create = (expiresAt: unknown = expiry) =>
    service.create('synthetic.user', 'synthetic-input', expiresAt);

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(now);
    random.mockReturnValue(Buffer.alloc(32, 7));
    credentials.authenticate.mockResolvedValue(identity());
    tx.user.findUnique.mockResolvedValue(account());
    tx.authSession.create.mockResolvedValue({ id });
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    service = new SessionCreationService(
      prisma as unknown as PrismaService,
      credentials as unknown as CredentialAuthenticationService,
    );
  });
  afterEach(() => jest.useRealTimers());

  it('composes credentials and atomically stores only a digest with explicit shared expiry', async () => {
    const raw = Buffer.alloc(32, 7).toString('base64url');
    await expect(
      service.create('Synthetic.User', 'synthetic-password-input', expiry),
    ).resolves.toEqual({
      id,
      account: identity(),
      expiresAt: expiry,
      refreshToken: raw,
    });
    expect(credentials.authenticate).toHaveBeenCalledWith(
      'Synthetic.User',
      'synthetic-password-input',
    );
    expect(random).toHaveBeenCalledWith(32);
    expect(tx.user.findUnique).toHaveBeenCalledWith({
      where: { id: owner },
      select: {
        id: true,
        username: true,
        role: true,
        isActive: true,
        authVersion: true,
      },
    });
    expect(tx.authSession.create).toHaveBeenCalledWith({
      data: {
        authVersion: 2,
        createdAt: now,
        expiresAt: expiry,
        user: { connect: { id: owner } },
        refreshTokens: {
          create: {
            tokenHash: createHash('sha256').update(raw).digest('hex'),
            createdAt: now,
            expiresAt: expiry,
          },
        },
      },
      select: { id: true },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 2000,
      timeout: 5000,
    });
    expect(JSON.stringify(tx.authSession.create.mock.calls)).not.toContain(raw);
  });

  it('issues an explicitly nonexpiring session and initial digest-only credential', async () => {
    const raw = Buffer.alloc(32, 7).toString('base64url');
    const result = await create(null);
    expect(result).toEqual({
      id,
      account: identity(),
      expiresAt: null,
      refreshToken: raw,
    });
    expect(tx.authSession.create).toHaveBeenCalledWith({
      data: {
        authVersion: 2,
        createdAt: now,
        expiresAt: null,
        user: { connect: { id: owner } },
        refreshTokens: {
          create: {
            tokenHash: createHash('sha256').update(raw).digest('hex'),
            createdAt: now,
            expiresAt: null,
          },
        },
      },
      select: { id: true },
    });
    expect(random).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(tx.authSession.create.mock.calls)).not.toContain(raw);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 2000,
      timeout: 5000,
    });
  });

  it.each([
    undefined,
    false,
    0,
    {},
    { getTime: () => expiry.getTime() },
    expiry.toISOString(),
    new Date(Infinity),
    new Date(NaN),
    now,
    new Date(now.getTime() - 1),
  ])(
    'rejects invalid or nonfuture expiry before credential work: %p',
    async (expiresAt) => {
      await expect(
        service.create('synthetic.user', 'synthetic-input', expiresAt),
      ).resolves.toBeNull();
      expect(credentials.authenticate).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('rejects an omitted runtime expiry before credential or database work', async () => {
    await expect(
      Reflect.apply(service.create, service, [
        'synthetic.user',
        'synthetic-input',
      ]),
    ).resolves.toBeNull();
    expect(credentials.authenticate).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });

  it('preserves null across credential, lookup and commit clock advancement', async () => {
    credentials.authenticate.mockImplementation(async () => {
      jest.setSystemTime(expiry);
      return identity();
    });
    tx.user.findUnique.mockImplementation(async () => {
      jest.setSystemTime(new Date('2040-01-01T00:00:00Z'));
      return account();
    });
    prisma.$transaction.mockImplementation(async (callback) => {
      const result = await callback(tx);
      jest.setSystemTime(new Date('2050-01-01T00:00:00Z'));
      return result;
    });
    expect((await create(null))?.expiresAt).toBeNull();
    expect(tx.authSession.create).toHaveBeenCalledTimes(1);
  });

  it('clones the finite caller expiry for persistence and the returned result', async () => {
    const supplied = new Date(expiry);
    const result = await create(supplied);
    const query = tx.authSession.create.mock
      .calls[0][0] as Prisma.AuthSessionCreateArgs;
    expect(query.data.expiresAt).toEqual(expiry);
    expect(query.data.expiresAt).not.toBe(supplied);
    expect(query.data.refreshTokens).toEqual({
      create: expect.objectContaining({ expiresAt: expiry }),
    });
    expect(result?.expiresAt).toEqual(expiry);
    expect(result?.expiresAt).not.toBe(query.data.expiresAt);
    expect(result?.expiresAt).not.toBe(supplied);
  });

  it('rechecks captured finite milliseconds even if the callback result Date is mutated', async () => {
    prisma.$transaction.mockImplementation(async (callback) => {
      const result = (await callback(tx)) as CreatedSession;
      result.expiresAt.setTime(expiry.getTime() + 60_000);
      jest.setSystemTime(expiry);
      return result;
    });
    await expect(create()).resolves.toBeNull();
    expect(tx.authSession.create).toHaveBeenCalledTimes(1);
  });

  it.each([expiry, null])(
    'does not write for rejected credentials with expiry %p',
    async (expiresAt) => {
      credentials.authenticate.mockResolvedValue(null);
      await expect(create(expiresAt)).resolves.toBeNull();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    account({ id: other }),
    account({ isActive: false }),
    account({ authVersion: 3 }),
  ])(
    'rejects an absent, mismatched, disabled or version-changed authenticated account',
    async (current) => {
      tx.user.findUnique.mockResolvedValue(current);
      for (const expiresAt of [expiry, null]) {
        await expect(create(expiresAt)).resolves.toBeNull();
      }
      expect(tx.authSession.create).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
    },
  );

  it('rechecks expiration after account lookup and snapshots the caller Date before awaiting', async () => {
    tx.user.findUnique.mockImplementation(async () => {
      jest.setSystemTime(expiry);
      return account();
    });
    await expect(create()).resolves.toBeNull();
    expect(tx.authSession.create).not.toHaveBeenCalled();
    jest.setSystemTime(now);
    const supplied = new Date(expiry);
    tx.user.findUnique.mockResolvedValue(account());
    credentials.authenticate.mockImplementation(async () => {
      supplied.setTime(0);
      return identity();
    });
    expect((await create(supplied))?.expiresAt).toEqual(expiry);
  });

  it.each([expiry, null])(
    'returns current minimal identity without persistence fields with expiry %p',
    async (expiresAt) => {
      tx.user.findUnique.mockResolvedValue(
        account({ role: UserRole.INSTRUCTOR }),
      );
      expect((await create(expiresAt))?.account).toEqual({
        ...identity(),
        role: UserRole.INSTRUCTOR,
      });
    },
  );

  it.each([expiry, null])(
    'withholds creation until commit and denies rejected commit with expiry %p',
    async (expiresAt) => {
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
      const pending = create(expiresAt).then((result) => {
        resolved = true;
        return result;
      });
      await Promise.race([callbackFinished, pending]);
      expect(resolved).toBe(false);
      release();
      expect((await pending)?.refreshToken).toHaveLength(43);
      prisma.$transaction.mockImplementation(async (callback) => {
        await callback(tx);
        throw new Error('synthetic commit failure');
      });
      await expect(create(expiresAt)).resolves.toBeNull();
    },
  );

  it('does not return credentials if expiration passes while committing', async () => {
    prisma.$transaction.mockImplementation(async (callback) => {
      const result = await callback(tx);
      jest.setSystemTime(expiry);
      return result;
    });
    await expect(create()).resolves.toBeNull();
    expect(tx.authSession.create).toHaveBeenCalledTimes(1);
  });

  it.each(['credentials', 'lookup', 'insert', 'transaction', 'random'])(
    'denies creation after %s failure without retry or leaking details',
    async (dependency) => {
      const error = new Error('synthetic private diagnostic');
      if (dependency === 'credentials')
        credentials.authenticate.mockRejectedValue(error);
      if (dependency === 'lookup') tx.user.findUnique.mockRejectedValue(error);
      if (dependency === 'insert')
        tx.authSession.create.mockRejectedValue(error);
      if (dependency === 'transaction')
        prisma.$transaction.mockRejectedValue(error);
      if (dependency === 'random')
        random.mockImplementation(() => {
          throw error;
        });
      for (const expiresAt of [expiry, null]) {
        prisma.$transaction.mockClear();
        await expect(create(expiresAt)).resolves.toBeNull();
        expect(prisma.$transaction.mock.calls.length).toBeLessThanOrEqual(1);
      }
    },
  );
});
