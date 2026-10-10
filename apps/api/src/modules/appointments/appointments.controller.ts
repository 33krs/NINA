import { Body, Controller, Post } from '@nestjs/common';
import { AppointmentsService } from './appointments.service';
import { ReserveAppointmentDto } from './reserve-appointment.dto';

@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @Post()
  reserve(@Body() input: ReserveAppointmentDto) {
    return this.appointments.reserve(input);
  }
}
