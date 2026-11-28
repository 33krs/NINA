import { describe, expect, it, jest } from '@jest/globals';
import { SimulatedImmunizationStore } from './simulated-immunization-store';

describe('SimulatedImmunizationStore', () => {
  it('persists and retrieves a labelled simulation for one patient', async () => {
    const record = { patientId: 'patient-1', vaccineCode: 'practice-vaccine', dateAdministered: '2026-01-01' };
    const insert = jest.fn(async () => undefined);
    const list = jest.fn(async () => [record]);
    const store = new SimulatedImmunizationStore({ insert, list });
    await store.create(record);
    expect(insert).toHaveBeenCalledWith(record);
    expect(await store.findByPatient('patient-1')).toEqual([{ ...record, kind: 'simulation' }]);
    expect(list).toHaveBeenCalledWith('patient-1');
  });
});
