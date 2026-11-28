import {
  createSimulatedImmunization,
  type SimulatedImmunization,
  type SimulatedImmunizationInput,
} from './simulated-immunization';

/** Internal persistence boundary; it is not registered as an HTTP provider. */
export interface SimulatedImmunizationRepository {
  insert(input: SimulatedImmunizationInput): Promise<void>;
  list(patientId: string): Promise<SimulatedImmunizationInput[]>;
}

export class SimulatedImmunizationStore {
  constructor(private readonly repository: SimulatedImmunizationRepository) {}

  async create(input: SimulatedImmunizationInput): Promise<void> {
    await this.repository.insert(input);
  }

  async findByPatient(patientId: string): Promise<SimulatedImmunization[]> {
    const records = await this.repository.list(patientId);
    return records.map(createSimulatedImmunization);
  }
}
