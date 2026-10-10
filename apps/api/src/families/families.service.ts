import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFamilyDto } from './dto/create-family.dto';
import { UpdateFamilyDto } from './dto/update-family.dto';

@Injectable()
export class FamiliesService {
  constructor(private readonly prisma: PrismaService) {}

  create(input: CreateFamilyDto) {
    return this.prisma.family.create({ data: input });
  }

  findAll() {
    return this.prisma.family.findMany();
  }

  async findOne(id: string) {
    const family = await this.prisma.family.findUnique({ where: { id } });
    if (!family) {
      throw new NotFoundException(`Family with id ${id} was not found`);
    }
    return family;
  }

  async update(id: string, input: UpdateFamilyDto) {
    await this.findOne(id);
    return this.prisma.family.update({ where: { id }, data: input });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.prisma.family.delete({ where: { id } });
  }
}
