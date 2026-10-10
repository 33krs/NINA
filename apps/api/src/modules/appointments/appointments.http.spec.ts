import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Prisma, type Appointment } from '@prisma/client';
import { type AddressInfo } from 'node:net';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../prisma/prisma.service';

const { fetch } = globalThis;

describe('appointment reservations over HTTP (dependency doubles)', () => {
  const input = {
    patientId: '3dfc6dbf-c6f9-478b-b7dc-ff6d9a622137',
    professionalId: 'professional-1',
    startTime: '2030-01-01T10:00:00Z',
    endTime: '2030-01-01T10:30:00Z',
    status: 'PENDING',
  };
  const owners = new Map<string, string>();
  const redis = {
    isOpen: true,
    isReady: true,
    connect: jest.fn<() => Promise<void>>(),
    destroy: jest.fn(),
    set: jest.fn<
      (key: string, owner: string, options: unknown) => Promise<string | null>
    >(),
    eval: jest.fn<
      (
        script: string,
        options: { keys: string[]; arguments: string[] },
      ) => Promise<number>
    >(),
    withCommandOptions: jest.fn(),
  };
  const transaction = {
    patient: { findUnique: jest.fn<() => Promise<unknown>>() },
    appointment: {
      create:
        jest.fn<
          (args: { data: Omit<Appointment, 'id'> }) => Promise<Appointment>
        >(),
    },
  };
  const prisma = {
    $transaction:
      jest.fn<
        (
          fn: (tx: typeof transaction) => Promise<Appointment>,
        ) => Promise<Appointment>
      >(),
  };
  let app: INestApplication;
  let url: string;
  const post = (body: unknown = input) =>
    fetch(`${url}/appointments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    jest.resetAllMocks();
    owners.clear();
    redis.isOpen = redis.isReady = true;
    redis.withCommandOptions.mockReturnValue(redis);
    redis.set.mockImplementation(async (key, owner) => {
      if (owners.has(key)) return null;
      owners.set(key, owner);
      return 'OK';
    });
    redis.eval.mockImplementation(
      async (_script, { keys, arguments: args }) => {
        if (owners.get(keys[0]) !== args[0]) return 0;
        owners.delete(keys[0]);
        return 1;
      },
    );
    transaction.patient.findUnique.mockResolvedValue({ id: input.patientId });
    transaction.appointment.create.mockImplementation(async ({ data }) => ({
      id: 'reservation-1',
      ...data,
    }));
    prisma.$transaction.mockImplementation(async (fn) => fn(transaction));
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider('APPOINTMENT_REDIS')
      .useValue(redis)
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app?.close();
  });

  it('reserves through a transaction after acquiring an expiring owner lock', async () => {
    const response = await post();
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      patientId: input.patientId,
      status: 'PENDING',
    });
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      { NX: true, PX: 10000 },
    );
    expect(redis.set.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.$transaction.mock.invocationCallOrder[0],
    );
    expect(transaction.appointment.create).toHaveBeenCalledWith({
      data: {
        ...input,
        startTime: new Date(input.startTime),
        endTime: new Date(input.endTime),
      },
    });
    expect(owners.size).toBe(0);
    await expect(fetch(`${url}/`)).resolves.toMatchObject({ status: 200 });
  });

  it.each([
    { endTime: input.startTime },
    { endTime: '2030-01-01T09:00:00Z' },
    { startTime: '2030-01-01T10:00:00' },
    { startTime: '2030-02-30T10:00:00Z' },
    { startTime: '2030-01-01T10:00:00-00:00' },
    { startTime: '2030-01-01T10:00:00.0001Z' },
    { status: undefined },
    { status: 'SCHEDULED' },
    { patientId: 'invalid' },
    { professionalId: ' ' },
  ])('rejects invalid input before Redis or Prisma: %j', async (patch) => {
    expect((await post({ ...input, ...patch })).status).toBe(400);
    expect(redis.set).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing patient without creating an appointment', async () => {
    transaction.patient.findUnique.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
    expect(transaction.appointment.create).not.toHaveBeenCalled();
    expect(owners.size).toBe(0);
  });

  it('fails closed on Redis acquisition errors without leaking internals', async () => {
    redis.set.mockRejectedValue(new Error('private Redis details'));
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private Redis details');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    [['professionalId', 'startTime', 'endTime'], 409],
    [['id'], 500],
    [undefined, 500],
  ])(
    'maps only confirmed exact-slot P2002 targets: %j',
    async (target, status) => {
      transaction.appointment.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('private DB details', {
          code: 'P2002',
          clientVersion: '6.19.3',
          meta: { modelName: 'Appointment', target },
        }),
      );
      const response = await post();
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain('private DB details');
      expect(owners.size).toBe(0);
    },
  );

  it.each([false, true])(
    'release failure preserves durable success or domain failure: %s',
    async (missing) => {
      if (missing) transaction.patient.findUnique.mockResolvedValue(null);
      redis.eval.mockRejectedValue(new Error('private release details'));
      expect((await post()).status).toBe(missing ? 404 : 201);
    },
  );

  it('does not remove a replacement owner after expiry', async () => {
    transaction.appointment.create.mockImplementation(async ({ data }) => {
      owners.set(redis.set.mock.calls[0][0], 'replacement-owner');
      return { id: 'reservation-1', ...data };
    });
    expect((await post()).status).toBe(201);
    expect([...owners.values()]).toEqual(['replacement-owner']);
    expect(redis.eval.mock.calls[0][0]).toMatch(/get.*KEYS\[1\].*ARGV\[1\]/s);
    expect(redis.eval.mock.calls[0][0]).toMatch(/del.*KEYS\[1\]/s);
  });

  it('gives identical concurrent requests one 201 and one 409 (canonical offset keys)', async () => {
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    prisma.$transaction.mockImplementation(async (fn) => {
      entered();
      await pending;
      return fn(transaction);
    });
    const first = post();
    try {
      await started;
      expect((await post()).status).toBe(409);
      expect(
        (
          await post({
            ...input,
            startTime: '2030-01-01T07:00:00-03:00',
            endTime: '2030-01-01T07:30:00-03:00',
          })
        ).status,
      ).toBe(409);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(redis.eval).not.toHaveBeenCalled();
      expect(new Set(redis.set.mock.calls.map((call) => call[1])).size).toBe(3);
      expect(new Set(redis.set.mock.calls.map((call) => call[0])).size).toBe(1);
    } finally {
      finish();
    }
    expect((await first).status).toBe(201);
    expect(transaction.appointment.create).toHaveBeenCalledTimes(1);
  });

  it('allows partial overlaps rather than inventing an overlap policy', async () => {
    expect((await post()).status).toBe(201);
    expect(
      (
        await post({
          ...input,
          endTime: '2030-01-01T11:00:00Z',
          status: 'CANCELLED',
        })
      ).status,
    ).toBe(201);
    expect(redis.set.mock.calls[0][0]).not.toEqual(redis.set.mock.calls[1][0]);
  });

  it('fails closed on connection failure and unexpected acquisition replies', async () => {
    redis.isOpen = redis.isReady = false;
    redis.connect.mockRejectedValue(new Error('private connection details'));
    expect((await post()).status).toBe(503);
    redis.isOpen = redis.isReady = true;
    redis.set.mockResolvedValue('unexpected');
    expect((await post()).status).toBe(503);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
