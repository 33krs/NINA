import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AppointmentLockService } from './appointment-lock.service';
import { ReserveAppointmentDto } from './reserve-appointment.dto';

function isExactSlotCollision(error: unknown): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2002'
  )
    return false;
  const target = error.meta?.target;
  return (
    (error.meta?.modelName === undefined ||
      error.meta.modelName === 'Appointment') &&
    Array.isArray(target) &&
    target.length === 3 &&
    ['professionalId', 'startTime', 'endTime'].every((field) =>
      target.includes(field),
    )
  );
}

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: AppointmentLockService,
  ) {}

  async reserve(input: ReserveAppointmentDto) {
    const startTime = new Date(input.startTime);
    const endTime = new Date(input.endTime);
    if (
      !Number.isFinite(startTime.getTime()) ||
      !Number.isFinite(endTime.getTime()) ||
      endTime <= startTime
    ) {
      throw new BadRequestException('endTime must be after startTime');
    }
    const key = `appointment:slot:${JSON.stringify([input.professionalId, startTime.toISOString(), endTime.toISOString()])}`;
    const owner = randomUUID();
    let acquired: boolean;
    try {
      acquired = await this.locks.acquire(key, owner);
    } catch {
      throw new ServiceUnavailableException('Reservation service unavailable');
    }
    if (!acquired)
      throw new ConflictException('Exact slot is already being reserved');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const patient = await tx.patient.findUnique({
          where: { id: input.patientId },
          select: { id: true },
        });
        if (!patient) throw new NotFoundException('Patient not found');
        return tx.appointment.create({
          data: { ...input, startTime, endTime },
        });
      });
    } catch (error: unknown) {
      if (isExactSlotCollision(error))
        throw new ConflictException('Exact slot is already reserved');
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException('Unable to reserve appointment');
    } finally {
      await this.locks.release(key, owner);
    }
  }
}
