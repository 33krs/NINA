import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cwd } from 'node:process';
import { describe, expect, it } from '@jest/globals';

const schema = readFileSync(resolve(cwd(), 'prisma/schema.prisma'), 'utf8');
const migration = readFileSync(
  resolve(
    cwd(),
    'prisma/migrations/20261018230000_add_auth_sessions/migration.sql',
  ),
  'utf8',
);

function model(name: string): string {
  const body = schema.match(
    new RegExp(`model ${name}\\s*\\{([\\s\\S]*?)\\n\\}`),
  )?.[1];
  expect(body).toBeDefined();
  return body ?? '';
}

function table(name: string): string {
  const body = migration.match(
    new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`),
  )?.[1];
  expect(body).toBeDefined();
  return body ?? '';
}

describe('unexposed session persistence foundation', () => {
  it('defines a session bound only to its account and retained refresh-token rows', () => {
    const session = model('AuthSession');
    expect(session).toMatch(
      /id\s+String\s+@id\s+@default\(uuid\(\)\)\s+@db\.Uuid/,
    );
    expect(session).toMatch(/userId\s+String\s+@db\.Uuid/);
    expect(session).toMatch(/authVersion\s+Int\s*\n/);
    expect(session).toMatch(
      /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Restrict, onUpdate: Restrict\)/,
    );
    expect(session).toMatch(/refreshTokens\s+RefreshToken\[\]/);
    expect(session).not.toMatch(/Patient|professionalId|password|tokenHash/);
  });

  it('stores only a unique digest per refresh token, retaining session lineage', () => {
    const token = model('RefreshToken');
    expect(token).toMatch(
      /id\s+String\s+@id\s+@default\(uuid\(\)\)\s+@db\.Uuid/,
    );
    expect(token).toMatch(/sessionId\s+String\s+@db\.Uuid/);
    expect(token).toMatch(/tokenHash\s+String\s+@unique\s+@db\.VarChar\(64\)/);
    expect(token).toMatch(
      /session\s+AuthSession\s+@relation\(fields: \[sessionId\], references: \[id\], onDelete: Restrict, onUpdate: Restrict\)/,
    );
    expect(token).not.toMatch(
      /password|rawToken|accessToken|Patient|professionalId/,
    );
  });

  it.each([
    ['AuthSession', 'revokedAt'],
    ['RefreshToken', 'consumedAt'],
  ])(
    'requires explicit UTC-aware expiry and optional lifecycle time in %s',
    (name, terminalTime) => {
      const body = model(name);
      expect(body).toMatch(
        /createdAt\s+DateTime\s+@default\(now\(\)\)\s+@db\.Timestamptz\(3\)/,
      );
      expect(body).toMatch(/expiresAt\s+DateTime\s+@db\.Timestamptz\(3\)/);
      expect(body).toMatch(
        new RegExp(
          `${terminalTime}\\s+DateTime\\?\\s+@db\\.Timestamptz\\(3\\)`,
        ),
      );
      expect(body).not.toMatch(/expiresAt[^\n]*@default/);
      expect(body).toMatch(/@@index\(\[expiresAt\]\)/);
      expect(body).toMatch(
        new RegExp(
          `@@index\\(\\[${name === 'AuthSession' ? 'userId' : 'sessionId'}\\]\\)`,
        ),
      );
    },
  );

  it.each([
    ['AuthSession', 'userId', 'User'],
    ['RefreshToken', 'sessionId', 'AuthSession'],
  ])(
    'enforces restrictive %s references and indexes in SQL',
    (name, owner, target) => {
      const body = table(name);
      expect(body).toContain('"id" UUID NOT NULL');
      expect(body).toContain(`"${owner}" UUID NOT NULL`);
      expect(body).toContain(`CONSTRAINT "${name}_pkey" PRIMARY KEY ("id")`);
      expect(body).toContain(
        `FOREIGN KEY ("${owner}") REFERENCES "${target}"("id") ON DELETE RESTRICT ON UPDATE RESTRICT`,
      );
      for (const field of [owner, 'expiresAt']) {
        expect(migration).toContain(
          `CREATE INDEX "${name}_${field}_idx" ON "${name}"("${field}")`,
        );
      }
    },
  );

  it.each([
    ['AuthSession', 'revokedAt'],
    ['RefreshToken', 'consumedAt'],
  ])(
    'enforces finite consistent %s timestamps without a duration policy',
    (name, terminalTime) => {
      const body = table(name);
      expect(body).toContain(
        '"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
      );
      expect(body).toContain('"expiresAt" TIMESTAMPTZ(3) NOT NULL,');
      expect(body).toContain(`"${terminalTime}" TIMESTAMPTZ(3),`);
      expect(body).toContain(
        'CHECK (isfinite("createdAt") AND isfinite("expiresAt") AND "expiresAt" > "createdAt")',
      );
      expect(body).toContain(
        `CHECK ("${terminalTime}" IS NULL OR (isfinite("${terminalTime}") AND "${terminalTime}" >= "createdAt"))`,
      );
      expect(body).not.toMatch(/expiresAt"[^\n]*DEFAULT|INTERVAL/i);
    },
  );

  it('enforces canonical digest uniqueness and a nonnegative issued auth version', () => {
    expect(table('AuthSession')).toContain('"authVersion" INTEGER NOT NULL,');
    expect(table('AuthSession')).toContain('CHECK ("authVersion" >= 0)');
    expect(table('RefreshToken')).toContain(
      '"tokenHash" VARCHAR(64) COLLATE "C" NOT NULL',
    );
    expect(table('RefreshToken')).toContain(
      `CHECK (("tokenHash" COLLATE "C") ~ '^[0-9a-f]{64}$')`,
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash")',
    );
  });

  it('adds only the two auth tables without seeds, existing-table changes or executable auth', () => {
    expect(
      [...migration.matchAll(/CREATE TABLE "([^"]+)"/g)].map(
        (match) => match[1],
      ),
    ).toEqual(['AuthSession', 'RefreshToken']);
    expect(migration).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER)\s+(INTO|FROM|TABLE|TYPE)\b/i,
    );
    expect(migration).not.toMatch(/password|rawToken|Patient|professionalId/);
  });
});
