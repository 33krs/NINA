import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { URL } from 'node:url';
import type { Prisma } from '@prisma/client';
import { afterAll, describe, expect, it, jest } from '@jest/globals';

jest.mock('@prisma/client', () => {
  if (process.env.NINA_ODONTOGRAM_PG15_TESTS !== '1') {
    return { PrismaClient: class OptOutPrismaClient {} };
  }
  const isolatedClientPath = process.env.NINA_ODONTOGRAM_PG15_PRISMA_CLIENT;
  if (!isolatedClientPath)
    throw new Error(
      'The PostgreSQL runner must provide its isolated generated Prisma client',
    );
  return jest.requireActual(isolatedClientPath);
});

import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { OdontogramService } from './odontogram.service';

const RUN_ID = 'NINA_ODONTOGRAM_PG15_RUN_ID';
const PROOF_FILE = 'NINA_ODONTOGRAM_PG15_PROOF_FILE';
const OPT_IN = 'NINA_ODONTOGRAM_PG15_TESTS';
const ISOLATED_CLIENT = 'NINA_ODONTOGRAM_PG15_PRISMA_CLIENT';
const OWNER = 'nina-suite';
const IMAGE = 'postgres:15-alpine';
const DOCKER_HOST = 'unix:///var/run/docker.sock';

interface ContainerProof {
  owner: string;
  runId: string;
  containerId: string;
  networkId: string;
  networkName: string;
  image: string;
  imageId: string;
  networkIsolated: boolean;
  networkMembers: number;
  publishedHost: string;
  publishedPort: number;
  database: string;
  user: string;
  auth: string;
  baselinePatient: string;
  baselineOdontogram: string;
  baselineTime: string;
  baselineJson: string;
}

interface SuiteConfig {
  proof: ContainerProof;
  databaseUrl: string;
  isolatedClientPath: string;
  tempRoot: string;
}

function inspectDocker(args: string[]): Record<string, unknown>[] {
  const result = spawnSync('docker', ['--host', DOCKER_HOST, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: resolve(tmpdir()) },
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error('Could not verify the runner-owned PostgreSQL container');
  }
  return JSON.parse(result.stdout) as Record<string, unknown>[];
}

function suiteConfig(): SuiteConfig | null {
  if (process.env[OPT_IN] !== '1') return null;
  const runId = process.env[RUN_ID];
  const proofFile = process.env[PROOF_FILE];
  const databaseUrl = process.env.DATABASE_URL;
  const isolatedClientPath = process.env[ISOLATED_CLIENT];
  if (!runId || !proofFile || !databaseUrl || !isolatedClientPath) {
    throw new Error(
      'The PostgreSQL 15 suite requires its runner-issued ownership proof',
    );
  }
  const absoluteProof = resolve(proofFile);
  const proofDirectory = dirname(absoluteProof);
  if (
    !isAbsolute(proofFile) ||
    absoluteProof !== resolve(proofDirectory, 'container-proof.json') ||
    !proofDirectory.split('/').at(-1)?.startsWith('nina-odontogram-pg15-')
  ) {
    throw new Error(
      'The PostgreSQL 15 proof must be inside the runner-owned temporary directory',
    );
  }
  const proof = JSON.parse(
    readFileSync(absoluteProof, 'utf8'),
  ) as ContainerProof;
  const tempRoot = proofDirectory;
  if (
    !resolve(isolatedClientPath).startsWith(`${tempRoot}/`) ||
    existsSync(resolve(proofDirectory, 'prisma', '.env'))
  ) {
    throw new Error(
      'Prisma must use the generated temporary client without an environment file',
    );
  }
  const url = new URL(databaseUrl);
  if (
    proof.owner !== OWNER ||
    proof.runId !== runId ||
    !proof.containerId ||
    !proof.networkId ||
    !proof.networkName ||
    proof.image !== IMAGE ||
    proof.networkIsolated !== true ||
    proof.networkMembers !== 1 ||
    proof.publishedHost !== '127.0.0.1' ||
    proof.auth !== 'isolated-trust' ||
    url.hostname !== proof.publishedHost ||
    url.port !== String(proof.publishedPort) ||
    decodeURIComponent(url.pathname.slice(1)) !== proof.database ||
    !proof.baselinePatient ||
    !proof.baselineOdontogram ||
    !proof.baselineTime ||
    !proof.baselineJson
  ) {
    throw new Error(
      'The PostgreSQL URL does not match the isolated runner-owned container proof',
    );
  }
  const container = inspectDocker(['inspect', proof.containerId])[0];
  const containerConfig = container.Config as {
    Image?: string;
    Labels?: Record<string, string>;
  };
  const networkSettings = container.NetworkSettings as {
    Networks?: Record<string, { NetworkID?: string }>;
    Ports?: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  };
  expect(container.Id).toBe(proof.containerId);
  expect(container.State).toMatchObject({ Status: 'running' });
  expect(containerConfig.Image).toBe(IMAGE);
  expect(containerConfig.Labels).toMatchObject({
    'nina.odontogram-postgres15.owner': OWNER,
    'nina.odontogram-postgres15.run': runId,
  });
  expect(networkSettings.Networks?.[proof.networkName]?.NetworkID).toBe(
    proof.networkId,
  );
  expect(networkSettings.Ports?.['5432/tcp']).toContainEqual({
    HostIp: '127.0.0.1',
    HostPort: String(proof.publishedPort),
  });
  const network = inspectDocker(['network', 'inspect', proof.networkId])[0];
  expect(network.Id).toBe(proof.networkId);
  expect(network.Labels).toMatchObject({
    'nina.odontogram-postgres15.owner': OWNER,
    'nina.odontogram-postgres15.run': runId,
  });
  expect(Object.keys(network.Containers as Record<string, unknown>)).toEqual([
    proof.containerId,
  ]);
  return { proof, databaseUrl, isolatedClientPath, tempRoot };
}

