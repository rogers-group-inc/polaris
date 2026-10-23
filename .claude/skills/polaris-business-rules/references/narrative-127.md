# Business rule 127 — full narrative

> Written 2026-10-22 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 127](#rule-127) — A standalone FortiGate integration always monitors its gate

<a id="rule-127"></a>

## Rule 127 — A standalone FortiGate integration always monitors its gate

### What was there before (2026-10-22)

Every integration class carried an `addAsMonitored` flag, off by default, and the
FortiGate class on a standalone `fortigate` integration was no exception. Discovery
created the gate's asset with its address, serial, model and firmware version, then left
it `monitored = false` until an operator ticked "Enable Auto-Monitoring" on the
integration's Monitoring tab or turned monitoring on per asset.

### What surfaced it

On 2026-10-22 the lab's five standalone gates were discovered on a fresh dev stack and two
of them upgraded to FortiOS 7.6.8 by the firmware engine (rule 87). Every gate was
unmonitored. That is allowed, so the upgrade ran, but it meant Polaris had no
`monitorStatus` to judge (the `healthBlockers` down / warning / recovering arm reads
only monitored assets) and the maintenance hold had nothing to silence. Asked how the
upgrade worked without monitoring, the operator's answer was the decision: *"by default,
with the fortigate integration, let's automatically enable monitoring, since the
discovery process is basically monitoring"*. Asked to choose between the two shapes, they
said *"the standalone fortigate integration should enable monitoring automatically for
gates, the switches and APs can still be toggled."*

### The reasoning

A standalone FortiGate integration IS one gate. Discovery already holds a working REST
session to it with the integration's own token, on its own cadence, so turning on
monitoring adds no credential, no reachability question and no new device. It only stops
Polaris from discarding what it already learns. Leaving the toggle meant every new
standalone integration discovered a device it then declined to watch.

### Alternatives rejected

- **Flip the default only for new integrations.** The operator's words were
  "automatically", not "by default for new ones". A default that only reaches new rows
  leaves every existing integration's stored `false`, which reads like a decision nobody
  made.
- **Also FortiManager (the parity convention).** Offered as the recommended option and
  declined. An FMG integration can carry hundreds of gates, so turning them all on is a
  fleet-load decision (the Integrations wiki's "turning on `addAsMonitored` starts
  polling a class of devices"). The standalone integration's one-gate shape is what
  makes "always" free. This is a deliberate parity divergence; it is listed in
  `polaris-change-impact` → cross-cutting/fmg-fortigate-parity-surfaces.md.
- **A data migration rewriting stored configs.** Not needed: every reader resolves the flag
  from the integration TYPE, so the stored value cannot disagree in effect. Create and
  update still stamp `true` so the row reads honestly.
- **Removing the per-asset off switch.** An operator may still not want one particular
  gate polled. Turning it off on the asset diverges from the (now fixed) class default, so
  `recomputeMonitorOverrideForAssets` records `monitorOverride = true` and discovery's
  sweep leaves it alone, the same mechanism every other class uses.

### What it does not change

The HA-standby arm still resolves a `secondary` member to false: a standby's address is
nulled and probing it is guaranteed failure. Switches and APs behind the gate keep their
own `fortiswitchMonitor` / `fortiapMonitor` toggles, which carry SNMP direct-polling
credentials and are a real load decision at site scale.

### Validated

Against the five-gate lab on 2026-10-22: a save sending `addAsMonitored: false` stored
`true`; an operator off on SPK1 recorded `monitorOverride = true` through the new SQL arm
(before the change the loader-written config resolved to "off" and there was no
divergence); one discovery pass then monitored HUB1-a, HUB2, ISP and SPK2, left the
HUB1-b standby and SPK1 off, and left the two FortiSwitches and the FortiAP unmonitored.
