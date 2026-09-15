# Runbook: a vendor's SNMP telemetry rows are quiet — profile symbols unresolved

**Symptom:** After an upgrade (or on a fresh install), SNMP-polled devices of one vendor stop producing CPU / memory / storage / hardware-sensor samples while reachability and interface polling keep working. The Events log carries a warning-level `manufacturer_profile.unresolved` Event per affected manufacturer from the last start ("Fortinet: 5 profile symbols do not resolve — fapCpuUsage, fapMemoryUsage, fsSysCpuUsage…"). Server Settings → Credentials → Manufacturer Profiles shows that profile's header pill as **N UNRESOLVED**. Debug-level logs read `vendor CPU symbol unresolved — upload its MIB to enable`.

---

## Background

Since 2026-09 Polaris ships no vendor OIDs (`polaris-change-impact` → cross-cutting/vendor-snmp-knowledge-boundary.md). A profile row names a SYMBOL (`fsSysCpuUsage`); the number comes from a MIB the operator uploaded, resolved through `services/oidRegistry.ts → resolveOidSync()` at the asset's (manufacturer, model) scope. The bundled IETF/IEEE standards resolve on every install; a vendor's symbols resolve only once that vendor's MIB is uploaded. Installs that upgraded from a pre-2026-09 release had those numbers baked in — the seed's removal is Phase 3 of the uniform-SNMP work — so the first boot after that upgrade is where this shows up. An unresolved symbol degrades to "this stream is not collected for this asset": no throw, no wiped rows, a per-collector debug line, and the Event above.

---

## Diagnose

1. **Read the Event.** Events → filter `manufacturer_profile.unresolved`. The message names the symbols; `details.unresolved` carries one line per symbol saying which of two things is wrong:
   - *"no uploaded MIB defines it — upload the vendor's MIB"* — nothing loaded at that manufacturer's scope defines the symbol.
   - *"<MODULE> is missing <ROOT> — upload it too"* — the row's MIB IS uploaded but cannot resolve, because an anchor it IMPORTs (`fortinet FROM FORTINET-CORE-MIB`) is not.
2. **Open the profile.** Manufacturer Profiles → expand the vendor. Every row's MIB cell reads either the module it resolves from ("FORTINET-FORTISWITCH-MIB (vendor MIB)") or "⚠ unresolved" with the same fix text beneath it.
3. **Check what is uploaded.** MIB Database → filter by manufacturer. A row's **Browse** shows a banner naming the defining module for each missing root when the module cannot resolve on its own.

## Fix

Upload the missing module(s) at **Manufacturer-wide** scope for that vendor — the leaf module AND the core module it imports from (`docs/INSTALL.md` → "A vendor's SNMP CPU / memory / storage is empty" has the per-vendor list). The upload response states the outcome immediately: *"412 symbols, all resolve"* or *"412 of 412 unresolved — needs FORTINET-CORE-MIB; upload it too"*. Nothing needs restarting: `createMib` refreshes the registry, the profile page re-reads readiness on the next open, and collection resumes on the next telemetry cadence.

## Verify

- The profile header pill reads **READY**; every row's MIB cell names a module.
- `polaris_snmp_symbol_unresolved_total{stream}` (Phase 5a metric) stops incrementing for that vendor.
- New CPU / memory samples appear on a device of that vendor within one heavy-cadence tick (default 30 s).

## Do not

- Do not hand-edit `BUILT_IN_OIDS` to put the numbers back — `tests/unit/noEnterpriseOids.test.ts` fails, and the fix belongs in the MIB the vendor publishes.
- Do not type a numeric OID into a profile row's Symbol field — rows name symbols; a MIB gives them numbers.
