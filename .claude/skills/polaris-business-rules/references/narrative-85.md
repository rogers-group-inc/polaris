# Business rule 85 — full narrative

> Written 2026-09-23 as its own file (one file per rule from rule 78 on). Rule numbers are a
> stable citation key — never renumber. (81 is a deliberate gap; see the note at the top of
> `narrative-82.md`.)

Each rule records the decision *and the constraint that forced it*. The invariant is in
`invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 85](#rule-85) — A path check measures a PATH from a host, not the host — it never moves `monitorStatus`, and the automation, not the check, says what failing means
  - [The Polaris server as a source (2026-09-30)](#rule-85-server-source)
  - [The Path Monitor trigger type (2026-10-05)](#rule-85-path-monitor-trigger)

<a id="rule-85"></a>

## Rule 85 — A path check measures a PATH from a host, not the host — it never moves `monitorStatus`, and the automation, not the check, says what failing means

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
the host `up` or `down` (`recordProbeResult({fromAgent:true})`). Feeding a pathCheck
result into it would have made "this laptop cannot reach the intranet" read as "this laptop
is down", and every alert, every dependency suppression and every dashboard tile that keys
off the host's status would have started lying about the host.

So a path-check result is its own sample (`AssetPathCheckSample`), keyed by host AND
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
what to measure and from where; an automation on the `path*` metrics says what measuring it
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
device's own address. A path check's target is chosen by an operator and then
contacted by every matching agent on a schedule — the case the guard exists for. So the
literal host is refused at save for loopback, link-local (including cloud metadata),
unspecified, multicast and IPv6 (v1 is IPv4-only); credentials in the URL are refused
(the check sends no authentication); and Polaris's own names and addresses are refused,
because the agent's responseTime stream already measures that path and a fleet of agents
aimed at the server on a schedule is a load generator. The agent refuses the same ranges
again AFTER resolving the name, which is what catches a hostname pointed at 127.0.0.1.
RFC1918 stays allowed — checking internal services is the point.

A check is also a separate permission (`pathChecks`), for the reason `networkScan`
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
news, not an outage. So a changed hop sequence is an audit Event (`path_check.path_changed`,
naming the host so an event automation's device filter applies to it — rule 46), rate-
limited to once per ten minutes per host and check so ECMP flapping is recorded in the rows
rather than in the Event table. The hash ignores RTTs and trailing silent hops, so the same
route at a different latency, or timing out two TTLs later, is not a change. The first
trace — and the first after the target is edited — is a baseline, never a change.

### Why the failure rate takes no saturation ceiling (2026-09-25)

`pathFailurePct` is a windowed ratio, and it was first wired through the same resolver shape
as `probeLossPct` — including rule 29's `ignoreAtOrAbove` ceiling, which defaults to 100.
For packet loss that ceiling is right: 100% loss IS an outage, the down automation owns it,
and a loss alert beside the down alert is the duplicate rule 29 exists to stop. A path check
has no such owner. The host is up and is the one reporting; every run to the target failing
is the headline case ("the ERP is unreachable from this site"), and nothing else alerts on
it. Under the inherited default a total outage of the target never fired, and a live
failure-rate alert CLEARED (`system:reading-saturated`) as the rate climbed to 100%.

So the ceiling is now scoped by metric, not by "is a windowed ratio":
`SATURATION_CEILING_METRICS` (`notificationTypes.ts`, `["probeLossPct"]`) is what
`readingAtOrAboveCeiling` checks, a stored `ignoreAtOrAbove` on any other metric is inert,
the `pathFailurePct` resolver does not consult it, and the wizard offers and saves the
"Ignore readings at or above" box only for a condition on a listed metric (the schema
serves the list as `saturationCeilingMetrics`). `WINDOWED_RATIO_METRICS` keeps both metrics
— History-as-window semantics are shared; the ceiling is not. Pinned by
`tests/unit/pathFailureRateCeiling.test.ts`, `probeLossWindow.test.ts` and the wizard DOM
test "offers the saturation ceiling on packet loss but not on a path check's failure rate".

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

<a id="rule-85-server-source"></a>

### The Polaris server as a source (2026-09-30)

**What was asked for.** The operator wanted a check to run from the Polaris server they
deployed — on Linux or in a container — as well as from agent hosts: the same progression
of results, from the one vantage point every install has, with no agent on it.

**Why the server is not made an asset.** The results tables are keyed by asset, so the
obvious move was a synthetic "Polaris server" asset. It was rejected: that record would
collide with the real one discovery already writes for the same machine (vCenter, AD,
Entra — rule 83's two-records-one-device problem), would show in every asset count, and
would need a monitorStatus nothing measures. Instead the server's membership row in
`path_check_sources` has `assetId` NULL (one per check — a partial unique index, since
NULLs are distinct in the table's `@@unique`), and its samples and traceroutes carry the
reserved subject `"polaris-server"` in the FK-less `assetId` column. It is never a UUID, so
no agent's bearer reaches it and no asset collides with it.

**What that costs, deliberately.** The alert engine resolves `path*` readings per asset in an
automation's scope, and the server is in no scope — so **a server-run result raises no
automation alert** in this version. It is charted and listed (Path Monitor → Results → the
"Polaris server" row, drawn by the same renderer as a host's Paths tab), and a changed path
is still an Event — naming the CHECK (`resourceType: "path-check"`), because there is no
host for an event automation's device filter to match (rule 46). Alerting on the server
source is a follow-up that needs a subject kind the engine does not have. *(Superseded
2026-10-05: the Path Monitor trigger type gave it one — see
[below](#rule-85-path-monitor-trigger).)*

**Why aiming the server takes a second key.** An agent probes from a host people sit at. The
server probes from ITS network position — often a management segment no agent reaches —
and an HTTP check hands back what came back (the failed-run excerpt, or every run's with
"keep excerpts"). That is a request relay from the server, which is exactly the concern the
Network Discovery key exists for (a sweep from the server, rule 34). So creating a
server-run check, turning the server on, re-aiming one (anything in the agent definition
except its name) or re-enabling one needs `networkScan:write` ON TOP of `pathChecks:write`
— the chained-gate shape of `POST /network-scans/…/adopt`. Turning the server off,
renaming, editing agent Sources and deleting do not: they reduce what the server sends.
The service decides it (`CheckWriteOpts.mayRunOnServer`), because only it can tell whether
an edit re-aims the server.

**The Test button is the same act.** The wizard's Expectations step can run a DRAFT once
from the server (`POST /path-checks/test`) and show the headers and the first 64 KB of the
body, so the operator writes the expectation from the real answer. That is the read
primitive above in its plainest form, so it takes the same chained key, is audited
(`path_check.tested`), is rate-limited per caller, stores nothing, applies the same
save-time target refusals, and redacts Set-Cookie values from what it shows.

**Authentication, and why it is the server's alone (2026-09-30).** An HTTP check may
authenticate — Bearer, Basic or Digest, from an `http` Credential. The operator's condition
was explicit: the credential must not be sent to agents. So a check with a credential runs
ONLY from the Polaris server: it may carry no agent scope or pins, reconcile gives it no agent
member, and the agent config filters it out besides — the definition an agent receives never
names a credential at all, and the agent has no auth code. Choosing one is a USE of a stored
secret against an operator-chosen target. It was first scoped like rule 43's test-by-id (own
row at `credentials:write`, any at fullwrite); the operator loosened it the same day: **anyone
with `credentials:read` may pick any credential and test with it — they just cannot change
it.** The residual risk is accepted knowingly: a caller who can see the list and may aim the
server (pathChecks:write + networkScan:write) can point a stored password at a host of their
choosing. What bounds it: both of those grants are deliberate and admin-seeded, the secret
never reaches an agent or follows a redirect off the target's origin, and every create,
re-aim and test is audited with the credential id. A
followed redirect that leaves the target's origin gets no credential and no Host override.
Basic and Bearer over plain HTTP are allowed (internal apps do it) but the wizard warns.

**The request options that were considered and refused.** PUT / POST / DELETE: a check runs
on a schedule from every source, and a write on a schedule from a fleet is an incident, not a
measurement — GET and HEAD only. A proxy option: a check measures the DIRECT path from its
source; through a proxy it measures the proxy. A threshold on the check: the SLA is the
automation's, per the section above. (SolarWinds' template offered all three; the operator
chose to skip them.)

**Why it runs on the scheduler role.** "The server" must be one vantage point. The monitor
role can have N replicas on N hosts; running there would interleave several hosts' paths
into one series that "changes path" every run. The scheduler role is the single-instance one
and runs the write buffers.

**What it mirrors, and what it refuses beyond the agent.** The probe
(`pathCheckServerRunner`) mirrors the agent's collectors field for field, so both sources
mean the same thing on one chart. After resolution it refuses the agent's ranges AND the
server's own interface addresses — a name that resolves to this host is a loopback probe of
Polaris itself, which the save-time literal check cannot see. ICMP uses the system `ping`
and the traceroute the system tracer (`traceroute`, then `tracepath`, then Windows
`tracert`), because the service holds no CAP_NET_RAW; a missing tool is a note on the trace,
never a failing target (rule 71). Pinned by `tests/unit/pathCheckServerRunner.test.ts`,
`serverTraceroute.test.ts`, the "the Polaris server" blocks of `pathCheckService.test.ts`
and `pathCheckIngest.test.ts`, and `pathCheckWizardDom.test.ts`.

<a id="rule-85-path-monitor-trigger"></a>

### The Path Monitor trigger type (2026-10-05)

**What was asked for.** The operator wanted path monitoring to be its own kind of automation:
pick it as the trigger type and the devices it can be about are only the hosts with the agent
installed, plus the Polaris server itself; the Devices-step conditions still narrow that pool;
the condition dropdown lists path conditions and nothing else; and the path conditions leave
the Device dropdown, where they had sat beside CPU and memory.

**Why it is a category, not a stored type.** The path* metrics already rode every piece of the
threshold machine — holds, count windows, bands, hysteresis, carve-outs, cadence, the Alerts
tab, portability — and every one of those keys on `type: "asset_metric"`. A new stored type
would have meant a second copy of each switch, or a data migration rewriting every path
automation and every export file. The wizard already files several stored types under one
category ("Device conditions" is asset_metric + asset_state + composite), so Path Monitor is
another category over the same storage: `isPathTrigger` decides it by WHAT a trigger watches,
and the server serves the vocabulary as `/schema`'s `pathMonitor`. The API shape is unchanged.

**Why the agent condition is ANDed at read time.** "Only agent hosts" is a property of the
trigger, not of anything the operator wrote, so it is never stored in the scope:
`scopeForTrigger` ANDs `AGENT_INSTALLED_RULE` in wherever the engine, the preview, the message
example and the dimension picker resolve a path rule's devices, and the wizard's Devices-step
count does the same client-side. A scope that selects nothing keeps selecting nothing — the
added leaf would otherwise be the one dimension that made an empty scope select every agent.

**How the server alerts.** `includeServer` on a single path condition (or on the path change)
adds the server as a source. It is resolved through a pseudo row whose id is
`POLARIS_SERVER_SUBJECT` (what the samples are stored under) and its readings are re-keyed to
the subject `""` — the Polaris-host alert's shape — so fire, recover, the email and the
Alerts table all handle it with no asset: `Notification.assetId` null, hostname
"Polaris server". It is outside the device filter, maintenance windows and dependency
suppression, because none of them can describe it. The vanished sweep gives its rows the
asset test: the server reporting other checks but not this one clears it; the operator
unticking the server clears it as out of scope. A rule stored before the flag reads it as
absent = agent hosts only, which is what it always did.

**What it refuses, and why.** A composite cannot include the server — it is evaluated per
device row and the server has none — so `includeServer` lives on single conditions only. A
custom reset condition beside `includeServer` is refused at save: the reset tree is resolved
per device row too, and the server's alert could never recover. A composite mixing path and
device conditions is refused (`validateCompositeTrigger`): the two halves would be evaluated
over two different device pools. For the path change, a server-side Event
(`resourceType: "path-check"`) matches when `includeServer` is set; with the flag absent the
event tail keeps its old answer — an unfiltered automation matched it, a filtered one could not
(`eventMatchesPathServer`). Pinned by `tests/unit/pathMonitorTrigger.test.ts`, the "Path
Monitor pool" block of `pathFailureRateCeiling.test.ts`, and the wizard DOM tests on the path
category.

### Rule 85 — the invariant as stated in full

See `invariants-30-43.md` → 85. The implementation is `pathCheckService.ts` (the
check, its validation and membership), `pathCheckIngestService.ts` (the two streams),
the `path*` metrics in `notificationTypes.ts` / `notificationEngine.ts`, and the agent's
`agent/internal/collectors/path_check*.go`.
