import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import {
  AppointmentLockService,
  createAppointmentRedis,
} from './appointment-lock.service';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsService } from './appointments.service';

@Module({
  imports: [PrismaModule],
  controllers: [AppointmentsController],
  providers: [
    AppointmentsService,
    AppointmentLockService,
    {
      provide: 'APPOINTMENT_REDIS',
      useFactory: createAppointmentRedis,
    },
  ],
})
export class AppointmentsModule {}
