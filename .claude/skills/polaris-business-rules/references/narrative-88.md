# Business rule 88 — full narrative

> Written 2026-09-28 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 75 is claimed by an in-flight worktree (alert
> grouping); 81 is a deliberate gap.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 88](#rule-88) — A port Polaris has positive evidence was never in use does not alert when the automation asks it to skip unused ports; "unused" is decided by the port's remembered address, never its current one

<a id="rule-88"></a>

## Rule 88 — A port Polaris has positive evidence was never in use does not alert when the automation asks it to skip unused ports; "unused" is decided by the port's remembered address, never its current one

### The case

The operator's FortiGate deployment template enables BOTH `wan1` and `wan2` on every
gate, and both are SD-WAN members, whether or not the site has a second circuit. A
site with one circuit has an unplugged `wan2` that is down on every health check, on
every poll, forever. A "SD-WAN member is down" automation therefore paged about it
on every such gate.

The operator's workaround was a second condition: "interface IP address is not
0.0.0.0", on the theory that an unplugged port reads 0.0.0.0. It did not work, and
could not, for two independent reasons:

1. **A multi-condition automation folds each condition per DEVICE, not per port**
   (the composite ANY fold — `notificationEngine.leafTruthByAsset`). "Some member is
   down" and "some interface has an address" were true of different ports: `wan2` was
   down, and `wan1`, the LAN interfaces and management all had addresses. On a
   FortiGate an unpinned "IP is not 0.0.0.0" is effectively always true.
2. **The current address cannot tell an unused port from a failed one.** A DHCP WAN
   whose cable is pulled, or whose modem dies, loses its lease and reads 0.0.0.0 too —
   the exact outage the automation exists for. The operator's fleet mixes static and
   DHCP WANs. A static WAN keeps its address when it goes down, so "is 0.0.0.0" would
   have behaved differently on the two kinds of circuit.

Two designs were considered and rejected:

- **Clearing an interface's IP to 0.0.0.0 whenever it is oper-down** (the operator's
  first idea). This would make EVERY down port read 0.0.0.0, static and DHCP alike, so
  "down AND IP is not 0.0.0.0" could never be true.
- **Per-port matching for multi-condition automations** (evaluate each condition on the
  same interface, mapping an SD-WAN member to its interface). This is general, but it is
  a real engine change. It would have to be opt-in: "wan1 is down AND wan2 is down" —
  both WANs lost — depends on today's per-device fold and would never fire under
  same-port matching. It also lands in the code the unmerged rule-75 branch rewrote.

### The decision

**Remember the last address a port had, and let a condition skip the ports that never
had one.**

- `AssetInterface.lastLearnedIp` / `lastLearnedIpAt` (migration
  `20260928000000_interface_last_learned_ip`). `persistInterfaceRows` is the ONE writer
  (system-info pass, agent push, vCenter, the backfill job), and it delete-replaces a
  device's rows every pass. So the remembered value is read first and carried into the
  new row, the way `firstSeen` already was (`nextLastLearnedIp`). An addressed scrape
  refreshes it; `0.0.0.0` or a pass that collected no address keeps it; after
  `LAST_LEARNED_IP_TTL_MS` (30 days, the operator's number) it is forgotten, so a port
  retired from service stops counting as "in use" a month later. The migration seeds
  each port from its current address; a port that happens to be down at upgrade time
  starts unlearned and learns on its next addressed poll.
- `isUnusedPort` needs POSITIVE evidence: a non-tunnel port, reporting an address
  field, reporting it unaddressed, with nothing remembered inside the TTL. Everything
  else is kept. In particular, IPsec/GRE overlay members (tunnels) are never skipped,
  since they carry no address the way a WAN does; nor is a member with no interface row.
  The option removes ports Polaris knows were never used, never ones it merely knows
  little about.
- **A flag on the condition, not a second condition.** `skipUnusedPorts` rides the
  condition it narrows, so no per-device fold is involved. An SD-WAN member matches its
  interface by name (the `link` half of the `healthCheck|link` key), the same join the
  SD-WAN tab uses to show a member's IP. Offered on SD-WAN member state, the three
  SD-WAN SLA metrics and interface oper status (`SKIP_UNUSED_PORT_TARGETS`). It is
  refused on anything else, where it would save and filter nothing.
- **A skipped port produces no reading** — the unpinned-interface contract. It never
  raises an alert, and one already live is retired by `clearVanishedStates`. A failed
  interface lookup keeps every port.
- **Part of `triggerSignature`**: an automation that skips unused ports and one that does
  not watch different sets of ports and must never carve each other out.

Accepted costs: a port that has been down for more than 30 days is treated as unused
and its alert retires. The asset's IP history does NOT hold a WAN's DHCP address
(`AssetIpHistory` records only `Asset.ipAddress`), so the remembered value lives on the
interface row and nowhere else.

### Retired 2026-10-08

The operator asked for the option to go and for a plain "SD-WAN member IP address != 0.0.0.0" condition in its place (rule 98). The trade-off was put to them first: the remembered address is what told an unused port from a DHCP WAN whose lease dropped with its link, and a current-address filter cannot — *is not 0.0.0.0* leaves that outage out too. They chose the filter they can read and set directly, and to drop the option everywhere, Interface oper status included, along with the `lastLearnedIp` / `lastLearnedIpAt` columns that existed only for it. Automations that had it ticked lose it on upgrade: the key is stripped on parse and alerts resume on the ports it skipped.

### Rule 88 — the invariant as stated in full until 2026-10-08

88. **A port Polaris has positive evidence was never in use does not alert when the automation asks it to skip unused ports; "unused" is decided by the port's remembered address, never its current one** — a FortiGate template that enables wan1 AND wan2 on every gate leaves an unplugged wan2 down on every SD-WAN health check forever, and both it and a working DHCP WAN whose link just dropped read `0.0.0.0` NOW. `AssetInterface.lastLearnedIp` / `lastLearnedIpAt` tell them apart: `services/interfaceInventoryService.ts → nextLastLearnedIp` refreshes both on any addressed scrape (bare, no mask) and carries them through `0.0.0.0` and address-less passes across `persistInterfaceRows`' delete-replace, forgetting them after `LAST_LEARNED_IP_TTL_MS` (30 days). `isUnusedPort` is true only for a NON-TUNNEL port that REPORTS an address field, reports it unaddressed, and has nothing remembered inside the TTL — a tunnel, a port that reports no address field, and a port with no interface row are always KEPT. The option is a flag on the condition (`skipUnusedPorts`, `SKIP_UNUSED_PORT_TARGETS`: SD-WAN member state / latency / jitter / loss, matched through the member name = the interface name, and interface oper status), refused anywhere else, part of `triggerSignature`, and applied in the resolver (`notificationEngine → dropUnusedPorts`): a skipped port produces NO reading, so its live alert retires through `clearVanishedStates`. A failed lookup keeps every port. Pinned by `skipUnusedPorts.test.ts` (unit; deleted 2026-10-08), `interfaceLastLearnedIp.test.ts` (integration; deleted 2026-10-08). → [narrative-88.md#rule-88](narrative-88.md#rule-88)
