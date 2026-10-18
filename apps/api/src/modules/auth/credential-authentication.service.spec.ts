import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { UserRole, type User } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { CredentialAuthenticationService } from './credential-authentication.service';
import { hashPassword, verifyPassword } from './password-hash';

jest.mock('./password-hash', () => ({
  hashPassword: jest.fn(),
  verifyPassword: jest.fn(),
}));

const hash = jest.mocked(hashPassword);
const verify = jest.mocked(verifyPassword);
const actualPassword =
  jest.requireActual<typeof import('./password-hash')>('./password-hash');

type SelectedAccount = Pick<
  User,
  'id' | 'username' | 'role' | 'isActive' | 'authVersion' | 'passwordHash'
>;

const account: SelectedAccount = {
  id: 'a24e8a50-0cf1-4e7a-8d60-c504a9025c8d',
  username: 'training.user',
  role: UserRole.STUDENT,
  isActive: true,
  authVersion: 2,
  passwordHash: 'synthetic-account-hash',
};

describe('internal credential authentication', () => {
  const findUnique =
    jest.fn<(query: unknown) => Promise<typeof account | null>>();
  const prisma = { user: { findUnique } } as unknown as PrismaService;
  let service: CredentialAuthenticationService;
  let password: string;

  beforeEach(() => {
    jest.resetAllMocks();
    password = randomBytes(24).toString('base64url');
    findUnique.mockResolvedValue({ ...account });
    hash.mockResolvedValue('synthetic-nonaccount-hash');
    verify.mockResolvedValue(true);
    service = new CredentialAuthenticationService(prisma);
  });

  it('authenticates a canonicalized active account with a narrow lookup', async () => {
    await expect(
      service.authenticate('  Training.User \n', password),
    ).resolves.toEqual({
      id: account.id,
      username: account.username,
      role: account.role,
      authVersion: account.authVersion,
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { username: account.username },
      select: {
        id: true,
        username: true,
        role: true,
        isActive: true,
        authVersion: true,
        passwordHash: true,
      },
    });
    expect(verify).toHaveBeenCalledWith(password, account.passwordHash);
    expect(hash).not.toHaveBeenCalled();
  });

  it.each(Object.values(UserRole))(
    'preserves the explicit %s account role',
    async (role) => {
      findUnique.mockResolvedValue({ ...account, role });
      expect(
        await service.authenticate(account.username, password),
      ).toMatchObject({
        role,
      });
    },
  );

  it('returns fresh identity snapshots without sensitive or clinical fields', async () => {
    const stored = { ...account };
    findUnique.mockResolvedValue(stored);
    const first = await service.authenticate(account.username, password);
    const second = await service.authenticate(account.username, password);
    expect(first).not.toBe(stored);
    expect(second).not.toBe(first);
    expect(Object.keys(first!).sort()).toEqual([
      'authVersion',
      'id',
      'role',
      'username',
    ]);
    stored.authVersion++;
    expect(first?.authVersion).toBe(account.authVersion);
  });

  it.each([undefined, null, 1, {}, '', '_invalid', 'аlice', 'a'.repeat(129)])(
    'rejects an invalid username without a lookup: %p',
    async (username) => {
      await expect(
        service.authenticate(username, password),
      ).resolves.toBeNull();
      expect(findUnique).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
      expect(hash).not.toHaveBeenCalled();
    },
  );

  it('rejects an incorrect password', async () => {
    verify.mockResolvedValue(false);
    await expect(
      service.authenticate(account.username, password),
    ).resolves.toBeNull();
  });

  it('verifies inactive accounts but never authenticates them', async () => {
    findUnique.mockResolvedValue({ ...account, isActive: false });
    await expect(
      service.authenticate(account.username, password),
    ).resolves.toBeNull();
    expect(verify).toHaveBeenCalledWith(password, account.passwordHash);
    expect(hash).not.toHaveBeenCalled();
  });

  it('does nonaccount password work without allowing a dummy match to authenticate', async () => {
    findUnique.mockResolvedValue(null);
    await expect(
      service.authenticate(account.username, password),
    ).resolves.toBeNull();
    expect(hash).toHaveBeenCalledTimes(1);
    expect(hash).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(verify).toHaveBeenCalledWith(password, 'synthetic-nonaccount-hash');
    expect(verify).toHaveReturnedTimes(1);
    await expect(
      service.authenticate(account.username, hash.mock.calls[0][0]),
    ).resolves.toBeNull();
    expect(hash).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('shares pending dummy preparation across concurrent missing accounts', async () => {
    findUnique.mockResolvedValue(null);
    let finish!: (value: string) => void;
    hash.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = service.authenticate('missing.one', password);
    const second = service.authenticate('missing.two', password);
    await Promise.resolve();
    expect(hash).toHaveBeenCalledTimes(1);
    expect(verify).not.toHaveBeenCalled();
    finish('synthetic-nonaccount-hash');
    await expect(Promise.all([first, second])).resolves.toEqual([null, null]);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('does not share dummy material between service instances', async () => {
    findUnique.mockResolvedValue(null);
    await service.authenticate(account.username, password);
    await new CredentialAuthenticationService(prisma).authenticate(
      account.username,
      password,
    );
    expect(hash).toHaveBeenCalledTimes(2);
    expect(hash.mock.calls[0][0]).not.toEqual(hash.mock.calls[1][0]);
  });

  it('contains database errors without invoking password work', async () => {
    findUnique.mockRejectedValue(new Error(password));
    await expect(
      service.authenticate(account.username, password),
    ).resolves.toBeNull();
    expect(verify).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it('contains verifier failures, including bounded-capacity rejection', async () => {
    verify.mockRejectedValue(new Error(password));
    await expect(
      service.authenticate(account.username, password),
    ).resolves.toBeNull();
  });

  it('contains failed dummy preparation and allows a later bounded retry', async () => {
    findUnique.mockResolvedValue(null);
    hash.mockRejectedValueOnce(new Error(password));
    await expect(
      service.authenticate(account.username, password),
    ).resolves.toBeNull();
    expect(verify).not.toHaveBeenCalled();
    await expect(
      service.authenticate(account.username, password),
    ).resolves.toBeNull();
    expect(hash).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, 1, {}, 'short', '\ud800', 'a'.repeat(129)])(
    'uses the existing password validator for malformed input: %p',
    async (input) => {
      verify.mockImplementation(actualPassword.verifyPassword);
      await expect(
        service.authenticate(account.username, input),
      ).resolves.toBeNull();
      expect(verify).toHaveBeenCalledWith(input, account.passwordHash);
    },
  );

  it.each(['', 'malformed', '$nina$scrypt$v=99$', 'a'.repeat(257)])(
    'rejects malformed stored hashes through the existing verifier: %p',
    async (passwordHash) => {
      findUnique.mockResolvedValue({ ...account, passwordHash });
      verify.mockImplementation(actualPassword.verifyPassword);
      await expect(
        service.authenticate(account.username, password),
      ).resolves.toBeNull();
      expect(verify).toHaveBeenCalledWith(password, passwordHash);
    },
  );

  it('composes with actual bounded hashing and verification using synthetic input', async () => {
    hash.mockImplementation(actualPassword.hashPassword);
    verify.mockImplementation(actualPassword.verifyPassword);
    const passwordHash = await actualPassword.hashPassword(password);
    findUnique.mockResolvedValue({ ...account, passwordHash });
    expect(
      await service.authenticate(account.username, password),
    ).toMatchObject({
      id: account.id,
    });
    await expect(
      service.authenticate(
        account.username,
        randomBytes(24).toString('base64url'),
      ),
    ).resolves.toBeNull();
    findUnique.mockResolvedValue(null);
    await expect(
      service.authenticate('missing.user', password),
    ).resolves.toBeNull();
  });
});
