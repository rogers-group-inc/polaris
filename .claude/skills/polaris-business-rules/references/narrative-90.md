# Business rule 90 — full narrative

> Written 2026-09-29 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 75 is claimed by an in-flight worktree (alert
> grouping); 81 is a deliberate gap.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 90](#rule-90) — An SD-WAN member riding a parent that is over the same line does not alert; the parent's alert names the cause

<a id="rule-90"></a>

## Rule 90 — An SD-WAN member riding a parent that is over the same line does not alert; the parent's alert names the cause

### The case

2026-09-29. The operator built one automation, "FortiGate Performance SLA Packet Loss"
(`sdwanPacketLoss >= 5`, averaged over 15 minutes, warning with serious at 25 and critical
at 50, scoped to every firewall, no health-check or member filter). On a gate whose second
circuit was down, the SD-WAN Members table read: underlay `wan2` dead on both of its health
checks, and the two overlays homed on it — `Overlay-3` and `Overlay-4`, IPsec tunnels whose
phase-1 `interface` is `wan2` — dead on theirs. Every one of those (health check, member)
pairs is its own alerting dimension, so one circuit produced an alert for `wan2` and one
for each overlay riding it. The operator's ask: "if a parent interface has packet loss,
then I don't want to see child interface packet loss alerts."

### What was built

**The parent.** Polaris already collects the one fact needed: an overlay member IS an
IPsec phase-1 interface, and its `AssetIpsecTunnelSample` row carries the phase-1
`interface` as `parentInterface` (the same field the System tab nests tunnel rows under).
`notificationEngine → loadSdwanParents` reads the newest such row per (gate, tunnel) within
`SDWAN_PARENT_LOOKBACK_HOURS` (48 — the phase-1 `interface` is configuration, not state, so a
day-old full scrape is still true), plus `AssetInterface.ifParent` on `ifType = "vlan"` rows
so a tunnel homed on `wan1.100` still reaches `wan1`. VLAN rows only: the aggregate
back-fill writes `ifParent` on a trunk's MEMBER ports pointing at the trunk, which is the
opposite direction.

**Over the line.** A reading yields (`utils/sdwanDimensions → sdwanChildrenYielding`) when
it MEETS the automation's condition and some ancestor of its member — walked at most
`SDWAN_PARENT_MAX_HOPS` (4), cycle-safe — is itself over the same line: the same automation
has a meeting reading on the ancestor this tick, or an uncleared, non-test alert that any
automation raised on the same metric / field (`Notification.metric`) names the ancestor as
its member (`notificationEngine → liveSdwanAlertMembers`, the member being the tail of the
`healthCheck|link` dimension). The top of a chain never yields, so the alert that survives
is the one naming the cause.

**Where it applies.** The four SD-WAN member conditions — `sdwanPacketLoss`,
`sdwanLatencyMs`, `sdwanJitterMs` (asset metrics) and `sdwanMemberState` (asset state) —
inside their resolvers, after "skip unused ports" (rule 88), via
`notificationEngine → yieldToSdwanParents`. Always on: there is no toggle, for the same
reason rule 38 has none — accusing the child of what its parent did is never what an
operator wants, and the parent's alert is still there.

**The handoff.** The threshold path passes an out-param (`sdwanYielded`) and, for each
state row whose `${assetId}|${dimensionKey}` yielded, clears a live alert as
`system:superseded` with NO reset actions and writes a `notification.superseded` Event with
`details.reason = "sdwan-parent"` and `details.parent`; a pending row is reset. The key is
marked seen so `clearVanishedStates` does not also retire it as "no longer reported". This
is rule 89's handoff shape, per DIMENSION rather than per asset — `wan1` on the same gate
keeps alerting.

### Why these choices

- **Why only readings that MEET yield.** A child that has come back under the line is
  recovering, and its alert must reset through the ordinary path. Yielding it would let the
  handoff eat a real recovery.
- **Why only the threshold path.** Every other caller of the resolvers must keep every
  reading. A reset-condition leaf is the trigger INVERTED, so "meets" there means
  recovered — yielding a recovered child to its recovered parent would strand the child's
  alert with no reading to reset on. A composite leaf folds per device, where the parent's
  reading already carries the device. The preview shows raw readings. `yieldToSdwanParents`
  is therefore a no-op unless the caller passes the out-param.
- **Why the live-alert half.** An operator who splits underlays and overlays into two
  automations (one filtered to `wan`, one to `Overlay`) has no parent reading inside the
  overlay automation at all; without the live-alert check that shape would page for every
  overlay. Keyed on the SAME metric / field only: "wan2 is losing packets" explains an
  overlay losing packets; whether wan2's latency explains an overlay's loss is a judgement
  Polaris does not make for the operator.
- **Why superseded and not "resolved".** The child has not recovered. Mailing "packet loss
  resolved" about an overlay still dropping every packet would be worse than silence — the
  same reasoning as the carve-out and the device-down handoff. The Event is the audit trail.
- **Why no hold on the parent.** The parent "is over the line" when its reading meets the
  value, whether or not its own hold has completed. During the parent's hold nothing alerts
  — the child is silent and the parent is pending — which is one hold of quiet about a
  fault that will be named when the hold completes, and never two alerts about one circuit.
- **A failed lookup keeps every reading.** The rule removes readings it has evidence about,
  never ones it could not check (the same contract as rule 88).
- **Cost.** The two lookups run only for the gates that have a reading over the line this
  tick, narrowed to the members named — so a healthy 2000-gate fleet runs no extra query at
  all, and a fault on a handful of gates costs two small indexed reads.

### Follow-up 2026-09-30 — a DOWN parent yields whatever the filter

The operator's "FortiGate Overlay is down" automation (`sdwanMemberState == down`, 3 polls,
`dimensionFilter.healthCheck = "Metrocenter|Flexential"`) still paged per overlay when the
underlay died. Both halves of "over the line" were blind to it: the filter is applied
before the yield, and the underlays are members of other health checks (or none), so the
automation never had a reading on wan2; and no automation carried a live member-state alert
about wan2. A physically down port that is in no health check was invisible to the rule
entirely.

