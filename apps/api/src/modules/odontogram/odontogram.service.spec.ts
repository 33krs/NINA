import { BadRequestException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service';
import { OdontogramService } from './odontogram.service';

describe('OdontogramService', () => {
  const patientId = 'patient-1';
  const odontogram = {
    id: 'odontogram-1',
    patientId,
    version: 0,
    teethStates: { tooth: 'intact' },
    updatedAt: new Date('2026-10-10T10:00:00.000Z'),
  };
  const revision = {
    id: 'revision-1',
    odontogramId: odontogram.id,
    version: 1,
    teethStates: { tooth: 'filled' },
    createdAt: new Date('2026-10-10T10:01:00.000Z'),
  };
  const tx = {
    $queryRaw: jest.fn<
      (
        query: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<Array<{ id: string }>>
    >(),
    patient: {
      findUnique: jest.fn<() => Promise<{ id: string } | null>>(),
    },
    odontogram: {
      findUnique: jest.fn<() => Promise<typeof odontogram | null>>(),
      create: jest.fn<() => Promise<typeof odontogram>>(),
      update: jest.fn<() => Promise<typeof odontogram>>(),
    },
    odontogramRevision: {
      create: jest.fn<() => Promise<typeof revision>>(),
      findMany: jest.fn<() => Promise<typeof revision[]>>(),
    },
  };
  const prisma = {
    $transaction: jest.fn<
      (callback: (transaction: typeof tx) => Promise<unknown>) => Promise<unknown>
    >(),
  };
  let service: OdontogramService;

  beforeEach(() => {
    jest.resetAllMocks();
    tx.$queryRaw.mockResolvedValue([{ id: patientId }]);
    tx.patient.findUnique.mockResolvedValue({ id: patientId });
    tx.odontogram.findUnique.mockResolvedValue(odontogram);
    tx.odontogram.create.mockResolvedValue(odontogram);
    tx.odontogram.update.mockResolvedValue(odontogram);
    tx.odontogramRevision.create.mockResolvedValue(revision);
    tx.odontogramRevision.findMany.mockResolvedValue([revision]);
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    service = new OdontogramService(prisma as unknown as PrismaService);
  });

  it('reads the current odontogram without creating missing state', async () => {
    tx.odontogram.findUnique.mockResolvedValue(null);

    await expect(service.getCurrent(patientId)).resolves.toBeNull();
    expect(tx.patient.findUnique).toHaveBeenCalledWith({
      where: { id: patientId },
      select: { id: true },
    });
    expect(tx.odontogram.create).not.toHaveBeenCalled();
  });

  it('returns a current state when one exists', async () => {
    await expect(service.getCurrent(patientId)).resolves.toEqual(odontogram);
  });

  it('rejects a current-state read for a missing patient', async () => {
    tx.patient.findUnique.mockResolvedValue(null);

    await expect(service.getCurrent(patientId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.odontogram.findUnique).not.toHaveBeenCalled();
  });

  it('creates version one and its snapshot for a patient without current state', async () => {
    tx.odontogram.findUnique.mockResolvedValue(null);

    await service.replaceCurrent(patientId, { tooth: 'filled' });

    const [lockQuery, lockedPatientId] = tx.$queryRaw.mock.calls[0];
    expect(lockQuery.join('')).toContain('FOR UPDATE');
    expect(lockedPatientId).toBe(patientId);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.odontogram.findUnique.mock.invocationCallOrder[0],
    );
    expect(tx.odontogram.create).toHaveBeenCalledWith({
      data: { patientId, version: 1, teethStates: { tooth: 'filled' } },
    });
    expect(tx.odontogramRevision.create).toHaveBeenCalledWith({
      data: {
        odontogramId: odontogram.id,
        version: 1,
        teethStates: { tooth: 'filled' },
      },
    });
  });

  it.each([
    [0, 1],
    [7, 8],
  ])('increments version %i to %i and records a matching snapshot', async (
    currentVersion,
    nextVersion,
  ) => {
    tx.odontogram.findUnique.mockResolvedValue({
      ...odontogram,
      version: currentVersion,
    });
    tx.odontogram.update.mockResolvedValue({
      ...odontogram,
      version: nextVersion,
    });
    tx.odontogramRevision.create.mockResolvedValue({
      ...revision,
      version: nextVersion,
    });

    const saved = await service.replaceCurrent(patientId, { tooth: 'filled' });

    expect(tx.odontogram.update).toHaveBeenCalledWith({
      where: { id: odontogram.id },
      data: { version: nextVersion, teethStates: { tooth: 'filled' } },
    });
    expect(tx.odontogramRevision.create).toHaveBeenCalledWith({
      data: {
        odontogramId: odontogram.id,
        version: nextVersion,
        teethStates: { tooth: 'filled' },
      },
    });
    expect(saved.version).toBe(nextVersion);
  });

  it('records a snapshot for an identical replacement', async () => {
    await service.replaceCurrent(patientId, odontogram.teethStates);

    expect(tx.odontogram.update).toHaveBeenCalledTimes(1);
    expect(tx.odontogramRevision.create).toHaveBeenCalledTimes(1);
  });

  it('checks the patient while holding a row lock before any write', async () => {
    tx.$queryRaw.mockResolvedValue([]);

    await expect(
      service.replaceCurrent(patientId, { tooth: 'filled' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.odontogram.update).not.toHaveBeenCalled();
    expect(tx.odontogram.create).not.toHaveBeenCalled();
    expect(tx.odontogramRevision.create).not.toHaveBeenCalled();
  });

  it('propagates a revision failure so the transaction cannot report success', async () => {
    const failure = new Error('snapshot insert failed');
    tx.odontogramRevision.create.mockRejectedValue(failure);

    await expect(
      service.replaceCurrent(patientId, { tooth: 'filled' }),
    ).rejects.toBe(failure);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('rejects null root JSON before opening a transaction', async () => {
    await expect(
      service.replaceCurrent(patientId, null as unknown as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns descending history with a bounded page size and cursor', async () => {
    await service.getVersions(patientId, { limit: 10, beforeVersion: 3 });

    expect(tx.odontogramRevision.findMany).toHaveBeenCalledWith({
      where: { odontogramId: odontogram.id, version: { lt: 3 } },
      orderBy: { version: 'desc' },
      take: 10,
    });
  });

  it('uses the default history page size', async () => {
    await service.getVersions(patientId);

    expect(tx.odontogramRevision.findMany).toHaveBeenCalledWith({
      where: { odontogramId: odontogram.id },
      orderBy: { version: 'desc' },
      take: 20,
    });
  });

  it('rejects invalid history pagination', async () => {
    await expect(service.getVersions(patientId, { limit: 101 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
