import { describe, expect, it, jest } from '@jest/globals';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SimulatedImmunizationModule } from './simulated-immunization.module';
import { SimulatedImmunizationStore } from './simulated-immunization-store';
import { SimulatedImmunizationPostgresRepository } from './simulated-immunization-postgres';

describe('SimulatedImmunizationModule', () => {
  it('connects the internal store and classification to Prisma', async () => {
    const execute = jest.fn(async (query: Prisma.Sql) => { void query; return 1; });
    const query = jest.fn(async (query: Prisma.Sql) => { void query; return []; });
    const module = await Test.createTestingModule({ imports: [SimulatedImmunizationModule] })
      .overrideProvider(PrismaService)
      .useValue({ $executeRaw: execute, $queryRaw: query })
      .compile();
    const repository = module.get(SimulatedImmunizationPostgresRepository);
    const store = module.get(SimulatedImmunizationStore);
    expect(await repository.markPatientSimulated('patient')).toBe(true);
    await store.create({ patientId: 'patient', vaccineCode: 'practice', dateAdministered: '2026-01-01' });
    expect(await store.findByPatient('patient')).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(1);
    await module.close();
  });
});
