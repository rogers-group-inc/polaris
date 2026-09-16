# Shipped manufacturer MIB sources

The manufacturer MIBs Polaris ships. These are **seeded into the MIB Database,
not baked into the product** — `jobs/seedVendorMibs.ts` inserts each as a
`MibFile` row at manufacturer scope on the first boot of a FRESH install, which
means they appear in Server Settings → Credentials → MIB Database exactly like
something an operator uploaded, and **an operator can delete them**. An UPGRADE
seeds nothing: an existing MIB Database is the operator's, and adding a vendor's
modules for devices they may not own is editing their data.

That is the whole distinction from [`../stdMibs/`](../stdMibs/SOURCES.md):

| | `stdMibs/` | `vendorMibs/` (here) |
|---|---|---|
| What | generic IETF / IEEE modules | a manufacturer's own public MIB |
| How it reaches the resolver | read off disk by `oidRegistry.loadStandardLayer` | a `MibFile` row, like an upload |
| Operator can delete it | **no** — changes only with a product update | **yes** |
| Why | every device speaks these; there is nothing to opt out of | a vendor's file: they may have a newer one, may object to it shipping, or may not run that gear |

**A module here must never also be placed in `stdMibs/`.** That directory is
globbed by `loadStandardLayer`, so a vendor file landing there silently becomes
part of the layer nobody can remove — the opposite of the intent.
`tests/unit/seedVendorMibs.test.ts` fails if one does.

## Which vendors, and why only these

A manufacturer MIB earns a place here only if a **manufacturer profile** needs
it, and a profile earns its place only if it overrides something the generic
MIBs cannot already do. A vendor whose telemetry HOST-RESOURCES-MIB already
answers needs neither.

| Module | Manufacturer | What it is for |
|---|---|---|
| `CISCO-SMI` | Cisco | The `cisco` / `ciscoMgmt` anchors. Carries no telemetry itself; the other two resolve to nothing without it. |
| `CISCO-PROCESS-MIB` | Cisco | `cpmCPUTotal5secRev` — per-CPU load, walked and averaged. IOS reports CPU through `hrProcessorLoad` too, but only as a 5-minute average on many platforms; this is the 5-second figure. |
| `CISCO-MEMORY-POOL-MIB` | Cisco | `ciscoMemoryPoolUsed` / `ciscoMemoryPoolFree` — per-pool bytes, walked and summed. HOST-RESOURCES-MIB's RAM row does not distinguish Cisco's pools. |

MikroTik was a candidate and was **dropped** (2026-09-16). RouterOS reports CPU,
memory and storage through HOST-RESOURCES-MIB, so the profile had nothing to
override there; the one thing MIKROTIK-MIB adds is the `mtxrHealth` sensor
group, whose `Temperature` is DISPLAY-HINT `d-1` and needs scaling at
COLLECTION — which nothing performs (`applyTransform` has one call site, the
custom-widget collector). The row would have charted 315 instead of 31.5, so
shipping the MIB would have shipped a broken example.

## Files

| Module | Source URL | SHA-256 | Bytes |
|---|---|---|---|
| `CISCO-SMI` | <https://raw.githubusercontent.com/cisco/cisco-mibs/main/v2/CISCO-SMI.my> | `3ea80f8160af50ba77e7309b7f95b4b6edb3ddc57dbe67eb0ee18ae1b56fd332` | 16811 |
| `CISCO-PROCESS-MIB` | <https://raw.githubusercontent.com/cisco/cisco-mibs/main/v2/CISCO-PROCESS-MIB.my> | `758af2a1dc93909623a02ef4f37b0b45789fe96c08e88575a52464a5dc761fce` | 107423 |
| `CISCO-MEMORY-POOL-MIB` | <https://raw.githubusercontent.com/cisco/cisco-mibs/main/v2/CISCO-MEMORY-POOL-MIB.my> | `a3233f34e65991d75c907d4d0999e676bfd66792cafa35d7e2954022a17b81f7` | 16214 |


Downloaded 2026-09-16, normalised to LF, renamed to `<MODULE>.txt`. The source
is the vendor's own publication: Cisco's public MIB mirror, which replaced
`ftp.cisco.com` when that was decommissioned in 2022. The SHA-256 is what makes
a substituted file detectable; re-record it on any refresh.

## Verified on download

Each module was checked before committing, not assumed:

- Correct `<NAME> DEFINITIONS ::= BEGIN` envelope matching the filename.
- Every symbol the seeded profiles name is actually defined in it — the check
  that matters, and the one that caught a profile naming
  `mtxrSystemUserCPULoad`, a symbol that exists in no MikroTik MIB (verified
  against MikroTik's own download and the LibreNMS mirror). That row had never
  resolved on any install.
- The whole chain resolves through `oidRegistry.resolveStandardSymbols()` once
  seeded: `cisco` → `1.3.6.1.4.1.9`, `cpmCPUTotal5secRev` →
  `1.3.6.1.4.1.9.9.109.1.1.1.1.6`, `ciscoMemoryPoolUsed` →
  `1.3.6.1.4.1.9.9.48.1.1.1.5`, and `ciscoMemoryPoolFree` → `1.3.6.1.4.1.9.9.48.1.1.1.6`.
- Units read off the MIB rather than guessed — which is what disqualified
  MikroTik's sensor: `DISPLAY-HINT "d-1"` means tenths of a degree, and Polaris
  has no collection-time scaling to turn that into Celsius.

**No enterprise arc is hardcoded to make any of this resolve.** `CISCO-SMI`
anchors on `enterprises`, which is IETF scaffolding and already seeded, and
`oidRegistry` resolves a module against the others present — so the chain
completes from data alone. The `tests/unit/noEnterpriseOids.test.ts` boundary
is untouched.

## Licensing

**Shipping these is a decision the project owner made deliberately (2026-09-16),
recorded here rather than left implicit.**

Cisco does not grant redistribution in writing: its mirror
(<https://github.com/cisco/cisco-mibs>) carries no LICENSE file and the modules
read `Copyright (c) … by cisco Systems, Inc. All rights reserved.` They are
published for public download by the vendor for exactly this purpose, and other
FOSS NMS projects have long redistributed them (LibreNMS, Observium,
netdisco-mibs) — a norm rather than a grant.

Two things follow, and they are why the seeded-not-bundled design matters:

- An operator who does not want a vendor's file on their install **can delete
  it**, which a baked-in module would not allow.
- Adding another vendor here is the same decision again, not a precedent
  already set. Re-read the file's own copyright header, record it in this
  section, and have a human confirm — the same bar
  [`../stdMibs/SOURCES.md`](../stdMibs/SOURCES.md) applies to LLDP-MIB and the
  reason the IEEE8021-* modules are still not shipped.

## Refreshing

There is no fetch script for these: three files on the vendor's own release
cadence did not justify one, and a vendor MIB should be re-read by a human on
update rather than pulled blind. To refresh, download from the URL above,
normalise CRLF → LF, save as `<MODULE>.txt`, update the SHA-256 and byte count
here, and re-run `tests/unit/seedVendorMibs.test.ts`.

A refreshed file reaches **fresh installs only**, and so did the original: the
job skips any database a previous release has already run against, so an
upgrade's MIB Database stays exactly as its operator curated it. Existing
installs that want these upload them like any other MIB.
