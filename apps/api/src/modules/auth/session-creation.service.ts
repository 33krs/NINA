import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CredentialAuthenticationService,
  type AuthenticatedAccount,
} from './credential-authentication.service';

const ACCOUNT_SELECTION = {
  id: true,
  username: true,
  role: true,
  isActive: true,
  authVersion: true,
} as const;
const TRANSACTION_LIMITS = { maxWait: 2000, timeout: 5000 } as const;

export interface CreatedSession {
  readonly id: string;
  readonly account: AuthenticatedAccount;
  readonly expiresAt: Date;
  readonly refreshToken: string;
}

@Injectable()
export class SessionCreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialAuthenticationService,
  ) {}

  async create(
    username: unknown,
    password: unknown,
    expiresAt: unknown,
  ): Promise<CreatedSession | null> {
    try {
      // Snapshot caller-owned Date before credential/transaction awaits.
      const milliseconds =
        expiresAt instanceof Date ? expiresAt.getTime() : NaN;
      if (!Number.isFinite(milliseconds) || milliseconds <= Date.now())
        return null;
      const expiration = new Date(milliseconds);
      const authenticated = await this.credentials.authenticate(
        username,
        password,
      );
      if (!authenticated) return null;

      // Await the transaction itself: callback success is not commit success.
      const result = await this.prisma.$transaction(
        async (tx) => {
          const account = await tx.user.findUnique({
            where: { id: authenticated.id },
            select: ACCOUNT_SELECTION,
          });
          const createdAt = new Date();
          if (
            !account ||
            account.id !== authenticated.id ||
            account.isActive !== true ||
            account.authVersion !== authenticated.authVersion ||
            expiration <= createdAt
          )
            return null;

          const refreshToken = randomBytes(32).toString('base64url');
          const session = await tx.authSession.create({
            data: {
              authVersion: account.authVersion,
              createdAt,
              expiresAt: expiration,
              user: { connect: { id: account.id } },
              refreshTokens: {
                create: {
                  tokenHash: createHash('sha256')
                    .update(refreshToken)
                    .digest('hex'),
                  createdAt,
                  expiresAt: expiration,
                },
              },
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
            expiresAt: new Date(expiration),
            refreshToken,
          };
        },
        {
          ...TRANSACTION_LIMITS,
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
      return result && result.expiresAt.getTime() > Date.now() ? result : null;
    } catch {
      // No retry after a possibly committed operation, and no supplied material.
      return null;
    }
  }
}
