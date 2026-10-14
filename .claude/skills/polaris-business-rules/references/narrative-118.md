# Business rule 118 — full narrative

> Written 2026-10-14 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 118](#rule-118) — A poll that failed is stamped as an attempt, never as an update — and how long a stream has been failing is a reading an automation can alert on

<a id="rule-118"></a>

## Rule 118 — A poll that failed is stamped as an attempt, never as an update — and how long a stream has been failing is a reading an automation can alert on

### The incident

2026-10-14. A FortiGate 61F's System tab showed **CPU & Memory · REST API (Direct) · every
2m · updated 1m ago** over an empty chart reading "No telemetry samples in this range yet."
The operator read "updated 1m ago" as "polled successfully a minute ago" and asked why the
chart was empty. A Poll Now on the asset said why: the REST pull was refused on every poll
(`ECONNREFUSED` on the management interface's 443 — a FortiOS fault Fortinet already knew
about). SNMP on the same gate kept answering, so the response-time stream read the device
`up` and nothing anywhere said its CPU / memory stream had been dead for days.

The operator's next two questions shaped the rule: *why didn't the yellow "time since last
poll" banner appear, when it does for a failing REST interface pull?* and *can an automation
alert when polling hasn't succeeded in 60 minutes, while response time — on a different
method — is fine?*

### Why the two streams disagreed

Both stamps were written together on 2026-04-25 and both advanced on every attempt.
`recordTelemetryResult` said why in a comment: *"Always advance the cadence stamp so a
transient failure doesn't make us hammer the device every 5 s."* One column was doing two
jobs — the scheduler's due anchor and the UI's "last updated".

System info diverged in May for a reason that had nothing to do with freshness: the
`/system-info` read fetched interface rows by exact equality on `lastSystemInfoAt`, so a
stamp moved by a failed (or empty-but-200) pull pointed at a moment with no rows and the
Interfaces table went blank. The fix — stamp only on a pull that returned interfaces — made
the stamp mean "last success", which in turn made the stale banner on Interfaces, Storage and
LLDP tell the truth. Nobody was forced to look at telemetry: its chart reads a time RANGE, so
an attempt-stamp broke nothing visible; it only made the header and the banner lie.

The two compromises had opposite costs. Telemetry scheduled well (one retry per cadence) but
reported failures as successes — the incident. System info reported honestly but, with its
due anchor only moving on success, re-walked a failing device on every 30-second heavy tick
instead of once per 10-minute cadence — exactly the hammering the original comment avoided.

### The decision

Split the one column into the facts it was conflating, per stream:

- `last<Stream>At` — the last poll that returned data. Everything an operator reads.
- `last<Stream>AttemptAt` — every attempt. The scheduler reads only this.
- `<stream>FailingSince` — the first failed attempt of the open run; null when healthy.
- `<stream>LastError` — what the latest failure said, capped at 500 characters.

The failure path is one raw `UPDATE … SET "…FailingSince" = COALESCE("…FailingSince", now)`:
the run must start at its FIRST failure, and a read-then-write would race the concurrent
writers (scheduled pass, Poll Now, the refresh endpoint). The success path spreads a helper
(`telemetrySuccessStamps` / `systemInfoSuccessStamps`) rather than naming columns, because
the trap in this design is a success writer that forgets the attempt stamp: the agent push
routes stamp `lastTelemetryAt` themselves, and had they kept doing only that, every agent
host's telemetry would have read as due on every tick once the scheduler moved to the
attempt column.

System info's "no interfaces" answer counts as a failure for the run as well as for the
anchor, so the two never disagree about whether the last pull worked.

### The alerting half

Two asset-state fields, `telemetryFailingMinutes` and `systemInfoFailingMinutes`, read
whole minutes from `FailingSince` to the **last attempt** — not to now. Measured to now, a
stream that stops being attempted (the device went `warning` and heavy cadences paused, or
the method was switched off) would keep climbing into an alert about polls nobody sent. To
the attempt, it freezes where it was. A stream never attempted has no reading at all (the
`fortilinkStatus` posture), so a fleet-wide `>= 60` cannot fire on a workstation with no
telemetry stream.

The operator's "while response time is fine" needed no new condition: neither field is in
`DEVICE_DOWN_KEEPS_STATE_FIELDS`, so a device that goes `down` hands the alert to asset-down
(rule 29(i)) — one outage, one alert. Adding `Monitor status == up` to the same automation
remains available for an operator who wants it stated.

### Rejected

- **Measure from the last SUCCESS instead of the first failure.** Turning REST on for an
  asset whose stream had been off for months would read "failing for 260 000 minutes" on its
  first refused poll and page immediately.
- **A per-stream dimension on one field** instead of two fields. The builder's dimension
  machinery is per-component (interface, tunnel); a stream picker on a single Asset-column
  reading added a lockstep site for no reader.
- **Keep the old stamp and derive success from the newest sample row.** Works for the UI,
  but costs a hypertable read per asset per engine tick at 2000 assets for the alert field,
  and still leaves system info hammering failing devices.
- **Extend the split to LLDP, storage, SD-WAN and event log now.** Each has its own anchor
  with its own deliberate semantics (LLDP retries promptly on a transport failure by design;
  event log stamps up front). Out of scope for the incident; the same four-column shape is
  the pattern to copy if one of them needs it.

### Known edge

A stream switched off while its run is open keeps its frozen reading, so an alert already
firing on it stays until the run closes or the automation is changed. Rare and visible;
clearing it would need the engine to resolve every asset's polling method per tick.
