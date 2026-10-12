# Business rule 101 — full narrative

> Written 2026-10-10 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 101](#rule-101) — An address is ranked by how directly it is known: a reservation the device holds, then what the gate sees online, then a held lease, then ARP — and a detection the gate's ARP contradicts decides nothing
- [Rule 101(a)](#rule-101a) — ARP on the ladder, untrusted detection, and the reservation above it

<a id="rule-101"></a>

## Rule 101 — An address is ranked by how directly it is known: a reservation the device holds, then what the gate sees online, then a held lease, then ARP — and a detection the gate's ARP contradicts decides nothing

### The incident

2026-10-10, prod. A plant HMI (a Windows 11 PC with an Ethernet card and a Wi-Fi card, both reported by Intune) showed an IP address from the Wi-Fi subnet. The address it was really using was a DHCP reservation in a different subnet, on its Ethernet card, on a FortiSwitch port. Monitoring was probing the wrong address.

Querying the gate directly, `GET /api/v2/monitor/user/device/query?filter=mac==<ethernet MAC>` returned the right address: the detected-device row, `is_online: true`, attributed to the switch port. The operator's question was the right one: if the gate already knows, why doesn't Polaris use that?

Two things went wrong, and either one alone was enough.

1. **The DHCP ranking could not let a reservation win.** Phase 6 scored each DHCP entry as `[seenLeased, inventorySeenMs, expireTime, lease-over-reservation]`. A reservation carries no `expire_time`, so it scored 0 on the third key, and a lease with any expiry beat it whenever the first two keys tied. On one gate they always tie: both bindings are held, and the inventory freshness is keyed by (mac, gate). So a leftover lease always beat the reservation the device was actually using, until the lease expired.
2. **The detected-device row never got a vote.** Phase 7 skipped the IP write for any MAC that appeared in the gate's DHCP data (`handledByDhcp`). Static reservations from the gate's configuration count as DHCP data whether or not the device is holding them, so any reservation or lease for the MAC silenced the most current evidence the gate had.

### Why a detected-device row is the strongest claim

A lease or a reservation records an address that was *handed out*. FortiOS builds the detected-device table from traffic it is seeing from that MAC. An online row is the gate saying "this MAC is at this address right now". Nothing in the DHCP data can say that: a held lease can outlive the device's use of it by the whole lease time, and a held reservation tells you the device is holding it, not that it is the address the device is using.

So the ladder's first key is a tier, and an online detected-device row is at the top. A row FortiOS keeps for a client that left (`is_online: false`, old `last_seen`) is below any binding the device is holding, so a stale row can't drag the address back. And a detected-device row only claims at all when it is local: a ZTNA access-proxy session creates a row on a gate the user only connects *through*, with an address from somewhere else. That is `inventorySightingIsLocal`, unchanged.

### Why one ladder, not two

Before this rule the DHCP pass and the detected-device pass each kept their own best-claim map (`bestIpClaimByAsset`, `bestInvIpSeenByAsset`), and the detected-device pass only ran for MACs the DHCP pass had not covered. Two maps meant a detected-device row and a DHCP entry never compared against each other. One map on the run-scoped `DhcpClaimState` makes them compete directly, across gates as well: in FortiManager mode each gate's sync adds to the same map, so a leftover lease on the gate the device left loses to the online row on the gate it is behind, whichever gate finishes first.

### Wired over wireless, and why freshness comes first

The HMI had both cards up. Each card's address is correct for that card, so the question is not which claim is true but which one the asset should be monitored on. The wired address is the one that stays put: the Wi-Fi card roams, gets a new lease per site, and drops when the AP does. So inside a tier, wired beats unknown beats wireless. The medium comes from the strongest evidence the claim has: the detected-device row's FortiSwitch or FortiAP attribution, the lease's AP / SSID fields, and failing those the adapter type Intune reported for that MAC (`intune-ethernet` / `intune-wifi`; a vCenter vNIC counts as wired).

The trap is a laptop that comes off its dock. Its wired reservation can stay "held" on the gate until the lease time runs out, and wired-over-wireless alone would keep the asset on an address the device has left. Two keys prevent it. The tier: once the dock is unplugged, the Wi-Fi card's detected-device row is online and the wired one is not. And a `recent` key ahead of the medium: a claim whose evidence is older than `RECENT_CLAIM_MS` (one hour) loses to one seen within it, before medium or binding type are compared. The exact evidence time still decides further down, which keeps the roaming-laptop case (two unexpired leases on two gates, both seen days ago) working the way it did.

### Reservation over lease

A reservation the device is holding is an address somebody chose on purpose; a lease is whatever was free in the pool. When both are held for the same device, the reservation wins. That is the old tiebreak turned around, and moved ahead of the evidence time and the lease expiry.

### The collectors

The FortiOS DHCP monitor returns the reservation's live lease with `access_point` / `ssid`, but both collectors (`fortimanagerService.ts`, `fortigateService.ts`) merge it into the CMDB reservation row and kept only `seenLeased`. They now copy the AP / SSID onto the reservation when they are absent, so a reservation held over Wi-Fi ranks as wireless. FortiManager and standalone FortiGate get the same change.

### The parser — the same incident, the same evening

The ladder shipped and the HMI still showed the leftover lease. The detected-device claim had never fired at all: both collectors read the row's address from `client.ip` and requested `ip` in `format=`, but the FortiOS 7.x build in prod names the field `ipv4_address` (and `os_name`, `detected_interface`, `unauth_user` for the OS, interface and user). A field name the parser doesn't know reads as empty, so every detected-device row reached discovery with no address — silently, since a row without an IP is legal. The tests for the ladder fed parsed rows straight into `syncDhcpSubnets`, so they could not see it.

`utils/inventoryLocality.ts → parseInventoryClient` is now the one parse for both collectors, taking the 7.x name first and the older one after, and `INVENTORY_QUERY_FORMAT` requests both spellings. `tests/unit/inventoryLocality.test.ts` pins it against the 7.x row shape. A new detected-device field goes through that function, never into one collector's loop.

### What did not change

- `handledByDhcp` still decides whether Phase 7 bumps the MAC row (Phase 6 already did); it no longer touches the address.
- Fortinet infrastructure (firewall / switch / AP) takes its address from its own discovery loop and is skipped on both passes. Phase 7 used to have no such guard; it only mattered once Phase 7 could claim an address a DHCP entry also covered.
- The projection still decides between source kinds (a vCenter guest IP still outranks the `fortigate-endpoint` blob). This rule decides what the `fortigate-endpoint` sighting says.

### Rejected

- **A detected-device row always wins, online or not.** FortiOS keeps clients that left, and their old address would beat the lease the device is holding today.
- **Wired before freshness.** The undocked-laptop case above.
- **Widening `handledByDhcp` across gates.** It also gates the per-gate MAC-row bump, which must keep running per gate. The claim needed its own predicate, and the shared ladder is that predicate.

<a id="rule-101a"></a>

### 101(a) — ARP on the ladder, untrusted detection, and the reservation above it (2026-10-12)

Two days after the ladder shipped, the owner pinned a static device to its real address. The pin was released (rule 103(a), on ARP evidence), and the next discovery moved the asset back to the address the FortiGate's detected-device table reported. Three statements from the owner, each of which changed the ladder:

- **"The ARP table should weigh in."** The ladder had only DHCP entries and detected-device rows on it; ARP did nothing but fill a blank address. A gate resolving an address to a MAC is a current binding, so an ARP row is now a claim (tier 2).
- **"If a single interface has multiple secondary IP addresses, we can't trust the device report from the FortiGate, and subsequently from FortiManager."** The detected-device row carries whichever source address the gate last saw traffic from. For a card with several addresses that proves the card has that address, not that it is the primary. So a detected-device row is UNTRUSTED when the same gate's ARP table shows the MAC with several addresses (`arpMultiHomed`), and also when ARP has the MAC bound to another address and not to the row's (`arpContradicts`). An untrusted row drops to tier 1, may fill a blank address, and never moves an asset off the address it has.
- **"A DHCP reservation should be scored higher than FortiGate discovery, because a reservation requires human review."** A held reservation moved above an online detected-device row (tier 5 over 4). A lease stays below detection: the original HMI case — the gate seeing the device at one address while holding a leftover lease for another — still resolves the same way.

Three guards came out of working the cases:

- **Absence is never a contradiction.** FortiOS ages an idle neighbour entry out in a minute or two, so a detected address missing from ARP proves nothing. Only the MAC being bound elsewhere, or to several addresses, counts — and a gate whose ARP read failed has no rows and contradicts nothing.
- **ARP below a held DHCP binding.** ARP lists a card's secondary addresses too. Ranked level with a lease, a secondary could take the primary from the lease the device is holding.
- **A stale reservation ranks as a lease.** The DHCP monitor keeps calling a reservation held until its lease time runs out. On top of the ladder unconditionally, an undocked laptop's wired reservation would beat the Wi-Fi card the gate is seeing online. When the gate's own detected-device data last saw that card more than `RECENT_CLAIM_MS` ago the reservation drops to tier 3; with no such data it keeps tier 5.

Among a card's several ARP addresses the claims tie, so the pass works per asset: the row for the standing address stakes its claim first and a sibling must strictly beat it. Equal claims leave the asset where it is — the operator pins the one they want, and that pin is now safe (103(a)). The one thing that lifts a sibling is a DHCP reservation configured for that MAC at that address, held or not: the address somebody chose for the card.

ARP only overrules an address this run's DHCP or detected-device claims decided. An address that came from vCenter, Arc or an operator has no claim on the ladder and is not ARP's to take — without that limit every VM with a secondary address in some gate's ARP table would flap between the two.

The sections above this one describe the ladder as first shipped (detection on top, three tiers); the tier order in the invariant is the current one.
