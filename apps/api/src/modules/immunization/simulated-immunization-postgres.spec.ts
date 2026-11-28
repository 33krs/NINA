import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '@prisma/client';
import { SimulatedImmunizationPostgresRepository } from './simulated-immunization-postgres';

describe('SimulatedImmunizationPostgresRepository', () => {
  it('uses separate parameterized storage and scopes reads by patient', async () => {
    const execute = jest.fn(async (query: Prisma.Sql) => { void query; return 1; });
    const query = jest.fn(async (query: Prisma.Sql) => { void query; return []; });
    const repository = new SimulatedImmunizationPostgresRepository({ execute, query });
    const record = { patientId: 'patient-1', vaccineCode: 'practice-vaccine', dateAdministered: '2026-01-01' };
    await repository.insert(record);
    await repository.list(record.patientId);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toMatchObject({ values: [record.patientId] });
  });
});

describe('patient simulation classification', () => {
  it('updates only the selected patient and reports when it does not exist', async () => {
    const execute = jest.fn(async (query: Prisma.Sql) => { void query; return 0; });
    const query = jest.fn(async (query: Prisma.Sql) => { void query; return []; });
    const repository = new SimulatedImmunizationPostgresRepository({ execute, query });
    expect(await repository.markPatientSimulated('missing')).toBe(false);
    expect(execute.mock.calls[0][0]).toMatchObject({ values: ['missing'] });
  });
});
