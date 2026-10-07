-- Per-token trusted hosts, 2026-10-07.
--
-- An API token may name the source addresses it is accepted from: bare
-- IPv4/IPv6 addresses or CIDRs, matched against the trust-proxy-resolved
-- request address. The default is the empty list, which means "any source" —
-- so every token minted before this column existed keeps working unchanged.

ALTER TABLE "api_tokens" ADD COLUMN "trustedHosts" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
