# Business rule 70a — full narrative

> Written 2026-11-12 as its own file (one file per rule from 78 on; rule 70's own narrative is in
> `narrative-60-64.md`, which is at its size ceiling). Rule numbers are a stable citation key —
> never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 70a](#rule-70a) — A machine gone from Azure Arc is decommissioned by the same sweep, judged one subscription at a time

## Rule 70a — A machine gone from Azure Arc is decommissioned by the same sweep, judged one subscription at a time

**How it was found.** The 2026-11-11 orphan audit (B.3, and the open half of B.2). Every other directory-like source had a disappearance sweep by then: vCenter, Active Directory, Entra / Intune, the workload hosts, the Generic API. Azure Arc had none, on purpose — its sync was audited on 2026-09-08 as "no fleet-absence passes" because an Arc agent's `Disconnected` status is a reachability fact and mapping it to a lifecycle state would decommission a fleet during an outbound-proxy outage. That reasoning is right about STATUS and says nothing about a machine RESOURCE that has been deleted from Azure. So a server removed from Arc:

- kept its `arc` source row for ever, still feeding the asset's projected hostname, OS and serial, and still counting as "claimed", so nothing else could ever age the asset out either;
- kept its `azure:` tags — which operators are blocked from removing, because the prefix belongs to the Arc sync — in filters, tag-scoped permissions and automation scopes.

**The decision.** Give Arc rule 70's sweep, not a new one. The shared `sweepDirectoryAbsence` already carries the three guards and the ownership rule, and one sweep for every directory is what stops them drifting apart. Arc supplies only what is Arc's: its evidence of what was read.

**What had to be added, and why.**

- **The raw set.** `discoverMachines` filtered before returning, so "not in the result" meant "deleted, or excluded by a resource-group / name / tag filter, or disconnected with `includeDisconnected` off". The result now carries `absence.machineIds`: every machine Azure returned, snapshotted before any of that. A filter edit therefore reads as "configuration changed", never as "the machines were deleted" — rule 70's point (b), for Arc.
- **The subscription guard.** This is the part rule 70 did not have. Arc reads many subscriptions with one app registration. If that registration loses Reader on ONE of them, the read is complete, non-empty and well-formed, and simply has none of that subscription's machines. Rule 70's scale guard refuses a loss over `max(50, 20%)` — and a subscription can hold five machines. So the evidence records which subscriptions were read in full (`subscriptionsRead`: all of them when Resource Graph answered; each one that succeeded on the per-subscription fallback), and a source row is judged only when the subscription in its own ARM id is in that list. Anything else is alive. The shared sweep gained an optional `inScope` predicate per kind for this; AD and Entra do not use it.
- **Clusters are their own kind.** Connected Kubernetes clusters are read by a separate, optional query. `absence.clusterIds` is null whenever that query did not run or did not finish, and a null kind leaves every one of its rows alive — rule 70's "not read is not the same as not there".
- **Refusals.** `arcSweepBlockedReason` refuses a scoped run (the asset panel's "Discover Now" reads one machine), a cancelled or capped read, a read where no subscription could be read, an empty read, and a result with no evidence at all.

**What Disconnected still means.** Nothing, to this sweep. A disconnected machine is still a resource in Azure, so it is in the raw set and is alive whatever `includeDisconnected` says. The 2026-09-08 reasoning stands; this rule sits beside it.

**The tags.** When a row goes, the asset's `azure:` tags go with it, provided no other Arc row still describes the asset. That happens whoever manages the asset: the tags mirrored a resource that no longer exists, and they are the one thing here an operator cannot clean up by hand. It runs before `syncAzureTagRegistry`, so a tag no asset carries any more is dropped from the registry in the same sync. The `arc-…` state tags (`arc-disconnected` and the like) are left; they are rewritten by the machine sync and are not operator-locked.

**What it does not do.** It is opt-in and off by default, so no install changes behaviour on upgrade; off, the stale rows stay too (rule 70's reasoning: deleting them is the same judgement in a smaller hat). It does not handle an Arc integration that is DISABLED rather than deleted — a disabled integration runs no sync, so there is no read to judge by.

**Scale.** No new Azure calls: the evidence is collected from reads the discovery already makes. The sweep is rule 70's — one read of this integration's source rows, partitioned in memory, deletes in chunks of 500.

Pinned by `tests/integration/arcAbsenceSweep.test.ts`.
