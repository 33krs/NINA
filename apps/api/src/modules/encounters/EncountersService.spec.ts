import { NotFoundException } from '@nestjs/common';
import { EncounterStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateEncounterDto } from './create-encounter.dto';
import { EncountersService } from './encounters.service';

describe('EncountersService', () => {
  const appointment = {
    id: 'appointment-1',
    patientId: 'patient-1',
    professionalId: 'professional-1',
    startTime: new Date('2026-10-10T10:00:00.000Z'),
  };
  const encounter = {
    id: 'encounter-1',
    appointmentId: appointment.id,
    patientId: appointment.patientId,
    professionalId: appointment.professionalId,
    date: appointment.startTime,
    status: EncounterStatus.IN_PROGRESS,
    soapSubjective: 'Headache',
    soapObjective: null,
    soapAssessment: null,
    soapPlan: null,
  };
  const prisma = {
    appointment: {
      findUnique: jest.fn<() => Promise<typeof appointment | null>>(),
    },
    encounter: {
      create: jest.fn<() => Promise<typeof encounter>>(),
    },
  };
  let service: EncountersService;

  beforeEach(() => {
    jest.resetAllMocks();
    service = new EncountersService(prisma as unknown as PrismaService);
  });

  it('creates an encounter using its appointment details', async () => {
    prisma.appointment.findUnique.mockResolvedValue(appointment);
    prisma.encounter.create.mockResolvedValue(encounter);
    const input: CreateEncounterDto = {
      appointmentId: appointment.id,
      status: EncounterStatus.IN_PROGRESS,
      soapSubjective: 'Headache',
    };

    await expect(service.create(input)).resolves.toEqual(encounter);
    expect(prisma.appointment.findUnique).toHaveBeenCalledWith({
      where: { id: appointment.id },
      select: {
        id: true,
        patientId: true,
        professionalId: true,
        startTime: true,
      },
    });
    expect(prisma.encounter.create).toHaveBeenCalledWith({
      data: {
        appointmentId: appointment.id,
        patientId: appointment.patientId,
        professionalId: appointment.professionalId,
        date: appointment.startTime,
        status: EncounterStatus.IN_PROGRESS,
        soapSubjective: 'Headache',
      },
    });
  });

  it('rejects an appointment that does not exist', async () => {
    prisma.appointment.findUnique.mockResolvedValue(null);
    const input: CreateEncounterDto = {
      appointmentId: 'missing-appointment',
      status: EncounterStatus.IN_PROGRESS,
    };

    await expect(service.create(input)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.encounter.create).not.toHaveBeenCalled();
  });
});
