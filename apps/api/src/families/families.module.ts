import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { FamiliesController } from './families.controller';
import { FamiliesService } from './families.service';

@Module({
  imports: [PrismaModule],
  controllers: [FamiliesController],
  providers: [FamiliesService],
})
export class FamiliesModule {}
