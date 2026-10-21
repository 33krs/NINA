-- Null expiry is an explicit persistence capability, not service activation.
-- Existing finite values and all other constraints/indexes are retained.
ALTER TABLE "AuthSession"
    ALTER COLUMN "expiresAt" DROP NOT NULL,
    DROP CONSTRAINT "AuthSession_lifetime_check",
    ADD CONSTRAINT "AuthSession_lifetime_check" CHECK (isfinite("createdAt") AND ("expiresAt" IS NULL OR
        (isfinite("expiresAt") AND "expiresAt" > "createdAt")));

ALTER TABLE "RefreshToken"
    ALTER COLUMN "expiresAt" DROP NOT NULL,
    DROP CONSTRAINT "RefreshToken_lifetime_check",
    ADD CONSTRAINT "RefreshToken_lifetime_check" CHECK (isfinite("createdAt") AND ("expiresAt" IS NULL OR
        (isfinite("expiresAt") AND "expiresAt" > "createdAt")));
