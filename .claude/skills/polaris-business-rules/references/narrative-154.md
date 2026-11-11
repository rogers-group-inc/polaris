# Business rule 154 — full narrative

> Written 2026-11-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 154](#rule-154) — What an SNMP device says about itself through the standard MIBs fills the identity nothing manages, and an ambiguous answer says nothing

## Rule 154 — What an SNMP device says about itself through the standard MIBs fills the identity nothing manages, and an ambiguous answer says nothing

**The incident (2026-11-11).** A Cisco MDS 9148S fibre-channel switch was created by FortiGate device-inventory discovery as an unmonitored endpoint: a DNS name, a manufacturer from the OUI, and nothing else — no hostname, model, serial or firmware, so the Dependency Tree drew it as its UUID. The operator turned on SNMP monitoring. Response time, CPU / memory, interfaces and the Hardware Modules list (fans, PSUs and the supervisor, each with model and serial) all arrived, and the General tab stayed empty. The operator asked for this to work "not just for this Cisco fibre switch, but for SNMP assets going forward".

**Why nothing filled it.** The monitor path had exactly two identity writers: the vendor-format sysDescr parse (`utils/snmpDescrIdentity.ts`, AXIS only, by design — a free-text sysDescr is not a format) and a manufacturer profile's `model` row, which reads one value (`<symbol>.0`) and so cannot point at a table row such as `entPhysicalModelName.<chassis>`. `sysName` was read only by Network Discovery at adoption. The chassis row of ENTITY-MIB — where every RFC 4133 agent states the box's own part number and serial — was walked every pass and then thrown away by `entityPhysicalIsInventory`, because a chassis is not a part an operator swaps.

**The decision.** Read the two standard answers every vendor gives, on the pass that already reads them:

- `sysName` rides the sysDescr multi-GET (one more varbind, no round trip);
- the chassis row's model / serial / manufacturer, and `entPhysicalSoftwareRev` (one more column on the heavy ~10-minute walk) for firmware.

They land through an ENRICHMENT `AssetSource` row, `snmp-identity`, and the projection — the `snmp-sysdescr` / `fortinet-live` precedent — never a direct column write. That is what makes it safe for every SNMP asset at once: the ladder, not this code, decides whether the device's word wins, so it fills only what no directory, hypervisor, controller or agent states, and discovery's own projection apply reaches the same answer instead of trading values with it. Ranked under `snmp-sysdescr` (a documented vendor format is the more specific reading) and above `generic-api` (rule 100: a feed never outranks a first-party source) and the gate's DHCP / device-inventory fingerprint.

**Ambiguity says nothing.** Each choice below is the `snmpDescrIdentity.ts` rule applied to ENTITY-MIB:

- *No chassis row → no model or serial.* The supervisor's `DS-C9148S-K9-SUP` / serial is not the chassis's, and an operator reading it as the box would RMA the wrong thing.
- *Several chassis rows (a stack, VSS) → the model only if they agree, never a serial.* A stack member's serial would name one member as the whole stack and feed rule 83's duplicate-serial report a false pair.
- *Firmware is softwareRev, not firmwareRev* — the latter is the ROM / bootloader on most agents. NX-OS leaves the chassis cell blank and puts the version on the supervisor, so the fallback is the one value every module that reports one agrees on; line cards with their own firmware disagree and yield nothing.

**What stays the operator's.** A typed hostname is a `hostnameOverride` pin (re-asserted by `db.ts`), so the service never offers one. An OUI override keeps the manufacturer, as on the sysDescr path. A profile `model` row that answered is the operator's statement of where the model lives (rule 68), so the chassis model is withheld — a FortiSwitch keeps "FortiSwitch S548DF". "Cisco" against "Cisco Systems, Inc." is a spelling, not a change (`sameVendor`; the alias table is DB-loaded and may be cold on a split role).

**Audit.** A first learn is silent — the `computeFirmwareChange` reasoning: the first pass over a fleet would otherwise write one Event per device saying nothing happened. A move of hostname, model, manufacturer or serial writes `asset.model_detected` (the sysDescr path's vocabulary); a firmware move writes `asset.firmware.changed`, which the firmware_changed trigger watches.

**Scale.** Steady state is an in-memory compare per device per pass (`lastRecorded`); after a restart, one indexed read per asset, then nothing until the reading changes. The extra cost on the wire is one varbind and one column walk per SNMP asset per heavy pass.

**Rejected.** A Cisco sysDescr parser (NX-OS / IOS strings are free text — "Version 8.4(2c)" — exactly what `snmpDescrIdentity.ts` refuses to guess at); letting the profile `model` row take an index or a numeric OID (fixes model only, and per vendor); writing the columns directly when empty (a second writer the projection cannot see, which the next discovery would revert or fight).

**Limits as shipped.** It runs on the SNMP system-info pass, which needs an interfaces, LLDP or storage stream and an `up` device; a device answering only the response-time probe gets nothing until a heavy pass runs. Model, serial and firmware written this way are not pinned against an operator's later edit beyond what the projection already does for every other source.
