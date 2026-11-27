import { describe, expect, it } from '@jest/globals';
import { createSimulatedImmunization } from './simulated-immunization';

describe('createSimulatedImmunization', () => {
  it('labels a training record as simulated and preserves its supplied details', () => {
    const input = {
      patientId: 'training-patient',
      vaccineCode: 'training-vaccine',
      dateAdministered: '2026-01-01',
    };

    expect(createSimulatedImmunization(input)).toEqual({
      ...input,
      kind: 'simulation',
    });
  });
});
