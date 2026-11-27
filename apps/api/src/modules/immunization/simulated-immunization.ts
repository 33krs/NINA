export interface SimulatedImmunizationInput {
  patientId: string;
  vaccineCode: string;
  dateAdministered: string;
}

export interface SimulatedImmunization extends SimulatedImmunizationInput {
  kind: 'simulation';
}

/** A training representation only; it is not an official vaccination record. */
export function createSimulatedImmunization(
  input: SimulatedImmunizationInput,
): SimulatedImmunization {
  return {
    patientId: input.patientId,
    vaccineCode: input.vaccineCode,
    dateAdministered: input.dateAdministered,
    kind: 'simulation',
  };
}
