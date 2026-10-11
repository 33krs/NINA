export interface StockBatch {
  readonly id: string;
  readonly expirationDate: Date;
  readonly stock: number;
}

export interface StockAllocation {
  readonly batchId: string;
  readonly quantity: number;
}

/**
 * Plan allocations from batches the caller has already deemed eligible.
 * This function neither filters medications/expired batches nor persists stock.
 */
export function allocateStock(
  batches: readonly StockBatch[],
  requestedQuantity: number,
): readonly StockAllocation[] {
  if (!Number.isSafeInteger(requestedQuantity) || requestedQuantity <= 0) {
    throw new RangeError('Requested quantity must be a positive safe integer');
  }
  if (!Array.isArray(batches)) {
    throw new TypeError('Batches must be an array');
  }

  const ids = new Set<string>();
  for (const batch of batches) {
    if (!batch || typeof batch.id !== 'string' || !batch.id.trim()) {
      throw new TypeError('Batch id must be a nonblank string');
    }
    if (ids.has(batch.id)) {
      throw new TypeError('Batch ids must be unique');
    }
    ids.add(batch.id);
    if (
      !(batch.expirationDate instanceof Date) ||
      !Number.isFinite(batch.expirationDate.getTime())
    ) {
      throw new TypeError('Batch expiration date must be a valid Date');
    }
    if (!Number.isSafeInteger(batch.stock) || batch.stock < 0) {
      throw new RangeError('Batch stock must be a nonnegative safe integer');
    }
  }

  const ordered = [...batches].sort((first, second) => {
    const expiryOrder =
      first.expirationDate.getTime() - second.expirationDate.getTime();
    if (expiryOrder !== 0) return expiryOrder;
    // Ordinal IDs break ties independently of input order and host locale.
    return first.id < second.id ? -1 : first.id > second.id ? 1 : 0;
  });
  const allocations: StockAllocation[] = [];
  let remaining = requestedQuantity;
  for (const batch of ordered) {
    const quantity = Math.min(batch.stock, remaining);
    if (quantity > 0) allocations.push({ batchId: batch.id, quantity });
    remaining -= quantity;
    if (remaining === 0) return allocations;
  }
  throw new RangeError('Insufficient stock');
}
