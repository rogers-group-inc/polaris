# Standard MIB sources

These canonical MIB modules back the SNMP Walk tab's browse tree for
built-in MIBs (`std:system`, `std:interfaces`, `std:if-ext`, `std:host-resources`,
`std:entity`, `std:entity-sensor`, `std:lldp`, `std:poe`, `std:bridge`,
`std:q-bridge`, `std:rstp`, `std:ip`). They are loaded by
[../stdMibLibrary.ts](../stdMibLibrary.ts) at first use.

Re-pull via:

```
node scripts/fetch-std-mibs.mjs
```

Source mirrors (per-module, see the `mirror` field in the fetch script):

- <https://mibs.pysnmp.com/> — tracks IETF + IEEE upstreams. Source of every
  module except the four below.
- <https://github.com/netdisco/netdisco-mibs> (`rfc/` tree) — source of the four
  switch physical-layer modules (POWER-ETHERNET / BRIDGE / Q-BRIDGE / RSTP),
  whose download from pysnmp was returning HTTP 522 when they were added. Each
  was verified after download: correct `<NAME> DEFINITIONS ::= BEGIN` envelope,
  an RFC reference and `LAST-UPDATED` matching the published RFC, IETF Trust
  copyright present, and — the check that actually matters — every expected
  symbol resolving to its canonical OID via `scripts/smoke-std-mibs.ts`.

## Files

| Module | std key | Root OID | Source URL | SHA-256 | Bytes |
|---|---|---|---|---|---|
| `SNMPv2-MIB` | `std:system` | `1.3.6.1.2.1.1` | <https://mibs.pysnmp.com/asn1/SNMPv2-MIB> | `0990746329a32c698157c633aa70d31b3c638e397ec15477ddaccc544a5473c4` | 31542 |
| `IF-MIB` | `std:interfaces` | `1.3.6.1.2.1.2` | <https://mibs.pysnmp.com/asn1/IF-MIB> | `91df18ae09db2df6a85d519c23533514c81e5464d44da4f21a4465ec9449e752` | 71751 |
| `HOST-RESOURCES-MIB` | `std:host-resources` | `1.3.6.1.2.1.25` | <https://mibs.pysnmp.com/asn1/HOST-RESOURCES-MIB> | `d3fd6069f18055375e1fbb1708f31c13f71528b8addb2ffd5bddc69e58d3c876` | 56653 |
| `ENTITY-MIB` | `std:entity` | `1.3.6.1.2.1.47` | <https://mibs.pysnmp.com/asn1/ENTITY-MIB> | `e56b77653a23171405dbae2431ed3f411dbe311e6ce1222cfd4cffd29dfe2e0c` | 65951 |
| `ENTITY-SENSOR-MIB` | `std:entity-sensor` | `1.3.6.1.2.1.99` | <https://mibs.pysnmp.com/asn1/ENTITY-SENSOR-MIB> | `51e878b065f5cd70361173ca3f37f8bb20509556eb82cd086a057dce66a66fa1` | 16145 |
| `LLDP-MIB` | `std:lldp` | `1.0.8802.1.1.2` | <https://mibs.pysnmp.com/asn1/LLDP-MIB> | `be01b2eecf2fc2031219fd4a676e2341ccf7be9d98b03794c422f7a7db117c74` | 77320 |
| `POWER-ETHERNET-MIB` | `std:poe` | `1.3.6.1.2.1.105` | <https://raw.githubusercontent.com/netdisco/netdisco-mibs/master/rfc/POWER-ETHERNET-MIB.txt> | `ddd60bc04d8e65fefd54625439de9f09b107b567fd69009bc7fc3c9ca4598865` | 21635 |
| `BRIDGE-MIB` | `std:bridge` | `1.3.6.1.2.1.17` | <https://raw.githubusercontent.com/netdisco/netdisco-mibs/master/rfc/BRIDGE-MIB.txt> | `1e18de882086fca7be165e367d3b8e141379f5181fcaa3af0efe63f6710440da` | 50948 |
| `Q-BRIDGE-MIB` | `std:q-bridge` | `1.3.6.1.2.1.17.7` | <https://raw.githubusercontent.com/netdisco/netdisco-mibs/master/rfc/Q-BRIDGE-MIB.txt> | `7cd2eac2dc24efc7c46d24aa153940ea442cc0d022c0c6776bd2f5f94976abc6` | 84011 |
| `IP-MIB` | `std:ip` | `1.3.6.1.2.1.4` | <https://mibs.pysnmp.com/asn1/IP-MIB> | `2d97324114ccd19d16f81cbe1cfcc0692779512b2fe66e4d56f6d4b8a5109d16` | 186015 |
| `RSTP-MIB` | `std:rstp` | `1.3.6.1.2.1.134` | <https://raw.githubusercontent.com/netdisco/netdisco-mibs/master/rfc/RSTP-MIB.txt> | `4b1d814fe48aaf85fc7b513c4382fb0b30db1742587fc736a55e7167f26199f5` | 10750 |

