# Business rule 127 — full narrative

> Written 2026-10-22 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 127](#rule-127) — IPv6 is a whole-install switch that follows the host, and an asset with no IPv4 is polled on its primary IPv6

<a id="rule-127"></a>

## Rule 127 — IPv6 is a whole-install switch that follows the host, and an asset with no IPv4 is polled on its primary IPv6

### What was there before (2026-10-22)

Rules 125 and 126 (both 2026-10-21) brought IPv6 in: networks and addresses from
FortiGate / FortiManager into IPAM, and an `ipv6Address` on every interface from
every collector. Both ran unconditionally. And both kept IPv6 OUT of the one place
a device is addressed — `Asset.ipAddress` — so an asset could carry a dozen IPv6
rows in its address list and still show only the IPv4 on the General tab's Address
row, and an IPv6-only device could not be polled at all (every probe dialled
`ipAddress`, which was null).

### What the operator asked for

"On asset details slide-in, general, I want a primary IPv4 address and primary IPv6
address. I only want IPv6 to be enabled on Polaris installations where the host
server is using IPv6." Asked to choose, they picked:

- **Scope — everything IPv6.** Off means no IPv6 discovery, collection, storage or
  display, not just a hidden column. An install on an IPv4-only network should not
  accumulate thousands of SLAAC and privacy addresses it can never reach.
- **Detection — auto-detect with an override.** On when the host has a routable
  IPv6, with a Server Settings switch to force either way.
- **The primary IPv6 — automatic and pinnable; monitoring stays on IPv4, but a
  device that only has an IPv6 address is monitored on that.**

### Why the host decides by default

The question the switch answers is "can this Polaris reach devices over IPv6, and
does the network it lives on use it?". The host's own addressing is the cheapest
honest proxy: a host with a global or ULA IPv6 is on a network that routes IPv6; a
host with only fe80:: is not (every IPv6-capable OS has link-local, so it proves
nothing — `routableHostIpv6` excludes it, and loopback, through
`isIpamIpv6Address`). Polling the FortiGates for whether THEY speak IPv6 was
rejected: discovery is the thing being gated, and a gate with an RA prefix on an
interface nobody routes is common.

`on` exists for the container case. A podman / Docker container on the default
bridge sees no IPv6 on its own interfaces even when the host and the LAN are
dual-stack, so `auto` would answer "off" inside the container on a network that
uses IPv6. `off` exists for an operator who has IPv6 on the host and does not
want the data.

### Why a separate column, not `Asset.ipAddress`

Rule 126(d) holds that no automatic path promotes an IPv6 into `Asset.ipAddress`,
and that is kept. `ipAddress` is read by well over a hundred places — subnets,
reservations, dependency gates, the Device Map, the LLDP match index, the conflict
detector — each written for IPv4 and many doing IPv4-only arithmetic. Putting an
IPv6 there for the v6-only case would have been a fleet-wide behaviour change
hidden behind an edge case. `Asset.ipv6Address` is additive: it is shown beside the
IPv4, and read by exactly one thing that decides behaviour — the dial address.

### The dial address

`utils/assetDialAddress.ts → assetDialAddress(asset, allowIpv6)` replaced every
`asset.ipAddress` read that decided where a probe goes: ICMP, SNMP (with `udp6`
transport for an IPv6 target — net-snmp defaults to `udp4`), SSH, WinRM, FortiOS
REST, the firmware HTTP client, the loss sweep, the HTTP check, the SNMP walk and
MIB test routes, the credential test and the agent install target. IPv4 first,
always; the IPv6 only when there is no IPv4. Every URL built from it goes through
`utils/cidr.ts → urlHost` (brackets an IPv6 literal) and every hostname read back
from a URL through `bareHost` — `new URL("https://[2001:db8::1]/").hostname` keeps
the brackets, which `http.request` and the TLS-pin keys do not want.

### How the primary is chosen

The candidates are the asset's IPv6 address-list rows (`AssetAssociatedIp`, filled
by rule 126). Scored by the address-confidence evidence score (rule 103), then the
newest sighting, then the lexically smallest address so two equal candidates do
not swap on every run. A reconcile job (`reconcilePrimaryIpv6`, every 10 minutes)
rather than a write-time hook: the candidates are written by a dozen paths, and a
privacy address that rotates daily would otherwise thrash the choice on every
scrape. The job writes only the assets whose choice changed, in one transaction
per 200-asset batch, so at 2000 assets the steady state is one read and no writes.

An operator's pin (`ipv6Pinned`) is never touched by the job, mirroring the IPv4
pin of rule 102. Unpinning re-picks immediately, so the panel shows the result.

### What "off" does to data already stored

Turning IPv6 off stops new IPv6 being written; it does not purge. The reconcile
clears every UNPINNED primary IPv6 (derived data, rebuilt when IPv6 comes back),
keeps a pinned one (the operator's data), and refuses new pins with a 409. Interface
rows lose their `ipv6Address` on the next scrape of each asset. IPAM `observed`
rows age out on their 24-hour expiry (rule 125(b)); other IPv6 reservations and
networks already in IPAM stay until removed by hand — deleting IPAM records on a
settings toggle was judged too destructive to do silently.

### Known IPv4-only paths (not gated, not dialling IPv6)

The address-confidence polling run, `dependencyTreeService` IPAM gate resolution,
the LLDP match index, subnet-scoped down rules (`ipAddress not null`), DNS-resolved
reservations (IPv4 by rule 11). The agent install resolves its target through
`assetDialAddress`, but an install over IPv6 has not been exercised end to end. An
IPv6-only device is polled; it is not yet placed under an IPAM gate or matched by
LLDP on its IPv6.

### Rule 127 — the invariant as stated in full

See `invariants-30-43.md` § 127.
