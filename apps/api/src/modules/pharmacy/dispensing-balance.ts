export interface DispensingBalance {
  readonly delivered: number;
  readonly pending: number;
}

/**
 * Balance a prescription item using its known, complete allocation history.
 * Missing legacy history is unknown delivery, not evidence of zero delivery.
 */
export function calculateDispensingBalance(
  prescribedQuantity: number,
  deliveredQuantities: readonly number[],
): DispensingBalance {
  if (!Number.isSafeInteger(prescribedQuantity) || prescribedQuantity <= 0) {
    throw new RangeError('Prescribed quantity must be a positive safe integer');
  }
  if (!Array.isArray(deliveredQuantities)) {
    throw new TypeError('Delivered quantities must be an array');
  }

  let delivered = 0;
  for (const quantity of deliveredQuantities) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new RangeError(
        'Delivered quantity must be a positive safe integer',
      );
    }
    // Compare before addition so overdelivery cannot overflow a safe balance.
    if (quantity > prescribedQuantity - delivered) {
      throw new RangeError('Overdelivery exceeds the prescribed quantity');
    }
    delivered += quantity;
  }
  return { delivered, pending: prescribedQuantity - delivered };
}
