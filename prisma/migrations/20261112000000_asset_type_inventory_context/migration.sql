-- Business rule 163: device-type rules get a third context, `inventory` — a
-- FortiGate's detected-device inventory (discovery Phase 7).
--
-- Phase 7 used to run the rules in the `directory` context with the OS
-- fingerprint alone. It now runs them in `inventory` with every fact it has
-- (OS, vendor, hostname, the asset's model / productType). Ticking `inventory`
-- on every type that already runs in `directory` carries the old behaviour
-- over: the shipped Server / Workstation OS ladders keep typing FortiGate
-- endpoints exactly as before, and an operator's own directory-ticked rule
-- (Manufacturer contains APC → Power) now reaches them too — the fix.
-- An operator can untick it per type afterwards.
--
-- Idempotent: a row that already carries `inventory` is left alone.
UPDATE "asset_type_defs"
SET "match_contexts" = array_append("match_contexts", 'inventory')
WHERE 'directory' = ANY("match_contexts")
  AND NOT ('inventory' = ANY("match_contexts"));
