-- The last TOTP time step accepted per user, so a code cannot be used twice
-- (RFC 6238 section 5.2). Nullable: no code has been used under the old rule.
ALTER TABLE "users" ADD COLUMN "totp_last_step" INTEGER;
