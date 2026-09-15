-- WebAuthn passkeys for local accounts.
--
-- Purely additive: no existing row is touched and no login path changes until
-- an operator both enables a passkey mode (Users → Authentication → Settings →
-- `passkeyConfig`) and a user registers a credential.
--
-- credential_id is base64url text rather than bytea because every place it is
-- compared — the allowCredentials list, the assertion the browser returns, the
-- unique lookup on a usernameless login — already speaks base64url, and a
-- bytea round-trip would only add two conversions per comparison.
CREATE TABLE "user_passkeys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "credential_id" TEXT NOT NULL,
    "public_key" BYTEA NOT NULL,
    "counter" BIGINT NOT NULL DEFAULT 0,
    "transports" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "name" TEXT NOT NULL,
    "aaguid" TEXT,
    "device_type" TEXT,
    "backed_up" BOOLEAN NOT NULL DEFAULT false,
    "last_used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_passkeys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_passkeys_credential_id_key" ON "user_passkeys"("credential_id");

CREATE INDEX "user_passkeys_user_id_idx" ON "user_passkeys"("user_id");

-- Cascade: deleting an account must take its credentials with it. A stranded
-- passkey row would keep a unique credential_id reserved against a user that
-- no longer exists, so a re-created account could not re-register the same
-- authenticator.
ALTER TABLE "user_passkeys" ADD CONSTRAINT "user_passkeys_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
