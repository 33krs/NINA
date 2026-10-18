import { describe, expect, it } from '@jest/globals';
import { allocateStock } from './allocate-stock';
import {
  prepareEligibleBatches,
  type PersistedBatch,
} from './prepare-eligible-batches';

function batch(
  id = 'lot',
  expiration = '2026-01-02',
  stock = 3,
  medicationId = 'medication',
): PersistedBatch {
  return {
    id,
    medicationId,
    stock,
    expirationDate: new Date(`${expiration}T00:00:00Z`),
  };
}

describe('prepareEligibleBatches', () => {
  it('preserves the UTC date label through the final Santiago hour', () => {
    const record = batch();
    expect(
      prepareEligibleBatches(
        [record],
        'medication',
        new Date('2026-01-03T02:59:59.999Z'),
      ),
    ).toEqual([
      {
        id: record.id,
        stock: record.stock,
        expirationDate: record.expirationDate,
      },
    ]);
  });

  const evaluation = new Date('2026-01-02T12:00:00Z');

  it('selects only matching, stocked, nonexpired batches without reordering', () => {
    const records = [
      batch('later', '2026-01-04'),
      batch('other', '2026-01-04', 3, 'other'),
      batch('empty', '2026-01-04', 0),
      batch('expired', '2026-01-01'),
      batch('same-date', '2026-01-02'),
    ];
    expect(
      prepareEligibleBatches(records, 'medication', evaluation).map(
        (item) => item.id,
      ),
    ).toEqual(['later', 'same-date']);
  });

  it('ignores other medication fields, including duplicate IDs and malformed stock or expiry', () => {
    const irrelevant = {
      ...batch('lot', '2026-01-02', 3, 'other'),
      stock: NaN,
      expirationDate: new Date(NaN),
    };
    expect(
      prepareEligibleBatches(
        [batch(), irrelevant, irrelevant],
        'medication',
        evaluation,
      ),
    ).toHaveLength(1);
  });

  it('matches medication IDs exactly rather than normalizing identifiers', () => {
    expect(
      prepareEligibleBatches([batch()], ' medication ', evaluation),
    ).toEqual([]);
  });

  it.each([
    ['2026-01-01', '2026-01-02T03:00:00Z'],
    ['2026-07-01', '2026-07-02T04:00:00Z'],
    ['2026-04-04', '2026-04-05T04:00:00Z'],
    ['2026-09-05', '2026-09-06T04:00:00Z'],
  ])('filters label %s only at its next Santiago date', (label, boundary) => {
    const at = new Date(boundary);
    expect(
      prepareEligibleBatches(
        [batch('lot', label)],
        'medication',
        new Date(at.getTime() - 1),
      ),
    ).toHaveLength(1);
    expect(
      prepareEligibleBatches([batch('lot', label)], 'medication', at),
    ).toEqual([]);
  });

  it.each(['0000-02-29', '0099-01-01', '9999-12-31'])(
    'accepts the complete four-digit year range without year-1900 normalization: %s',
    (label) => {
      expect(
        prepareEligibleBatches(
          [batch('lot', label)],
          'medication',
          new Date(`${label}T12:00:00Z`),
        ),
      ).toHaveLength(1);
    },
  );

  it.each([
    '2026-01-02T01:00:00Z',
    '2026-01-02T00:01:00Z',
    '2026-01-02T00:00:01Z',
    '2026-01-02T00:00:00.001Z',
    '-000001-01-01T00:00:00Z',
    '+010000-01-01T00:00:00Z',
  ])(
    'rejects ambiguous or out-of-range timestamp %s without changing it',
    (iso) => {
      const record = { ...batch(), expirationDate: new Date(iso) };
      const original = record.expirationDate.getTime();
      expect(() =>
        prepareEligibleBatches([record], 'medication', evaluation),
      ).toThrow(RangeError);
      expect(record.expirationDate.getTime()).toBe(original);
    },
  );

  it.each([new Date(NaN), null, undefined, '2026-01-02', 0])(
    'rejects invalid persisted dates %j',
    (expirationDate) => {
      const record = {
        ...batch(),
        expirationDate,
      } as unknown as PersistedBatch;
      expect(() =>
        prepareEligibleBatches([record], 'medication', evaluation),
      ).toThrow(TypeError);
    },
  );

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', null])(
    'rejects invalid relevant stock %j',
    (stock) => {
      const record = { ...batch(), stock } as unknown as PersistedBatch;
      expect(() =>
        prepareEligibleBatches([record], 'medication', evaluation),
      ).toThrow(RangeError);
    },
  );

  it('accepts safe-integer stock limits', () => {
    expect(
      prepareEligibleBatches(
        [batch('lot', '2026-01-02', Number.MAX_SAFE_INTEGER)],
        'medication',
        evaluation,
      )[0].stock,
    ).toBe(Number.MAX_SAFE_INTEGER);
  });

  it.each(['', ' ', null, undefined, 1])(
    'rejects malformed identifiers %j',
    (id) => {
      expect(() =>
        prepareEligibleBatches([], id as unknown as string, evaluation),
      ).toThrow(TypeError);
      expect(() =>
        prepareEligibleBatches(
          [{ ...batch(), id } as unknown as PersistedBatch],
          'medication',
          evaluation,
        ),
      ).toThrow(TypeError);
      expect(() =>
        prepareEligibleBatches(
          [{ ...batch(), medicationId: id } as unknown as PersistedBatch],
          'medication',
          evaluation,
        ),
      ).toThrow(TypeError);
    },
  );

  it.each([null, undefined, {}])('rejects non-array inputs %j', (records) => {
    expect(() =>
      prepareEligibleBatches(
        records as unknown as readonly PersistedBatch[],
        'medication',
        evaluation,
      ),
    ).toThrow(TypeError);
  });

  it('rejects malformed records without a medication identity', () => {
    expect(() =>
      prepareEligibleBatches(
        [null as unknown as PersistedBatch],
        'medication',
        evaluation,
      ),
    ).toThrow(TypeError);
  });

  it.each([new Date(NaN), null, undefined, 0, '2026-01-02'])(
    'validates evaluation instant %j even for empty or irrelevant inputs',
    (instant) => {
      for (const records of [[], [batch('other', '2026-01-02', 3, 'other')]]) {
        expect(() =>
          prepareEligibleBatches(
            records,
            'medication',
            instant as unknown as Date,
          ),
        ).toThrow(TypeError);
      }
    },
  );

  it.each([
    ['2026-01-01', 3],
    ['2026-01-02', 0],
  ])(
    'rejects duplicate relevant IDs before dropping filtered records',
    (label, stock) => {
      expect(() =>
        prepareEligibleBatches(
          [batch(), batch('lot', String(label), Number(stock))],
          'medication',
          evaluation,
        ),
      ).toThrow('unique');
    },
  );

  it('validates malformed relevant records even when stock is zero or expiry is past', () => {
    expect(() =>
      prepareEligibleBatches(
        [{ ...batch('empty', '2026-01-02', 0), expirationDate: new Date(NaN) }],
        'medication',
        evaluation,
      ),
    ).toThrow(TypeError);
    expect(() =>
      prepareEligibleBatches(
        [batch('expired', '2026-01-01', -1)],
        'medication',
        evaluation,
      ),
    ).toThrow(RangeError);
  });

  it('clones projections and dates without mutating persisted records or evaluation time', () => {
    const record = Object.freeze(batch());
    const records = Object.freeze([record]);
    const original = record.expirationDate.getTime();
    const instant = evaluation.getTime();
    const prepared = prepareEligibleBatches(records, 'medication', evaluation);
    expect(prepared[0]).not.toBe(record);
    expect(prepared[0].expirationDate).not.toBe(record.expirationDate);
    prepared[0].expirationDate.setUTCDate(1);
    expect(record.expirationDate.getTime()).toBe(original);
    expect(evaluation.getTime()).toBe(instant);
    expect(record.stock).toBe(3);
  });

  it('composes with allocation in date order and ordinal-ID tie order', () => {
    const records = [
      batch('late', '2026-01-04', 4),
      batch('batch-z', '2026-01-02', 2),
      batch('batch-A', '2026-01-02', 2),
    ];
    const prepared = prepareEligibleBatches(records, 'medication', evaluation);
    expect(allocateStock(prepared, 5)).toEqual([
      { batchId: 'batch-A', quantity: 2 },
      { batchId: 'batch-z', quantity: 2 },
      { batchId: 'late', quantity: 1 },
    ]);
    expect(prepared.map((item) => item.id)).toEqual(
      records.map((item) => item.id),
    );
  });

  it('does not replace the allocator insufficient-stock rejection', () => {
    expect(() =>
      allocateStock(
        prepareEligibleBatches(
          [batch('expired', '2026-01-01')],
          'medication',
          evaluation,
        ),
        1,
      ),
    ).toThrow('Insufficient stock');
  });
});
