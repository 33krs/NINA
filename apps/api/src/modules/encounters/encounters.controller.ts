import { Body, Controller, Post } from '@nestjs/common';
import { CreateEncounterDto } from './create-encounter.dto';
import { EncountersService } from './encounters.service';

@Controller('encounters')
export class EncountersController {
  constructor(private readonly encounters: EncountersService) {}

  @Post()
  create(@Body() input: CreateEncounterDto) {
    return this.encounters.create(input);
  }
}
