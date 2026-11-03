import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import type { Prisma } from '@prisma/client';
import { afterAll, describe, expect, it, jest } from '@jest/globals';

jest.mock('@prisma/client', () => {
  if (process.env.NINA_AUTH_SESSION_REVOCATION_PG15 !== '1')
    return {
      PrismaClient: class OptOutPrismaClient {},
      Prisma: { TransactionIsolationLevel: { Serializable: 'Serializable' } },
    };
  const client = process.env.NINA_ODONTOGRAM_PG15_PRISMA_CLIENT;
  if (!client) throw new Error('Auth proof requires its runner-issued client');
  return jest.requireActual(client);
});

import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RefreshRotationService,
  type RotatedSession,
} from './refresh-rotation.service';
import { RefreshSessionRevocationService } from './refresh-session-revocation.service';

interface Proof {
  suite: string;
  owner: string;
  runId: string;
  image: string;
  imageId: string;
  containerId: string;
  networkId: string;
  networkName: string;
  networkIsolated: boolean;
  networkMembers: number;
  publishedHost: string;
  publishedPort: number;
  auth: string;
  database: string;
  user: string;
}
interface DockerConfig {
  Image: string;
  Labels: Record<string, string>;
}
interface Port {
  HostIp: string;
  HostPort: string;
}
interface NetworkBinding {
  NetworkID: string;
}
interface NetworkSettings {
  Networks: Record<string, NetworkBinding>;
  Ports: Record<string, Port[]>;
}
interface Container {
  Id: string;
  Image: string;
  Config: DockerConfig;
  NetworkSettings: NetworkSettings;
}
interface Network {
  Id: string;
  Labels: Record<string, string>;
  Containers: Record<string, unknown>;
}

interface BlockedBackend {
  pid: number;
  blockers: number[];
}
interface BackendPid {
  pid: number;
}
interface TransactionOptions {
  isolationLevel: Prisma.TransactionIsolationLevel;
  maxWait: number;
  timeout: number;
}

function inspect<T>(args: string[]): T {
  const result = spawnSync(
    'docker',
    ['--host', 'unix:///var/run/docker.sock', ...args],
    {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: tmpdir() },
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0)
    throw new Error('Could not inspect runner-owned PostgreSQL resources');
  return (JSON.parse(result.stdout) as T[])[0];
}

