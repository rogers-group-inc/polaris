# Business rule 103 — full narrative

> Written 2026-10-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 103](#rule-103) — How sure Polaris is of an address is a score the evidence earns, the operator's choice counts but cannot vouch for itself, and the score only informs
- [Rule 103(a)](#rule-103a) — a pin the network comes to back is released

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
