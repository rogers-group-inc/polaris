# Business rule 85 — full narrative

> Written 2026-09-23 as its own file (one file per rule from rule 78 on). Rule numbers are a
> stable citation key — never renumber. (81 is a deliberate gap; see the note at the top of
> `narrative-82.md`.)

Each rule records the decision *and the constraint that forced it*. The invariant is in
`invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 85](#rule-85) — A connectivity check measures a PATH from a host, not the host — it never moves `monitorStatus`, and the automation, not the check, says what failing means

<a id="rule-85"></a>

## Rule 85 — A connectivity check measures a PATH from a host, not the host — it never moves `monitorStatus`, and the automation, not the check, says what failing means

### What was asked for

Operators wanted to know whether a URL or service is reachable **from the machines people
sit at**, not from the Polaris server: the response time, the HTTP status or body that
comes back, and the route the traffic takes to get there — with each hop matched to a
device Polaris already monitors — and they wanted to alert on it the way they alert on
everything else: a device filter, a trigger with an SLA, and the normal actions.

The Polaris Agent was already on those machines. It had no network client for arbitrary
targets (its only HTTPS client is pinned to Polaris), no ICMP and no traceroute. Scripts
could not be a trigger, only an action. There was no device-filter field for "has the
agent".

### Why the result cannot ride the host's own stream

The agent already pushes one latency series, `responseTime`: the round trip from the host
to Polaris. That series is the input to the host's monitor state machine — it is what makes
the host `up` or `down` (`recordProbeResult({fromAgent:true})`). Feeding a connectivity
result into it would have made "this laptop cannot reach the intranet" read as "this laptop
is down", and every alert, every dependency suppression and every dashboard tile that keys
off the host's status would have started lying about the host.

So a connectivity result is its own sample (`AssetConnectivitySample`), keyed by host AND
check, and nothing in its write path touches `monitorStatus`, `consecutiveFailures`,
`lastMonitorAt` or the responseTime stream. The asset on the row is the agent host — the
thing that measured — never the target.

### Why the check carries no threshold

The first shape considered put the SLA on the check ("alert when latency > 800 ms"). It was
rejected for the reason rule 36 gives for "down": the automation already owns what a
reading MEANS. Holds counted in readings (rule 19), count windows (rule 66), severity bands,
hysteresis resets, precedence between overlapping automations (rule 18), maintenance and
dependency suppression (rules 16, 37) — all of it lives on the automation, and a threshold
on the check would either duplicate that machinery or silently bypass it. The check says
what to measure and from where; an automation on the `conn*` metrics says what measuring it
badly means and who hears about it. Two automations can watch one check with different
SLAs, and editing an SLA never restarts the measurement.

The same reasoning is why the check is a standalone entity rather than a field of an
automation: history and charts survive an automation being edited or deleted, and two
automations on the same URL do not probe it twice.

### Why the excerpt policy is enforced at ingest

An HTTP check reads a response body. A body can carry a session token, a user's name, an
internal hostname — anything. Storing every body from every agent on every run would make
the database a copy of whatever the fleet's targets say, which is not what was asked for.
So the hash and the byte count are always kept (enough to notice the body CHANGED), and a
≤4 KB excerpt only when the run FAILED (so the operator can see what came back instead) or
when the operator explicitly asked for it on that check. The agent applies the same rule
before sending, but the server re-applies it: an agent is a remote process and a policy it
alone enforces is a policy one bug or one tampered binary removes.

The same distrust decides WHO a sample is about. The subject is always the pushing agent's
own asset (from its bearer), and a sample naming a check that host is not a source of is
rejected and counted, never stored — a stolen bearer cannot write results under another
check.

### Why rule 33's exemption does not carry over

The vendor HTTP check (rule 33) skips `netGuard` because its target is the monitored
device's own address. A connectivity check's target is chosen by an operator and then
contacted by every matching agent on a schedule — the case the guard exists for. So the
literal host is refused at save for loopback, link-local (including cloud metadata),
unspecified, multicast and IPv6 (v1 is IPv4-only); credentials in the URL are refused
(the check sends no authentication); and Polaris's own names and addresses are refused,
because the agent's responseTime stream already measures that path and a fleet of agents
aimed at the server on a schedule is a load generator. The agent refuses the same ranges
again AFTER resolving the name, which is what catches a hostname pointed at 127.0.0.1.
RFC1918 stays allowed — checking internal services is the point.

A check is also a separate permission (`connectivityChecks`), for the reason `networkScan`
is: directing hundreds of agents to send traffic at a destination is a capability an admin
may want to withhold from someone who may still edit automations. It is not remote code
execution (the agent runs a fixed, validated probe, never operator code), so it is not
`automationScripts`.

### Why hops are resolved at write time, and a path change is an Event

A traceroute is a list of IPs. Its value to an operator is "the path goes through
BRANCH-FW port internal1, then CORE-01" — which needs each hop matched to an asset and a
subnet. Doing that at read time would re-resolve thirty addresses every time a tab opens,
and would describe the path in terms of TODAY's inventory rather than the inventory when
the trace was taken. So `resolveHopContexts` resolves every hop in a push in ONE query
(primary address, then associated/interface address with the port name, then the most
specific subnet) and the decoration is stored on the row.

A path is not a status: two equal-cost paths are both healthy, and a route that moved is
news, not an outage. So a changed hop sequence is an audit Event (`connectivity.path_changed`,
naming the host so an event automation's device filter applies to it — rule 46), rate-
limited to once per ten minutes per host and check so ECMP flapping is recorded in the rows
rather than in the Event table. The hash ignores RTTs and trailing silent hops, so the same
route at a different latency, or timing out two TTLs later, is not a change. The first
trace — and the first after the target is edited — is a baseline, never a change.

### Alternatives rejected

- **Scripts as triggers.** Scripts are RCE-equivalent and free-form; making their exit code a
  trigger would have given every SLA an interpreter and no structure to chart. A fixed probe
  with a declared result shape is safer and is what the charts and the hop table need.
- **A CAP_NET_RAW privilege tier.** Raw ICMP on Linux needs it, and it would have meant a
  reinstall on every host. Traceroute uses UDP probes with `IP_RECVERR` (the tracepath
  method) and ICMP echo uses a datagram ICMP socket, which works wherever
  `ping_group_range` allows; where it does not, the sample says so with a distinct error
  rather than reading as "down" (rule 71).
- **Traceroute on every run.** ~90 probes a minute per agent for a 30-hop path. It runs
  every Nth run (default 5) and immediately on a pass→fail transition, so a failure always
  has a fresh path and a baseline to compare it with.

### Rule 85 — the invariant as stated in full

See `invariants-30-43.md` → 85. The implementation is `connectivityCheckService.ts` (the
check, its validation and membership), `connectivityIngestService.ts` (the two streams),
the `conn*` metrics in `notificationTypes.ts` / `notificationEngine.ts`, and the agent's
`agent/internal/collectors/connectivity*.go`.
