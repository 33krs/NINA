import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import type { SimulatedImmunizationInput } from './simulated-immunization';
import type { SimulatedImmunizationRepository } from './simulated-immunization-store';

export interface SimulatedImmunizationDatabase {
  execute(query: Prisma.Sql): Promise<number>;
  query(query: Prisma.Sql): Promise<SimulatedImmunizationInput[]>;
}

/** Internal adapter; the database enforces the simulated-patient boundary. */
export class SimulatedImmunizationPostgresRepository implements SimulatedImmunizationRepository {
  constructor(private readonly database: SimulatedImmunizationDatabase) {}

  async markPatientSimulated(patientId: string): Promise<boolean> {
    const updated = await this.database.execute(Prisma.sql`
      UPDATE "Patient" SET "isSimulated" = true WHERE "id" = ${patientId}
    `);
    return updated === 1;
  }

  async insert(input: SimulatedImmunizationInput): Promise<void> {
    await this.database.execute(Prisma.sql`
      INSERT INTO "SimulatedImmunization" ("id", "patientId", "vaccineCode", "dateAdministered")
      VALUES (${randomUUID()}, ${input.patientId}, ${input.vaccineCode}, ${input.dateAdministered})
    `);
  }

  async list(patientId: string): Promise<SimulatedImmunizationInput[]> {
    return this.database.query(Prisma.sql`
      SELECT "patientId", "vaccineCode", "dateAdministered"
      FROM "SimulatedImmunization" WHERE "patientId" = ${patientId}
      ORDER BY "id"
    `);
  }
}
