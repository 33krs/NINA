import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { type AddressInfo } from 'node:net';
import { createClient } from 'redis';
import { env } from 'node:process';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../prisma/prisma.service';
import {
  AppointmentLockService,
  LOCK_TTL_MS,
  RELEASE_LOCK,
} from './appointment-lock.service';

interface CleanupContext {
  redisReady: () => boolean;
  created: boolean;
  releaseOwner: (owner: string) => Promise<unknown>;
  deleteAppointments: () => Promise<unknown>;
  deletePatient: () => Promise<unknown>;
  assertAppointmentsAbsent: () => Promise<unknown>;
  assertPatientAbsent: () => Promise<unknown>;
  closeApp: () => Promise<unknown> | undefined;
  redisOpen: () => boolean;
  destroyRedis: () => void;
  disconnectPrisma: () => Promise<unknown>;
}

async function cleanupLiveFixture(context: CleanupContext): Promise<void> {
  const errors: unknown[] = [];
  const attempt = async (action: () => unknown) => {
    try {
      await action();
    } catch (error: unknown) {
      errors.push(error);
    }
  };

  for (const owner of ['first-owner', 'next-owner']) {
    await attempt(async () => {
      if (context.redisReady()) await context.releaseOwner(owner);
    });
  }
  if (context.created) {
    await attempt(context.deleteAppointments);
    await attempt(context.deletePatient);
    await attempt(context.assertAppointmentsAbsent);
    await attempt(context.assertPatientAbsent);
  }
  await attempt(context.closeApp);
  await attempt(() => {
    if (context.redisOpen()) context.destroyRedis();
  });
  await attempt(context.disconnectPrisma);

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Live appointment fixture cleanup failed');
  }
}

const cleanupOrder = [
  'first-owner',
  'next-owner',
  'deleteAppointments',
  'deletePatient',
  'assertAppointmentsAbsent',
  'assertPatientAbsent',
  'closeApp',
  'destroyRedis',
  'disconnectPrisma',
] as const;

function cleanupDouble(failures: ReadonlyMap<string, unknown>) {
  const calls: string[] = [];
  const action = (name: string) => {
    calls.push(name);
    if (failures.has(name)) throw failures.get(name);
  };
  const context: CleanupContext = {
    redisReady: () => true,
    created: true,
    releaseOwner: async (owner) => action(owner),
    deleteAppointments: async () => action('deleteAppointments'),
    deletePatient: async () => action('deletePatient'),
    assertAppointmentsAbsent: async () => action('assertAppointmentsAbsent'),
    assertPatientAbsent: async () => action('assertPatientAbsent'),
    closeApp: async () => action('closeApp'),
    redisOpen: () => true,
    destroyRedis: () => action('destroyRedis'),
    disconnectPrisma: async () => action('disconnectPrisma'),
  };
  return { context, calls };
}

describe('live fixture cleanup without services', () => {
  it.each(cleanupOrder)(
    'continues after %s fails and retains its error',
    async (failedAction) => {
      const original = new Error(failedAction);
      const { context, calls } = cleanupDouble(
        new Map([[failedAction, original]]),
      );
      const result: unknown = await cleanupLiveFixture(context).catch(
        (error: unknown) => error,
      );
      expect(calls).toEqual(cleanupOrder);
      expect(result).toBeInstanceOf(AggregateError);
      expect((result as AggregateError).errors).toEqual([original]);
    },
  );

  it('retains every original rejection, including non-Error values, in action order', async () => {
    const originals = cleanupOrder.map((name, index) =>
      index === 0 ? undefined : new Error(name),
    );
    const failures = new Map(
      cleanupOrder.map((name, index) => [name, originals[index]]),
    );
    const { context, calls } = cleanupDouble(failures);
    const result: unknown = await cleanupLiveFixture(context).catch(
      (error: unknown) => error,
    );
    expect(calls).toEqual(cleanupOrder);
    expect(result).toBeInstanceOf(AggregateError);
    const errors = (result as AggregateError).errors as unknown[];
    expect(errors).toHaveLength(originals.length);
    errors.forEach((error, index) => expect(error).toBe(originals[index]));
  });

  it('preserves readiness and created guards while always attempting shutdown', async () => {
    const { context, calls } = cleanupDouble(new Map());
    context.redisReady = () => false;
    context.created = false;
    context.redisOpen = () => false;
    await expect(cleanupLiveFixture(context)).resolves.toBeUndefined();
    expect(calls).toEqual(['closeApp', 'disconnectPrisma']);
  });

  it('completes every action without reporting errors when cleanup succeeds', async () => {
    const { context, calls } = cleanupDouble(new Map());
    await expect(cleanupLiveFixture(context)).resolves.toBeUndefined();
    expect(calls).toEqual(cleanupOrder);
  });
});

