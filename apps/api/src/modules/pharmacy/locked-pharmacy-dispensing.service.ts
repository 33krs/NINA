import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { calculateDispensingBalance } from './dispensing-balance';
import {
  PharmacyDispensingService,
  type DispenseItemRequest,
  type DispensingResult,
} from './pharmacy-dispensing.service';
import { PharmacyLockService } from './pharmacy-lock.service';

@Injectable()
export class LockedPharmacyDispensingService {
  constructor(
    private readonly dispensing: PharmacyDispensingService,
    private readonly locks: PharmacyLockService,
  ) {}

  async dispenseItem(request: DispenseItemRequest): Promise<DispensingResult> {
    for (const id of [request.prescriptionId, request.itemId]) {
      if (typeof id !== 'string' || !id.trim())
        throw new TypeError(
          'Prescription and item IDs must be nonblank strings',
        );
    }
    calculateDispensingBalance(request.quantity, []);
    if (
      typeof request.eventId !== 'string' ||
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
        request.eventId,
      )
    )
      throw new TypeError('Event ID must be a UUID');
    const key = `pharmacy:prescription:${JSON.stringify([request.prescriptionId])}`;
    const owner = randomUUID();
    let acquired: boolean;
    try {
      acquired = await this.locks.acquire(key, owner);
    } catch {
      throw new ServiceUnavailableException('Dispensing service unavailable');
    }
    if (!acquired)
      throw new ConflictException('Prescription is already being dispensed');
    try {
      return await this.dispensing.dispenseItem(request);
    } finally {
      // The owner-checked adapter preserves committed success and the original failure.
      await this.locks.release(key, owner);
    }
  }
}
