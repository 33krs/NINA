import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PrescriptionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { allocateStock, type StockAllocation } from './allocate-stock';
import { calculateDispensingBalance } from './dispensing-balance';
import {
  prepareEligibleBatches,
  type PersistedBatch,
} from './prepare-eligible-batches';

const allocationSelection = {
  batchId: true,
  quantity: true,
  prescriptionItemId: true,
  batch: { select: { medicationId: true } },
  dispensing: { select: { prescriptionId: true } },
} as const;

export interface DispenseItemRequest {
  readonly prescriptionId: string;
  readonly itemId: string;
  readonly quantity: number;
  readonly eventId: string;
}

export interface DispensingResult {
  readonly eventId: string;
  readonly allocations: readonly StockAllocation[];
}

@Injectable()
export class PharmacyDispensingService {
  constructor(private readonly prisma: PrismaService) {}

  async dispenseItem(request: DispenseItemRequest): Promise<DispensingResult> {
    for (const id of [request.prescriptionId, request.itemId]) {
      if (typeof id !== 'string' || !id.trim()) {
        throw new TypeError(
          'Prescription and item IDs must be nonblank strings',
        );
      }
    }
    if (
      typeof request.eventId !== 'string' ||
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
        request.eventId,
      )
    ) {
      throw new TypeError('Event ID must be a UUID');
    }
    calculateDispensingBalance(request.quantity, []);

    return this.prisma.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "Prescription"
          WHERE "id" = ${request.prescriptionId} FOR UPDATE
        `;
        if (!locked.length)
          throw new NotFoundException('Prescription not found');
        const prescription = await tx.prescription.findUniqueOrThrow({
          where: { id: request.prescriptionId },
          include: { items: true },
        });
        const items = new Map(
          prescription.items.map((item) => [item.id, item]),
        );
        const item = items.get(request.itemId);
        if (!item)
          throw new NotFoundException('Item does not belong to prescription');
        const replay = await tx.prescriptionDispensing.findUnique({
          where: { id: request.eventId },
          include: { allocations: { select: allocationSelection } },
        });
        if (replay && replay.prescriptionId !== prescription.id) {
          throw new ConflictException(
            'Event ID belongs to another prescription',
          );
        }
        // Include incoming foreign events too: FKs alone do not prove ownership.
        const history = await tx.prescriptionDispensingAllocation.findMany({
          where: {
            OR: [
              { dispensing: { prescriptionId: prescription.id } },
              { prescriptionItem: { prescriptionId: prescription.id } },
            ],
          },
          select: allocationSelection,
        });
        for (const allocation of history) {
          const owner = items.get(allocation.prescriptionItemId);
          if (
            allocation.dispensing.prescriptionId !== prescription.id ||
            !owner ||
            owner.medicationId !== allocation.batch.medicationId
          ) {
            throw new ConflictException('Inconsistent dispensing history');
          }
        }
        const balances = new Map(
          prescription.items.map((entry) => [
            entry.id,
            calculateDispensingBalance(
              entry.quantity,
              history
                .filter(
                  (allocation) => allocation.prescriptionItemId === entry.id,
                )
                .map((allocation) => allocation.quantity),
            ),
          ]),
        );
        if (replay) {
          if (
            replay.allocations.some(
              (allocation) =>
                allocation.prescriptionItemId !== item.id ||
                allocation.dispensing.prescriptionId !== prescription.id ||
                allocation.batch.medicationId !== item.medicationId,
            ) ||
            calculateDispensingBalance(
              request.quantity,
              replay.allocations.map((allocation) => allocation.quantity),
            ).pending !== 0
          ) {
            throw new ConflictException(
              'Event ID does not match requested delivery',
            );
          }
          return {
            eventId: replay.id,
            allocations: replay.allocations.map(({ batchId, quantity }) => ({
              batchId,
              quantity,
            })),
          };
        }
        if (prescription.status !== PrescriptionStatus.ISSUED) {
          throw new ConflictException(
            'Prescription does not admit new deliveries',
          );
        }
        if (request.quantity > balances.get(item.id)!.pending) {
          throw new ConflictException(
            'Requested quantity exceeds pending quantity',
          );
        }
        // Shared medication stock is serialized across different prescriptions.
        const batches = await tx.$queryRaw<PersistedBatch[]>`
          SELECT "id", "medicationId", "expirationDate", "stock" FROM "Batch"
          WHERE "medicationId" = ${item.medicationId} ORDER BY "id" FOR UPDATE
        `;
        const allocations = allocateStock(
          prepareEligibleBatches(batches, item.medicationId, new Date()),
          request.quantity,
        );
        for (const allocation of allocations) {
          const updated = await tx.batch.updateMany({
            where: {
              id: allocation.batchId,
              stock: { gte: allocation.quantity },
            },
            data: { stock: { decrement: allocation.quantity } },
          });
          if (updated.count !== 1) throw new ConflictException('Stock changed');
        }
        // A global event-ID collision throws and rolls back; never blindly retry.
        await tx.prescriptionDispensing.create({
          data: {
            id: request.eventId,
            prescriptionId: prescription.id,
            allocations: {
              create: allocations.map((allocation) => ({
                ...allocation,
                prescriptionItemId: item.id,
              })),
            },
          },
        });
        const complete = prescription.items.every(
          (entry) =>
            balances.get(entry.id)!.pending ===
            (entry.id === item.id ? request.quantity : 0),
        );
        await tx.prescription.update({
          where: { id: prescription.id },
          data: {
            status: complete
              ? PrescriptionStatus.DISPENSED
              : PrescriptionStatus.ISSUED,
          },
        });
        return { eventId: request.eventId, allocations };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }
}
