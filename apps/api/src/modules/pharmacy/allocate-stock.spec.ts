import { describe, expect, it } from '@jest/globals';
import { allocateStock, type StockBatch } from './allocate-stock';

function batch(
  id: string,
  stock: number,
  expirationDate = new Date('2030-01-01'),
): StockBatch {
  return { id, stock, expirationDate };
}

describe('allocateStock', () => {
  it('rejects insufficient stock instead of returning a partial allocation', () => {
    expect(() => allocateStock([batch('batch-a', 2)], 3)).toThrow(
      'Insufficient stock',
    );
  });

  it('allocates exact stock from a single batch', () => {
    expect(allocateStock([batch('batch-a', 4)], 4)).toEqual([
      { batchId: 'batch-a', quantity: 4 },
    ]);
  });

  it('allocates only the requested quantity when stock exceeds demand', () => {
    expect(allocateStock([batch('batch-a', 8)], 3)).toEqual([
      { batchId: 'batch-a', quantity: 3 },
    ]);
  });

  it('splits lots by earliest expiry and partially uses the final lot', () => {
    const batches = [
      batch('late', 4, new Date('2030-03-01')),
      batch('early', 2, new Date('2030-01-01')),
      batch('middle', 3, new Date('2030-02-01')),
    ];
    expect(allocateStock(batches, 6)).toEqual([
      { batchId: 'early', quantity: 2 },
      { batchId: 'middle', quantity: 3 },
      { batchId: 'late', quantity: 1 },
    ]);
  });

  it('can consume the exact combined stock across batches', () => {
    expect(
      allocateStock([batch('batch-b', 3), batch('batch-a', 2)], 5),
    ).toEqual([
      { batchId: 'batch-a', quantity: 2 },
      { batchId: 'batch-b', quantity: 3 },
    ]);
  });

  it.each([
    { ids: ['batch-z', 'batch-A', 'batch-a'] },
    { ids: ['batch-a', 'batch-z', 'batch-A'] },
  ])('breaks equal-expiry ties by ordinal id for input $ids', ({ ids }) => {
    expect(
      allocateStock(
        ids.map((id) => batch(id, 1)),
        2,
      ),
    ).toEqual([
      { batchId: 'batch-A', quantity: 1 },
      { batchId: 'batch-a', quantity: 1 },
    ]);
  });

  it('does not emit zero-quantity allocations for empty batches', () => {
    expect(allocateStock([batch('empty', 0), batch('stocked', 2)], 1)).toEqual([
      { batchId: 'stocked', quantity: 1 },
    ]);
  });

  it.each([
    { scenario: 'no batches', batches: [] },
    { scenario: 'only depleted batches', batches: [batch('empty', 0)] },
  ])('rejects unavailable stock with $scenario', ({ batches }) => {
    expect(() => allocateStock(batches, 1)).toThrow('Insufficient stock');
  });

  it('does not apply an expiry eligibility policy to caller-selected batches', () => {
    expect(
      allocateStock([batch('caller-eligible', 1, new Date('2000-01-01'))], 1),
    ).toEqual([{ batchId: 'caller-eligible', quantity: 1 }]);
  });

  it('avoids summing stock beyond the safe integer range', () => {
    expect(
      allocateStock(
        [batch('batch-a', Number.MAX_SAFE_INTEGER - 1), batch('batch-b', 2)],
        Number.MAX_SAFE_INTEGER,
      ),
    ).toEqual([
      { batchId: 'batch-a', quantity: Number.MAX_SAFE_INTEGER - 1 },
      { batchId: 'batch-b', quantity: 1 },
    ]);
  });

  it.each([0, -1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid requested quantity %s',
    (quantity) => {
      expect(() => allocateStock([batch('batch-a', 5)], quantity)).toThrow(
        'Requested quantity must be a positive safe integer',
      );
    },
  );

  it.each([null, undefined, '2', true])(
    'does not coerce requested quantity %s',
    (quantity) => {
      expect(() =>
        allocateStock([batch('batch-a', 5)], quantity as unknown as number),
      ).toThrow('Requested quantity must be a positive safe integer');
    },
  );

  it.each([-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid batch stock %s',
    (stock) => {
      expect(() => allocateStock([batch('batch-a', stock)], 1)).toThrow(
        'Batch stock must be a nonnegative safe integer',
      );
    },
  );

  it('does not coerce string stock', () => {
    const malformed = { ...batch('batch-a', 1), stock: '1' };
    expect(() =>
      allocateStock([malformed as unknown as StockBatch], 1),
    ).toThrow('Batch stock must be a nonnegative safe integer');
  });

  it.each(['', '   '])('rejects blank batch id %j', (id) => {
    expect(() => allocateStock([batch(id, 1)], 1)).toThrow(
      'Batch id must be a nonblank string',
    );
  });

  it('rejects duplicate batch IDs instead of counting the same lot twice', () => {
    expect(() =>
      allocateStock([batch('duplicate', 1), batch('duplicate', 1)], 2),
    ).toThrow('Batch ids must be unique');
  });

  it.each([new Date('invalid'), '2030-01-01', null])(
    'rejects malformed expiration date %s',
    (expirationDate) => {
      const malformed = { ...batch('batch-a', 1), expirationDate };
      expect(() => allocateStock([malformed as StockBatch], 1)).toThrow(
        'Batch expiration date must be a valid Date',
      );
    },
  );

  it.each([null, undefined, {}])('rejects non-array batches %s', (batches) => {
    expect(() => allocateStock(batches as unknown as StockBatch[], 1)).toThrow(
      'Batches must be an array',
    );
  });

  it.each([null, undefined, {}])(
    'rejects malformed batch entries %s',
    (item) => {
      expect(() => allocateStock([item as StockBatch], 1)).toThrow(
        'Batch id must be a nonblank string',
      );
    },
  );

  it('validates later batches even when the first batch satisfies the request', () => {
    expect(() =>
      allocateStock([batch('valid', 5), batch('invalid', -1)], 1),
    ).toThrow('Batch stock must be a nonnegative safe integer');
  });

  it('does not mutate array order, batches, dates or stock on success or rejection', () => {
    const batches = Object.freeze([
      Object.freeze(batch('later', 4, Object.freeze(new Date('2030-02-01')))),
      Object.freeze(batch('earlier', 2, Object.freeze(new Date('2030-01-01')))),
    ]);
    const snapshot = batches.map((item) => ({
      ...item,
      expirationDate: new Date(item.expirationDate),
    }));
    expect(allocateStock(batches, 3)).toEqual([
      { batchId: 'earlier', quantity: 2 },
      { batchId: 'later', quantity: 1 },
    ]);
    expect(batches).toEqual(snapshot);
    expect(() => allocateStock(batches, 7)).toThrow('Insufficient stock');
    expect(batches).toEqual(snapshot);
  });

  it('returns fresh allocation arrays and records rather than input references', () => {
    const batches = [batch('batch-a', 2)];
    const first = allocateStock(batches, 1);
    const second = allocateStock(batches, 1);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
    expect(first[0]).not.toBe(batches[0]);
    expect(batches[0].stock).toBe(2);
  });
});
