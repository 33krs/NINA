import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { SimulatedImmunizationPostgresRepository } from './simulated-immunization-postgres';
import { SimulatedImmunizationStore } from './simulated-immunization-store';

@Module({
  imports: [PrismaModule],
  providers: [
    {
      provide: SimulatedImmunizationPostgresRepository,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new SimulatedImmunizationPostgresRepository({
          execute: (query) => prisma.$executeRaw(query),
          query: (query) => prisma.$queryRaw(query),
        }),
    },
    {
      provide: SimulatedImmunizationStore,
      inject: [SimulatedImmunizationPostgresRepository],
      useFactory: (repository: SimulatedImmunizationPostgresRepository) =>
        new SimulatedImmunizationStore(repository),
    },
  ],
  exports: [SimulatedImmunizationPostgresRepository, SimulatedImmunizationStore],
})
export class SimulatedImmunizationModule {}
