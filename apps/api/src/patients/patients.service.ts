import { Injectable, NotFoundException } from '@nestjs/common';
import { CreatePatientDto } from './dto/create-patient.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PatientsService {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreatePatientDto) {
    const { dateOfBirth, ...patientData } = input;
    return this.prisma.patient.create({
      data: { ...patientData, dateOfBirth: new Date(dateOfBirth) },
    });
  }

  findAll() {
    return this.prisma.patient.findMany();
  }

  async findOne(id: string) {
    const patient = await this.prisma.patient.findUnique({ where: { id } });
    if (!patient) {
      throw new NotFoundException(`Patient with id ${id} was not found`);
    }
    return patient;
  }

  async update(id: string, input: UpdatePatientDto) {
    await this.findOne(id);
    const { dateOfBirth, ...patientData } = input;
    return this.prisma.patient.update({
      where: { id },
      data: {
        ...patientData,
        ...(dateOfBirth === undefined
          ? {}
          : { dateOfBirth: new Date(dateOfBirth) }),
      },
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.patient.delete({ where: { id } });
  }
}
