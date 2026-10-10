import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateEncounterDto } from './create-encounter.dto';

@Injectable()
export class EncountersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateEncounterDto) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: input.appointmentId },
      select: {
        id: true,
        patientId: true,
        professionalId: true,
        startTime: true,
      },
    });
    if (!appointment) throw new NotFoundException('Appointment not found');

    return this.prisma.encounter.create({
      data: {
        appointmentId: appointment.id,
        patientId: appointment.patientId,
        professionalId: appointment.professionalId,
        date: appointment.startTime,
        status: input.status,
        soapSubjective: input.soapSubjective,
        soapObjective: input.soapObjective,
        soapAssessment: input.soapAssessment,
        soapPlan: input.soapPlan,
      },
    });
  }
}
