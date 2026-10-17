import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PrescriptionStatus } from '@prisma/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { PrismaService } from '../../prisma/prisma.service';
import { PharmacyDispensingService } from './pharmacy-dispensing.service';

const request = {
  prescriptionId: 'prescription',
  itemId: 'item',
  quantity: 2,
  eventId: '11111111-1111-4111-8111-111111111111',
};
const item = { id: 'item', medicationId: 'medication', quantity: 5 };
const allocation = (quantity = 1) => ({
  batchId: 'batch',
  prescriptionItemId: item.id,
  quantity,
  batch: { medicationId: item.medicationId },
  dispensing: { prescriptionId: request.prescriptionId },
});
const batch = (id = 'batch', stock = 5, date = '2035-01-01') => ({
  id,
  stock,
  medicationId: item.medicationId,
  expirationDate: new Date(`${date}T00:00:00.000Z`),
});
const prescription = {
  id: request.prescriptionId,
  status: PrescriptionStatus.ISSUED as PrescriptionStatus,
  items: [item],
};
const event = {
  id: request.eventId,
  prescriptionId: prescription.id,
  allocations: [allocation(2)],
};

describe('PharmacyDispensingService', () => {
  const tx = {
    $queryRaw:
      jest.fn<
        (
          query: TemplateStringsArray,
          ...values: unknown[]
        ) => Promise<Array<{ id: string } | ReturnType<typeof batch>>>
      >(),
    prescription: {
      findUniqueOrThrow: jest.fn<() => Promise<typeof prescription>>(),
      update: jest.fn<() => Promise<unknown>>(),
    },
    prescriptionDispensing: {
      findUnique: jest.fn<() => Promise<typeof event | null>>(),
      create: jest.fn<() => Promise<unknown>>(),
    },
    prescriptionDispensingAllocation: {
      findMany: jest.fn<() => Promise<ReturnType<typeof allocation>[]>>(),
    },
    batch: { updateMany: jest.fn<() => Promise<{ count: number }>>() },
  };
  const prisma = {
    $transaction:
      jest.fn<
        (
          callback: (client: typeof tx) => Promise<unknown>,
          options: unknown,
        ) => Promise<unknown>
      >(),
  };
  let service: PharmacyDispensingService;
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(new Date('2026-10-11T12:00:00Z'));
    tx.$queryRaw
      .mockResolvedValueOnce([{ id: prescription.id }])
      .mockResolvedValue([batch()]);
    tx.prescription.findUniqueOrThrow.mockResolvedValue(prescription);
    tx.prescriptionDispensing.findUnique.mockResolvedValue(null);
    tx.prescriptionDispensingAllocation.findMany.mockResolvedValue([]);
    tx.batch.updateMany.mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    service = new PharmacyDispensingService(prisma as unknown as PrismaService);
  });
  afterEach(() => jest.useRealTimers());

  it('delivers the requested portion through a transaction', async () => {
    await expect(service.dispenseItem(request)).resolves.toEqual({
      eventId: request.eventId,
      allocations: [{ batchId: 'batch', quantity: 2 }],
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
    expect(tx.batch.updateMany).toHaveBeenCalledWith({
      where: { id: 'batch', stock: { gte: 2 } },
      data: { stock: { decrement: 2 } },
    });
    expect(tx.prescriptionDispensing.create).toHaveBeenCalledWith({
      data: {
        id: request.eventId,
        prescriptionId: prescription.id,
        allocations: {
          create: [
            { batchId: 'batch', quantity: 2, prescriptionItemId: item.id },
          ],
        },
      },
    });
    expect(tx.prescription.update).toHaveBeenCalledWith({
      where: { id: prescription.id },
      data: { status: PrescriptionStatus.ISSUED },
    });
  });

  it('locks prescription before reads and shared batches in deterministic order', async () => {
    await service.dispenseItem(request);
    const [parent, parentId] = tx.$queryRaw.mock.calls[0];
    const [stock, medicationId] = tx.$queryRaw.mock.calls[1];
    expect(parent.join('')).toContain('FROM "Prescription"');
    expect(parent.join('')).toContain('FOR UPDATE');
    expect(parentId).toBe(prescription.id);
    expect(stock.join('')).toContain('ORDER BY "id" FOR UPDATE');
    expect(medicationId).toBe(item.medicationId);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.prescription.findUniqueOrThrow.mock.invocationCallOrder[0],
    );
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.batch.updateMany.mock.invocationCallOrder[0],
    );
    expect(tx.prescriptionDispensingAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [
            { dispensing: { prescriptionId: prescription.id } },
            { prescriptionItem: { prescriptionId: prescription.id } },
          ],
        },
      }),
    );
  });

  it('composes eligibility and expiry-ordered splitting without mutating input', async () => {
    const batches = [
      batch('later', 5, '2036-01-01'),
      batch('expired', 100, '2020-01-01'),
      batch('earlier', 1),
    ];
    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ id: prescription.id }])
      .mockResolvedValue(batches);
    await expect(service.dispenseItem(request)).resolves.toEqual({
      eventId: request.eventId,
      allocations: [
        { batchId: 'earlier', quantity: 1 },
        { batchId: 'later', quantity: 1 },
      ],
    });
    expect(batches.map((entry) => entry.stock)).toEqual([5, 100, 1]);
    expect(tx.batch.updateMany).toHaveBeenCalledTimes(2);
  });

  it('marks complete only when every item has been delivered', async () => {
    tx.prescription.findUniqueOrThrow.mockResolvedValue({
      ...prescription,
      items: [item, { ...item, id: 'other', quantity: 1 }],
    });
    tx.prescriptionDispensingAllocation.findMany.mockResolvedValue([
      allocation(3),
      { ...allocation(), prescriptionItemId: 'other' },
    ]);
    await service.dispenseItem(request);
    expect(tx.prescription.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: PrescriptionStatus.DISPENSED },
      }),
    );
  });

  it('keeps ISSUED when the selected item completes but another remains pending', async () => {
    tx.prescription.findUniqueOrThrow.mockResolvedValue({
      ...prescription,
      items: [item, { ...item, id: 'other' }],
    });
    tx.prescriptionDispensingAllocation.findMany.mockResolvedValue([
      allocation(3),
    ]);
    await service.dispenseItem(request);
    expect(tx.prescription.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: PrescriptionStatus.ISSUED } }),
    );
  });

  it.each([PrescriptionStatus.DISPENSED, PrescriptionStatus.CANCELLED])(
    'rejects new delivery on %s',
    async (status) => {
      tx.prescription.findUniqueOrThrow.mockResolvedValue({
        ...prescription,
        status,
      });
      await expect(service.dispenseItem(request)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(tx.batch.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([PrescriptionStatus.DISPENSED, PrescriptionStatus.CANCELLED])(
    'replays exact recorded delivery on %s without writes',
    async (status) => {
      tx.prescription.findUniqueOrThrow.mockResolvedValue({
        ...prescription,
        status,
      });
      tx.prescriptionDispensing.findUnique.mockResolvedValue(event);
      tx.prescriptionDispensingAllocation.findMany.mockResolvedValue(
        event.allocations,
      );
      const result = await service.dispenseItem(request);
      expect(result).toEqual({
        eventId: event.id,
        allocations: [{ batchId: 'batch', quantity: 2 }],
      });
      expect(result.allocations[0]).not.toBe(event.allocations[0]);
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(tx.batch.updateMany).not.toHaveBeenCalled();
      expect(tx.prescriptionDispensing.create).not.toHaveBeenCalled();
      expect(tx.prescription.update).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...event, prescriptionId: 'foreign' },
    {
      ...event,
      allocations: [{ ...allocation(2), prescriptionItemId: 'foreign' }],
    },
    { ...event, allocations: [allocation(1)] },
    { ...event, allocations: [allocation(3)] },
    { ...event, allocations: [] },
    {
      ...event,
      allocations: [{ ...allocation(2), batch: { medicationId: 'foreign' } }],
    },
  ])(
    'rejects event-key reuse with different prescription/item/quantity',
    async (replay) => {
      tx.prescriptionDispensing.findUnique.mockResolvedValue(replay);
      await expect(service.dispenseItem(request)).rejects.toThrow();
      expect(tx.batch.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...allocation(), dispensing: { prescriptionId: 'foreign' } },
    { ...allocation(), prescriptionItemId: 'foreign' },
    { ...allocation(), batch: { medicationId: 'foreign' } },
    allocation(0),
    allocation(6),
  ])('rejects inconsistent or overdelivered history', async (record) => {
    tx.prescriptionDispensingAllocation.findMany.mockResolvedValue([record]);
    await expect(service.dispenseItem(request)).rejects.toThrow();
    expect(tx.batch.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a requested portion larger than the pending quantity', async () => {
    tx.prescriptionDispensingAllocation.findMany.mockResolvedValue([
      allocation(4),
    ]);
    await expect(service.dispenseItem(request)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('validates the balance of unselected items before any stock writes', async () => {
    tx.prescription.findUniqueOrThrow.mockResolvedValue({
      ...prescription,
      items: [item, { ...item, id: 'other', quantity: 1 }],
    });
    tx.prescriptionDispensingAllocation.findMany.mockResolvedValue([
      { ...allocation(2), prescriptionItemId: 'other' },
    ]);
    await expect(service.dispenseItem(request)).rejects.toThrow('Overdelivery');
    expect(tx.batch.updateMany).not.toHaveBeenCalled();
  });

  it.each(
    [[], [batch('expired', 100, '2020-01-01')], [batch('small', 1)]].map(
      (batches) => ({ batches }),
    ),
  )(
    'rejects insufficient eligible stock without writes',
    async ({ batches }) => {
      tx.$queryRaw
        .mockReset()
        .mockResolvedValueOnce([{ id: prescription.id }])
        .mockResolvedValue(batches);
      await expect(service.dispenseItem(request)).rejects.toThrow(
        'Insufficient stock',
      );
      expect(tx.batch.updateMany).not.toHaveBeenCalled();
      expect(tx.prescriptionDispensing.create).not.toHaveBeenCalled();
    },
  );

  it('evaluates expiry after waiting for batch locks', async () => {
    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ id: prescription.id }])
      .mockImplementation(async () => {
        jest.setSystemTime(new Date('2035-01-02T12:00:00Z'));
        return [batch()];
      });
    await expect(service.dispenseItem(request)).rejects.toThrow(
      'Insufficient stock',
    );
  });

  it('rejects ambiguous stored date encodings rather than repairing them', async () => {
    tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce([{ id: prescription.id }])
      .mockResolvedValue([
        { ...batch(), expirationDate: new Date('2035-01-01T12:00:00Z') },
      ]);
    await expect(service.dispenseItem(request)).rejects.toThrow('UTC midnight');
    expect(tx.batch.updateMany).not.toHaveBeenCalled();
  });

  it.each([0, 2])(
    'requires each decrement to affect one row, not %i',
    async (count) => {
      tx.batch.updateMany.mockResolvedValue({ count });
      await expect(service.dispenseItem(request)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(tx.prescriptionDispensing.create).not.toHaveBeenCalled();
      expect(tx.prescription.update).not.toHaveBeenCalled();
    },
  );

  it.each(['decrement', 'event', 'status'])(
    'propagates %s failure out of the transaction without retry',
    async (stage) => {
      const failure = new Error(
        stage === 'event' ? 'unique event-ID collision' : stage,
      );
      if (stage === 'decrement') tx.batch.updateMany.mockRejectedValue(failure);
      if (stage === 'event')
        tx.prescriptionDispensing.create.mockRejectedValue(failure);
      if (stage === 'status') tx.prescription.update.mockRejectedValue(failure);
      await expect(service.dispenseItem(request)).rejects.toBe(failure);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      if (stage !== 'status')
        expect(tx.prescription.update).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ...request, prescriptionId: '' },
    { ...request, itemId: ' ' },
    { ...request, eventId: 'not-a-uuid' },
    { ...request, quantity: 0 },
    { ...request, quantity: -1 },
    { ...request, quantity: 1.5 },
    { ...request, quantity: Number.MAX_SAFE_INTEGER + 1 },
  ])(
    'rejects invalid requests before opening a transaction',
    async (invalid) => {
      await expect(service.dispenseItem(invalid)).rejects.toThrow();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('rejects a missing prescription before reading its state', async () => {
    tx.$queryRaw.mockReset().mockResolvedValue([]);
    await expect(service.dispenseItem(request)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.prescription.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('rejects an item belonging to another prescription', async () => {
    await expect(
      service.dispenseItem({ ...request, itemId: 'foreign' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.prescriptionDispensing.findUnique).not.toHaveBeenCalled();
  });
});
