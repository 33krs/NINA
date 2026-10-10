import { AppointmentStatus } from '@prisma/client';
import {
  IsEnum,
  IsISO8601,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

// Millisecond precision matches the current PostgreSQL DateTime columns.
const ZONED_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export class ReserveAppointmentDto {
  @IsUUID()
  patientId!: string;

  @IsString()
  @Matches(/\S/)
  @MaxLength(128)
  professionalId!: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(ZONED_DATETIME)
  @Matches(/^(?!.*-00:00$)/)
  startTime!: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(ZONED_DATETIME)
  @Matches(/^(?!.*-00:00$)/)
  endTime!: string;

  @IsEnum(AppointmentStatus)
  status!: AppointmentStatus;
}
