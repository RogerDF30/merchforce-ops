-- Migrated accounts keep their Apps Script hash until first sign-in.
--
-- That scheme was SHA-256(password + salt + PEPPER); it cannot be converted to
-- bcrypt without the plaintext. Verifying against it once and re-hashing on
-- success is what lets a supplier's whole team keep their existing passwords
-- through the cutover instead of everyone resetting on day one.
ALTER TABLE "users" ADD COLUMN "legacy_salt" TEXT;
ALTER TABLE "users" ADD COLUMN "password_legacy" BOOLEAN NOT NULL DEFAULT false;
