import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { EncountersController } from './encounters.controller';
import { EncountersService } from './encounters.service';

@Module({
  imports: [PrismaModule],
  controllers: [EncountersController],
  providers: [EncountersService],
})
export class EncountersModule {}
