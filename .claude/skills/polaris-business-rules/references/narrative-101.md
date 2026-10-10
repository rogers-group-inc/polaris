# Business rule 101 — full narrative

> Written 2026-10-10 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 101](#rule-101) — The address a device is using right now outranks the address it was handed: an online detected-device row beats every DHCP binding, a held reservation beats a leftover lease, and a wired card beats a wireless one

<a id="rule-101"></a>

## Rule 101 — The address a device is using right now outranks the address it was handed: an online detected-device row beats every DHCP binding, a held reservation beats a leftover lease, and a wired card beats a wireless one

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
