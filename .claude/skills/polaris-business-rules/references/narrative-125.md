# Business rule 125 — full narrative

> Written 2026-10-21 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 125](#rule-125) — An IPv6 address a FortiGate knows is recorded in its IPAM network, and never becomes the address a device is polled on

<a id="rule-125"></a>

## Rule 125 — An IPv6 address a FortiGate knows is recorded in its IPAM network, and never becomes the address a device is polled on

### What was missing (2026-10-21)

An operator reported that Polaris was not discovering IPv6 addresses from FortiGates or adding
them to IPAM networks. It never had. Every FortiGate read was IPv4 by construction: the DHCP
scopes came from `system.dhcp/server` alone, interface addresses were taken from `ip` and
`secondary-ip` behind an `isValidIpv4` gate, and the lease read asked for the IPv4 table. The
detected-device query already requested `ipv6_address` and parsed it into a field nothing read.

The IPAM side was not the problem. Blocks, subnets and reservations already took IPv6. The
`netmask` 2.x library behind `utils/cidr.ts` parses IPv6, so `normalizeCidr`, `cidrContains`,
`cidrOverlaps` and `ipInCidr` were correct for it and never matched across families. Their
comments said "IPv4 only", which was out of date; the first diagnosis repeated that claim and
had to be corrected once the functions were run.

### What FortiOS actually returns

Read off the lab gates (FortiOS 7.6.7 and 8.0.1), not from documentation:

- `system.dhcp6/server` has `subnet` (the prefix, `::/0` until configured), `ip-mode`,
  `ip-range` and `prefix-range`, and **no reserved-address table** on either version. FortiOS
  has no DHCPv6 reservations. Every DHCPv6 binding is a lease, so there is nothing to push,
  sweep or adopt.
- `monitor/system/dhcp?ipv6=true` returns the COMBINED table. The IPv4 rows are unchanged and
  every row carries `type: "ipv4" | "ipv6"`, so adding the flag only adds rows.
- An interface's CMDB row carries an `ipv6` object: `ip6-address` (`::/0` when unset),
  `ip6-extra-addr[].prefix`, `ip6-send-adv` and `ip6-prefix-list[].prefix`. An address that is
  runtime state (`ip6-mode` dhcp / pppoe / delegated) is not in it at all.
- The device inventory reports one `ipv6_address` per client. That field is the only place a
  SLAAC or privacy address shows up. The detected-device `last_seen` is an age in seconds (a
  live row read 7), not the epoch its type comment claimed.
- FortiManager returns option fields as integers where FortiOS returns strings, so every flag
  is read through `fortiosEnabled`.

### The decisions

**What becomes a network.** A DHCPv6 scope, and a prefix the gate advertises by router
advertisement. The RA prefix is the IPv6 counterpart of a DHCP scope: it is how a SLAAC network
is served. An interface address alone does not make a network. That matches IPv4, where a WAN
address never created its /24. RA prefixes answer to the DHCP include / exclude filter, as
scopes do, and not to the interface filter. Their ids are prefixed (`dhcp6-`, `ra-`) so a
pattern an operator wrote for IPv4 scope 3 cannot catch DHCPv6 scope 3.

**What becomes an address.** The gate's own addresses (`interface_ip`) and DHCPv6 leases
(`dhcp_lease`) map onto existing source types. A client's self-assigned address had no source
type that fit, and it is the common case for IPv6. The operator asked for all of them, so it
got its own type, `observed`.

**Why `observed` is evidence, not a claim.** The gate did not assign the address; it saw it in
use. Privacy addresses rotate about daily. So an observed row never disputes anything: a row of
any other source at the address wins untouched, and no Conflict is raised (rule 7's conflicts
are for discovery values that differ from a manual claim, and a sighting is not one). A create
supersedes it like a lease. Each row carries `expiresAt` set to its last sighting plus 24
hours, and the existing 15-minute `expireReservations` job ages it out. That keeps a client at
one or two rows at a time instead of a growing history, with no new sweep. Only a CURRENT
sighting moves the clock, and every refresh shares one `expiresAt`, so the steady state is one
`updateMany` per run. A remembered-offline inventory row cannot keep an address alive, the same
evidence-time rule Phase 7 already applies to presence.

**Why no IPv6 address may address an asset.** `Asset.ipAddress` is the address every probe
transport dials, and each one (ICMP, SNMP, SSH, WinRM, FortiOS REST) assumes IPv4. Letting an
IPv6 lease into the address ranking (rule 101) would have let it win on freshness and silently
move a monitored device onto an address Polaris cannot poll. The same client's IPv4 lease,
inventory row and ARP entry already carry its presence, MAC, location and gateway. So Phase 6
skips IPv6 entries entirely, and Phase 7's new-asset address fallbacks are IPv4-only.

**The push bug this exposed.** The subnet panel already marked IPv6 networks as not
push-eligible, but `reservationService` did not. A manual reservation typed into a discovered
IPv6 network on a push-enabled integration would find no IPv4 scope to push into, fail
permanently, and roll the create back. All three eligibility sites now refuse IPv6, and lease
release skips the gate for an IPv6 address instead of sending a verb whose effect there is
unverified.

**Canonical spelling.** Reservation keys and the unique index compare strings. Discovery writes
RFC 5952 form (`canonicalIp`, the form `normalizeCidr` already used for a network base), and
`createReservationFlow` canonicalises an operator's input to match. Otherwise
`2001:DB8::0005` and `2001:db8::5` would be two active rows for one address.

### Rejected

- **Recording SLAAC addresses only on the asset's address list.** The operator asked for them in
  IPAM networks, and the address list feeds the primary-address pin (rule 102), which would have
  offered an IPv6 address to monitor on.
- **Reusing `dhcp_lease` for observed addresses.** It would be wrong in the UI ("DHCP Lease" for
  an address the gate never leased), and Phase 5's lease logic would treat it as gate state.
- **A per-gate current-state sweep for observed rows.** The expiry clock does the same job
  through existing machinery, and it does not need to know whether a gate's inventory read
  succeeded.
- **Reading runtime interface addresses** (`monitor/system/available-interfaces`). Its IPv6
  shape could not be verified on the lab, which has no IPv6 configured. This is a known gap,
  recorded in polaris-monitoring-discovery → discovery-fortinet.md.

### Amended 2026-10-22 by rule 127

IPv6 is now a whole-install switch (`services/ipv6GateService.ts → ipv6Enabled()`); while it is off none of this runs. And an asset with NO IPv4 is now polled on its primary IPv6 — `Asset.ipv6Address`, a separate column chosen from the address list. `Asset.ipAddress` still never holds an IPv6 automatically. See [narrative-127.md](narrative-127.md#rule-127).

### Rule 125 — the invariant as stated in full

See `invariants-30-43.md` § 125.
