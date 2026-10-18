import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd } from 'node:process';
import { describe, expect, it } from '@jest/globals';

const schema = readFileSync(resolve(cwd(), 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(
    cwd(),
    'prisma/migrations/20261012190000_add_training_accounts/migration.sql',
  ),
  'utf8',
);

describe('training account schema foundation', () => {
  it('defines explicit account roles and only the auth-session account relation', () => {
    expect(schema).toMatch(
      /enum UserRole\s*\{\s*ADMIN\s+INSTRUCTOR\s+STUDENT\s*\}/,
    );
    const userModel = schema.match(/model User\s*\{([\s\S]*?)\n\}/)?.[1];
    expect(userModel).toBeDefined();
    expect(userModel).toMatch(/id\s+String\s+@id\s+@default\(uuid\(\)\)/);
    expect(userModel).toMatch(/username\s+String\s+@unique/);
    expect(userModel).toMatch(/passwordHash\s+String/);
    expect(userModel).toMatch(/role\s+UserRole(?!\s+@default)/);
    expect(userModel).toMatch(/isActive\s+Boolean\s+@default\(true\)/);
    expect(userModel).toMatch(/authVersion\s+Int\s+@default\(0\)/);
    expect(userModel).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)/);
    expect(userModel).toMatch(/updatedAt\s+DateTime\s+@updatedAt/);
    expect(userModel).toMatch(/^\s*sessions\s+AuthSession\[\]\s*$/m);
    expect(userModel).not.toMatch(/Patient|professionalId|@relation/);
    // Exact fields prevent another implicit relation from bypassing this guard.
    expect(
      [...userModel!.matchAll(/^\s*(\w+)\s+\w+/gm)].map((match) => match[1]),
    ).toEqual([
      'id',
      'username',
      'passwordHash',
      'role',
      'isActive',
      'authVersion',
      'createdAt',
      'updatedAt',
      'sessions',
    ]);
  });

  it('adds database-enforced canonical username and nonnegative auth-version checks without seeds', () => {
    expect(migration).toMatch(
      /CREATE TYPE "UserRole" AS ENUM \('ADMIN', 'INSTRUCTOR', 'STUDENT'\)/,
    );
    expect(migration).toMatch(/CREATE TABLE "User"/);
    expect(migration).toMatch(/username"[^\n]*COLLATE "C"/);
    expect(migration).toMatch(
      /CHECK \(char_length\("username"\) BETWEEN 3 AND 32\)/,
    );
    expect(migration).toMatch(
      /CHECK \(\("username" COLLATE "C"\) ~ '\^\[a-z0-9\]\[a-z0-9\._-\]\{2,31\}\$'\)/,
    );
    expect(migration).toMatch(/CHECK \("authVersion" >= 0\)/);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(migration).not.toMatch(/\bDROP\s+(TABLE|TYPE)\b/i);
    expect(migration).not.toMatch(
      /\bALTER\s+TABLE\s+"(Patient|Family|Encounter|Appointment)"/i,
    );
  });
});
