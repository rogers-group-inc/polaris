## cross-cutting/fortinet-infra-dhcp-binding

**What it is:** `Reservation.dhcpBinding` (`null` | `"lease"` | `"reservation"`) — whether the FortiGate actually has a MAC→IP reserved-address entry for an address, held SEPARATE from `sourceType` (which says who owns it). Exists because Phase 3a/3b create a `fortiswitch`/`fortinap` reservation for every managed switch/AP — including ones whose address they read out of the gate's own lease table via the `dhcpByHostname` fallback — so a dynamically-leased AP presented as an authoritative reservation with no Reserve action while the gate reported it `Not Reserved`. See business rule 23.

**Writers** (files that mutate or emit this state):
- `src/utils/infraDhcpBinding.ts` — the pure decisions: `decideInfraDhcpBinding` (patch-or-null), `isLeaseBackedInfraRow` (claimable?), `reservationBelongsToInfraDevice` (is this row this device's?), `isInfraSourceType`. No Prisma, no device I/O; fully unit-tested in `tests/unit/infraDhcpBinding.test.ts`.
- `src/services/discovery/discoveryEngine.ts` (`syncDhcpSubnets`, Phase 5 infra branch) — the ONLY writer of `dhcpBinding`. Applies `decideInfraDhcpBinding`'s patch to an existing fortiswitch/fortinap row, writing only when it returns non-null, and counts `pathExistingInfraBindingChange` / `pathExistingInfraNoChange` (before this branch the source types matched nothing and fell through with no counter, so the phase summary's "path-* counters sum to entriesTotal" was false for every managed switch/AP).
- `src/services/discovery/discoveryEngine.ts` (Phase 3a/3b) — gates the `manual`-row conflict raise on `!reservationBelongsToInfraDevice(...)`, so an operator's own reservation for an AP isn't reported as colliding with that AP.
- `src/services/reservationService.ts` — `isSupersedableByCreate` admits lease-backed infra rows; `releaseSupersededDhcpLeaseAt` releases whichever row it admitted.
- `src/services/reservationService.ts:releaseInfraReservationsForAssets` — the device-lifecycle release. Resolves reservations from the asset's `ipAddress`, judges each with the pure `shouldReleaseInfraReservation` (scope + ownership), and delegates to `releaseReservation` so unpush + lease-expiry + audit all come for free. Bounded at `INFRA_RELEASE_CEILING` (100) per invocation with `deferred` reported; never throws.
- `src/services/reservationService.ts:reconcileOrphanedInfraReservations` — the backstop sweep behind `jobs/reconcileInfraReservations.ts`; verdict per row from the pure `classifyOrphanInfraRow`.
- Call sites (all pass ONLY switch/access_point ids): `discoveryEngine.ts` Phase 2a controller cascade + Phase 2b stale-infra sweep; `api/routes/assets.ts` `DELETE /:id`, `DELETE /` (bulk), and the `applyAssetUpdateSideEffects` operator-decommission branch; `jobs/decommissionStaleAssets.ts`.
- `src/services/infraReservationPushService.ts` — the OPT-IN auto-push (`config.pushReservations` AND `config.autoReserveFortinetInfra`, both required, `integrationPushEnabled` re-checked server-side). Post-sync pass in `runDiscovery`, deliberately after the Phase 5 branch that refreshes `dhcpBinding`. Eligibility is the pure `isInfraPushCandidate`; on success it stamps the push pointers + `dhcpBinding="reservation"`, on a PERMANENT failure it stamps `pushStatus="failed_permanent"` + `pushError` (which both removes the row from the candidate set and surfaces the device's own message in the IP panel), and on a transient failure it leaves the row for the next cycle.
- `src/api/routes/integrations.ts` — `autoReserveFortinetInfra` on BOTH `FortiManagerConfigSchema` and `FortiGateConfigSchema` (parity).
- `public/js/integrations.js` — the nested checkbox in `reservationPushFormHTML` (+ `_readAutoReserveInfraToggle` at the create/edit collect sites, and `syncAutoReserveInfraEnabled` as an inline onchange so the child enables/disables with its parent).
- `src/services/placeholderMacAdoptionService.ts` — the OPT-IN placeholder-MAC adoption (`config.pushReservations` AND `config.adoptDiscoveredMac`, both required, `integrationPushEnabled` re-checked server-side). Discovery **Phase 7.7**, immediately after 7.6 because it consumes the same `result.arpTable` / `result.deviceInventory`. Pure parts: `buildMacEvidenceIndex` (the `(device, ip)` → MAC merge + precedence) and `isAdoptionCandidate` (eligibility). Writes through `updatePushedReservation`, never a bare `prisma.reservation.update`, so the gate is corrected and read-back-verified BEFORE Polaris changes. Stamps `pushStatus="failed_permanent"` + `pushError` on a permanent refusal (same anti-retry marker the auto-push uses).
- `src/services/reservationMacService.ts` — sole owner of the `reservationMacPlaceholder` Setting (the prefix). Read by the adoption pass and by `subnetService.getSubnetIps` (which hands it to the browser for the Generate button).
- `src/services/discovery/discoveryEngine.ts` (Phase 6 reservation cross-update) — now SKIPS the `macAddress` overwrite for rows carrying `pushedToId`/`pushStatus`. It has no device write behind it, so rewriting a pushed row's MAC diverged Polaris from the gate with nothing to reconcile it; it would also have stripped the placeholder before Phase 7.7 could act on it.
- `src/api/routes/integrations.ts` — `adoptDiscoveredMac` on BOTH `FortiManagerConfigSchema` and `FortiGateConfigSchema` (parity).
- `public/js/placeholder-mac.js` — the ONE generator (`window.PolarisPlaceholderMac`), shared by `ip-panel.js` and both mobile surfaces; loaded by ipam.html / subnets.html / mobile.html.

**Readers** (files that consume it):
- `src/services/subnetService.ts` (`toReservationDto`) — surfaces `dhcpBinding` on the IP-panel payload.
- `public/js/ip-panel.js` (`_isLeaseBackedInfra`) — "FortiAP (lease)" / "FortiSwitch (lease)" pill + tooltip, the Reserve button (reusing `ip-lease-reserve-btn`), and the supersede wording in `_openLeaseReserveModal`.
- `public/js/mobile/subnet-detail.js` — same predicate inline for the mobile row actions.

**Invariants:**
- `sourceType` is NEVER flipped by this branch. Ownership is a separate fact, and Phase 5b's sweep exclusion + Phase 2b decommission semantics both key on it.
- `expiresAt` is NEVER stamped on an infra row. A lease carries an expiry; stamping it hands the row to `expireReservations`, which would expire a live AP's row on the gate's lease clock and let discovery re-create it — churn plus windows where the device reads as unreserved.
- `macAddress` is fill-only and comes from the DHCP entry, never from `ap.baseMac` / `sw.baseMac`. Only the MAC the gate saw requesting the address can be bound by a future MAC→IP push; a base MAC that isn't the DHCP client MAC yields an entry that looks correct on both sides and never binds.
- `null` is NOT "free". It means no DHCP data has ever been observed for the address (a statically-addressed AP, or one not currently leasing), and such rows stay authoritative.
- Releasing a lease-backed infra row must stay a pure DB release. It has no push pointers and its `sourceType` isn't `dhcp_reservation`, so neither unpush branch fires, and the gate-lease-expiry branch keys on `dhcp_lease` — claiming an AP's address must not bounce its lease.
- The client predicates in `ip-panel.js` / `mobile/subnet-detail.js` must stay in lockstep with `isSupersedableByCreate`; a Reserve button the server would 409 is worse than no button.

- Both delete routes must release BEFORE `prisma.asset.delete`. The release resolves the reservation from the asset's `ipAddress`, which is unreadable once the row is gone.
- Release call sites filter to `switch`/`access_point` themselves. The helper's ownership predicate would also match a Polaris-pushed reservation on a server, and a status change or delete on an ordinary host must not quietly unpush an operator's binding.
- "No longer discovered" is NOT a release trigger. An offline AP stays in its controller's CMDB roster, and business rule 16 already establishes that roster absence is config truth rather than reachability — the release hangs off the existing decommission decision so one bad FMG query can't strip a fleet's worth of bindings.
- The orphan reconcile releases a PUSHED row only on an explicitly decommissioned device. "No asset found" is a transient discovery state as often as it is a real orphan, and acting on it would write to a live gate.

- The auto-push writes DHCP config to production devices on a SCHEDULE, which nothing else in Polaris does. It stays double-gated, bounded per cycle (`RUN_CEILING`), MAC-from-lease-only, read-back-verified, and never retries a row that already carries push state. Loosening any one of those needs a deliberate decision, not a refactor.
- The auto-push only ever pins an address the device is ALREADY holding by lease, so it cannot change pool occupancy. If it is ever extended to claim free addresses, the pool-capacity question that was deferred (Polaris has no `dhcpStart`/`dhcpEnd` and no subnet-utilization alerting) has to be answered first.

- Adoption may overwrite a MAC ONLY when the stored one matches the placeholder prefix. That single condition is what makes an unattended overwrite of a production DHCP binding defensible; an operator-typed MAC is never touched, whatever discovery saw.
- The placeholder prefix must stay locally-administered unicast (`normalizePlaceholderPrefix` enforces it). A vendor OUI would put real devices' factory MACs inside the placeholder space and hand adoption permission to rewrite them.
- An observed MAC that is ITSELF a placeholder is never adopted. Besides being meaningless, this is what keeps the documented `02` legacy prefix safe: a genuine KVM/Docker/FortiOS-HA device presents its own `02:` MAC in ARP, so its row reads as placeholder-observed and is skipped rather than churned every cycle.
- Adoption is bounded per RUN, not per call. `syncDhcpSubnets` runs once per managed FortiGate in FMG mode, so the budget object is created in `runDiscovery` and threaded through every gate; a ceiling held inside the phase would become ceiling × gate-count writes per cycle. **That per-gate fan-out is a standing trap for any state that means something only across gates, and there are now two instances of the pattern** — this budget, and the DHCP claim ranking's `DhcpClaimState` (cross-cutting/asset-source-projection; `src/utils/dhcpClaimFreshness.ts → createDhcpClaimState()`), which was declared inside the function and so silently degraded the ranking to last-gate-to-finish-wins until 2026-09. Before adding run-level state to that function, thread it from `runIntegrationDiscovery` rather than declaring it inside — and note that the FMG run's closing call cannot be the repair, since it uses mode `"finalize"` and Phases 3–7 are gated to `"full" | "skip-deprecation"`.
- Exactly one code path may change a PUSHED reservation's MAC. Phase 6 is excluded by design — if a second push-less writer is ever added, the divergence it caused before this change comes straight back.

**Change checklist:**
- [ ] Adding a source type that discovery auto-creates for a device? Decide whether it needs a binding fact too, and whether `INFRA_SOURCE_TYPES` should grow.
- [ ] Adding a path that decommissions or deletes a switch/AP? Call `releaseInfraReservationsForAssets` from it — the reconcile will converge it eventually, but only after up to 6 hours.
- [ ] Touching the auto-push? Re-read the SAFETY block at the top of `infraReservationPushService.ts` first; every clause there is load-bearing.
- [ ] Touching adoption? Re-read the SAFETY block at the top of `placeholderMacAdoptionService.ts` first — same posture, every clause load-bearing.
- [ ] Adding another MAC-generation call site? Use `window.PolarisPlaceholderMac.generate` — the two hand-rolled copies this replaced are why the mobile edit sheet had no Generate button at all.
- [ ] End-to-end check after any change here: reserve an IP with a generated MAC on a push-eligible subnet, confirm the entry on the gate, bring a device up at that IP, run discovery, then verify Polaris AND the FortiGate both show the real MAC and a `reservation.mac.adopted` Event names both.
- [ ] Touching the Phase 5 existing-row chain? Keep the infra branch BEFORE the fall-through `continue`, and keep exactly one path counter per processed entry.
- [ ] Widening the takeover set? Change `isSupersedableByCreate` only, then mirror it in both client predicates.

---

---

### The VIP case (business rule 77)

`dhcpBinding` gained a second kind of row in 2026-09. A `vip` reservation is the other
authoritative row that can sit on an address the gate is ALSO serving over DHCP, and it had
nowhere to say so: Phase 5's VIP branch fills a MAC and raises a fill-only conflict but writes
no binding, so the IP panel said "VIP" and an operator could not learn a client was holding
the address too. `vipInfo` is the third column in the same split — `sourceType` says who owns
the address, `dhcpBinding` says how the gate hands it out, `vipInfo` says what the gate
translates for it — and no surface may collapse them.

**Writers:**
- `src/utils/vipAddressFacts.ts` — the pure decisions: `parseVipRow` (one reader for all three
  `firewall/vip` encodings), `vipIpRoles`, `vipInfoSnapshot` / `vipInfoDiffers` (the only
  comparison allowed to trigger a write), `decideVipDhcpBinding` (patch-or-null, and
  `decideInfraDhcpBinding`'s three omissions kept verbatim). No Prisma, no device I/O; tested
  in `tests/unit/vipAddressFacts.test.ts`, which also pins its Virtual Server classification
  against `fortimanagerService.parseVipServerInfo`.
- `src/services/subnetRefreshService.ts` — the per-subnet Discover pass: stamps `dhcpBinding`
  onto a `vip` row from the DHCP view, stamps/creates `vipInfo` from the gate's VIP table, and
  clears / converts / releases a VIP the gate no longer reports (scoped to snapshots naming
  THIS gate). The VIP read is settled, never awaited alongside the DHCP reads.
- `src/services/reservationService.ts` — `isSupersedableByCreate` admits `vip`;
  `releaseSupersededDhcpLeaseAt` releases it with no device I/O and returns its `vipInfo`;
  `persistReservationRow` stamps that onto the operator's new row.
- `src/services/discovery/discoveryEngine.ts` (Phase 3c `manual` branch) — stamps rather than
  raises a conflict when the row already names this same VIP, the `reservationBelongsToInfraDevice`
  pattern applied to VIPs.

**Readers:**
- `src/services/subnetService.ts` (`toReservationDto`) — surfaces `vipInfo` (and the four push
  columns, which it had also been withholding) on the IP-panel payload.
- `public/js/ip-panel.js` (`_ipStatusPresentation` / `_ipAllocationPresentation`) — the composed
  "VIP / Leased" pill, the VIP badge beside the hostname, the Reserve button on a `vip` row and
  the supersede wording in `_openLeaseReserveModal`. The PDF and CSV exports call the same
  function, so a record that leaves the screen cannot disagree with the table it left.

**Invariants:**
- A `vip` row's `sourceType` is flipped ONLY by a succession path — one that has seen the gate
  stop reporting the VIP. `decideVipDhcpBinding` never flips it, and neither does the DHCP loop.
- A VIP table that could not be READ skips every VIP decision. "Could not read" and "there are
  none" are opposite facts, and collapsing them retires every VIP on the subnet.
- `interface_ip` is NOT claimable and never joins this set. Only `vip` parts company with it.
