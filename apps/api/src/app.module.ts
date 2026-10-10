import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FamiliesModule } from './families/families.module';
import { PatientsModule } from './patients/patients.module';
import { PrismaModule } from './prisma/prisma.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { EncountersModule } from './modules/encounters/encounters.module';

@Module({
  imports: [
    PrismaModule,
    PatientsModule,
    FamiliesModule,
    AppointmentsModule,
    EncountersModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
  ],
})
export class AppModule {}
