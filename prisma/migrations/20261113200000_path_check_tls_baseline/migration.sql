-- Business rule 85(c): each path-check source remembers the TLS certificate it last saw,
-- so a renewed or replaced certificate can be recorded as path_check.tls_cert_changed.
ALTER TABLE "path_check_sources" ADD COLUMN "lastTlsNotAfter" TIMESTAMP(3);
ALTER TABLE "path_check_sources" ADD COLUMN "lastTlsIssuer" TEXT;
ALTER TABLE "path_check_sources" ADD COLUMN "lastTlsChangeEventAt" TIMESTAMP(3);
