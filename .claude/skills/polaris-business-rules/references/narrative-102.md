# Business rule 102 — full narrative

> Written 2026-10-10 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 102](#rule-102) — An address belongs to a card, a card may carry several, and the operator picks the pair a device is monitored on

<a id="rule-102"></a>

## Rule 102 — An address belongs to a card, a card may carry several, and the operator picks the pair a device is monitored on

### Where it came from

The same session as rule 101 (2026-10-10, the plant HMI). Once the ranking was fixed, the asset panel still showed the problem that made the bug hard to see: an "IP Address" row, a separate "MAC Address" row, and an "All MACs" list. The IP came from discovery's address ranking; the MAC from `selectPrimaryMac`, which anchors on the hardware NICs Intune reports. They are chosen by different rules, so they could come from different cards — the panel showed the Ethernet MAC beside the Wi-Fi card's address, and nothing on screen said the two didn't belong together.

The operator's proposal: list the IP addresses under each MAC, mark the winning (MAC, IP) pair as primary — that is what monitoring uses — and let an admin choose a different pair. Two follow-ups during the build shaped the result: a MAC can carry several IPs (secondary addresses), and for such a card the operator still has to say which IP is the primary. So the pin is a pair, not a card.

### Decisions the owner made

- **A pinned card that goes quiet stays pinned.** Monitoring keeps probing the pinned address and the asset shows down; the panel warns "not seen since …". Falling back to the automatic pick would hide exactly the failure a pin is set to watch.
- **The typed IP override stays.** Assets with no MAC sightings (SNMP-only gear, anything behind NAT, a static server no gate sees) have nothing on the list to pin. The typed address remains the way to name one, and the two pins (plus the blank pin) are mutually exclusive: setting one clears the others.
- **Port-range MACs are shown collapsed** and are never a primary candidate. Fortinet infrastructure keeps its management IP from its own discovery loop and cannot be pinned.

### Why AssetAssociatedIp, not a new table

`AssetAssociatedIp` already was "IPs on this asset, each with its own MAC, source and first/last seen", unique per (asset, IP). One row per IP with a MAC column is the shape the operator described: several rows can share a MAC. A parallel table would have split the asset's addresses across two places that search, IP lookup, reservation staleness, LLDP matching and network-scan exclusion would each have had to learn.

The cost of reusing it is that those readers now see discovered rows, and they all assume an address on this table is the asset's address *now*. So discovery writes only bindings the gate reports as current — a DHCP binding the monitor says is held, an online local detected-device row, an ARP entry — and keeps the rows current-state per gate: a successful read of a gate deletes that gate's discovered rows it no longer reports. A configured reservation nobody holds and a remembered-but-offline detected-device row are not written. Without that, a recycled lease would leave the old asset claiming the address, and reservation staleness would read the old asset's presence as evidence the address was in use.

The prune is scoped by kind: a gate whose ARP read failed keeps its ARP rows even if its DHCP read succeeded. Rows from a gate nobody reads any more (removed from FortiManager) are swept after 30 days.

### Three writers, three owners

The table already had two writers: operator/legacy rows (`manual`) and the monitored device's own interface table (`monitor-system-info`, a full replace per scrape). The scrape used to delete every non-manual row before re-inserting; it now leaves discovered rows alone, except that it takes over an IP it also reports (the device's own interface table names it better). Discovery never overwrites a manual or interface-scrape row: on a collision it only fills a MAC the row lacked.

### Why the pin lives on the asset, and how it is enforced

`AssetMacAddress` is fully replaced by discovery's reconcile on every sync, so a flag on a MAC row would be one reconcile away from being lost. The pin is two columns on `Asset`, enforced where the typed override already is: the `src/db.ts` guard (`enforceOperatorOverrides` → `applyPrimaryAddressPin`). Every writer that stages `ipAddress` — the Fortinet phases, vCenter, Arc, the projection pass — is rewritten back to the pinned IP without knowing a pin exists. The guard's extra read (the pinned card's address rows) fires only for a pinned asset's IP-staging write.

### Following the card

A DHCP card that renumbers would otherwise leave the pin on an address nobody holds, forever. The exception: when the pinned IP has not been seen for `PIN_FOLLOW_STALE_MS` (24 hours) and the pinned card has exactly ONE address seen inside that window, the pin moves to it in the same write and an `asset.primary_address.followed` event says so. With several recent addresses the guard can't know which one the operator would pick, so the pin holds and the panel warns. The follow lags discovery by one run: the guard reads the address rows the previous run wrote, because the asset write happens before this run's address reconcile.

### What the pin does not touch

`Asset.macAddress` stays the identity MAC `selectPrimaryMac` chooses. It keys the `fortigate-endpoint` AssetSource row and every MAC-based match; moving it with a pin would reopen the identity churn the hardware anchoring exists to stop. The panel's Primary Address row shows the pair the IP is on (the pin's MAC, else the address row holding the IP, else the identity MAC), which is what the operator asked to see.

### (a) IPAM is checked when the details open (2026-10-11)

The owner released and edited reservations in IPAM, opened the asset, and the Addresses list still showed the old bindings. Nothing in the reservation write paths (`reservationService`, the IP panel) reaches `AssetAssociatedIp`; only the next successful read of the gate prunes it, so between discovery runs IPAM and the asset disagree, and IPAM is the one the operator just corrected.

The owner was offered a live gate read on open and declined it: "you don't have to discover from the gate, but check it against ipam." So `GET /assets/:id` runs `assetAddressService → reconcileAddressesWithIpam` for that one asset before it reads the row. For each `dhcp-lease` / `dhcp-reservation` row it finds the narrowest IPAM subnet ON THE ROW'S GATE (`Subnet.fortigateDevice` = the row's `device`; RFC1918 space repeats behind gates) that contains the IP, and the active reservation at that IP there:

- no covering subnet → keep (an excluded range or an unimported scope is not a release);
- no active reservation → remove;
- an active reservation with a different MAC → remove (the address is someone else's now);
- otherwise re-label the kind from the reservation (`dhcp_lease` / `dhcp_reservation`, or a synced pushed manual row as a reservation).

Removals write one `asset.addresses_ipam_reconciled` Event. A read grant is enough: the check only drops or re-labels rows discovery wrote, the same rows the next gate read would settle. It never adds a row from IPAM — a reservation nobody holds is configuration, not an address (see Rejected), and adding one would flap against the next gate read. It does not touch ARP, detected-device, interface-scrape or manual rows, `Asset.ipAddress`, or a pin (a pinned pair whose row is removed shows the panel's "no longer on the list" warning, as for any quiet pin). A failure is logged and the stored list served. Order is safe against a run in flight: Phase 5 writes reservations before the address reconcile after Phase 7.5.

### Rejected

- **Per-MAC IP columns on `AssetMacAddress`.** One IP per card — wrong as soon as a card has a secondary address.
- **Pinning a card rather than a pair.** Says nothing about which of its addresses to monitor.
- **Writing every DHCP entry, held or not.** A reservation nobody holds is configuration, not an address the device has, and the readers of this table would treat it as one.
- **Treating a pinned address as operator-owned for duplicate-IP detection (rule 40).** Left out: a pinned address is a discovered binding the operator chose, current by the same `AssetIpHistory` test as any other. Revisit if a pinned pair ever needs to win a duplicate-IP card on its own.
