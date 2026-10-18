import { describe, expect, it } from '@jest/globals';
import { calculateDispensingBalance } from './dispensing-balance';

describe('calculateDispensingBalance', () => {
  it('calculates partial delivery across multiple events', () => {
    expect(calculateDispensingBalance(10, [3, 2])).toEqual({
      delivered: 5,
      pending: 5,
    });
  });

  it('rejects overdelivery instead of clamping the pending balance', () => {
    expect(() => calculateDispensingBalance(5, [3, 3])).toThrow('Overdelivery');
  });

  it('returns zero delivered only when an empty history is known complete', () => {
    expect(calculateDispensingBalance(5, [])).toEqual({
      delivered: 0,
      pending: 5,
    });
  });

  it('calculates a single partial delivery', () => {
    expect(calculateDispensingBalance(5, [2])).toEqual({
      delivered: 2,
      pending: 3,
    });
  });

  it.each([{ quantities: [5] }, { quantities: [2, 3] }])(
    'recognizes exact fulfillment with $quantities',
    ({ quantities }) => {
      expect(calculateDispensingBalance(5, quantities)).toEqual({
        delivered: 5,
        pending: 0,
      });
    },
  );

  it('rejects a single allocation exceeding the prescribed quantity', () => {
    expect(() => calculateDispensingBalance(5, [6])).toThrow('Overdelivery');
  });

  it.each([0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid prescribed quantity %s',
    (quantity) => {
      expect(() => calculateDispensingBalance(quantity, [])).toThrow(
        'Prescribed quantity must be a positive safe integer',
      );
    },
  );

  it.each([null, undefined, '5', true])(
    'does not coerce prescribed quantity %s',
    (quantity) => {
      expect(() =>
        calculateDispensingBalance(quantity as unknown as number, []),
      ).toThrow('Prescribed quantity must be a positive safe integer');
    },
  );

  it.each([0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid delivered quantity %s',
    (quantity) => {
      expect(() => calculateDispensingBalance(5, [quantity])).toThrow(
        'Delivered quantity must be a positive safe integer',
      );
    },
  );

  it.each([null, undefined, '2', true])(
    'does not coerce delivered quantity %s',
    (quantity) => {
      expect(() =>
        calculateDispensingBalance(5, [quantity as unknown as number]),
      ).toThrow('Delivered quantity must be a positive safe integer');
    },
  );

  it.each([null, undefined, {}])('rejects non-array history %s', (history) => {
    expect(() =>
      calculateDispensingBalance(5, history as unknown as number[]),
    ).toThrow('Delivered quantities must be an array');
  });

  it('validates entries after fulfillment instead of ignoring them', () => {
    expect(() => calculateDispensingBalance(5, [5, 0])).toThrow(
      'Delivered quantity must be a positive safe integer',
    );
  });

  it('calculates exact fulfillment at the safe integer boundary', () => {
    expect(
      calculateDispensingBalance(Number.MAX_SAFE_INTEGER, [
        Number.MAX_SAFE_INTEGER - 1,
        1,
      ]),
    ).toEqual({ delivered: Number.MAX_SAFE_INTEGER, pending: 0 });
  });

  it('rejects a sum exceeding the safe integer boundary as overdelivery', () => {
    expect(() =>
      calculateDispensingBalance(Number.MAX_SAFE_INTEGER, [
        Number.MAX_SAFE_INTEGER,
        1,
      ]),
    ).toThrow('Overdelivery');
  });

  it('does not mutate history on success or rejection', () => {
    const quantities = Object.freeze([3, 2]);
    expect(calculateDispensingBalance(10, quantities)).toEqual({
      delivered: 5,
      pending: 5,
    });
    expect(quantities).toEqual([3, 2]);
    expect(() => calculateDispensingBalance(4, quantities)).toThrow(
      'Overdelivery',
    );
    expect(quantities).toEqual([3, 2]);
  });
});
