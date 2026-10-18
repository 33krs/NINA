-- Unexposed session persistence; no account or credential data is created.
CREATE TABLE "AuthSession" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "authVersion" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AuthSession_authVersion_nonnegative_check" CHECK ("authVersion" >= 0),
    CONSTRAINT "AuthSession_lifetime_check" CHECK (isfinite("createdAt") AND isfinite("expiresAt") AND "expiresAt" > "createdAt"),
    CONSTRAINT "AuthSession_revokedAt_check" CHECK ("revokedAt" IS NULL OR (isfinite("revokedAt") AND "revokedAt" >= "createdAt"))
);

CREATE TABLE "RefreshToken" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "tokenHash" VARCHAR(64) COLLATE "C" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AuthSession"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "RefreshToken_tokenHash_canonical_check" CHECK (("tokenHash" COLLATE "C") ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "RefreshToken_lifetime_check" CHECK (isfinite("createdAt") AND isfinite("expiresAt") AND "expiresAt" > "createdAt"),
    CONSTRAINT "RefreshToken_consumedAt_check" CHECK ("consumedAt" IS NULL OR (isfinite("consumedAt") AND "consumedAt" >= "createdAt"))
);

CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");
CREATE INDEX "AuthSession_expiresAt_idx" ON "AuthSession"("expiresAt");
CREATE UNIQUE INDEX "RefreshToken_tokenHash_key" ON "RefreshToken"("tokenHash");
CREATE INDEX "RefreshToken_sessionId_idx" ON "RefreshToken"("sessionId");
CREATE INDEX "RefreshToken_expiresAt_idx" ON "RefreshToken"("expiresAt");
