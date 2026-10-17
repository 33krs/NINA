import type { StockBatch } from './allocate-stock';
import { isBatchExpired } from './batch-expiry';

export interface PersistedBatch extends StockBatch {
  readonly medicationId: string;
}

/**
 * Select allocator inputs from confirmed UTC-midnight calendar-label encodings.
 * Other medication records are ignored after validating their medication ID.
 * Validate every relevant record, including expired and zero-stock records.
 */
export function prepareEligibleBatches(
  batches: readonly PersistedBatch[],
  medicationId: string,
  evaluationInstant: Date,
): readonly StockBatch[] {
  if (!Array.isArray(batches)) {
    throw new TypeError('Batches must be an array');
  }
  if (typeof medicationId !== 'string' || !medicationId.trim()) {
    throw new TypeError('Medication id must be a nonblank string');
  }
  if (
    !(evaluationInstant instanceof Date) ||
    !Number.isFinite(evaluationInstant.getTime())
  ) {
    throw new TypeError('Evaluation instant must be a valid Date');
  }

  const ids = new Set<string>();
  const eligible: StockBatch[] = [];
  for (const batch of batches) {
    if (
      !batch ||
      typeof batch.medicationId !== 'string' ||
      !batch.medicationId.trim()
    ) {
      throw new TypeError('Batch medication id must be a nonblank string');
    }
    if (batch.medicationId !== medicationId) continue;
    if (typeof batch.id !== 'string' || !batch.id.trim()) {
      throw new TypeError('Batch id must be a nonblank string');
    }
    if (ids.has(batch.id))
      throw new TypeError('Relevant batch ids must be unique');
    ids.add(batch.id);
    if (!Number.isSafeInteger(batch.stock) || batch.stock < 0) {
      throw new RangeError('Batch stock must be a nonnegative safe integer');
    }
    const expiration = batch.expirationDate;
    if (
      !(expiration instanceof Date) ||
      !Number.isFinite(expiration.getTime())
    ) {
      throw new TypeError('Batch expiration date must be a valid Date');
    }
    if (
      expiration.getUTCFullYear() < 0 ||
      expiration.getUTCFullYear() > 9999 ||
      expiration.getUTCHours() !== 0 ||
      expiration.getUTCMinutes() !== 0 ||
      expiration.getUTCSeconds() !== 0 ||
      expiration.getUTCMilliseconds() !== 0
    ) {
      throw new RangeError(
        'Batch expiration must encode a four-digit date at UTC midnight',
      );
    }
    const label = expiration.toISOString().slice(0, 10);
    if (isBatchExpired(label, evaluationInstant) || batch.stock === 0) continue;
    eligible.push({
      id: batch.id,
      stock: batch.stock,
      expirationDate: new Date(expiration.getTime()),
    });
  }
  return eligible;
}
