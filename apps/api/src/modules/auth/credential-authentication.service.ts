import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { hashPassword, verifyPassword } from './password-hash';
import { canonicalizeUsername } from './username';

export interface AuthenticatedAccount {
  readonly id: string;
  readonly username: string;
  readonly role: UserRole;
  readonly authVersion: number;
}

@Injectable()
export class CredentialAuthenticationService {
  private dummyHash?: Promise<string>;

  constructor(private readonly prisma: PrismaService) {}

  async authenticate(
    username: unknown,
    password: unknown,
  ): Promise<AuthenticatedAccount | null> {
    try {
      const canonical = canonicalizeUsername(username);
      const account = await this.prisma.user.findUnique({
        where: { username: canonical },
        select: {
          id: true,
          username: true,
          role: true,
          isActive: true,
          authVersion: true,
          passwordHash: true,
        },
      });
      // Missing accounts still use the bounded verifier; inactive rows use
      // their stored hash. Neither path can produce an authenticated identity.
      const passwordHash = account
        ? account.passwordHash
        : await this.getDummyHash();
      const matches = await verifyPassword(password, passwordHash);
      if (!account || account.isActive !== true || matches !== true)
        return null;

      return {
        id: account.id,
        username: account.username,
        role: account.role,
        authVersion: account.authVersion,
      };
    } catch {
      // Do not expose database, hashing-capacity, or supplied-input details.
      return null;
    }
  }

  private getDummyHash(): Promise<string> {
    // Per-instance, lazy and single-flight. This random material is never
    // stored as an account credential or sufficient to authenticate a row.
    this.dummyHash ??= hashPassword(randomBytes(32).toString('hex')).catch(
      () => {
        this.dummyHash = undefined;
        throw new Error('Credential verification unavailable');
      },
    );
    return this.dummyHash;
  }
}
