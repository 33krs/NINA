import {
  ConflictException,
  Logger,
  ServiceUnavailableException,
  type INestApplication,
} from '@nestjs/common';
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
  PharmacyDispensingService,
  type DispenseItemRequest,
} from './pharmacy-dispensing.service';
import { LockedPharmacyDispensingService } from './locked-pharmacy-dispensing.service';
import {
  PHARMACY_LOCK_TTL_MS,
  PHARMACY_RELEASE_LOCK,
  PHARMACY_REDIS,
  PharmacyLockService,
} from './pharmacy-lock.service';

interface LeaseOptions {
  NX: boolean;
  PX: number;
}
interface ReleaseOptions {
  keys: string[];
  arguments: string[];
}

const request = {
  prescriptionId: 'prescription',
  itemId: 'item',
  quantity: 2,
  eventId: '11111111-1111-4111-8111-111111111111',
};
const result = {
  eventId: request.eventId,
  allocations: [{ batchId: 'batch', quantity: 2 }],
};

describe('Locked pharmacy dispensing (Redis and transaction dependency doubles)', () => {
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
  const core = {
    dispenseItem: jest.fn<PharmacyDispensingService['dispenseItem']>(),
  };
  let app: INestApplication;
  let service: LockedPharmacyDispensingService;

  beforeEach(async () => {
    jest.resetAllMocks();
    redis.isOpen = redis.isReady = true;
    redis.withCommandOptions.mockReturnValue(commands);
    redis.set.mockResolvedValue('OK');
    redis.eval.mockResolvedValue(1);
    core.dispenseItem.mockResolvedValue(result);
    const module = await Test.createTestingModule({
      providers: [
        PharmacyLockService,
        LockedPharmacyDispensingService,
        { provide: PHARMACY_REDIS, useValue: redis },
        { provide: PharmacyDispensingService, useValue: core },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
    service = app.get(LockedPharmacyDispensingService);
  });

  afterEach(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  it('rejects a busy prescription without calling the transaction or releasing', async () => {
    redis.set.mockResolvedValue(null);
    await expect(service.dispenseItem(request)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(core.dispenseItem).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('acquires before delegating once, preserves identities, and releases with bounded commands', async () => {
    await expect(service.dispenseItem(request)).resolves.toBe(result);
    expect(core.dispenseItem).toHaveBeenCalledTimes(1);
    expect(core.dispenseItem.mock.calls[0][0]).toBe(request);
    const [key, owner] = redis.set.mock.calls[0];
    expect(key).toBe('pharmacy:prescription:["prescription"]');
    expect(owner).toMatch(/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i);
    expect(owner).not.toBe(request.eventId);
    expect(PHARMACY_LOCK_TTL_MS).toBe(10000);
    expect(redis.set).toHaveBeenCalledWith(key, owner, { NX: true, PX: 10000 });
    expect(redis.eval).toHaveBeenCalledWith(PHARMACY_RELEASE_LOCK, {
      keys: [key],
      arguments: [owner],
    });
    expect(redis.withCommandOptions.mock.calls).toEqual([
      [{ timeout: 1500 }],
      [{ timeout: 1500 }],
    ]);
    expect(redis.set.mock.invocationCallOrder[0]).toBeLessThan(
      core.dispenseItem.mock.invocationCallOrder[0],
    );
    expect(core.dispenseItem.mock.invocationCallOrder[0]).toBeLessThan(
      redis.eval.mock.invocationCallOrder[0],
    );
    expect(redis.connect).not.toHaveBeenCalled();
  });

  it('uses new owners for the same replay event and preserves exact prescription key components', async () => {
    for (const prescriptionId of [
      'prescription',
      'prescription',
      ' a:b ',
      '["a:b"]',
    ]) {
      await service.dispenseItem({ ...request, prescriptionId });
    }
    const calls = redis.set.mock.calls;
    expect(new Set(calls.map((call) => call[1])).size).toBe(4);
    expect(calls[0][0]).toBe(calls[1][0]);
    expect(calls[2][0]).toBe('pharmacy:prescription:[" a:b "]');
    expect(calls[3][0]).toBe(
      `pharmacy:prescription:${JSON.stringify(['["a:b"]'])}`,
    );
    expect(new Set(calls.map((call) => call[0])).size).toBe(3);
  });

  it.each([
    { prescriptionId: '' },
    { prescriptionId: ' ' },
    { prescriptionId: undefined },
    { prescriptionId: 42 },
    { itemId: '' },
    { itemId: null },
    { quantity: 0 },
    { quantity: -1 },
    { quantity: 1.5 },
    { quantity: NaN },
    { quantity: Number.MAX_SAFE_INTEGER + 1 },
    { eventId: '' },
    { eventId: 'not-a-uuid' },
    { eventId: null },
  ])(
    'rejects malformed input before any Redis or transaction call: %j',
    async (change) => {
      redis.isReady = redis.isOpen = false;
      await expect(
        service.dispenseItem({
          ...request,
          ...change,
        } as unknown as DispenseItemRequest),
      ).rejects.toThrow();
      expect(redis.connect).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
      expect(core.dispenseItem).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'fails closed on acquisition error/unexpected reply: %s',
    async (unexpected) => {
      if (unexpected) redis.set.mockResolvedValue('unexpected private reply');
      else
        redis.set.mockRejectedValue(new Error('private acquisition details'));
      await expect(service.dispenseItem(request)).rejects.toMatchObject({
        status: 503,
        message: 'Dispensing service unavailable',
      });
      expect(core.dispenseItem).not.toHaveBeenCalled();
      expect(redis.eval).not.toHaveBeenCalled();
    },
  );

  it.each([
    new ConflictException('terminal'),
    new Error('original DB failure'),
  ])(
    'preserves the exact transaction error and releases once',
    async (error) => {
      core.dispenseItem.mockRejectedValue(error);
      await expect(service.dispenseItem(request)).rejects.toBe(error);
      expect(core.dispenseItem).toHaveBeenCalledTimes(1);
      expect(redis.eval).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    'cleanup failure preserves durable success/original failure: %s',
    async (failed) => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => {});
      redis.eval.mockRejectedValue(new Error('private cleanup details'));
      const original = new Error('original transaction failure');
      if (failed) core.dispenseItem.mockRejectedValue(original);
      const operation = service.dispenseItem(request);
      if (failed) await expect(operation).rejects.toBe(original);
      else await expect(operation).resolves.toBe(result);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'Dispensing lock release failed; lease will expire',
      );
    },
  );

  it.each([false, true])(
    'compare-delete protects a successor after expiry: %s',
    async (replaced) => {
      let owner: string | undefined;
      redis.set.mockImplementation(async (_key, token) => {
        owner = token;
        return 'OK';
      });
      core.dispenseItem.mockImplementation(async () => {
        if (replaced) owner = 'replacement-owner';
        return result;
      });
      redis.eval.mockImplementation(async (_script, { arguments: tokens }) => {
        if (owner !== tokens[0]) return 0;
        owner = undefined;
        return 1;
      });
      await expect(service.dispenseItem(request)).resolves.toBe(result);
      expect(owner).toBe(replaced ? 'replacement-owner' : undefined);
      expect(PHARMACY_RELEASE_LOCK).toMatch(
        /if redis\.call\('get', KEYS\[1\]\) == ARGV\[1\] then\s+return redis\.call\('del', KEYS\[1\]\)\s+end\s+return 0/,
      );
    },
  );

  it('coalesces concurrent lazy connections before either transaction starts', async () => {
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
      service.dispenseItem(request),
      service.dispenseItem({ ...request, prescriptionId: 'other' }),
    ]);
    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
    expect(core.dispenseItem).not.toHaveBeenCalled();
    finish();
    await expect(pending).resolves.toEqual([result, result]);
  });

  it('shares a failed connection, then safely retries the next attempt', async () => {
    redis.isOpen = redis.isReady = false;
    redis.connect.mockRejectedValueOnce(
      new Error('private connection details'),
    );
    const outcomes = await Promise.allSettled([
      service.dispenseItem(request),
      service.dispenseItem(request),
    ]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected')
        expect(outcome.reason).toBeInstanceOf(ServiceUnavailableException);
    }
    expect(redis.connect).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(core.dispenseItem).not.toHaveBeenCalled();
    redis.connect.mockImplementation(async () => {
      redis.isOpen = redis.isReady = true;
    });
    await expect(service.dispenseItem(request)).resolves.toBe(result);
    expect(redis.connect).toHaveBeenCalledTimes(2);
  });
});
