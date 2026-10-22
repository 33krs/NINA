import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
import { AppModule } from '../../app.module';
import { FamiliesService } from '../../families/families.service';
import { PatientsService } from '../../patients/patients.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AppointmentsService } from '../appointments/appointments.service';
import { EncountersService } from '../encounters/encounters.service';
import { OdontogramService } from '../odontogram/odontogram.service';

const { fetch } = globalThis;

@Controller('health-lookalike')
class HealthLookalikeController {
  @Get()
  getHealthCheck() {
    return { status: 'not-the-health-handler' };
  }
}

describe('temporary global access boundary over HTTP (no guard override)', () => {
  const id = '3dfc6dbf-c6f9-478b-b7dc-ff6d9a622137';
  const clinical = {
    create: jest.fn(async () => []),
    findAll: jest.fn(async () => []),
    findOne: jest.fn(async () => []),
    update: jest.fn(async () => []),
    remove: jest.fn(async () => []),
    reserve: jest.fn(async () => []),
    getCurrent: jest.fn(async () => []),
    replaceCurrent: jest.fn(async () => []),
    getVersions: jest.fn(async () => []),
  };
  let app: INestApplication;
  let url: string;

  beforeAll(async () => {
    const builder = Test.createTestingModule({
      imports: [AppModule],
      controllers: [HealthLookalikeController],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider('APPOINTMENT_REDIS')
      .useValue({ isOpen: false });
    for (const service of [
      PatientsService,
      FamiliesService,
      AppointmentsService,
      EncountersService,
      OdontogramService,
    ]) {
      builder.overrideProvider(service).useValue(clinical);
    }
    const module = await builder.compile();
    app = module.createNestApplication({ logger: false });
    app.use((request: Request, _response: Response, next: NextFunction) => {
      // Simulate identity attached by an untrusted earlier middleware.
      (request as Request & { user: unknown }).user = {
        id,
        role: 'ADMIN',
        isAuthenticated: true,
      };
      next();
    });
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  beforeEach(() => jest.clearAllMocks());
  afterAll(async () => app?.close());

  it.each([
    ['GET', '/patients'],
    ['GET', `/patients/${id}`],
    ['POST', '/patients'],
    ['PATCH', `/patients/${id}`],
    ['DELETE', `/patients/${id}`],
    ['GET', '/families'],
    ['GET', `/families/${id}`],
    ['POST', '/families'],
    ['PATCH', `/families/${id}`],
    ['DELETE', `/families/${id}`],
    ['POST', '/appointments'],
    ['POST', '/encounters'],
    ['GET', `/patients/${id}/odontogram`],
    ['PUT', `/patients/${id}/odontogram`],
    ['GET', `/patients/${id}/odontogram/history`],
  ])('denies %s %s before clinical service work', async (method, path) => {
    const response = await fetch(`${url}${path}`, {
      method,
      ...(method === 'GET'
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: '{}' }),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      statusCode: 401,
      message: 'Unauthorized',
    });
    for (const operation of Object.values(clinical)) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it('ignores forged credentials, proxy headers, and middleware identity', async () => {
    const response = await fetch(`${url}/patients`, {
      headers: {
        authorization: 'Bearer forged-test-credential',
        cookie: 'session=forged-test-credential',
        'x-user-role': 'ADMIN',
        'x-forwarded-uri': '/',
        'x-original-url': '/',
      },
    });
    expect(response.status).toBe(401);
    expect(clinical.findAll).not.toHaveBeenCalled();
  });

  it('allows the existing GET health handler', async () => {
    const response = await fetch(`${url}/`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', name: 'NINA API' });
  });

  it('denies automatic HEAD handling of the health route', async () => {
    expect((await fetch(`${url}/`, { method: 'HEAD' })).status).toBe(401);
  });

  it('denies another controller with the same health method name', async () => {
    expect((await fetch(`${url}/health-lookalike`)).status).toBe(401);
  });

  it.each(['/health', '/health-lookalike/extra', '/patients-extra'])(
    'does not broaden the health exception to %s',
    async (path) => {
      expect((await fetch(`${url}${path}`)).status).toBe(404);
    },
  );

  it('does not create a POST health route', async () => {
    expect((await fetch(`${url}/`, { method: 'POST' })).status).toBe(404);
  });
});
