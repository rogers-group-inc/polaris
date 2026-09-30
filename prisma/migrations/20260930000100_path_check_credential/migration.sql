-- A path check may authenticate (bearer / basic / digest) with an http-typed
-- Credential. Such a check runs ONLY from the Polaris server, so the secret
-- never reaches an agent. RESTRICT: a credential a check uses cannot be
-- deleted underneath it (credentialService.deleteCredential refuses first,
-- with a readable 409).
ALTER TABLE "path_checks" ADD COLUMN "credentialId" TEXT;

ALTER TABLE "path_checks"
  ADD CONSTRAINT "path_checks_credentialId_fkey"
  FOREIGN KEY ("credentialId") REFERENCES "credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "path_checks_credentialId_idx" ON "path_checks" ("credentialId");
