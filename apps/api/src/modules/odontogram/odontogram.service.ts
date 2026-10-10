import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type Odontogram,
  type OdontogramRevision,
  type Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface OdontogramHistoryOptions {
  limit?: number;
  beforeVersion?: number;
}

@Injectable()
export class OdontogramService {
  constructor(private readonly prisma: PrismaService) {}

  async getCurrent(patientId: string): Promise<Odontogram | null> {
    return this.prisma.$transaction(async (tx) => {
      await this.requirePatient(tx, patientId);
      return tx.odontogram.findUnique({ where: { patientId } });
    });
  }

  async replaceCurrent(
    patientId: string,
    teethStates: Prisma.InputJsonValue,
  ): Promise<Odontogram> {
    if (teethStates === null) {
      throw new BadRequestException('teethStates must not be null');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lockPatient(tx, patientId);
      const current = await tx.odontogram.findUnique({ where: { patientId } });
      const version = (current?.version ?? 0) + 1;
      const saved = current
        ? await tx.odontogram.update({
            where: { id: current.id },
            data: { version, teethStates },
          })
        : await tx.odontogram.create({
            data: { patientId, version, teethStates },
          });

      await tx.odontogramRevision.create({
        data: { odontogramId: saved.id, version, teethStates },
      });
      return saved;
    });
  }

  async getVersions(
    patientId: string,
    options: OdontogramHistoryOptions = {},
  ): Promise<OdontogramRevision[]> {
    const limit = options.limit ?? DEFAULT_PAGE_SIZE;
    const { beforeVersion } = options;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      throw new BadRequestException(
        `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`,
      );
    }
    if (
      beforeVersion !== undefined &&
      (!Number.isInteger(beforeVersion) || beforeVersion < 0)
    ) {
      throw new BadRequestException('beforeVersion must be a non-negative integer');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.requirePatient(tx, patientId);
      const current = await tx.odontogram.findUnique({ where: { patientId } });
      if (!current) return [];

      return tx.odontogramRevision.findMany({
        where: {
          odontogramId: current.id,
          ...(beforeVersion === undefined
            ? {}
            : { version: { lt: beforeVersion } }),
        },
        orderBy: { version: 'desc' },
        take: limit,
      });
    });
  }

  private async requirePatient(
    tx: Prisma.TransactionClient,
    patientId: string,
  ): Promise<void> {
    const patient = await tx.patient.findUnique({
      where: { id: patientId },
      select: { id: true },
    });
    if (!patient) throw new NotFoundException('Patient not found');
  }

  private async lockPatient(
    tx: Prisma.TransactionClient,
    patientId: string,
  ): Promise<void> {
    // The patient row serializes first-time and subsequent writes for this patient.
    const patients = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "Patient" WHERE "id" = ${patientId} FOR UPDATE
    `;
    if (patients.length === 0) throw new NotFoundException('Patient not found');
  }
}