function ownedUrl(): string | null {
  if (process.env.NINA_AUTH_SESSION_REVOCATION_PG15 !== '1') return null;
  const proofFile = process.env.NINA_ODONTOGRAM_PG15_PROOF_FILE;
  const client = process.env.NINA_ODONTOGRAM_PG15_PRISMA_CLIENT;
  const urlText = process.env.DATABASE_URL;
  if (!proofFile || !client || !urlText)
    throw new Error('Auth proof requires isolated runner ownership evidence');
  const root = dirname(resolve(proofFile));
  if (
    resolve(proofFile) !== proofFile ||
    !root.split('/').at(-1)?.startsWith('nina-odontogram-pg15-') ||
    realpathSync(proofFile) !== resolve(root, 'container-proof.json') ||
    !realpathSync(client).startsWith(`${root}/isolated-client/`) ||
    (statSync(proofFile).mode & 0o077) !== 0 ||
    existsSync(resolve(root, 'prisma', '.env'))
  )
    throw new Error('Auth proof requires private runner-owned temporary files');
  const proof = JSON.parse(readFileSync(proofFile, 'utf8')) as Proof;
  const url = new URL(urlText);
  if (
    proof.suite !== 'auth-session-revocation' ||
    proof.owner !== 'nina-suite' ||
    proof.runId !== process.env.NINA_ODONTOGRAM_PG15_RUN_ID ||
    proof.image !== 'postgres:15-alpine' ||
    !proof.imageId ||
    !proof.containerId ||
    !proof.networkId ||
    proof.networkIsolated !== true ||
    proof.networkMembers !== 1 ||
    proof.auth !== 'isolated-scram' ||
    proof.publishedHost !== '127.0.0.1' ||
    url.protocol !== 'postgresql:' ||
    url.hostname !== proof.publishedHost ||
    url.port !== String(proof.publishedPort) ||
    decodeURIComponent(url.username) !== proof.user ||
    !/^[a-f0-9]{64}$/.test(url.password) ||
    decodeURIComponent(url.pathname.slice(1)) !== proof.database
  )
    throw new Error('Auth proof DSN does not match owned PostgreSQL evidence');
  const container = inspect<Container>(['inspect', proof.containerId]);
  const network = inspect<Network>(['network', 'inspect', proof.networkId]);
  const labels = {
    'nina.odontogram-postgres15.owner': 'nina-suite',
    'nina.odontogram-postgres15.run': proof.runId,
  };
  expect(container.Id).toBe(proof.containerId);
  expect(container.Image).toBe(proof.imageId);
  expect(container.Config.Image).toBe(proof.image);
  expect(container.Config.Labels).toMatchObject(labels);
  expect(container.NetworkSettings.Networks[proof.networkName].NetworkID).toBe(
    proof.networkId,
  );
  expect(container.NetworkSettings.Ports['5432/tcp']).toEqual([
    { HostIp: '127.0.0.1', HostPort: String(proof.publishedPort) },
  ]);
  expect(network.Id).toBe(proof.networkId);
  expect(network.Labels).toMatchObject(labels);
  expect(Object.keys(network.Containers)).toEqual([proof.containerId]);
  return urlText;
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

const databaseUrl = ownedUrl();
const postgres15 = databaseUrl ? describe : describe.skip;
postgres15('Refresh-authenticated revocation on owned PostgreSQL 15', () => {
  if (!databaseUrl) {
    it.skip('requires the explicit isolated PostgreSQL runner', () => {});
    return;
  }
  const clients: PrismaClient[] = [];
  function client(label: string): PrismaClient {
    const url = new URL(databaseUrl!);
    url.searchParams.set('connection_limit', '1');
    url.searchParams.set('application_name', label);
    const db = new PrismaClient({
      datasourceUrl: url.toString(),
      errorFormat: 'minimal',
    });
    clients.push(db);
    return db;
  }
  const db = client('b2-fixtures');
  const monitor = client('b2-monitor');
  const blocker = client('b2-blocker');
  const firstDb = client('b2-first');
  const secondDb = client('b2-second');
  const revoke = (writer: PrismaClient) =>
    new RefreshSessionRevocationService(writer as unknown as PrismaService);
  const rotate = (writer: PrismaClient) =>
    new RefreshRotationService(writer as unknown as PrismaService);

  async function fixture(expiresAt: Date | null = null, userId?: string) {
    const owner = userId
      ? await db.user.findUniqueOrThrow({ where: { id: userId } })
      : await db.user.create({
          data: {
            username: `b2_${randomBytes(8).toString('hex')}`,
            passwordHash: `synthetic-unusable-${randomUUID()}`,
            role: 'STUDENT',
          },
        });
    const createdAt = new Date(Date.now() - 60000);
    const session = await db.authSession.create({
      data: {
        userId: owner.id,
        authVersion: owner.authVersion,
        createdAt,
        expiresAt,
      },
    });
    const credential = randomBytes(32).toString('base64url');
    const token = await db.refreshToken.create({
      data: {
        sessionId: session.id,
        tokenHash: createHash('sha256').update(credential).digest('hex'),
        createdAt,
        expiresAt,
      },
    });
    return { owner, session, token, credential };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;

  async function snapshot(value: Fixture) {
    return {
      session: await db.authSession.findUniqueOrThrow({
        where: { id: value.session.id },
      }),
      tokens: await db.refreshToken.findMany({
        where: { sessionId: value.session.id },
        orderBy: { id: 'asc' },
      }),
      owner: await db.user.findUniqueOrThrow({ where: { id: value.owner.id } }),
    };
  }

  async function waiting(label: string, blockingPid: number): Promise<number> {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const rows = await monitor.$queryRaw<BlockedBackend[]>`
        SELECT pid, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = ${label}
          AND wait_event_type = 'Lock'
      `;
      if (rows.some((row) => row.blockers.includes(blockingPid)))
        return rows.find((row) => row.blockers.includes(blockingPid))!.pid;
      await setTimeout(10);
    }
    throw new Error(
      'Expected identified PostgreSQL lock contention was not observed',
    );
  }

  // The server trigger pauses the first UPDATE with its row lock held. The second
  // actual service must be observed waiting on that backend before release.
  async function orderedRace(
    first: () => Promise<unknown>,
    second: () => Promise<unknown>,
  ) {
    await db.$executeRawUnsafe(`CREATE FUNCTION b2_claim_barrier() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(734019); RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER b2_claim_barrier BEFORE UPDATE ON "RefreshToken"
      FOR EACH ROW EXECUTE FUNCTION b2_claim_barrier()`);
    const acquired = latch();
    const release = latch();
    let blockingPid = 0;
    const lock = blocker.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(734019)`;
        const rows = await tx.$queryRaw<
          BackendPid[]
        >`SELECT pg_backend_pid() AS pid`;
        blockingPid = rows[0].pid;
        acquired.resolve();
        await release.promise;
      },
      { timeout: 10000 },
    );
    // Settle/release in finally even when observation or a service assertion fails.
    let firstResult: Promise<unknown> | undefined;
    let secondResult: Promise<unknown> | undefined;
    try {
      await Promise.race([
        acquired.promise,
        lock.then(() => {
          throw new Error('Blocker ended before acquisition');
        }),
      ]);
      firstResult = first();
      const firstPid = await waiting('b2-first', blockingPid);
      secondResult = second();
      const secondPid = await waiting('b2-second', firstPid);
      expect(new Set([blockingPid, firstPid, secondPid]).size).toBe(3);
      release.resolve();
      await lock;
      return await Promise.all([firstResult, secondResult]);
    } finally {
      release.resolve();
      await Promise.allSettled([lock, firstResult, secondResult]);
      await db.$executeRawUnsafe(
        'DROP TRIGGER b2_claim_barrier ON "RefreshToken"',
      );
      await db.$executeRawUnsafe('DROP FUNCTION b2_claim_barrier()');
    }
  }

  afterAll(async () => {
    // The database itself is disposable; never touch a foreign database/table.
    await Promise.all(clients.map((instance) => instance.$disconnect()));
  });

  it.each([null, 'finite'])(
    'settles successful revocation with %s expiry',
    async (expiry) => {
      const value = await fixture(expiry ? new Date(Date.now() + 60000) : null);
      expect(await revoke(firstDb).revoke(value.credential)).toBe(true);
      const after = await snapshot(value);
      expect(after.session.revokedAt).toBeInstanceOf(Date);
      expect(after.tokens).toHaveLength(1);
      expect(after.tokens[0].consumedAt).toBeInstanceOf(Date);
      expect(after.owner).toEqual(value.owner);
      expect(await revoke(secondDb).revoke(value.credential)).toBe(false);
    },
  );

  const DENIALS = [
    'consumed',
    'revoked',
    'inactive',
    'version',
    'expired',
    'unpaired',
    'creation',
    'binding',
  ] as const;
  it.each(DENIALS)('denies %s state without writes', async (reason) => {
    const value = await fixture();
    const past = new Date(Date.now() - 10000);
    if (reason === 'consumed')
      await db.refreshToken.update({
        where: { id: value.token.id },
        data: { consumedAt: past },
      });
    if (reason === 'revoked')
      await db.authSession.update({
        where: { id: value.session.id },
        data: { revokedAt: past },
      });
    if (reason === 'inactive')
      await db.user.update({
        where: { id: value.owner.id },
        data: { isActive: false },
      });
    if (reason === 'version')
      await db.user.update({
        where: { id: value.owner.id },
        data: { authVersion: 1 },
      });
    if (reason === 'expired' || reason === 'unpaired')
      await db.refreshToken.update({
        where: { id: value.token.id },
        data: { expiresAt: past },
      });
    if (reason === 'expired')
      await db.authSession.update({
        where: { id: value.session.id },
        data: { expiresAt: past },
      });
    if (reason === 'creation')
      await db.refreshToken.update({
        where: { id: value.token.id },
        data: { createdAt: new Date(value.session.createdAt.getTime() - 1000) },
      });
    const before = await snapshot(value);
    const result =
      reason === 'binding'
        ? await revoke(firstDb).revoke(value.credential, {
            sessionId: randomUUID(),
            account: {
              id: value.owner.id,
              username: value.owner.username,
              role: value.owner.role,
              authVersion: value.owner.authVersion,
            },
          })
        : await revoke(firstDb).revoke(value.credential);
    expect(result).toBe(false);
    expect(await snapshot(value)).toEqual(before);
  });

  it('rejects malformed or unknown credentials without changing a valid session', async () => {
    const value = await fixture();
    const before = await snapshot(value);
    expect(await revoke(firstDb).revoke('not-a-refresh-credential')).toBe(
      false,
    );
    expect(
      await revoke(firstDb).revoke(randomBytes(32).toString('base64url')),
    ).toBe(false);
    expect(await snapshot(value)).toEqual(before);
  });

  it('leaves other owners, same-owner sessions and sibling tokens unchanged', async () => {
    const value = await fixture();
    const sameOwner = await fixture(null, value.owner.id);
    const otherOwner = await fixture();
    const before = await Promise.all([
      snapshot(sameOwner),
      snapshot(otherOwner),
    ]);
    const sibling = await db.refreshToken.create({
      data: {
        sessionId: value.session.id,
        tokenHash: createHash('sha256').update(randomBytes(32)).digest('hex'),
      },
    });
    expect(await revoke(firstDb).revoke(value.credential)).toBe(true);
    expect(
      await Promise.all([snapshot(sameOwner), snapshot(otherOwner)]),
    ).toEqual(before);
    expect(
      await db.refreshToken.findUnique({ where: { id: sibling.id } }),
    ).toEqual(sibling);
    expect(
      await db.refreshToken.count({ where: { sessionId: value.session.id } }),
    ).toBe(2);
  });

  it('allows exactly one of two actually contending logout claims', async () => {
    const value = await fixture();
    expect(
      await orderedRace(
        () => revoke(firstDb).revoke(value.credential),
        () => revoke(secondDb).revoke(value.credential),
      ),
    ).toEqual([true, false]);
    const after = await snapshot(value);
    expect(after.session.revokedAt).toBeInstanceOf(Date);
    expect(after.tokens).toHaveLength(1);
    expect(after.tokens[0].consumedAt).toBeInstanceOf(Date);
  });

  it('logout wins the observed lock order and rotation creates no successor', async () => {
    const value = await fixture();
    const [logout, rotation] = await orderedRace(
      () => revoke(firstDb).revoke(value.credential),
      () => rotate(secondDb).rotate(value.credential),
    );
    expect(logout).toBe(true);
    // Never print a raw successor credential, even if an assertion fails.
    expect(rotation === null).toBe(true);
    const after = await snapshot(value);
    expect(after.session.revokedAt).toBeInstanceOf(Date);
    expect(after.tokens).toHaveLength(1);
    expect(after.tokens[0].consumedAt).toBeInstanceOf(Date);
  });

  it('rotation wins the observed lock order; old-token logout denies without revocation', async () => {
    const value = await fixture();
    const [rotation, logout] = await orderedRace(
      () => rotate(firstDb).rotate(value.credential),
      () => revoke(secondDb).revoke(value.credential),
    );
    expect(logout).toBe(false);
    expect((rotation as RotatedSession | null)?.id).toBe(value.session.id);
    const after = await snapshot(value);
    expect(after.session.revokedAt).toBeNull();
    expect(after.tokens).toHaveLength(2);
    expect(
      after.tokens.find((token) => token.id === value.token.id)?.consumedAt,
    ).toBeInstanceOf(Date);
    expect(
      after.tokens.filter((token) => token.consumedAt === null),
    ).toHaveLength(1);
  });

  it('rolls back the token claim on an observed post-claim server abort', async () => {
    const value = await fixture();
    const before = await snapshot(value);
    await db.$executeRawUnsafe('CREATE SEQUENCE b2_abort_observed');
    await db.$executeRawUnsafe(`CREATE FUNCTION b2_abort_session() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM "RefreshToken" WHERE "sessionId" = NEW.id AND "consumedAt" IS NOT NULL)
        THEN RAISE EXCEPTION 'claim not visible'; END IF;
        PERFORM nextval('b2_abort_observed');
        RAISE EXCEPTION 'synthetic post-claim abort';
      END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER b2_abort_session BEFORE UPDATE ON "AuthSession"
      FOR EACH ROW EXECUTE FUNCTION b2_abort_session()`);
    try {
      expect(await revoke(firstDb).revoke(value.credential)).toBe(false);
      // Sequences are nontransactional: this proves the server saw the claim
      // before aborting, rather than merely observing an unrelated false result.
      expect(
        await db.$queryRaw`SELECT is_called FROM b2_abort_observed`,
      ).toEqual([{ is_called: true }]);
      expect(await snapshot(value)).toEqual(before);
    } finally {
      await db.$executeRawUnsafe(
        'DROP TRIGGER b2_abort_session ON "AuthSession"',
      );
      await db.$executeRawUnsafe('DROP FUNCTION b2_abort_session()');
      await db.$executeRawUnsafe('DROP SEQUENCE b2_abort_observed');
    }
    expect(await revoke(secondDb).revoke(value.credential)).toBe(true);
  });

  it('denies injected lost settlement after a real commit without claiming rollback', async () => {
    const value = await fixture();
    let commits = 0;
    // This is an injected acknowledgement loss, NOT a real connection failure.
    const ambiguous = new Proxy(firstDb, {
      get(target, property, receiver) {
        if (property !== '$transaction')
          return Reflect.get(target, property, receiver);
        return async (
          work: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options: TransactionOptions,
        ) => {
          await target.$transaction(work, options);
          commits += 1;
          throw new Error('synthetic lost settlement acknowledgement');
        };
      },
    });
    expect(await revoke(ambiguous).revoke(value.credential)).toBe(false);
    expect(commits).toBe(1);
    const after = await snapshot(value);
    expect(after.session.revokedAt).toBeInstanceOf(Date);
    expect(after.tokens).toHaveLength(1);
    expect(after.tokens[0].consumedAt).toBeInstanceOf(Date);
    expect(await revoke(secondDb).revoke(value.credential)).toBe(false);
  });
});
