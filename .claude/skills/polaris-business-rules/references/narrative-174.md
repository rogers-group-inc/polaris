# Business rule 174 — full narrative

> Written 2026-11-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 174](#rule-174) — SD-WAN state that nothing collects any more is let go

## Rule 174 — SD-WAN state that nothing collects any more is let go

**How it was found.** The 2026-11-11 orphan audit listed it as suspected (E.13); reading the code confirmed it. `AssetSdwanRule` holds a gate's SD-WAN service rules as CURRENT STATE: `runSdwanFor` replaces the whole set on every successful read and nothing else ever touches it. The cadence only runs for a gate that `sdwanShouldQueue` accepts — the integration pulls SD-WAN, and the gate's interfaces are polled over FortiOS REST. When that stops being true for a gate that is still monitored (the operator switches the integration's SD-WAN pull off, moves the gate's interfaces to SNMP, or deletes the integration and keeps the asset), the scheduler simply stops queueing it. The rows written on the last good read stay.

Two consequences, both permanent:

- **An alert that could not end.** An automation on `sdwanRuleStatus` reads those rows every tick. A rule that was "down" on the day collection stopped is "down" for ever, so the alert stays up; and a recovery can never be observed. The same held for the SLA conditions in a slower way: once the samples aged out of the window the gate produced no readings, and the engine parks a state whose subject reports nothing, because a collection gap is not recovery.
- **A tab that lied by omission.** The SD-WAN tab kept showing the rules as they stood. Its freshness strip turned amber, which is honest, but nothing in the UI could remove them.

**The distinction that matters.** A gate that is still polled and is failing to answer is a collection gap: the alert SHOULD stay frozen and rule 118 reports the failing stream. A gate that nothing polls any more is a configuration edge: no reading will ever arrive. The scheduler already has the predicate that tells them apart, `resolveSdwanPollIntervalForAsset` (null = nothing polls it), so both halves of the fix ask it rather than guessing from age.

**What it does.**

- `sdwanCollectionStopped` joins the vanished sweep's other carve-outs (the unpin, the tag gate, the deleted object): for an automation on an SD-WAN condition, a parked state on a gate whose poll interval resolves to null is retired through the ordinary out-of-scope path, with its Event. The resolver is injected and lazily imported, because the notification engine must not import the monitoring service at module load. A resolve that throws is read as "still polled" — it proves nothing.
- `pruneStaleSdwanRules` runs with the daily history prune: rule rows untouched for seven days, on a gate nothing polls, are deleted. Seven days because a switched-off toggle is often switched back on, and the rows cost nothing in the meantime.

**What it does not do.** It does not touch the SLA sample history, which ages out on the sample retention schedule like every time series. It does not generalise to other streams: an interface or storage alert on a device whose stream was reconfigured has its own carve-outs (the pin tests), and a general "stream no longer collected" rule would need each stream's eligibility predicate — worth doing only when one is found frozen.

**Scale.** The sweep half runs only for SD-WAN automations with parked rows: one resolve per distinct parked gate per tick, ten at a time. The prune half is one grouped read that is normally empty.

Pinned by the "rule 174" cases in `tests/unit/dimensionTargetGuards.test.ts` and `tests/integration/historyRetention.test.ts`.
