import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedAccount } from './credential-authentication.service';

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
      user: {
        select: {
          id: true,
          username: true,
          role: true,
          isActive: true,
          authVersion: true,
        },
      },
    },
  },
} as const;
const TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 2000,
  timeout: 5000,
} as const;

export interface RotatedSession {
  readonly id: string;
  readonly account: AuthenticatedAccount;
  readonly expiresAt: Date;
  readonly refreshToken: string;
}

@Injectable()
export class RefreshRotationService {
  constructor(private readonly prisma: PrismaService) {}

  async rotate(refreshToken: unknown): Promise<RotatedSession | null> {
    try {
      if (
        typeof refreshToken !== 'string' ||
        refreshToken.length !== 43 ||
        !/^[A-Za-z0-9_-]{43}$/.test(refreshToken) ||
        Buffer.from(refreshToken, 'base64url').toString('base64url') !==
          refreshToken
      )
        return null;
      const tokenHash = createHash('sha256').update(refreshToken).digest('hex');
      const result = await this.prisma.$transaction(async (tx) => {
        const token = await tx.refreshToken.findUnique({
          where: { tokenHash },
          select: TOKEN_SELECTION,
        });
        if (!token || token.consumedAt !== null) return null;
        const session = token.session;
        const account = session.user;
        const createdAt = token.createdAt.getTime();
        const sessionCreatedAt = session.createdAt.getTime();
        const expiresAt = token.expiresAt.getTime();
        const sessionExpiresAt = session.expiresAt.getTime();
        const rotatedAt = new Date();
        if (
          token.sessionId !== session.id ||
          session.userId !== account.id ||
          account.isActive !== true ||
          session.revokedAt !== null ||
          !Number.isInteger(session.authVersion) ||
          session.authVersion < 0 ||
          session.authVersion > 2147483647 ||
          session.authVersion !== account.authVersion ||
          ![createdAt, sessionCreatedAt, expiresAt, sessionExpiresAt].every(
            Number.isFinite,
          ) ||
          createdAt < sessionCreatedAt ||
          createdAt > rotatedAt.getTime() ||
          expiresAt <= rotatedAt.getTime() ||
          expiresAt !== sessionExpiresAt
        )
          return null;

        const successor = randomBytes(32).toString('base64url');
        const successorHash = createHash('sha256')
          .update(successor)
          .digest('hex');
        const consumed = await tx.refreshToken.updateMany({
          where: { id: token.id, sessionId: session.id, consumedAt: null },
          data: { consumedAt: rotatedAt },
        });
        // Abort instead of committing any unexpected partial consumption.
        if (consumed.count !== 1)
          throw new Error('Refresh consumption unavailable');
        await tx.refreshToken.create({
          data: {
            sessionId: session.id,
            tokenHash: successorHash,
            createdAt: rotatedAt,
            expiresAt: new Date(expiresAt),
          },
          select: { id: true },
        });
        return {
          id: session.id,
          account: {
            id: account.id,
            username: account.username,
            role: account.role,
            authVersion: account.authVersion,
          },
          expiresAt: new Date(expiresAt),
          refreshToken: successor,
        };
      }, TRANSACTION_OPTIONS);
      return result && result.expiresAt.getTime() > Date.now() ? result : null;
    } catch {
      // No retry/recovery or automatic revocation after an uncertain commit.
      return null;
    }
  }
}
