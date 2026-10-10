import { EncounterStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateEncounterDto {
  @IsUUID()
  appointmentId!: string;

  @IsEnum(EncounterStatus)
  status!: EncounterStatus;

  @IsOptional()
  @IsString()
  soapSubjective?: string;

  @IsOptional()
  @IsString()
  soapObjective?: string;

  @IsOptional()
  @IsString()
  soapAssessment?: string;

  @IsOptional()
  @IsString()
  soapPlan?: string;
}