## Cross-module anchors

`stdMibLibrary` resolves each module independently against `BUILT_IN_OIDS` —
there is no cross-MIB visibility between bundled modules. Two of these anchor on
a sibling's symbol via IMPORTS and therefore need that symbol seeded in
`oidRegistry.BUILT_IN_OIDS`, or they resolve to (almost) nothing:

| Module | Anchors on | Seeded as | Without the seed |
|---|---|---|---|
| `Q-BRIDGE-MIB` | `dot1dBridge` (BRIDGE-MIB) | `1.3.6.1.2.1.17` | 0 of 129 assignments resolve |
| `RSTP-MIB` | `dot1dStp` (BRIDGE-MIB) | `1.3.6.1.2.1.17.2` | 9 of 19 assignments resolve |

Check the IMPORTS of any newly-added module for symbols used as OID parents.
`IP-MIB` needs no seed: it hangs off `mib-2` like the rest, and its IMPORTS
(InetAddressType, InterfaceIndex, …) are textual conventions, not OID parents.

## Known cosmetic gap

`BRIDGE-MIB`'s `dot1dBasePort` and `LLDP-MIB`'s two `*ManAddrSubtype` symbols
render as "(unresolved)" in the browse tree. This is a pre-existing quirk of the
regex extractor in `oidRegistry.parseObjectAssignments`, which skips those
particular OBJECT-TYPE definitions; it is display-only and affects no collector,
since collectors use numeric OIDs. Notably `dot1dBasePortIfIndex` — the
basePort→ifIndex join every FDB and STP row depends on — resolves correctly.
Changing `ASSIGNMENT_RE` to close the gap is guarded by the 102 cases in
`tests/unit/mibParseStructured.test.ts`.

## Licensing

- **IETF RFC-derived MIBs** (SNMPv2-MIB, IF-MIB, HOST-RESOURCES-MIB, ENTITY-MIB,
  ENTITY-SENSOR-MIB, POWER-ETHERNET-MIB, BRIDGE-MIB, Q-BRIDGE-MIB, RSTP-MIB,
  IP-MIB) carry the IETF Trust legal provisions — permissive, allows bundling
  and redistribution.
- **LLDP-MIB** (IEEE 802.1AB) carries an IEEE-specific copyright header. IEEE
  historically allows reproduction of standalone MIB modules; the boilerplate is
  preserved in the file. Re-read the in-file header on every refresh and have a
  human verify before committing significant version changes.
- **A manufacturer MIB never goes in this directory.** The vendor MIBs Polaris
  ships live in `../vendorMibs/` and are SEEDED into the MIB Database as rows an
  operator can delete, not baked in here where `loadStandardLayer` globs them and
  nobody can. See that directory's SOURCES.md for the distinction and the
  licensing position on shipping a vendor's file at all.
- **IEEE8021-* modules are deliberately NOT bundled** (e.g. IEEE8021-MSTP-MIB for
  per-MSTI spanning tree). They carry IEEE copyright and would need the same
  human licensing review LLDP-MIB got. Operators can upload them instead — the
  IEEE 802.1 anchor chain is seeded in `BUILT_IN_OIDS` so a single leaf module
  resolves without also uploading IEEE8021-TC-MIB.
