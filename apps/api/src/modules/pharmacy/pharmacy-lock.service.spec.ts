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
import { createClient } from 'redis';
import {
  createPharmacyRedis,
  PHARMACY_LOCK_TTL_MS,
  PHARMACY_RELEASE_LOCK,
  PHARMACY_REDIS,
  PharmacyLockService,
} from './pharmacy-lock.service';

jest.mock('redis', () => ({ createClient: jest.fn() }));

interface LeaseOptions {
  NX: boolean;
  PX: number;
}
interface ReleaseOptions {
  keys: string[];
  arguments: string[];
}

describe('Pharmacy lease adapter (Redis dependency double)', () => {
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
    on: jest.fn<(event: string, listener: (error: Error) => void) => void>(),
    withCommandOptions:
      jest.fn<(options: { timeout: number }) => typeof commands>(),
    ...commands,
  };
  let app: INestApplication;
  let service: PharmacyLockService;
  beforeEach(async () => {
    jest.resetAllMocks();
    redis.isOpen = redis.isReady = true;
    redis.withCommandOptions.mockReturnValue(commands);
    redis.set.mockResolvedValue('OK');
    redis.eval.mockResolvedValue(1);
    const module = await Test.createTestingModule({
      providers: [
        PharmacyLockService,
        { provide: PHARMACY_REDIS, useValue: redis },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
    service = app.get(PharmacyLockService);
  });
  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  it('configures only the explicit URL, bounded sockets, and sanitized error listener', () => {
    // The dependency double implements only commands used by this adapter.
    jest
      .mocked(createClient)
      .mockReturnValue(redis as unknown as ReturnType<typeof createClient>);
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    const url = 'redis://fixture.invalid:6379';
    expect(createPharmacyRedis(url)).toBe(redis);
    expect(createClient).toHaveBeenCalledWith({
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 1500,
        socketTimeout: 1500,
        reconnectStrategy: false,
      },
    });
    expect(redis.connect).not.toHaveBeenCalled();
    expect(redis.on.mock.calls[0][0]).toBe('error');
    const listener = redis.on.mock.calls[0][1];
    if (typeof listener !== 'function')
      throw new Error('Missing error listener');
    listener(new Error('private connection details'));
    expect(warn).toHaveBeenCalledWith('Redis connection unavailable');
  });

  it.each(['', ' ', undefined, null, 42])(
    'rejects missing explicit factory URL: %p',
    (url) => {
      expect(() => createPharmacyRedis(url as string)).toThrow(TypeError);
      expect(createClient).not.toHaveBeenCalled();
    },
  );

  it('uses NX/PX and bounds acquisition and owner-checked release commands', async () => {
    await expect(service.acquire('key', 'owner')).resolves.toBe(true);
    await expect(service.release('key', 'owner')).resolves.toBeUndefined();
    expect(PHARMACY_LOCK_TTL_MS).toBe(10000);
    expect(redis.set).toHaveBeenCalledWith('key', 'owner', {
      NX: true,
      PX: 10000,
    });
    expect(redis.eval).toHaveBeenCalledWith(PHARMACY_RELEASE_LOCK, {
      keys: ['key'],
      arguments: ['owner'],
    });
    expect(redis.withCommandOptions.mock.calls).toEqual([
      [{ timeout: 1500 }],
      [{ timeout: 1500 }],
    ]);
    expect(redis.connect).not.toHaveBeenCalled();
  });

  it('reports contention without releasing an unowned lease', async () => {
    redis.set.mockResolvedValue(null);
    await expect(service.acquire('key', 'owner')).resolves.toBe(false);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('rejects an unexpected acquisition reply without releasing', async () => {
    redis.set.mockResolvedValue('unexpected');
    await expect(service.acquire('key', 'owner')).rejects.toThrow(
      'Unexpected Redis acquisition result',
    );
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('propagates acquisition failure without releasing', async () => {
    const failure = new Error('acquisition failure');
    redis.set.mockRejectedValue(failure);
    await expect(service.acquire('key', 'owner')).rejects.toBe(failure);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('coalesces concurrent lazy connections before issuing either command', async () => {
    redis.isOpen = redis.isReady = false;
    let finish!: () => void;
    const connected = new Promise<void>((resolve) => {
      finish = resolve;
    });
    redis.connect.mockImplementation(async () => {
      await connected;
      redis.isOpen = redis.isReady = true;
    });
    const pending = Promise.all([
      service.acquire('first', 'owner'),
      service.acquire('second', 'owner'),
    ]);
    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
    finish();
    await expect(pending).resolves.toEqual([true, true]);
  });

  it('shares failed connection attempts and safely retries the next acquisition', async () => {
    redis.isOpen = redis.isReady = false;
    const failure = new Error('connection failure');
    redis.connect.mockRejectedValueOnce(failure);
    const outcomes = await Promise.allSettled([
      service.acquire('key', 'first'),
      service.acquire('key', 'second'),
    ]);
    expect(outcomes).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
    redis.connect.mockImplementation(async () => {
      redis.isOpen = redis.isReady = true;
    });
    await expect(service.acquire('key', 'next')).resolves.toBe(true);
    expect(redis.connect).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'compare-delete preserves a successor after expiry: %s',
    async (replaced) => {
      let owner: string | undefined = replaced ? 'successor' : 'original';
      redis.eval.mockImplementation(async (_script, { arguments: tokens }) => {
        if (owner !== tokens[0]) return 0;
        owner = undefined;
        return 1;
      });
      await service.release('key', 'original');
      expect(owner).toBe(replaced ? 'successor' : undefined);
      expect(PHARMACY_RELEASE_LOCK).toMatch(
        /if redis\.call\('get', KEYS\[1\]\) == ARGV\[1\] then\s+return redis\.call\('del', KEYS\[1\]\)\s+end\s+return 0/,
      );
    },
  );

  it('swallows release failures with only a fixed sanitized warning', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => {});
    redis.eval.mockRejectedValue(new Error('private cleanup details'));
    await expect(service.release('key', 'owner')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'Dispensing lock release failed; lease will expire',
    );
  });

  it.each([false, true])(
    'destroys only its opened owned client on shutdown: %s',
    async (opened) => {
      redis.isOpen = opened;
      await app.close();
      expect(redis.destroy).toHaveBeenCalledTimes(opened ? 1 : 0);
      redis.isOpen = false;
    },
  );
});
