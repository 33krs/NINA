import { Logger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import {
  AppointmentLockService,
  LOCK_TTL_MS,
  RELEASE_LOCK,
} from './appointment-lock.service';

interface LeaseOptions {
  NX: boolean;
  PX: number;
}

interface ReleaseOptions {
  keys: string[];
  arguments: string[];
}

describe('AppointmentLockService (Redis dependency double)', () => {
  const commands = {
    set: jest.fn<
      (
        key: string,
        owner: string,
        options: LeaseOptions,
      ) => Promise<string | null>
    >(),
    eval: jest.fn<
      (script: string, options: ReleaseOptions) => Promise<number>
    >(),
  };
  const redis = {
    isOpen: true,
    isReady: true,
    connect: jest.fn<() => Promise<void>>(),
    destroy: jest.fn<() => void>(),
    withCommandOptions:
      jest.fn<(options: { timeout: number }) => typeof commands>(),
    ...commands,
  };
  let app: INestApplication;
  let locks: AppointmentLockService;

  beforeEach(async () => {
    jest.resetAllMocks();
    redis.isOpen = redis.isReady = true;
    redis.withCommandOptions.mockReturnValue(redis);
    redis.set.mockResolvedValue('OK');
    redis.eval.mockResolvedValue(1);
    const module = await Test.createTestingModule({
      providers: [
        AppointmentLockService,
        { provide: 'APPOINTMENT_REDIS', useValue: redis },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
    locks = app.get(AppointmentLockService);
  });

  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  it('acquires atomically with NX, bounded PX, and a command timeout', async () => {
    await expect(locks.acquire('slot', 'owner')).resolves.toBe(true);
    expect(LOCK_TTL_MS).toBe(10000);
    expect(redis.set).toHaveBeenCalledWith('slot', 'owner', {
      NX: true,
      PX: 10000,
    });
    expect(redis.withCommandOptions).toHaveBeenCalledWith({ timeout: 1500 });
    expect(redis.connect).not.toHaveBeenCalled();
  });

  it('reports contention without claiming ownership', async () => {
    redis.set.mockResolvedValue(null);
    await expect(locks.acquire('slot', 'owner')).resolves.toBe(false);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('fails closed on an unexpected acquisition reply', async () => {
    redis.set.mockResolvedValue('unexpected');
    await expect(locks.acquire('slot', 'owner')).rejects.toThrow(
      'Unexpected Redis acquisition result',
    );
  });

  it('propagates acquisition failure without releasing an unowned lease', async () => {
    const error = new Error('set failed');
    redis.set.mockRejectedValue(error);
    await expect(locks.acquire('slot', 'owner')).rejects.toBe(error);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('shares a connection failure, then retries on the next acquisition', async () => {
    redis.isOpen = redis.isReady = false;
    redis.connect.mockRejectedValueOnce(new Error('connect failed'));
    await expect(
      Promise.all([
        locks.acquire('slot-1', 'owner-1'),
        locks.acquire('slot-2', 'owner-2'),
      ]),
    ).rejects.toThrow('connect failed');
    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
    redis.connect.mockImplementation(async () => {
      redis.isOpen = redis.isReady = true;
    });
    await expect(locks.acquire('slot', 'owner')).resolves.toBe(true);
    expect(redis.connect).toHaveBeenCalledTimes(2);
  });

  it('coalesces lazy connections and destroys the client on application close', async () => {
    redis.isOpen = redis.isReady = false;
    let finish!: () => void;
    const connected = new Promise<void>((resolve) => {
      finish = resolve;
    });
    redis.connect.mockImplementation(async () => {
      await connected;
      redis.isOpen = redis.isReady = true;
    });
    const acquisitions = Promise.all([
      locks.acquire('test-1', 'owner-1'),
      locks.acquire('test-2', 'owner-2'),
    ]);
    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
    finish();
    await acquisitions;
    await app.close();
    expect(redis.destroy).toHaveBeenCalledTimes(1);
    redis.isOpen = false;
  });

  it.each(['owner', 'successor'])(
    'releases only its own lease, current owner: %s',
    async (current) => {
      let owner: string | undefined = current;
      redis.eval.mockImplementation(async (_script, { arguments: args }) => {
        if (owner !== args[0]) return 0;
        owner = undefined;
        return 1;
      });
      await expect(locks.release('slot', 'owner')).resolves.toBeUndefined();
      expect(redis.eval).toHaveBeenCalledWith(RELEASE_LOCK, {
        keys: ['slot'],
        arguments: ['owner'],
      });
      expect(RELEASE_LOCK).toMatch(
        /if redis\.call\('get', KEYS\[1\]\) == ARGV\[1\] then\s+return redis\.call\('del', KEYS\[1\]\)\s+end\s+return 0/,
      );
      expect(owner).toBe(current === 'owner' ? undefined : 'successor');
      expect(redis.withCommandOptions).toHaveBeenCalledWith({ timeout: 1500 });
    },
  );

  it.each([false, true])(
    'cleanup failure preserves the original outcome: %s',
    async (failed) => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      redis.eval.mockRejectedValue(new Error('private release details'));
      const error = new Error('original failure');
      const operation = async () => {
        try {
          if (failed) throw error;
          return 'durable result';
        } finally {
          await locks.release('slot', 'owner');
        }
      };
      if (failed) await expect(operation()).rejects.toBe(error);
      else await expect(operation()).resolves.toBe('durable result');
      expect(warn).toHaveBeenCalledWith(
        'Reservation lock release failed; lease will expire',
      );
    },
  );

  it('does not destroy a client that was never opened', async () => {
    redis.isOpen = false;
    await app.close();
    expect(redis.destroy).not.toHaveBeenCalled();
  });
});
