import { describe, expect, it } from '@jest/globals';
import { isBatchExpired } from './batch-expiry';

const boundaryCases = [
  {
    name: 'summer',
    label: '2026-01-01',
    boundary: '2026-01-02T03:00:00.000Z',
    offset: 'GMT-03:00',
    firstHour: '00',
  },
  {
    name: 'winter',
    label: '2026-07-01',
    boundary: '2026-07-02T04:00:00.000Z',
    offset: 'GMT-04:00',
    firstHour: '00',
  },
  {
    name: 'autumn repeated hour',
    label: '2026-04-04',
    boundary: '2026-04-05T04:00:00.000Z',
    offset: 'GMT-04:00',
    firstHour: '00',
  },
  {
    name: 'spring skipped midnight',
    label: '2026-09-05',
    boundary: '2026-09-06T04:00:00.000Z',
    offset: 'GMT-03:00',
    firstHour: '01',
  },
];

const localClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Santiago',
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'longOffset',
});

describe('isBatchExpired', () => {
  it('expires when the next Santiago calendar date begins', () => {
    expect(
      isBatchExpired('2026-01-01', new Date('2026-01-02T03:00:00.000Z')),
    ).toBe(true);
  });

  // These UTC fixtures were checked against installed ICU, not assumed offsets.
  it.each(boundaryCases)(
    'expires exactly at the next local date during $name',
    ({ label, boundary, offset, firstHour }) => {
      const at = new Date(boundary);
      const before = new Date(at.getTime() - 1);
      const after = new Date(at.getTime() + 1);
      const beforeParts = Object.fromEntries(
        localClock
          .formatToParts(before)
          .map(({ type, value }) => [type, value]),
      );
      expect(
        `${beforeParts.year}-${beforeParts.month}-${beforeParts.day}`,
      ).toBe(label);
      expect(beforeParts.hour).toBe('23');
      expect(beforeParts.minute).toBe('59');
      expect(beforeParts.second).toBe('59');
      const atParts = Object.fromEntries(
        localClock.formatToParts(at).map(({ type, value }) => [type, value]),
      );
      expect(atParts).toMatchObject({
        hour: firstHour,
        minute: '00',
        second: '00',
        timeZoneName: offset,
      });
      expect(isBatchExpired(label, before)).toBe(false);
      expect(isBatchExpired(label, at)).toBe(true);
      expect(isBatchExpired(label, after)).toBe(true);
    },
  );

  it.each(['2026-04-05T02:30:00Z', '2026-04-05T03:30:00Z'])(
    'remains valid through both occurrences of the repeated 23:30 hour: %s',
    (instant) => {
      const date = new Date(instant);
      expect(localClock.format(date)).toContain('23:30:00');
      expect(isBatchExpired('2026-04-04', date)).toBe(false);
    },
  );

  it('preserves the indicated label instead of shifting UTC midnight into yesterday', () => {
    expect(isBatchExpired('2026-01-02', new Date('2026-01-02T00:00:00Z'))).toBe(
      false,
    );
    expect(
      isBatchExpired('2026-01-02', new Date('2026-01-03T02:59:59.999Z')),
    ).toBe(false);
  });

  it.each([
    '0000-02-29',
    '0001-01-01',
    '0099-12-31',
    '2000-02-29',
    '2024-02-29',
    '2100-02-28',
    '2400-02-29',
    '9999-12-31',
  ])(
    'accepts the real Gregorian label %s throughout its local date',
    (label) => {
      expect(isBatchExpired(label, new Date(`${label}T12:00:00Z`))).toBe(false);
    },
  );

  it.each([
    '',
    '2026-1-01',
    '2026-01-1',
    '2026/01/01',
    ' 2026-01-01',
    '2026-01-01 ',
    '2026-01-01\n',
    '2026-01-01\r',
    '2026-01-01\r\n',
    '2026-01-01T00:00:00Z',
    '2026-00-01',
    '2026-13-01',
    '2026-01-00',
    '2026-01-32',
    '2026-04-31',
    '2025-02-29',
    '1900-02-29',
    '2100-02-29',
    '2024-02-30',
    '10000-01-01',
    '-0001-01-01',
  ])(
    'rejects an invalid or noncanonical label %j without normalization',
    (label) => {
      expect(() =>
        isBatchExpired(label, new Date('2026-01-01T12:00:00Z')),
      ).toThrow();
    },
  );

  it.each([null, undefined, 20260101, new Date('2026-01-01T00:00:00Z')])(
    'rejects a non-string label %j, including legacy Date values',
    (label) => {
      expect(() =>
        isBatchExpired(label as unknown as string, new Date(0)),
      ).toThrow(TypeError);
    },
  );

  it.each([
    new Date(NaN),
    new Date(Infinity),
    null,
    undefined,
    0,
    '2026-01-01',
  ])('rejects an invalid evaluation instant %j', (instant) => {
    expect(() =>
      isBatchExpired('2026-01-01', instant as unknown as Date),
    ).toThrow(TypeError);
  });

  it('compares all finite Date instants numerically, including outside four-digit label years', () => {
    expect(isBatchExpired('0000-01-01', new Date(-8640000000000000))).toBe(
      false,
    );
    expect(isBatchExpired('9999-12-31', new Date(8640000000000000))).toBe(true);
    expect(isBatchExpired('0000-02-29', new Date('0000-03-01T12:00:00Z'))).toBe(
      true,
    );
  });

  it('does not mutate the supplied evaluation instant', () => {
    const instant = new Date('2026-09-06T04:00:00Z');
    const original = instant.getTime();
    isBatchExpired('2026-09-05', instant);
    expect(instant.getTime()).toBe(original);
  });
});
