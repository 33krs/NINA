import { Buffer } from 'node:buffer';
import * as crypto from 'node:crypto';

const SCRYPT = {
  COST: 2 ** 17,
  BLOCK_SIZE: 8,
  PARALLELIZATION: 1,
  MAX_MEMORY: 192 * 1024 * 1024,
} as const;

const SCRYPT_LIMITS = {
  ACTIVE: 2,
  QUEUED: 16,
} as const;

const SALT_BYTES = 16;
const KEY_BYTES = 64;
const MAX_HASH_LENGTH = 256;
const MIN_PASSWORD_CHARACTERS = 15;
const MAX_PASSWORD_CHARACTERS = 128;
const MAX_PASSWORD_BYTES = 1024;
const HASH_PATTERN =
  /^\$nina\$scrypt\$v=1\$N=131072,r=8,p=1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/;

interface ParsedHash {
  salt: Buffer;
  key: Buffer;
}

type Permit = () => void;

let activeScryptOperations = 0;
const queuedScryptOperations: Permit[] = [];

function isPasswordInput(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (!isWellFormedUnicode(value)) return false;
  const characters = Array.from(value).length;
  const bytes = Buffer.byteLength(value, 'utf8');
  return (
    characters >= MIN_PASSWORD_CHARACTERS &&
    characters <= MAX_PASSWORD_CHARACTERS &&
    bytes <= MAX_PASSWORD_BYTES
  );
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return false;
      index++;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

function acquireScryptPermit(): Promise<void> {
  if (activeScryptOperations < SCRYPT_LIMITS.ACTIVE) {
    activeScryptOperations++;
    return Promise.resolve();
  }

  if (queuedScryptOperations.length >= SCRYPT_LIMITS.QUEUED)
    return Promise.reject(new Error('Password hashing capacity exceeded'));

  return new Promise((resolve) => {
    queuedScryptOperations.push(resolve);
  });
}

function releaseScryptPermit(): void {
  const next = queuedScryptOperations.shift();
  if (next) next();
  else activeScryptOperations--;
}

async function deriveKey(password: Buffer, salt: Buffer): Promise<Buffer> {
  await acquireScryptPermit();
  try {
    return await new Promise((resolve, reject) => {
      crypto.scrypt(
        password,
        salt,
        KEY_BYTES,
        {
          N: SCRYPT.COST,
          r: SCRYPT.BLOCK_SIZE,
          p: SCRYPT.PARALLELIZATION,
          maxmem: SCRYPT.MAX_MEMORY,
        },
        (error, key) => {
          if (error) reject(new Error('Password hashing failed'));
          else resolve(key);
        },
      );
    });
  } catch {
    throw new Error('Password hashing failed');
  } finally {
    releaseScryptPermit();
  }
}

function parseHash(value: unknown): ParsedHash | null {
  if (typeof value !== 'string' || value.length > MAX_HASH_LENGTH) return null;
  const match = HASH_PATTERN.exec(value);
  if (!match) return null;

  const salt = Buffer.from(match[1], 'base64url');
  const key = Buffer.from(match[2], 'base64url');
  if (
    salt.length !== SALT_BYTES ||
    key.length !== KEY_BYTES ||
    salt.toString('base64url') !== match[1] ||
    key.toString('base64url') !== match[2]
  )
    return null;

  return { salt, key };
}

export async function hashPassword(password: unknown): Promise<string> {
  if (!isPasswordInput(password)) throw new Error('Invalid password input');

  const passwordBytes = Buffer.from(password, 'utf8');
  const salt = crypto.randomBytes(SALT_BYTES);
  let key: Buffer | undefined;
  try {
    key = await deriveKey(passwordBytes, salt);
    return `$nina$scrypt$v=1$N=131072,r=8,p=1$${salt.toString('base64url')}$${key.toString('base64url')}`;
  } finally {
    passwordBytes.fill(0);
    key?.fill(0);
  }
}

export async function verifyPassword(
  password: unknown,
  encodedHash: unknown,
): Promise<boolean> {
  if (!isPasswordInput(password)) return false;
  const parsed = parseHash(encodedHash);
  if (!parsed) return false;

  const passwordBytes = Buffer.from(password, 'utf8');
  let candidateKey: Buffer | undefined;
  try {
    candidateKey = await deriveKey(passwordBytes, parsed.salt);
    return crypto.timingSafeEqual(candidateKey, parsed.key);
  } finally {
    passwordBytes.fill(0);
    parsed.salt.fill(0);
    parsed.key.fill(0);
    candidateKey?.fill(0);
  }
}
