# Business rule 94 — full narrative

> Written 2026-10-07 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 94](#rule-94) — A workload Polaris restarts or updates is held, one Polaris stops is paused until Polaris starts it, and every attempt is on the record

<a id="rule-94"></a>

## Rule 94 — A workload Polaris restarts or updates is held, one Polaris stops is paused until Polaris starts it, and every attempt is on the record

### The ask

2026-10-07. The operator asked for Unraid and TrueNAS SCALE integrations that discover the
host, its VMs and its containers, chart their usage and track up/down — and, asked whether they
should stay read-only, chose to "include start/stop/restart, also include check for updates and
give the ability to perform an update". That makes Polaris the cause of the downtime it is
monitoring, which is the same situation rule 80 (agent operations) and rule 87 (firmware
flashes) already settled: Polaris must not page anyone about an outage it caused on purpose.

### Restart and update take a hold, for the length of the call

`services/workloadActionService.ts` opens a rule-80 maintenance hold — `workload-restart`
(TTL 10 min) or `workload-update` (TTL 30 min: an image pull and recreate, or a TrueNAS App
upgrade with its own migrations) — BEFORE it calls the platform, and releases it when the
platform reports the action finished, success or failure, in a `finally`. Both platforms'
calls return only when the action is done (Unraid's mutations; TrueNAS's jobs, polled to a
terminal state), so "released on completion" is "released once the workload is back or has
definitively failed". The TTL is the cap for the path where nothing releases it — a process
that died mid-call. As with every hold, nothing is taken on an unmonitored asset.

### Stop pauses monitoring — it does not take a hold

A stop is the operator saying "this is meant to be off", for as long as they like. A hold has
a TTL by design (rule 80: the cap is what keeps a forgotten hold from silencing a device
forever), so a held stop would start paging the moment the TTL ran out, on a workload that is
exactly where the operator left it. Instead a stop sets `monitored = false`, recomputes the
override (so discovery's auto-monitor sweep respects it as an operator pin), and stamps
`Asset.virtualization.monitoringPausedByStop = true`. The workload sync rewrites that blob
every run, so it carries the flag forward explicitly. A start from Polaris clears the flag and
sets `monitored = true` again — and ONLY when the flag is there: a workload an operator
unmonitored by hand stays unmonitored when someone starts it. The stop dialog lets the operator
opt out of the pause (they want the down alert); default on.

### The handle is read fresh; the state decides what is offered

The platform handle comes from a fresh read of the host (the snapshot cache dropped first),
never from the source row: an Unraid container's id changes on every recreate and every image
update, so the one stored at the last discovery may already point at nothing. The same read
decides which verbs are legal (`allowedVerbs`): start unless running, stop when running or
paused, restart when running, update only for a container the platform says has one waiting.
Anything else is refused with 409 BEFORE any hold is taken. The host is never a target — the
actions are for VMs and containers / Apps.

### Every attempt is an Event

`asset.workload.<verb>` for a refusal (warning), a platform failure (error, with the
platform's reason) and a success (info, with the duration and whether monitoring was paused or
resumed). A stop/start that moved `monitored` says so in the message, so the asset's history
explains why it went quiet.

### Gate: `assets:write`, not a new key

The plan proposed a dedicated `workloadControl` key. It was not added: the firmware routes
record the operator's decision of 2026-09-26 that "whoever may edit an asset may upgrade it" —
a flash, which reboots a switch and everything behind it, is `assets:write`. Restarting a
container is a smaller act than that, so it takes the same gate; reading the live state is
`assets:read`. A separate key would have been a grant no existing role could derive without a
judgment call, for an act the catalogue already places.

### What this rule does not do

- No action on the host (no reboot / shutdown of the NAS). Out of scope.
- No scheduled actions. A workload action runs now or not at all.
- An update is "the newest the platform offers" (Unraid's image digest; TrueNAS's latest
  catalog version, or a pull + redeploy for a custom App) — Polaris does not choose versions.
- No action on a Proxmox VE guest (the third workload platform, 2026-10-09). That integration
  authenticates with a PVEAuditor token and is monitored read-only:
  `workloadActionService.platformHasActions` is true for Unraid and TrueNAS only, so a Proxmox
  guest's status answers `verbs: []`, `runWorkloadAction` / `checkWorkloadUpdates` refuse it
  with 400 before any hold or platform call, and the asset card says so instead of offering
  buttons.
