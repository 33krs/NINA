import { IsDefined } from 'class-validator';
import { type Prisma } from '@prisma/client';

export class ReplaceOdontogramDto {
  @IsDefined()
  teethStates!: Prisma.InputJsonValue;
}
