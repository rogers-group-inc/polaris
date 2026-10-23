# Business rule 128 — full narrative

> Written 2026-10-22 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 128](#rule-128) — IPv6 is a whole-install switch that follows the host, and an asset with no IPv4 is polled on its primary IPv6

<a id="rule-128"></a>

## Rule 128 — IPv6 is a whole-install switch that follows the host, and an asset with no IPv4 is polled on its primary IPv6

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

In a container "the host" is the container. A podman / Docker container on the
default bridge sees no IPv6 on its own interfaces even when the host and the LAN
are dual-stack, so `auto` answers "off" — and that is the right answer, because
such a container also cannot SEND to an IPv6 device. The fix is to give the
compose network IPv6 (`enable_ipv6` with a ULA subnet, NAT66 to the host — the
commented block in `docker-compose.yml`, docs/INSTALL.md "IPv6 in a container");
the container then holds a ULA address, which counts as routable, and `auto`
turns on by itself. `on` is for detection that is wrong in some other way; `off`
for an operator who has IPv6 and does not want the data.

### On is not reachable (added 2026-10-22, the same day)

The first cut documented `on` as "for a container that cannot see the host's
IPv6". Read through, that advice produced false down alerts: forced on, the
container still learned IPv6 from discovery (the FortiGate is read over IPv4),
gave IPv6-only assets a primary IPv6, and the monitor then polled them over a
network with no IPv6 route — every probe failed and the asset went down, where
before rule 128 it had simply had no address to poll. So the gate answers two
questions: `ipv6Enabled()` (collect and show IPv6) and `ipv6Dialable()` (dial
it), the second requiring a routable source address or a kernel route to
2000::/3. The route check is a UDP `connect()`, which only asks the kernel to
choose a route — no packet is sent, nothing outside is contacted. The asset's
IPv6 line says *not polled* in that state and the Server Settings card warns.

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

### The off-hold and the automatic Events (added 2026-10-22, the same day)

Asked "if the server gains IPv6 later, how does Polaris update?", the answer
exposed the reverse case: `auto` re-reads the host's interfaces every minute, so
a host that loses its address for two minutes — a router advertisement that
lapsed, a DHCPv6 renewal that failed — turned IPv6 off, and the next reconcile
cleared every automatically chosen primary IPv6 across the fleet. And none of it
left a record: only an operator's mode change wrote an Event.

So `auto` is asymmetric. It turns ON as soon as a routable address appears and
OFF only after `AUTO_OFF_HOLD_MS` (15 minutes) without one, per process
(`lastHostIpv6At`; a process that never saw an address starts off — boot is not
a flap). While held, `enabled` stays true, so nothing is cleared, but `dialable`
follows the route check, so an IPv6-only device the host can no longer reach is
skipped rather than polled into down. Each automatic transition is an Event —
`settings.ipv6.auto_on`, `auto_hold` (warning: the address went, with the time
IPv6 turns off), `auto_hold_ended` (it came back), `auto_off` (warning) — chosen
by the pure `autoChangeEvent` and written only by the scheduler role, since every
role refreshes its own cache and one record per change is enough. The comparison
is against the last real refresh, never the boot placeholder. An operator's mode
change is not an automatic transition (the modes differ) and keeps its own
`settings.ipv6.updated`.

### Decided at install, then a toggle (changed 2026-10-22, the same day)

The operator then changed the design: "enable IPv6 on install if the server has
IPv6. If it doesn't, then don't enable on install. Otherwise, let's make it a
toggle in Server Settings." The `auto` / `on` / `off` mode, the 15-minute
off-hold and the four `settings.ipv6.auto_*` Events above are gone with it — the
sections describing them are kept as the record of what was built and why it
was dropped.

What replaced them: `ipv6Config` holds `{ enabled, setBy, installHostAddresses }`.
`initializeIpv6Setting` runs once per boot on the migrations role
(`jobs/initIpv6Setting.ts`, listed with the other one-shot startup jobs in
`src/app.ts`); it does nothing when a decision exists, so the row is its own
marker, and otherwise writes the host detection with `setBy: "install"` and an
`settings.ipv6.initialized` Event. An existing install makes that decision on the
first start of the version carrying it. A monitor or discovery process that
boots before web reads the same host detection until the row lands. From then on
only `setIpv6Enabled` (the Server Settings checkbox) changes it.

Why this is simpler and loses little: every failure the off-hold existed to
contain came from the switch moving on its own — a host's IPv6 flapping cleared
every automatic primary IPv6 fleet-wide. A switch that only an operator moves
cannot flap, so the hold, the per-process `lastHostIpv6At`, and the
scheduler-role Event dedupe all fall away. The cost is that a host that gains
IPv6 after install does not light IPv6 up by itself; the card says so ("this
server now has a routable IPv6 address — turn IPv6 on") rather than doing it.
The pre-release `{ mode }` row (only ever on dev databases) parses on → true,
off → false, auto → undecided, so the install-time decision settles it.

Reachability (`ipv6Dialable`) stays: an operator can switch IPv6 on in a
container that has no IPv6 network, and the guard against polling IPv6-only
assets into down is as needed as before.

### Known IPv4-only paths (not gated, not dialling IPv6)

The address-confidence polling run, `dependencyTreeService` IPAM gate resolution,
the LLDP match index, subnet-scoped down rules (`ipAddress not null`), DNS-resolved
reservations (IPv4 by rule 11). The agent install resolves its target through
`assetDialAddress`, but an install over IPv6 has not been exercised end to end. An
IPv6-only device is polled; it is not yet placed under an IPAM gate or matched by
LLDP on its IPv6.

### Rule 128 — the invariant as stated in full

See `invariants-30-43.md` § 128.