So a third source: `notificationEngine → downSdwanParents` marks an ancestor over the line
when its `AssetInterface.operStatus` is `down`, or its newest perf-SLA read within 15 min is
`down` on ANY health check — read without the automation's filter. It applies to all four
conditions, not only member state: unlike "wan2's latency explains an overlay's loss", a
dead underlay explains every symptom of a tunnel riding it. It runs inside the same
hot-readings-only branch, narrowed to the ancestor names, so a healthy fleet still costs no
query; a failed lookup falls back to the same-condition evidence alone. Pinned by the three
"down parent" cases in `tests/integration/sdwanParentYield.test.ts`.

### Rejected alternatives

- **Rule 38 dependency suppression.** That machinery is per ASSET (a device behind a dark
  parent device); an SD-WAN member is a dimension of one gate, and the gate itself is up.
- **A per-automation toggle.** Considered and dropped: nothing an operator configures is
  better served by an overlay alert that repeats its underlay's.
- **Suppressing every child whenever the parent has ANY live SD-WAN alert.** Too wide — a
  latency alert on wan1 would silence a genuine packet-loss problem on a tunnel riding it.

### Rule 90 — the invariant as stated in full

See `invariants-30-43.md` (rule 90). Pinned by `tests/unit/sdwanDimensions.test.ts`
(the walk: same-tick parent, live parent, recovering child, per-gate keys, VLAN hop,
cycles, hop bound) and `tests/integration/sdwanParentYield.test.ts` (one alert on wan2;
a pre-existing overlay alert retired as superseded with reason `sdwan-parent`; a parent
alert from a different automation; a healthy underlay keeps its overlay alerting).
