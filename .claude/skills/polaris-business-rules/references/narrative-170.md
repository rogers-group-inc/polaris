# Business rule 170 — full narrative

> Written 2026-11-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 170](#rule-170) — Which MIB a stream reads is the manufacturer profile's to say, never a per-stream pin

## Rule 170 — Which MIB a stream reads is the manufacturer profile's to say, never a per-stream pin

**How it was found.** 2026-11-12, an operator getting an APC UPS's model and serial onto its
General tab looked at the asset's Monitoring tab and asked which MIB Response Time polling used.
The stream's MIB box said "Automatic (SNMPv2-MIB)"; the SNMP Walk list called the same subtree
"System (RFC 1213)". Tracing what the box DID gave a worse answer than the naming:

| Stream | What a pinned MIB changed |
|---|---|
| Response Time | nothing — the probe GETs `sysUpTime` (+ `sysDescr` / `sysObjectID`) whatever is picked |
| Interfaces, LLDP | nothing — they always walk IF-MIB / LLDP-MIB |
| CPU/Memory, Hardware Sensors | a standard MIB: nothing. An UPLOADED MIB: `profileSubjectFor` replaced the asset's manufacturer and model with the MIB's, so the asset silently switched into that MIB's manufacturer profile |

Elsewhere the pin only decorated the monitoring chip ("· MIB: <module>"). So on most streams the
control was a placebo, and on two it was a hidden second way to choose a manufacturer profile,
one that nothing else in the product (the Custom MIB tab, the widget switch, the System tab) knew
about: rule 131 says one answer decides which profile covers a device, and the pin made a second.

The operator's decision: no MIB dropdown under an SNMP stream; say what is used instead, "either
that default MIBs are being used or that a manufacturer profile is in use".

**What changed.**

- The resolver stops resolving the six `*MibId` fields; every one reads null. The collectors build
  the profile subject from the asset alone.
- Every write path keeps the key (an API client written against the old contract would otherwise
  start getting 400s) but parses it to `undefined`, so it is never stored.
- The asset modal, the phone's Monitoring sheet, the integration and class-override stream tabs
  show a read-only MIB line. On an asset it names the covering profile and the MIB modules uploaded
  under its name, from the effective-settings read; a tier form covers many assets and says "each
  asset's manufacturer profile". The chip loses its MIB segment.
- `deleteMib`'s guard (rule 167's MIB clause) counted only these pins; with nothing able to hold a
  MIB any more it is removed, and a stale pin cannot block a delete.
- The migration records, before clearing, each pin that could have changed the profile: an uploaded
  MIB on CPU/Memory or Hardware Sensors whose manufacturer differs from the asset's (or has none,
  which fed the module name into `matchPattern`). Each event names the MIB and says to set the
  asset's Manufacturer instead.

**Alternatives rejected.**

- *Keep the picker on CPU/Memory and Hardware Sensors only.* It would keep the second way of
  choosing a profile that rule 131 forbids, on the two streams where it is most surprising.
- *Keep the pins, relabel the dropdown.* The truthful label for most of its options would have
  been "does nothing".
- *Reject the keys with a 400.* Accepting and ignoring costs nothing and breaks no client; the
  columns go in a later release once no rollback can need them.

### Rule 170 — the invariant as stated in full until 2026-11-12

(new rule; the invariant above is its first statement)
