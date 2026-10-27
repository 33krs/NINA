import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { VerifiedAccessSession } from './access-credential.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_SELECTION = {
  id: true,
  sessionId: true,
  createdAt: true,
  expiresAt: true,
  consumedAt: true,
  session: {
    select: {
      id: true,
      userId: true,
      authVersion: true,
      createdAt: true,
      expiresAt: true,
      revokedAt: true,
      user: { select: { id: true, isActive: true, authVersion: true } },
    },
  },
} as const;
const TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 2000,
  timeout: 5000,
} as const;

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 36 && UUID.test(value);
}
function isVersion(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2147483647
  );
}
function milliseconds(value: unknown): number {
  return value instanceof Date ? value.getTime() : NaN;
}
interface Binding {
  readonly sessionId: string;
  readonly ownerId: string;
  readonly authVersion: number;
}

/** Internal only: deliberately absent from application providers and routes. */
@Injectable()
export class RefreshSessionRevocationService {
  constructor(private readonly prisma: PrismaService) {}

  async revoke(
    refreshToken: unknown,
    expectedBinding?: VerifiedAccessSession,
  ): Promise<boolean> {
    try {
      if (
        typeof refreshToken !== 'string' ||
        refreshToken.length !== 43 ||
        !/^[A-Za-z0-9_-]{43}$/.test(refreshToken)
      )
        return false;
      const decoded = Buffer.from(refreshToken, 'base64url');
      if (
        decoded.length !== 32 ||
        decoded.toString('base64url') !== refreshToken
      )
        return false;
      let binding: Binding | null = null;
      if (arguments.length > 1) {
        if (
          !expectedBinding ||
          typeof expectedBinding !== 'object' ||
          Array.isArray(expectedBinding)
        )
          return false;
        const { sessionId, account } = expectedBinding;
        if (!account || typeof account !== 'object' || Array.isArray(account))
          return false;
        const { id: ownerId, authVersion } = account;
        if (!isId(sessionId) || !isId(ownerId) || !isVersion(authVersion))
          return false;
        binding = { sessionId, ownerId, authVersion };
      }
      let checkedAt = Date.now();
      if (
        !Number.isSafeInteger(checkedAt) ||
        !Number.isFinite(new Date(checkedAt).getTime())
      )
        return false;
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
      let capturedExpiry: number | null = null;
      const result = await this.prisma.$transaction(async (tx) => {
        const token = await tx.refreshToken.findUnique({
          where: { tokenHash },
          select: TOKEN_SELECTION,
        });
        if (!token || token.consumedAt !== null) return false;
        const session = token.session;
        const account = session.user;
        const tokenCreatedAt = milliseconds(token.createdAt);
        const sessionCreatedAt = milliseconds(session.createdAt);
        const expiresAt =
          token.expiresAt === null ? null : milliseconds(token.expiresAt);
        const sessionExpiry =
          session.expiresAt === null ? null : milliseconds(session.expiresAt);
        const sessionId = session.id;
        const ownerId = account.id;
        const authVersion = session.authVersion;
        if (
          !isId(token.id) ||
          !isId(sessionId) ||
          !isId(ownerId) ||
          token.sessionId !== sessionId ||
          session.userId !== ownerId ||
          tokenCreatedAt < sessionCreatedAt ||
          !Number.isFinite(tokenCreatedAt) ||
          !Number.isFinite(sessionCreatedAt) ||
          session.revokedAt !== null ||
          account.isActive !== true ||
          !isVersion(authVersion) ||
          authVersion !== account.authVersion ||
          expiresAt !== sessionExpiry ||
          (expiresAt !== null && !Number.isFinite(expiresAt)) ||
          (binding &&
            (binding.sessionId !== sessionId ||
              binding.ownerId !== ownerId ||
              binding.authVersion !== authVersion))
        )
          return false;
        capturedExpiry = expiresAt;
        checkedAt = this.checkTime(
          Math.max(checkedAt, tokenCreatedAt),
          capturedExpiry,
        );
        const claimed = await tx.refreshToken.updateMany({
          where: { id: token.id, sessionId, consumedAt: null },
          data: { consumedAt: new Date(checkedAt) },
        });
        if (claimed.count !== 1)
          throw new Error('Refresh revocation unavailable');
        checkedAt = this.checkTime(checkedAt, capturedExpiry);
        const revoked = await tx.authSession.updateMany({
          where: {
            id: sessionId,
            userId: ownerId,
            authVersion,
            revokedAt: null,
          },
          data: { revokedAt: new Date(checkedAt) },
        });
        if (revoked.count !== 1)
          throw new Error('Refresh revocation unavailable');
        checkedAt = this.checkTime(checkedAt, capturedExpiry);
        return true;
      }, TRANSACTION_OPTIONS);
      if (result !== true) return false;
      this.checkTime(checkedAt, capturedExpiry);
      return true;
    } catch {
      // A false result cannot establish whether an uncertain commit took effect.
      return false;
    }
  }

  private checkTime(notBefore: number, expiresAt: number | null): number {
    const now = Date.now();
    if (
      !Number.isSafeInteger(now) ||
      !Number.isFinite(new Date(now).getTime()) ||
      now < notBefore ||
      (expiresAt !== null && now >= expiresAt)
    )
      throw new Error('Refresh revocation unavailable');
    return now;
  }
}
