import { describe, expect, it } from '@jest/globals';
import { AppointmentStatus } from '@prisma/client';
import { validateSync } from 'class-validator';
import { ReserveAppointmentDto } from './reserve-appointment.dto';

describe('ReserveAppointmentDto', () => {
  const input = {
    patientId: '3dfc6dbf-c6f9-478b-b7dc-ff6d9a622137',
    professionalId: 'professional-1',
    startTime: '2030-01-01T10:00:00Z',
    endTime: '2030-01-01T10:30:00Z',
    status: AppointmentStatus.PENDING,
  };
  const invalidFields = (patch: Record<string, unknown>) =>
    validateSync(Object.assign(new ReserveAppointmentDto(), input, patch)).map(
      (error) => error.property,
    );

  it.each(Object.values(AppointmentStatus))(
    'accepts current status %s',
    (status) => {
      expect(invalidFields({ status })).toEqual([]);
    },
  );

  it('accepts the maximum professional identifier length', () => {
    expect(invalidFields({ professionalId: 'p'.repeat(128) })).toEqual([]);
  });

  it.each([
    ['patientId', 'not-a-uuid'],
    ['patientId', undefined],
    ['professionalId', undefined],
    ['professionalId', 42],
    ['professionalId', ''],
    ['professionalId', ' \t '],
    ['professionalId', 'p'.repeat(129)],
    ['status', undefined],
    ['status', null],
    ['status', 'SCHEDULED'],
  ])('rejects invalid %s: %j', (field, value) => {
    expect(invalidFields({ [field as string]: value })).toContain(field);
  });

  it.each([
    '2032-02-29T10:00:00Z',
    '2030-01-01T10:00:00+03:00',
    '2030-01-01T10:00:00-03:00',
    '2030-01-01T10:00:00.1Z',
    '2030-01-01T10:00:00.12Z',
    '2030-01-01T10:00:00.123Z',
  ])('accepts strict zoned dates with millisecond precision: %s', (value) => {
    expect(invalidFields({ startTime: value, endTime: value })).toEqual([]);
  });

  it.each([
    undefined,
    '2030-01-01T10:00:00',
    '2030-01-01T10:00:00-00:00',
    '2030-01-01T10:00:00+25:00',
    '2030-02-29T10:00:00Z',
    '2030-02-30T10:00:00Z',
    '2030-01-01 10:00:00Z',
    '2030-01-01T10:00Z',
    '2030-01-01T10:00:00.1234Z',
  ])('rejects invalid datetime on both boundaries: %j', (value) => {
    expect(invalidFields({ startTime: value, endTime: value })).toEqual(
      expect.arrayContaining(['startTime', 'endTime']),
    );
  });
});
