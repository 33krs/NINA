const santiagoDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Santiago',
  calendar: 'gregory',
  numberingSystem: 'latn',
  era: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function expirationDateKey(label: string): number {
  if (typeof label !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(label)) {
    throw new TypeError(
      'Expiration label must be a canonical YYYY-MM-DD string',
    );
  }
  const [year, month, day] = label.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]) {
    throw new RangeError('Expiration label must be a real Gregorian date');
  }
  return year * 10000 + month * 100 + day;
}

/**
 * Expire only after the indicated calendar date in America/Santiago.
 * The label uses four-digit proleptic Gregorian years, including year 0000.
 * This function never interprets stored Batch timestamps or filters stock.
 */
export function isBatchExpired(
  expirationLabel: string,
  evaluationInstant: Date,
): boolean {
  const expiration = expirationDateKey(expirationLabel);
  if (
    !(evaluationInstant instanceof Date) ||
    !Number.isFinite(evaluationInstant.getTime())
  ) {
    throw new TypeError('Evaluation instant must be a valid Date');
  }

  const parts: Record<string, string> = {};
  for (const part of santiagoDate.formatToParts(evaluationInstant)) {
    parts[part.type] = part.value;
  }
  // Intl presents astronomical year 0000 as Gregorian 1 BC.
  const year = parts.era === 'BC' ? 1 - Number(parts.year) : Number(parts.year);
  const evaluated =
    year * 10000 + Number(parts.month) * 100 + Number(parts.day);
  return evaluated > expiration;
}