// Explicit opt-in; only the repository's localhost Compose development services.
const { fetch } = globalThis;
const live =
  env.NINA_APPOINTMENTS_LIVE_TESTS === '1' ? describe : describe.skip;
live('appointment acceptance with actual local Redis/PostgreSQL', () => {
  const fixture = randomUUID();
  const prisma = new PrismaService({
    datasourceUrl:
      'postgresql://nina_admin:nina_dev_password@127.0.0.1:5432/nina_db',
  });
  const redis = createClient({
    url: 'redis://127.0.0.1:6379',
    disableOfflineQueue: true,
    socket: {
      connectTimeout: 1500,
      socketTimeout: 1500,
      reconnectStrategy: false,
    },
  });
  redis.on('error', () => {
    /* Command rejections surface service failures. */
  });
  const input = {
    patientId: fixture,
    professionalId: `step5-test-${fixture}`,
    startTime: '2035-01-01T10:00:00Z',
    endTime: '2035-01-01T10:30:00Z',
    status: 'PENDING',
  };
  const key = `appointment:acceptance:${fixture}`;
  let created = false;
  let app: INestApplication | undefined;
  let url: string;

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider('APPOINTMENT_REDIS')
      .useValue(redis)
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    await prisma.patient.create({
      data: {
        id: fixture,
        rut: `step5-test-${fixture}`,
        firstName: 'Acceptance',
        lastName: 'Fixture',
        dateOfBirth: new Date('1990-01-01T00:00:00Z'),
      },
    });
    created = true;
  });

  afterAll(async () => {
    await cleanupLiveFixture({
      redisReady: () => redis.isReady,
      created,
      releaseOwner: (owner) =>
        redis.eval(RELEASE_LOCK, { keys: [key], arguments: [owner] }),
      deleteAppointments: () =>
        prisma.appointment.deleteMany({
          where: { patientId: fixture, professionalId: input.professionalId },
        }),
      deletePatient: () => prisma.patient.delete({ where: { id: fixture } }),
      assertAppointmentsAbsent: async () => {
        expect(
          await prisma.appointment.count({ where: { patientId: fixture } }),
        ).toBe(0);
      },
      assertPatientAbsent: async () => {
        expect(
          await prisma.patient.findUnique({ where: { id: fixture } }),
        ).toBeNull();
      },
      closeApp: () => app?.close(),
      redisOpen: () => redis.isOpen,
      destroyRedis: () => redis.destroy(),
      disconnectPrisma: () => prisma.$disconnect(),
    });
  });

  it('persists exactly one of two concurrent HTTP reservations; later duplicate is 409', async () => {
    const post = () =>
      fetch(`${url}/appointments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    const responses = await Promise.all([post(), post()]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 409,
    ]);
    expect(
      await prisma.appointment.count({
        where: { patientId: fixture, professionalId: input.professionalId },
      }),
    ).toBe(1);
    expect((await post()).status).toBe(409);
  });

  it('sets a real lease TTL and prevents an expired owner deleting the successor', async () => {
    const locks = app!.get(AppointmentLockService);
    expect(await locks.acquire(key, 'first-owner')).toBe(true);
    const ttl = await redis.pTTL(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(LOCK_TTL_MS);
    // Expire only this test-owned key, without waiting ten seconds.
    await redis.pExpire(key, 0);
    expect(await locks.acquire(key, 'next-owner')).toBe(true);
    await locks.release(key, 'first-owner');
    expect(await redis.get(key)).toBe('next-owner');
    await locks.release(key, 'next-owner');
    expect(await redis.get(key)).toBeNull();
  });
});
