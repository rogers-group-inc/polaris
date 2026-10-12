# Business rule 103 — full narrative

> Written 2026-10-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 103](#rule-103) — How sure Polaris is of an address is a score the evidence earns, the operator's choice counts but cannot vouch for itself, and the score only informs
- [Rule 103(a)](#rule-103a) — a pin the network comes to back is released
- [Rule 103(b)](#rule-103b) — unpinning moves to the best-backed listed address
- [Rule 103(a) amended, (c), (d)](#rule-103c) — the contested pin, ARP as evidence, evidence that does not age while polling answers

<a id="rule-103"></a>

## Rule 103 — How sure Polaris is of an address is a score the evidence earns, the operator's choice counts but cannot vouch for itself, and the score only informs

### Where it came from

The day after rules 101 and 102 (2026-10-11). An asset now lists every address under its MACs, and an operator can pin any pair. The owner asked for a confidence score per address — weighted by the source it came from, by whether an operator configured or pinned it, and by how long the asset has polled successfully on it — shown on hover, and a warning before an operator applies an address the evidence doesn't support. The design was proposed and agreed in the same conversation; three decisions were the owner's: warn below 50 (not block), probe a typed address from the server before saving, and keep the score informational.

### The formula

Each piece of evidence contributes `weight × freshness`, freshness being `0.5 ^ (age / half-life)`. They combine as `1 − Π(1 − v)` — a noisy-OR — so corroboration adds up and the total can never pass 100, and a weak piece never drags a strong one down. Within one kind only the strongest piece counts: two gates both reporting an ARP entry is one source repeating itself, not two witnesses.

The weights are a judgement about how directly each source observes the device:

| kind | weight | half-life | why |
|---|---|---|---|
| the device's own interface table | 0.95 | 24 h | the device says it holds the address |
| detected device, online, local | 0.90 | 2 h | the gate is seeing traffic from that MAC at that address now |
| vCenter Tools guest IP | 0.85 | 6 h | the guest OS reports it through the hypervisor |
| DHCP reservation, held | 0.85 | 12 h | chosen on purpose and in use |
| DHCP lease, held | 0.70 | 12 h | in use, but the pool's choice, and it can outlive real use |
| Azure Arc network profile | 0.70 | 24 h | host-side, refreshed slowly |
| ARP entry | 0.60 | 1 h | real but short-lived — the secondary-address source |
| Generic API feed | 0.40 | 24 h | an inventory claim, not an observation (rule 100) |
| detected device, offline | 0.30 | 24 h | remembered, not seen |
| DHCP reservation configured | 0.20 | none | intent, not presence |
| polling as primary | up to 0.95 | — | `0.95 × (1 − e^(−hours/24))` |
| operator (pin, typed address) | 0.80 | none | a decision, not an observation |

A reservation is counted twice on purpose: once as configured (0.2, never decays) and once as held (decaying from `Reservation.lastSeenLeased`). Without the configured half, a reservation held three days ago would score lower than one never held at all. A reservation only counts when its MAC is one of the asset's — an address reserved for another device is not evidence for this one.

### Polling, and why the column is never cleared

The polling credit is the strongest single piece and the only one that grows with time, so its bookkeeping matters. `Asset.ipConfirmedFor` / `ipConfirmedSince` record the address Polaris's own probes have been answering on and since when. `recordProbeResult` starts a new run (`pollingRunStart`) on a successful probe when the address differs from the run's, when there is no run, or when the device is coming back from down / unknown. An agent-reported sample never touches it: the agent answering proves the host is alive, not that the address is right.

The probe write path is a batched patch whose flush keeps the old value for anything a patch leaves undefined, so clearing a column there would need a new mechanism. It doesn't need one: the run restarts on recovery, and the score simply gives no polling credit while the asset is down or when the run's address is not the current primary. Only the current primary ever earns polling credit — which is what monitoring actually exercises.

### Contradictions, not absences

A device that is down fails on every address, so a failing probe alone costs an address nothing. Two situations actively contradict an address and multiply its score down:

- **alive elsewhere (× 0.3)** — the primary is down while a gate reports this asset online, within the last hour, at a different address. That is the wrong-IP signature: monitoring is probing an address the device has left.
- **claimed elsewhere (× 0.5)** — another network-present device's primary is this address and it was seen more recently than this address's best evidence (rule 40's duplicate, read as doubt).

### Two numbers, and which one warns

A pin or a typed address is real information — the operator may know the network better than any gate — so it counts in the displayed `score`. But the warning before applying a pin or a typed address must not be satisfied by the act it is warning about. So `evidenceScore` leaves the operator out, and the check (`POST /assets/:id/address-check`) warns on it below 50. A typed address the gate has never reported scores 0 and always asks; the check also sends one ping from the server, reported beside the score — a reply proves something answers there, not that it is this device, so it is not folded into the number.

### Informational, by decision — with one act

Nothing alerts, ranks, decides the primary, or refuses a write on the score. Rule 101's ladder still picks the address; the score explains how well-supported each address is and asks before an operator applies a weak one. Turning it into an event (say, the primary's evidence dropping below 20) was offered and deferred.

<a id="rule-103a"></a>

### 103(a) — a pin the network comes to back is released

Asked for the same day, while the score was being built: "if the pinned IP's confidence exceeds the others on an asset, remove the pin". A pin exists to overrule discovery; once discovery's own evidence agrees with it, it is doing nothing but blocking the next change the network reports. It is the primary-address counterpart of the typed IP override, which already releases itself when discovery reports the same address.

The comparison could not use the displayed score, and could not use the evidence score either:

- **The operator's weight** would make every pin confirm itself the moment it was set.
- **Polling credit** is earned only by the primary — so by the pinned address. Within a day of polling it would beat every other address, the pin would release, discovery could move the asset back to the address the operator overrode, and the polling credit would follow it there. The pin would have released into exactly the state it was set to prevent.

So `discoveryScore` leaves out both, and `pinReleaseVerdict` releases when the pinned address's discovery score reaches the warn line (50) and is strictly higher than every other address the asset has. The warn line is what stops "best of a weak lot" from counting as backing: a pinned address at 40 beside one at 10 is still the operator's call.

The release clears the pin and keeps the address (it is already the one the evidence backs), names the strongest reporting gate as `ipSource`, and records `asset.primary_address.released` with both scores. It is a sweep (`jobs/releaseConfirmedPins.ts`, every 15 minutes, scheduler role) rather than a discovery hook, because the evidence arrives from several integrations on their own schedules; pinned assets are few, so the pass is one read and a batched score. The write is conditional on the pin being the one that was scored, so an operator re-pinning in between keeps their new pin.

What it does not settle: after release, rule 101's ladder decides again, and the ladder and the score weigh some things differently (the ladder prefers wired over wireless; the score does not look at the medium). Where they disagree, discovery can move the asset off the released address. That is discovery doing its job on unpinned evidence; an operator who disagrees pins again, and the warning will say what the evidence is.

### Rejected

- **A weighted average.** It lets a weak source dilute a strong one: a fresh detected device plus a stale ARP entry would score lower than the detected device alone.
- **Penalising failed polls.** Down is not wrong; only "down here while seen elsewhere" is.
- **Counting the operator in the warning score.** Every pin would pass its own check.
- **Shipping the full breakdown on the list endpoint.** At 2000 assets with several addresses each that is megabytes per page; the list carries score and band, the detail endpoint the breakdown.

### Tuning

The weights and half-lives are reasoned, not fitted. They live in one table (`EVIDENCE_KINDS`) so they can be tuned against what operators see; change them there, together with this table and the wiki's.

<a id="rule-103b"></a>

### 103(b), and the evidence gaps found the same day

The owner tried it on prod within hours, and three reports came back:

1. **"I unpinned a 92 and it went to a lower one."** Unpin re-projected the address from the AssetSource blobs, through rule 101's ladder and the projection's source order — a different decision system from the score the operator had just been reading. A 92 is also mostly the operator's own weight plus polling credit, so the comparison on screen was not like for like.
2. **"I removed every other MAC and unpinned, and it chose an address that wasn't in the list."** The same re-projection: a removed MAC takes its address rows with it (rule 79 / 102), but a source blob — the FortiGate endpoint record, vCenter, Arc — keeps the IP from its last sync until that integration runs again.
3. **"Switches score high, access points all show 0, and this AP has a polling history and the FortiManager source shows this IP."** The score read only three source kinds. Discovery keeps Fortinet infrastructure off the address list on purpose (its address is the management IP), so a switch scored only because its own SNMP interface table fills the list; an AP has no interface table and had no evidence at all. And the polling run only began at the first success after the update, so months of answers counted for nothing.

The fixes:

- **103(b): unpin chooses from the list, by the score.** `unpinPrimaryAddress` moves to the listed address with the highest `evidenceScore` — no operator weight (the pin is being removed), polling included (the address monitoring has relied on keeps that credit). Ties keep the current address. The projection decides only when the list is empty, which is exactly when there is nothing on screen to contradict it. This is a partial unification: discovery's next pass still writes rule 101's winner, so where the ladder and the score disagree the asset can still move. Making one system decide both — the score choosing the unpinned primary, with hysteresis so two close addresses don't trade places — was proposed and left for the owner to decide with real numbers in hand.
- **Every address-carrying source counts.** `SOURCE_ADDRESS_KINDS` mirrors the projection's IP rules: a source the projection would use to SET the address is evidence for it. The three Fortinet infra kinds count as `controller` (0.90, 24 h) — the controller's roster naming the IP it reaches the device on; the hypervisor workloads as `hypervisor` (0.80, 6 h); vCenter hosts join vCenter VMs; the FortiGate endpoint record counts modestly (0.50, 12 h), since it is derived from the same claims as the address rows and mostly matters for an address the list no longer carries.
- **Polling is seeded from history.** `seedPollingRuns` sets an empty run's start to the latest of: the oldest retained probe sample (credit is never claimed for time with no record), the last failed probe in a 30-day lookback, and when the address became the asset's (`AssetIpHistory.firstSeen`). One statement at startup, idempotent, reaching only rows still without a run.

Alongside, not part of the rule: the MAC list's × did nothing when the asset panel was opened from global search on another page, because its click handler was registered inside the Assets page's own init, which returns early elsewhere. It is now wired at load like the pin buttons (`tests/unit/assetPanelClickWiring.test.ts`).

<a id="rule-103c"></a>

### 103(a) amended, 103(c) and 103(d) — the contested pin, ARP, and evidence that does not age (2026-10-12)

**The contested pin.** The owner pinned a static device to its real address; "after a couple of discoveries the pin I set was removed and it changed back to what the FortiGate is reporting." The release rule had done exactly what it said: the pinned address's discovery score (ARP, 60) reached 50 and beat the other address's (a detected-device row, halved to 45), so the pin was released — and rule 101's ladder, which did not look at ARP at all, put the asset straight back on the detected address. The scores agreeing with the pin is not the same as discovery agreeing with it.

So the release now needs both. Whenever a write tries to move a pinned asset to a different address, the `db.ts` guard already puts the pin back; it now also stamps `Asset.primaryAddressContestedAt`. `releaseConfirmedPins` skips any pin contested inside `PIN_CONTEST_WINDOW_MS` (three days — longer than any sane discovery interval, so "no contest in the window" means discovery has run and agreed, not that it has not run). A pin that is the only thing holding the address where the operator put it is never released, whatever the scores say. This is the positive form of the typed override's rule, which releases when discovery reports the same address.

**The weights.** The owner: "we need to lower the weight of FortiGate/FortiManager. I would almost argue that a DHCP reservation should be scored higher than FortiGate discovery because a reservation requires human review." Detection went from 0.90 to 0.70, a held reservation from 0.85 to 0.90, a configured reservation from 0.20 to 0.40, and the FortiGate endpoint record from 0.50 to 0.40. The managed-device record's management IP stayed at 0.90: that is the controller's roster of what it manages, not an inference from traffic. Rule 101's ladder moved the same way. (The weight table near the top of this file shows the values as first shipped; `EVIDENCE_KINDS` is current.)

**103(c) — ARP.** ARP counted only when it was the source naming an address's row, because the address list keeps one source per address. The score now reads the gates' own ARP tables (`AssetArpEntry`, refreshed on the monitoring cadence for a monitored gate) by MAC: an ARP piece for any address a gate resolves to one of the asset's MACs; an `arp-elsewhere` penalty (× 0.5) on an address that rests on detection while a gate has that MAC bound to a different address; and detection counted as `detected-ambiguous` (0.20) when ARP shows the card with several addresses — the owner's "we can't trust the device report" for a card with secondary IPs. As on the ladder, a missing ARP entry is never held against an address.

**103(d) — evidence does not age while polling answers.** The owner: "freshness shouldn't halve as long as polling works." If Polaris's own probes are answering on an address, the device is demonstrably there, and the age of a gate's last report says nothing against it; a half-life there was measuring the time since the last discovery run. So an address with a live polling run has its evidence held at full weight (`sustained`) in `score` and `evidenceScore`. `discoveryScore` keeps ordinary decay: it is the number addresses are compared on for the pin release, only the primary is ever polled, and sustaining it there would hold the pinned address at full strength while every rival faded — the self-confirming pin again.

The two FortiGate half-lives were also lengthened (detection 2 h → 6 h, ARP 1 h → 4 h). Their rows are refreshed only when a gate is read and deleted when it stops reporting them, so a short half-life had been punishing a long discovery interval rather than a stale observation.
