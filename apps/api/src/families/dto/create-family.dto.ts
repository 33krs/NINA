import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

export class CreateFamilyDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsString()
  @IsNotEmpty()
  address!: string;

  @IsInt()
  @Min(0)
  socialRiskLevel!: number;
}
