# Business rule 156 — full narrative

> Written 2026-11-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 156](#rule-156) — A fibre-channel login names the asset it is only when its registered host name answers to exactly one asset; a WWN alone identifies nothing

## Rule 156 — A fibre-channel login names the asset it is only when its registered host name answers to exactly one asset; a WWN alone identifies nothing

**The request (2026-11-11).** With a Cisco MDS 9148S monitored over SNMP (rule 154 had just filled its identity), the operator asked what else SNMP could say about a fibre-channel switch — "what is connected to what". FC does not run LLDP, so nothing in Polaris could draw those links. Walks of the switch, done together in the session, showed what it publishes:

- `fcIfFLoginTable` (CISCO-FC-FE-MIB), one row per logged-in device, indexed `ifIndex.vsan.loginIndex`, with its port and node WWNs. Eighteen logins in VSAN 101, one device per port.
- `fcIfErrorTable`, per-port cumulative counters. fc1/5 had 2.3 billion invalid transmission words, and fc1/8 — a storage-array port — had 309 CRC errors. That is why the counters are kept beside the logins.
- `fcNameServerTable` (CISCO-NS-MIB), indexed `vsan.d.a.p`. Its symbolic node name, on Emulex HBAs, reads `Emulex SN1200E2P FV14.2.589.5 DV14.0.0.21 HN:<host>.<domain> OS:Linux`.
- `cfdmiHbaPortTable` (CISCO-FDMI-MIB), indexed `vsan.<hba id>.<port wwn>`, the host name each HBA registered. The storage array registers its port labels here (`PURE01-ct0`, `PURE01-ct1`) and no symbolic name.
- `fcIfElpTable` was empty: the switch has no ISLs; the site runs two separate fabrics.

The operator saw their host names in the `HN:` field and proposed using them to match the connectivity to assets, with a Fibre Channel tab on each server showing fabric A and fabric B.

**Why the WWN does not match anything yet.** Polaris stores no WWNs on hosts: neither the agent nor the vCenter integration reports HBAs today. So a WWN on the switch side meets nothing, and the only bridge to an asset is the name the HBA registered. That is the rule-91 situation exactly — a name is not an identity — so the match is taken only when exactly one asset answers to it, and is recorded as `matchMethod: "name"` so the UI can say how it was made. When a host source reports its own WWNs (the vCenter SOAP fetch already reads `HostSystem`; `config.storageDevice.hostBusAdapter` carries them), that becomes the firm match and outranks the name.

**How names compare.** An exact hostname or DNS name wins when unique. Failing that, short names are compared, but a FQDN on one side meets only a SHORT name on the other: `esx07.a.com` and `esx07.b.com` are different hosts. An empty `HN:` (ESXi's driver writes `HN:OS:VMware ESXi 8.0.3` when the host has no FQDN set) and a domain-only value (`.example.com`) name nothing.

**Joining.** The four tables are joined on the port WWN. The login table's own index is documented as "an arbitrary value" (on the MDS it happens to equal the FC address); joining on it would work here and break on the next vendor.

**What is kept.** The switch's ports and logins as current state, full-replaced each pass with `firstSeen` kept, because the operator's question is "what is plugged in now". A device logging out is the one change worth an Event (`asset.fc_logins_changed`, warning): on the walked switch, fc1/13–15 had error history and nothing logged in.

**The MIBs come from the operator.** The collector names every object by its symbol and resolves it through the registry at the asset's scope, the vendor-knowledge boundary `tests/unit/noEnterpriseOids.test.ts` enforces: CISCO-FC-FE-MIB, CISCO-NS-MIB and CISCO-FDMI-MIB (with their imports) must be uploaded. The first build used literal OIDs and that test refused it. The upside is that a device whose manufacturer scope has no FC MIB costs no query at all.

**Scale.** A device that is not an FC switch costs one GETNEXT per system-info pass when the MIB resolves at its scope, and nothing when it does not. An FC switch costs six more walks and one candidate query per pass.

**Rejected.** Matching by WWN prefix or vendor OUI (identifies a vendor, not a host); reading zoning to decide what a host "reaches" (deferred; the host view says "on this switch's VSAN", nothing more); a profile-widget implementation (one column per widget, raw indexes, WWNs garbled by the value decoder — shown to the operator first and set aside).

**Not yet.** The standard FC-MGMT-MIB (RFC 4044) for other vendors, host-side WWNs from vCenter and the agent, Device Map links, and alerts for a host that lost a fabric or a port whose error counters are climbing.
