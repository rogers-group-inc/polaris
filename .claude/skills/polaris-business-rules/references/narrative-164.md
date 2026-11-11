# Business rule 164 — full narrative

> Written 2026-11-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 164](#rule-164) — A firewall's detected-device inventory is its own place for device-type rules to run, and it offers every fact it has

## Rule 164 — A firewall's detected-device inventory is its own place for device-type rules to run, and it offers every fact it has

**The incident (2026-11-11).** The operator had a custom device type, Power ("UPSs, PDUs, ATSs and any other power related devices"), whose rule was `Manufacturer contains APC`, ticked for Directory discovery and Network Discovery scans. Every APC device on the network still read "Other". They had all been created by FortiGate device-inventory discovery (Phase 7): manufacturer APC from the NIC vendor, OS "APC AOS" from the gate's fingerprint.

**Why the rule never fired.** Phase 7 did run the device-type rules, but it called the directory-context resolver with ONE fact, the OS fingerprint (`inferAssetTypeFromOs(inv.os)`), and on an existing asset only when the row carried an OS at all. A rule on Manufacturer, Model, Hostname or Product type could never claim a device the gate found. The screen did not say so either: the only checkbox that reached Phase 7 was labelled "Directory discovery (AD / Entra / Intune / Azure Arc)", so an operator had no way to know FortiGate endpoints were involved.

**The decision.** A third context, `inventory` — "Firewall device inventory (FortiGate / FortiManager detected devices)" on the Device Types modal — and Phase 7 hands it every fact it has: the asset's own OS / version / hostname / manufacturer where set (else the row's fingerprint and NIC vendor), plus the asset's model and productType (which the monitor path may have filled since, rule 161). Still `other`-only on an existing asset, so a type an authoritative source or an operator set is never overwritten.

**Carrying behaviour over.** Migration `20261112000000_asset_type_inventory_context` ticks `inventory` on every type that already had `directory`, and `DEFAULT_TYPE_MATCHING` ships Server / Workstation with both. The shipped OS ladders therefore keep typing FortiGate endpoints exactly as they did, and an operator's own directory-ticked rule (the Power rule) starts reaching them — which is the fix. One consequence an operator may not expect: a directory rule on Hostname or Manufacturer now also sees FortiGate devices. The checkbox is there to untick per type.

**Retroactive apply.** "Apply rules to existing Other assets" evaluated stored rows in the directory context only, so a type ticked for inventory alone could never reach the "other" bucket on a FortiGate install — mostly devices the gate found. It now tries `directory`, then `inventory`. Never `scan`: those rules read a device's own self-description, which a stored row does not carry.

**Rejected.** Passing more facts to the directory context with no new checkbox: smaller, but the screen would keep calling a FortiGate inventory "AD / Entra / Intune / Azure Arc". Evaluating Phase 7 in the `scan` context: scan rules are written against a device's self-description ("fortigate", "printer" anywhere in it) and would mis-type endpoints whose hostname contains those words.
