import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
} from '@nestjs/common';
import { OdontogramHistoryQueryDto } from './dto/odontogram-history-query.dto';
import { ReplaceOdontogramDto } from './dto/replace-odontogram.dto';
import { OdontogramService } from './odontogram.service';

@Controller('patients/:patientId/odontogram')
export class OdontogramController {
  constructor(private readonly odontograms: OdontogramService) {}

  @Get()
  async getCurrent(@Param('patientId', ParseUUIDPipe) patientId: string) {
    const current = await this.odontograms.getCurrent(patientId);
    if (!current) throw new NotFoundException('Odontogram not found');
    return current;
  }

  @Put()
  replaceCurrent(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() input: ReplaceOdontogramDto,
  ) {
    return this.odontograms.replaceCurrent(patientId, input.teethStates);
  }

  @Get('history')
  getVersions(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Query() options: OdontogramHistoryQueryDto,
  ) {
    return this.odontograms.getVersions(patientId, options);
  }
}
