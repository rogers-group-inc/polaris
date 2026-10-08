# Business rule 98 — full narrative

> Written 2026-10-08 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 98](#rule-98) — An SD-WAN condition may be narrowed to the members whose current address passes a comparison, and a member whose address cannot be read is kept

<a id="rule-98"></a>

## Rule 98 — An SD-WAN condition may be narrowed to the members whose current address passes a comparison, and a member whose address cannot be read is kept

### What asked for it

On 2026-10-08 the operator, building SD-WAN automations (a packet-loss automation
grouped by device, an "overlay is down" member-state automation filtered to two
data-centre health checks), asked for a condition "SD-WAN member IP address != 0.0.0.0".
The case is the same one rule 88 was written for: a deployment template enables `wan1`
and `wan2` on every FortiGate as SD-WAN members whether or not a second circuit exists,
so an unplugged `wan2` is down on every health check, forever, on every gate that has one.

Rule 88's answer was a checkbox, **Skip unused ports**, that decided "unused" from a
30-day remembered address. It was pointed out to the operator that this already covered
the case, and why it was arguably better (it tells an unused port from a DHCP WAN whose
lease dropped with its link — both read `0.0.0.0` now). The operator chose to remove it
and have the explicit comparison instead, everywhere it existed, Interface oper status
included. Rule 88 is retired; this rule is its replacement.

### Why a filter on the condition, and not a condition

The obvious build — a new asset-state field "SD-WAN member IP address" that an operator
ANDs with the member condition — does not work, for the reason rule 88's own narrative
recorded: the leaves of a multi-condition automation fold per DEVICE. "Member state is
down AND member IP is not 0.0.0.0" would be true on a gate where `wan2` is down and `wan1`
has an address, which is exactly the alert the operator wanted gone. The comparison has to
apply to the SAME member the reading is about, so it lives on the condition, as a
`dimensionFilter` key, the way `healthCheck` and `link` already narrow which members a
condition reads.

That choice gave the rest for free: a `dimensionFilter` key is already in
`triggerSignature` (so a filtered and an unfiltered automation never carve each other out,
rule 18), already round-trips through the wizard's filter-row compile / lift, and already
reaches the resolver.

### Why a comparison string, not a pattern

Every other filter row is "matches <pattern>" — positive substring patterns, with no
negative to offer. "Not 0.0.0.0" is a negative, and "matches 0.0.0.0" would be a substring
test that also matches `10.0.0.0`-anything. So the stored value is a comparison,
`"!= 0.0.0.0"` / `"== 203.0.113.9"`, parsed by `parseMemberIpFilter`, and the wizard draws
the row as *is / is not* + an address instead of the pattern picker. Storing it as one
string kept it inside the existing compile / lift machinery, which compares filter values
for equality to decide whether a row lifts.

### Why it is not in METRIC_DIMENSIONS

`METRIC_DIMENSIONS` / `FIELD_DIMENSIONS` look like "the dimensions a condition takes", but
`dimensionSpaceOf` reads the metric list as the identity of a reading's KEY space —
`sdwanPacketLoss` and `sdwanMemberState` share `healthCheck,link`, which is what lets a reset
tree mix them. Adding a filter key there would have silently split the two. The targets are
therefore their own set, `SDWAN_MEMBER_IP_TARGETS`, published to the wizard as
`sdwanMemberIpTargets` and enforced on save by `validateMemberIpFilter`.

### What "unknown" means, and why it is kept

The member is joined to its interface by name (the SD-WAN tab's join). A member can have
no interface row (an overlay on a gate whose interface scrape has not run), or a row whose
scrape returned no address field (`ipAddress` null — "not collected", never "unaddressed").
Either is UNKNOWN, and the reading is kept: the filter removes members it has evidence
about, never ones it could not read — the same posture rules 88 and 90 took for a failed
lookup.

### The trade-off the operator accepted

A current-address comparison cannot tell an unused port from a DHCP WAN whose lease was
released when its link dropped. *Is not 0.0.0.0* therefore leaves that outage out as well.
The wiki says so beside the filter, and the alternative (an oper-status or member-state
automation without the filter) is named there.
