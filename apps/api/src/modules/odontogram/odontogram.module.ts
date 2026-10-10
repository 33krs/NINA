import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { OdontogramController } from './odontogram.controller';
import { OdontogramService } from './odontogram.service';

@Module({
  imports: [PrismaModule],
  controllers: [OdontogramController],
  providers: [OdontogramService],
})
export class OdontogramModule {}
