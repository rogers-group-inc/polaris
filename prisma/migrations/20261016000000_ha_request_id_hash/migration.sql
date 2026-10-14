-- Business rule 117 (re-scan F86): the HA enrollment poll handle is the only
-- credential the unauthenticated bundle download checks, and the bundle holds
-- .env (POLARIS_SECRET_KEY included) and the TLS / etcd private keys. It was
-- stored raw, so anyone who could read the table (a dump, an unencrypted
-- backup, a replica) could claim the bundle. Store only its SHA-256 — the
-- handle is 256 random bits, so a fast hash is enough — and hash the handles
-- of rows already in flight so a bootstrap script polling right now keeps
-- working. sha256() is built into PostgreSQL 11+.
ALTER TABLE "ha_enrollments" RENAME COLUMN "requestId" TO "requestIdHash";
ALTER INDEX "ha_enrollments_requestId_key" RENAME TO "ha_enrollments_requestIdHash_key";
UPDATE "ha_enrollments"
   SET "requestIdHash" = encode(sha256(convert_to("requestIdHash", 'UTF8')), 'hex')
 WHERE "requestIdHash" IS NOT NULL;
