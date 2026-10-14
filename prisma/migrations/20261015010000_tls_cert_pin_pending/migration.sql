-- Business rule 113(f)/(g): a TLS pin remembers the certificate that replaced
-- it (so an administrator can trust exactly that one) and an optional window
-- in which Polaris re-pins a changed certificate itself (after its own
-- firmware upgrade of the device). Additive; existing pins are unchanged.
ALTER TABLE "tls_cert_pins"
  ADD COLUMN "pending_fingerprint" TEXT,
  ADD COLUMN "pending_subject"     TEXT,
  ADD COLUMN "pending_seen_at"     TIMESTAMP(3),
  ADD COLUMN "repin_until"         TIMESTAMP(3);
