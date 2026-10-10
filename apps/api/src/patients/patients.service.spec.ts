import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PatientsService } from './patients.service';

describe('PatientsService', () => {
  const patient = {
    id: 'patient-id',
    rut: '12.345.678-9',
    firstName: 'Ada',
    lastName: 'Lovelace',
    dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
    familyId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
  };

  const prisma = {
    patient: {
      create: jest.fn<() => Promise<unknown>>(),
      findMany: jest.fn<() => Promise<unknown>>(),
      findUnique: jest.fn<() => Promise<unknown>>(),
      update: jest.fn<() => Promise<unknown>>(),
      delete: jest.fn<() => Promise<unknown>>(),
    },
  };

  let service: PatientsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PatientsService(prisma as never);
  });

  it('creates a patient and converts the birth date for Prisma', async () => {
    prisma.patient.create.mockResolvedValue(patient);

    await expect(
      service.create({
        rut: patient.rut,
        firstName: patient.firstName,
        lastName: patient.lastName,
        dateOfBirth: '1990-01-01T00:00:00.000Z',
      }),
    ).resolves.toEqual(patient);
    expect(prisma.patient.create).toHaveBeenCalledWith({
      data: {
        rut: patient.rut,
        firstName: patient.firstName,
        lastName: patient.lastName,
        dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
      },
    });
  });

  it('lists patients and returns a not-found error for an unknown id', async () => {
    prisma.patient.findMany.mockResolvedValue([patient]);
    prisma.patient.findUnique.mockResolvedValue(null);

    await expect(service.findAll()).resolves.toEqual([patient]);
    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updates and deletes a patient by id', async () => {
    prisma.patient.findUnique.mockResolvedValue(patient);
    prisma.patient.update.mockResolvedValue(patient);
    prisma.patient.delete.mockResolvedValue(patient);

    await expect(
      service.update('patient-id', { firstName: 'Augusta' }),
    ).resolves.toEqual(patient);
    expect(prisma.patient.update).toHaveBeenCalledWith({
      where: { id: 'patient-id' },
      data: { firstName: 'Augusta' },
    });
    await expect(service.remove('patient-id')).resolves.toEqual(patient);
  });
});