const config = suiteConfig();
const postgres15 = config ? describe : describe.skip;

postgres15(
  'Odontogram persistence against the isolated PostgreSQL 15 runner',
  () => {
    if (!config) {
      it.skip('requires explicit PostgreSQL runner ownership proof', () => {});
      return;
    }
    const clients: PrismaClient[] = [];
    const client = () => {
      const instance = new PrismaClient({ datasourceUrl: config!.databaseUrl });
      clients.push(instance);
      return instance;
    };
    const baselineDb = client();
    const blocker = client();
    const monitor = client();
    const writers = Array.from({ length: 4 }, client);
    const services = writers.map(
      (prisma) => new OdontogramService(prisma as unknown as PrismaService),
    );
    const racePatient = randomUUID();
    const rollbackPatient = randomUUID();

    async function createPatient(
      prisma: PrismaClient,
      id: string,
    ): Promise<void> {
      await prisma.patient.create({
        data: {
          id,
          rut: `synthetic-${id}`,
          firstName: 'Synthetic',
          lastName: 'Verification',
          dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
        },
      });
    }

    async function waitForBlockedWriters(): Promise<number> {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const rows = await monitor.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS "count"
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%FOR UPDATE%'
      `;
        if (rows[0].count >= 2) return rows[0].count;
        await setTimeout(25);
      }
      return 0;
    }

    async function race(
      patientId: string,
      expectedVersions: number[],
    ): Promise<void> {
      let pending:
        | Promise<Array<{ version: number; state: Prisma.InputJsonValue }>>
        | undefined;
      let blockedCount = 0;
      await blocker.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Patient" WHERE "id" = ${patientId} FOR UPDATE`;
        pending = Promise.all(
          services.map(async (service, index) => {
            const state: Prisma.InputJsonValue = {
              synthetic: 'writer-state',
              writer: index,
              details: ['opaque', index, null],
            };
            const saved = await service.replaceCurrent(patientId, state);
            return { version: saved.version, state };
          }),
        );
        blockedCount = await waitForBlockedWriters();
      });

      expect(blockedCount).toBeGreaterThanOrEqual(2);
      const results = await pending!;
      expect(
        results.map((result) => result.version).sort((a, b) => a - b),
      ).toEqual(expectedVersions);
      for (const result of results) {
        const revision = await baselineDb.odontogramRevision.findUnique({
          where: {
            odontogramId_version: {
              odontogramId: (
                await baselineDb.odontogram.findUniqueOrThrow({
                  where: { patientId },
                })
              ).id,
              version: result.version,
            },
          },
        });
        expect(revision?.teethStates).toEqual(result.state);
      }
      const current = await baselineDb.odontogram.findUniqueOrThrow({
        where: { patientId },
      });
      expect(current.version).toBe(expectedVersions.at(-1));
      expect(current.teethStates).toEqual(
        results.find((result) => result.version === expectedVersions.at(-1))
          ?.state,
      );
    }

    afterAll(async () => {
      await Promise.allSettled(
        clients.map((instance) => instance.$disconnect()),
      );
    });

    it('backfills the original current JSON and updatedAt as baseline version zero', async () => {
      const { proof } = config!;
      expect(
        resolve(config!.isolatedClientPath).startsWith(`${config!.tempRoot}/`),
      ).toBe(true);
      expect(existsSync(resolve(config!.tempRoot, 'prisma', '.env'))).toBe(
        false,
      );
      const current = await baselineDb.odontogram.findUniqueOrThrow({
        where: { patientId: proof.baselinePatient },
      });
      const revision = await baselineDb.odontogramRevision.findUniqueOrThrow({
        where: {
          odontogramId_version: {
            odontogramId: proof.baselineOdontogram,
            version: 0,
          },
        },
      });
      expect(current.version).toBe(0);
      expect(current.teethStates).toEqual(JSON.parse(proof.baselineJson));
      expect(current.updatedAt.toISOString()).toBe(proof.baselineTime);
      expect(revision.teethStates).toEqual(JSON.parse(proof.baselineJson));
      expect(revision.createdAt.toISOString()).toBe(proof.baselineTime);
    });

    it('serializes four independent first writes and later writes with contiguous snapshots', async () => {
      await createPatient(baselineDb, racePatient);
      await race(racePatient, [1, 2, 3, 4]);
      await race(racePatient, [5, 6, 7, 8]);
    });

    it('rolls back first and later writes on snapshot failure, then recovers', async () => {
      await createPatient(baselineDb, rollbackPatient);
      const before = await baselineDb.odontogram.findUniqueOrThrow({
        where: { patientId: racePatient },
      });
      const history = await baselineDb.odontogramRevision.findMany({
        where: { odontogramId: before.id },
        orderBy: { version: 'asc' },
      });
      await baselineDb.$executeRawUnsafe(`
      CREATE FUNCTION fail_odontogram_revision() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic revision failure'; END $$
    `);
      await baselineDb.$executeRawUnsafe(`
      CREATE TRIGGER fail_odontogram_revision BEFORE INSERT ON "OdontogramRevision"
      FOR EACH ROW EXECUTE FUNCTION fail_odontogram_revision()
    `);
      try {
        await expect(
          services[0].replaceCurrent(racePatient, {
            synthetic: 'existing rollback',
          }),
        ).rejects.toThrow();
        await expect(
          services[0].replaceCurrent(rollbackPatient, [
            'synthetic first rollback',
          ]),
        ).rejects.toThrow();
        expect(
          await baselineDb.odontogram.findUnique({
            where: { patientId: rollbackPatient },
          }),
        ).toBeNull();
        expect(
          await baselineDb.odontogram.findUnique({
            where: { patientId: racePatient },
          }),
        ).toEqual(before);
        expect(
          await baselineDb.odontogramRevision.findMany({
            where: { odontogramId: before.id },
            orderBy: { version: 'asc' },
          }),
        ).toEqual(history);
      } finally {
        await baselineDb.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS fail_odontogram_revision ON "OdontogramRevision"',
        );
        await baselineDb.$executeRawUnsafe(
          'DROP FUNCTION IF EXISTS fail_odontogram_revision()',
        );
      }
      expect(
        (
          await services[0].replaceCurrent(racePatient, {
            synthetic: 'recovered existing',
          })
        ).version,
      ).toBe(9);
      expect(
        (
          await services[0].replaceCurrent(rollbackPatient, [
            'synthetic recovered first',
          ])
        ).version,
      ).toBe(1);
    });

    it('paginates history descending with an exclusive cursor including baseline zero', async () => {
      const baselineId = config!.proof.baselinePatient;
      const firstPage = await services[0].getVersions(racePatient, {
        limit: 3,
      });
      const nextPage = await services[0].getVersions(racePatient, {
        limit: 3,
        beforeVersion: 7,
      });
      expect(firstPage.map((revision) => revision.version)).toEqual([9, 8, 7]);
      expect(nextPage.map((revision) => revision.version)).toEqual([6, 5, 4]);
      expect(
        (await services[0].getVersions(baselineId, { beforeVersion: 1 })).map(
          (revision) => revision.version,
        ),
      ).toEqual([0]);
      expect(
        await services[0].getVersions(baselineId, { beforeVersion: 0 }),
      ).toEqual([]);
    });
  },
);
