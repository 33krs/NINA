import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { FamiliesService } from './families.service';

describe('FamiliesService', () => {
  const family = {
    id: 'family-id',
    code: 'FAM-001',
    address: '1 Main Street',
    socialRiskLevel: 2,
  };

  const prisma = {
    family: {
      create: jest.fn<() => Promise<unknown>>(),
      findMany: jest.fn<() => Promise<unknown>>(),
      findUnique: jest.fn<() => Promise<unknown>>(),
      update: jest.fn<() => Promise<unknown>>(),
      delete: jest.fn<() => Promise<unknown>>(),
    },
  };

  let service: FamiliesService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FamiliesService(prisma as never);
  });

  it('creates a family', async () => {
    prisma.family.create.mockResolvedValue(family);

    await expect(service.create(family)).resolves.toEqual(family);
    expect(prisma.family.create).toHaveBeenCalledWith({ data: family });
  });

  it('lists families and returns a not-found error for an unknown id', async () => {
    prisma.family.findMany.mockResolvedValue([family]);
    prisma.family.findUnique.mockResolvedValue(null);

    await expect(service.findAll()).resolves.toEqual([family]);
    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('updates and deletes a family by id', async () => {
    prisma.family.findUnique.mockResolvedValue(family);
    prisma.family.update.mockResolvedValue(family);
    prisma.family.delete.mockResolvedValue(family);

    await expect(
      service.update('family-id', { address: '2 Main Street' }),
    ).resolves.toEqual(family);
    expect(prisma.family.update).toHaveBeenCalledWith({
      where: { id: 'family-id' },
      data: { address: '2 Main Street' },
    });
    await expect(service.remove('family-id')).resolves.toEqual(family);
  });
});
