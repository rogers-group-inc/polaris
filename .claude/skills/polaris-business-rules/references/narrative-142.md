# Business rule 142 — full narrative

> Written 2026-11-06 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 142](#rule-142) — Discover Now on a FortiGate is that gate's full discovery: every finalize phase runs, each narrowed to the gate

<a id="rule-142"></a>

## Rule 142 — Discover Now on a FortiGate is that gate's full discovery: every finalize phase runs, each narrowed to the gate

**What prompted it (2026-11-06).** A site swapped a FortiSwitch. The operator ran Discover Now
on the switch's FortiGate; the new switch's asset appeared, its trunk interfaces and LLDP
neighbours were visible, and the dependency tree did not change. The scoped run's finalize
(`finalize-scoped`) ran Phase 2b only. Phase 12 — `recomputeDependencyTree`, the only writer of
`source="computed"` parent rows apart from the one-shot startup backfill — was gated to
`full | finalize`, so the swapped switch waited up to a full poll interval to be parented.
The owner's call: *"I want a Discover Now on a gate to essentially do the main integration's
discovery, but just for that gate and its devices, switches, access points, networks, all
that stuff."* And the boundary: *"a Discover Now wouldn't update cpu/memory, response time,
hardware sensors, interfaces, lldp neighbors, mac table or any of the other 1, 2, 10 minute
cadence polls. Discover Now does the other stuff."*

**Why the phases were off.** They were excluded together under one reason — "fleet-wide
reconciles owned by full runs" — that only some of them deserve. Phase 2 / 2a / 2b's orphan
clause read the roster, and a scoped result carries one device. The rest read the database or
the run's own result, and were off only because nobody had narrowed them.

**What each phase does in a scoped run.**
- **2 (deprecate networks of gates that left the roster)** — never. The scoped gate is on the
  roster by construction (the FMG service throws otherwise), so it has nothing to say.
- **2a (stale firewalls)** — judges only firewall assets carrying the scoped gate's FMG device
  name or hostname (`firewallNamedForScopedGate`, keyed on `clusterSerialsByDevice`, which a
  scoped run fills with exactly that gate). Only the `replaced` verdict (rule 41(a)) acts: a
  gate RMA'd under the same name retires its old chassis on the click. `stale` would mean the
  scoped gate is absent from the roster — impossible — and its cascade keys on a name, so it
  is never reached. `knownDeviceSerials` is the whole roster's (read before the roster is
  narrowed), so an HA member or a chassis now registered elsewhere still reads `keep`.
- **2b (switches / APs gone from their controller)** — unchanged: it was always per-controller.
  Its orphan clause, which judges children of gates OTHER than the ones read, is held off
  (`rosterJudgeable` excludes `finalize-scoped` explicitly now that 2a runs there).
- **2c (interface auto-monitor apply)** — `applyAutoMonitorForClass(…, onlyAssetIds)` with the
  gate's infra set, so a swapped-in switch gets its trunk pins on the click.
- **8 / 9 (PTR lookup, OUI lookup + overrides)** — over `scopedFinalizeAssetIds(result,
  assetIdx).all`: the gate and its HA members, its switches and APs by serial, and every
  endpoint the gate reported this run by normalized MAC (DHCP entries, device inventory, ARP,
  the switch MAC tables). Fleet-wide there would be thousands of lookups on a click.
- **12 (dependency tree)** — runs as-is. It reads the database, not this run's result, and
  the gate's per-device pass has already landed; its writeback is integration-scoped as on a
  full run. The cost is a full recompute's, once per click.
- **13 / 13.65 (region tags, criteria tags)** — run as-is: DB-wide, idempotent, and what tags
  the new switch.
- **13.6 (management access)** — already reads only the devices in `result`.
- **13.7 (description sync)** — `runDescriptionSyncForIntegration(…, onlyDevices)` keeps only
  the gate's group, and the central-DB heal sees only that group's assets.

The finalize also runs now when the gate's switch and AP reads both came back empty: 2b then
no-ops itself, and the rest still owe the operator their answer.

**Not part of it.** Discover Now is discovery, not monitoring: CPU / memory, response time,
hardware sensors, interfaces, LLDP neighbours and MAC tables stay on their own cadences. The
dependency tree is rebuilt from what those polls last stored — the LLDP rows the operator
already saw on the new switch. Scoped runs still skip `Integration.lastDiscoveryAt`, so the
scheduler's next full run is not delayed.

**Rejected:** running the full fleet finalize on a scoped click. Phase 2 and the roster sweeps
would judge a one-device result, and 8–9 / 13.7 would do every gate's work (and every gate's
FortiOS reads) for one.
