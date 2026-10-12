-- Add NINA-managed training accounts without linking them to clinical identities.
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'INSTRUCTOR', 'STUDENT');

CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "username" VARCHAR(32) COLLATE "C" NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "authVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "User_username_length_check" CHECK (char_length("username") BETWEEN 3 AND 32),
    CONSTRAINT "User_username_canonical_check" CHECK (("username" COLLATE "C") ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
    CONSTRAINT "User_authVersion_nonnegative_check" CHECK ("authVersion" >= 0)
);

CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
