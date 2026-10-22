import { Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { FamiliesModule } from './families/families.module';
import { PatientsModule } from './patients/patients.module';
import { PrismaModule } from './prisma/prisma.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { EncountersModule } from './modules/encounters/encounters.module';
import { OdontogramModule } from './modules/odontogram/odontogram.module';
import { AccessBoundaryGuard } from './modules/auth/access-boundary.guard';

@Module({
  imports: [
    PrismaModule,
    PatientsModule,
    FamiliesModule,
    AppointmentsModule,
    EncountersModule,
    OdontogramModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    AccessBoundaryGuard,
    { provide: APP_GUARD, useExisting: AccessBoundaryGuard },
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
