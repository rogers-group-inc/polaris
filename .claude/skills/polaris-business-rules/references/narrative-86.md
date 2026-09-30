# Business rule 86 — full narrative

> Written 2026-09-24 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 85 was claimed by an in-flight worktree
> (connectivity checks) when this rule was numbered; 81 is a deliberate gap.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 86](#rule-86) — An agent that deployed and went quiet has missed its poll — unless Polaris is the one that stopped listening

<a id="rule-86"></a>

## Rule 86 — An agent that deployed and went quiet has missed its poll — unless Polaris is the one that stopped listening

### The gap

The operator's requirement, 2026-09-24: *if the Polaris Agent has been deployed
successfully to an asset and then the asset stops reporting back, it needs to raise an
asset down alert.*

It did not, and it could not. An agent-monitored asset is never polled by the server.
The agent pushes its own response-time samples to `POST /api/v1/agents/samples`, and
`ingestResponseTime` hands each one to `recordProbeResult(..., { fromAgent: true })`.
Those pushed samples were the only readings that could move the monitor state machine.
For the server's own tick, `probeAsset` returned a synthetic success, and
`recordProbeResult` discarded it (`responseTimePolling === "agent" && !fromAgent` →
return). That guard exists for a good reason: without it, the periodic success would
clobber the agent's real signal.

The agent can report a bad path to Polaris. Its response-time loop times a `/heartbeat`
call and pushes the result, so a failed heartbeat whose push still gets through lands as
a real miss. What it cannot report is its own death. A host that is powered off, crashed,
cut off the network or has had its agent service stopped pushes nothing at all, and the
agent buffers no failed samples. So the failure bucket never moved, `monitorStatus` froze
at its last value (normally `up`), and the "Asset down" automation (seeded `critical`,
`missedPolls: 3`) had nothing to evaluate.

The only signal was the WebSocket drop. `agentChannelService.detach()` emits
`agent.disconnected`, and the seeded "Agent disconnected" automation fires on it. But
that alert is `warning`, it has a 30-minute cooldown, and it describes the agent, not the
host. A dead server read green on every dashboard, map and widget.

### The decision

**The missing push is the miss.** The agent's contract is to push a response-time sample
every interval, and `verifyBearer` stamps `ManagedAgent.lastSeenAt` on every
bearer-authenticated call. So "no bearer call for longer than the agent could plausibly
take" is exactly the observation an ICMP miss records: the device was expected to answer
and did not. `probeAsset`'s agent branch now asks `judgeAgentSilence()`, and a `silent`
verdict returns `{ success: false, agentSilent: true }`. `recordProbeResult` lets that
one flag past the agent guard, and it runs the whole path: a failed `AssetMonitorSample`
(the chart dives), the bucket, the status, and the `lastMonitorAt` stamp that spaces the
next miss a full cadence out. Because the covering automation's missedPolls still decides
`down` (rule 36), the operator's existing "down after N missed" means the same thing for
an agent host as for anything else. With the defaults, a host that dies at a 60 s cadence
reads `warning` about two minutes after its last push and `down` about two minutes after
that.

**The window** is `max(2 × interval, interval + 60 s)`. That is one fully missed push,
plus slack for push jitter, the agent's phase offsets and the fire-and-forget
`lastSeenAt` write. Tighter windows turned ordinary jitter into warnings.

**Who is judged.** Only an agent that finished deploying: installStatus `active`,
`upgrading` or `upgrade_failed`, with a bearer that exists and is not revoked. Silence
from an install still in flight, a failed install, an uninstall or a revoked agent says
nothing about the host, because Polaris does not expect that agent to call. An asset set
to `agent` with no `ManagedAgent` row keeps the old no-op. The agent restart during an
upgrade, reinstall or uninstall is already covered by the rule 80 maintenance hold, which
keeps the asset out of the monitor pass altogether.

### Polaris's own silence never counts

Every agent's silence is measured at one receiver, Polaris. If the receiver stops
listening, every agent in the fleet goes silent at the same moment. Accusing them all
would be the rule 80 failure at fleet scale: downtime Polaris caused, reported as an
incident on every host. Two guards stop this.

- **Boot.** The silence clock never starts before `agentListeningSince`, which is this
  monitor process's boot. After an update or a restart, agents have not reconnected yet,
  and each one gets a full window from boot before its silence counts.
- **Fleet dark.** When no enrolled agent anywhere has reported inside the window, the
  ingest itself is what is down: a web role stopped in a split-role install, the reverse
  proxy, or Polaris's own network. The verdict is `fleetDark`. The tick is `skipped`,
  which writes no sample and moves no counter, and `agentListeningSince` moves to now.
  Stragglers therefore get a full window from the moment the ingest comes back, rather
  than being accused the instant the first agent reconnects. The check is one
  `ManagedAgent` aggregate, cached for 10 s.

**A fleet of one cannot tell the two apart**, so the fleet guard needs at least two
enrolled agents before it will abstain. With one agent, "Polaris stopped listening" and
"the host died" look identical, and the choice is to accuse rather than never alert. An
operator with a single agent and a flaky web role will see a warning. An operator with a
single agent and a dead host will see it go down, which is what they asked for.

### Rejected alternatives

- **Drive it from `agent.disconnected`.** The WebSocket drops on a Polaris restart, a
  proxy idle timeout, a replaced connection or a revoke, and it lives in the web process
  while the state machine lives on the monitor role. It is also an edge, not a reading:
  it cannot express "missed three polls", so it would bypass rule 36 and hand-roll a
  second definition of down.
- **Fall back to ICMP for agent assets.** Many agent hosts block ICMP. It would also
  quietly override the operator's chosen polling method and double-count on hosts where
  both work.
- **A new sweep job over `ManagedAgent`.** That is a second writer of `monitorStatus`
  outside `recordProbeResult`. The publishers already queue a tick for every overdue
  agent asset (and had been queuing no-op ticks for silent ones on every publisher cycle,
  because nothing stamped `lastMonitorAt`), so the probe path was the place that already
  existed.
- **Measure silence from the last `responseTime` sample instead of `lastSeenAt`.** That
  column is `Asset.lastMonitorAt`, which the silent miss itself now stamps to space the
  cadence, so it cannot also be the evidence. `lastSeenAt` is written only by the agent.

### What pins it

`tests/unit/agentSilence.test.ts` pins the verdict: the window, who is expected to
report, the boot clock, fleet-dark, and the fleet-of-one choice.
`tests/integration/agentSilenceDown.test.ts` drives a real asset through
`probeAsset` → `recordProbeResult` against a database: warning → warning → down on a
`missedPolls: 3` automation, recovery on the agent's next real sample, and no movement
for an agent that is reporting, revoked, still enrolling, or just booted.
