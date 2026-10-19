import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedAccount } from './credential-authentication.service';

const ACCOUNT_SELECTION = {
  id: true,
  username: true,
  role: true,
  isActive: true,
  authVersion: true,
} as const;
const TRANSACTION_OPTIONS = {
  maxWait: 2000,
  timeout: 5000,
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
} as const;

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Internal online check only; the caller must first verify its access credential. */
  async validate(
    sessionId: unknown,
    ownerId: unknown,
    authVersion: unknown,
  ): Promise<AuthenticatedAccount | null> {
    if (
      !this.isId(sessionId) ||
      !this.isId(ownerId) ||
      !this.isVersion(authVersion)
    )
      return null;
    try {
      const snapshot = await this.prisma.$transaction(async (tx) => {
        const session = await tx.authSession.findUnique({
          where: { id: sessionId },
          select: {
            userId: true,
            authVersion: true,
            createdAt: true,
            expiresAt: true,
            revokedAt: true,
            user: { select: ACCOUNT_SELECTION },
          },
        });
        if (!session) return null;
        const createdAt = session.createdAt.getTime();
        const expiresAt = session.expiresAt.getTime();
        const now = Date.now();
        if (
          session.userId !== ownerId ||
          session.user.id !== ownerId ||
          session.authVersion !== authVersion ||
          session.user.authVersion !== authVersion ||
          session.user.isActive !== true ||
          session.revokedAt !== null ||
          !Number.isFinite(createdAt) ||
          !Number.isFinite(expiresAt) ||
          createdAt > now ||
          expiresAt <= now
        )
          return null;
        return { account: this.identity(session.user), expiresAt };
      }, TRANSACTION_OPTIONS);
      return snapshot && snapshot.expiresAt > Date.now()
        ? snapshot.account
        : null;
    } catch {
      return null;
    }
  }

  private isId(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length === 36 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        value,
      )
    );
  }

  private isVersion(value: unknown): value is number {
    return (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 2147483647
    );
  }

  private identity(account: AuthenticatedAccount): AuthenticatedAccount {
    return {
      id: account.id,
      username: account.username,
      role: account.role,
      authVersion: account.authVersion,
    };
  }
}
