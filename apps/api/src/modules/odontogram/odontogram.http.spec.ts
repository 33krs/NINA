import { NotFoundException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { type AddressInfo } from 'node:net';
import { AppModule } from '../../app.module';
import { PrismaService } from '../../prisma/prisma.service';
import { OdontogramService } from './odontogram.service';
import { AccessBoundaryGuard } from '../auth/access-boundary.guard';

const { fetch } = globalThis;

describe('odontogram HTTP behavior (dependency doubles; access boundary overridden)', () => {
  const patientId = '3dfc6dbf-c6f9-478b-b7dc-ff6d9a622137';
  const current = {
    id: 'odontogram-1',
    patientId,
    version: 2,
    teethStates: { arbitrary: ['opaque', null, 1] },
    updatedAt: new Date('2026-10-10T10:00:00.000Z'),
  };
  const service = {
    getCurrent: jest.fn<(id: string) => Promise<unknown>>(),
    replaceCurrent: jest.fn<(id: string, value: unknown) => Promise<unknown>>(),
    getVersions:
      jest.fn<
        (
          id: string,
          options: { limit?: number; beforeVersion?: number },
        ) => Promise<unknown>
      >(),
  };
  let app: INestApplication;
  let url: string;

  const request = (path: string, init?: Parameters<typeof fetch>[1]) =>
    fetch(`${url}${path}`, init);
  const get = (path: string) => request(path);
  const put = (path: string, body: unknown) =>
    request(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeEach(async () => {
    jest.resetAllMocks();
    service.getCurrent.mockResolvedValue(current);
    service.replaceCurrent.mockImplementation(async (id, teethStates) => ({
      ...current,
      patientId: id,
      teethStates,
    }));
    service.getVersions.mockResolvedValue([]);

    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AccessBoundaryGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(OdontogramService)
      .useValue(service)
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app?.close();
  });

  it('returns 404 without creating state when no current odontogram exists', async () => {
    service.getCurrent.mockResolvedValue(null);

    const response = await get(`/patients/${patientId}/odontogram`);

    expect(response.status).toBe(404);
    expect(service.getCurrent).toHaveBeenCalledWith(patientId);
    expect(service.replaceCurrent).not.toHaveBeenCalled();
  });

  it('returns the current state from the patient-scoped route', async () => {
    const response = await get(`/patients/${patientId}/odontogram`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: current.id,
      version: current.version,
      teethStates: current.teethStates,
    });
    expect(service.getCurrent).toHaveBeenCalledWith(patientId);
  });

  it('validates patient UUIDs before calling the service', async () => {
    expect((await get('/patients/not-a-uuid/odontogram')).status).toBe(400);
    expect(service.getCurrent).not.toHaveBeenCalled();
  });

  it('preserves opaque non-null JSON replacement values', async () => {
    const values: unknown[] = [
      { arbitrary: ['opaque', null, 1] },
      ['opaque', 2, false],
      'opaque string',
      0,
      false,
    ];

    for (const teethStates of values) {
      const response = await put(`/patients/${patientId}/odontogram`, {
        teethStates,
      });

      expect(response.status).toBe(200);
      expect(service.replaceCurrent).toHaveBeenLastCalledWith(
        patientId,
        teethStates,
      );
    }
  });

  it('rejects a missing replacement state', async () => {
    expect((await put(`/patients/${patientId}/odontogram`, {})).status).toBe(
      400,
    );
    expect(service.replaceCurrent).not.toHaveBeenCalled();
  });

  it('rejects null root JSON while allowing nested nulls', async () => {
    expect(
      (await put(`/patients/${patientId}/odontogram`, { teethStates: null }))
        .status,
    ).toBe(400);
    expect(service.replaceCurrent).not.toHaveBeenCalled();
  });

  it('rejects unknown replacement envelope properties', async () => {
    expect(
      (
        await put(`/patients/${patientId}/odontogram`, {
          teethStates: {},
          actorId: 'invented',
        })
      ).status,
    ).toBe(400);
    expect(service.replaceCurrent).not.toHaveBeenCalled();
  });

  it('rejects invalid patient UUIDs on replacement', async () => {
    expect(
      (await put('/patients/not-a-uuid/odontogram', { teethStates: {} }))
        .status,
    ).toBe(400);
    expect(service.replaceCurrent).not.toHaveBeenCalled();
  });

  it('propagates a missing patient as HTTP 404', async () => {
    service.replaceCurrent.mockRejectedValue(new NotFoundException());

    expect(
      (await put(`/patients/${patientId}/odontogram`, { teethStates: {} }))
        .status,
    ).toBe(404);
  });

  it('gets bounded history with its default query options', async () => {
    const response = await get(`/patients/${patientId}/odontogram/history`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
    expect(service.getVersions).toHaveBeenCalledWith(patientId, {});
  });

  it('transforms integral pagination values and forwards the cursor', async () => {
    const response = await get(
      `/patients/${patientId}/odontogram/history?limit=100&beforeVersion=0`,
    );

    expect(response.status).toBe(200);
    expect(service.getVersions).toHaveBeenCalledWith(patientId, {
      limit: 100,
      beforeVersion: 0,
    });
  });

  it('accepts the largest PostgreSQL integer history cursor', async () => {
    const response = await get(
      `/patients/${patientId}/odontogram/history?beforeVersion=2147483647`,
    );

    expect(response.status).toBe(200);
    expect(service.getVersions).toHaveBeenCalledWith(patientId, {
      beforeVersion: 2147483647,
    });
  });

  it.each(['junk', '1junk', '1.5', '0', '101'])(
    'rejects invalid limit %s',
    async (limit) => {
      expect(
        (await get(`/patients/${patientId}/odontogram/history?limit=${limit}`))
          .status,
      ).toBe(400);
      expect(service.getVersions).not.toHaveBeenCalled();
    },
  );

  it.each(['junk', '-1', '1.5'])(
    'rejects invalid beforeVersion %s',
    async (beforeVersion) => {
      expect(
        (
          await get(
            `/patients/${patientId}/odontogram/history?beforeVersion=${beforeVersion}`,
          )
        ).status,
      ).toBe(400);
      expect(service.getVersions).not.toHaveBeenCalled();
    },
  );

  it.each(['2147483648', '9007199254740993'])(
    'rejects beforeVersion outside PostgreSQL integer range: %s',
    async (beforeVersion) => {
      expect(
        (
          await get(
            `/patients/${patientId}/odontogram/history?beforeVersion=${beforeVersion}`,
          )
        ).status,
      ).toBe(400);
      expect(service.getVersions).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown history query parameters', async () => {
    expect(
      (await get(`/patients/${patientId}/odontogram/history?offset=2`)).status,
    ).toBe(400);
    expect(service.getVersions).not.toHaveBeenCalled();
  });
});
