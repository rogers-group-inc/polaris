# Business rule 129 — full narrative

> Written 2026-10-23 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 129](#rule-129) — An HA cluster is upgraded as one device, through its primary, and is done only when every member is back and in sync

<a id="rule-129"></a>

## Rule 129 — An HA cluster is upgraded as one device, through its primary, and is done only when every member is back and in sync

### Before (until 2026-10-23)

Rule 87 refused every FortiGate HA member, twice: `haClusterOf` marked the card `unsupported`
and refused at start and at booking, and the engine refused again from the gate's own
`system/ha`. The reason was that one member's upgrade reboots every member, and nothing
orchestrated or verified that.

### What made it buildable

On 2026-10-22/23 the lab's HUB1 pair (two 61F, a-p, uninterruptible upgrade mode) was upgraded
7.6.7 → 7.6.8 OUTSIDE Polaris, with the engine's own multipart call, while both members were
watched. That run is recorded in narrative-87 "Groundwork (2026-10-23)" and in the
fortinet-api-conventions plugin. The facts this rule rests on:

- One upload, to the primary, is enough. FortiOS upgrades the secondary first, fails over,
  then reboots the old primary.
- The upload request is not answered until the secondary is upgraded and the cluster has
  failed over: 242 s, against ~8 s for a standalone gate. The engine's answer cap was the
  upload idle cap (120 s). It would have cut the request and taken the drop as "image taken",
  which happens to work but logs a dropped connection for an upgrade that is fine. So
  `uploadAnswerMs` is now its own timeout, 15 minutes for a cluster.
- `ha-peer` (members, primary flag), `ha-checksums` (config sync) and `ha-history` (events,
  including `new member '<serial>' joins the cluster`) are readable through the primary.
  **No endpoint reports another member's firmware version**, and discovery stamps the primary's
  version on every member.

The operator then asked to "wire up configuring ha firewall upgrades" and chose:

- **Always on, no setting.** Not a per-integration opt-in like `allowReboot` (rule 115), and not
  a global switch.
- **Started from the primary's card.** The secondary's card shows the cluster's state and
  links to the primary.
- **Not in group upgrades yet** (rule 122). A single cluster run has to be proven first.

### How "done" is judged without the secondary's version

FortiOS reboots the primary only after its secondaries have upgraded. So with the primary
verified on the image through its own address, the cluster is done when:

1. every member Polaris recorded is back in `ha-peer`;
2. `ha-checksums` agree across members; and
3. every OTHER member logged a rejoin after the flash began.

The rejoin is compared in the gate's own clock: the newest `ha-history` event time read at
preflight is the baseline. A build with no readable history is judged on (1) and (2) and says so
in the run log. Anything still unsettled after `clusterSettleMs` (10 min) is `unverified`, naming
what is missing. A single dropped API call right after a member rejoins is normal (seen once
on the lab pair) and is retried, never counted against the run.

### Refusals, all before a byte of image is sent

- a secondary (the card says the cluster upgrades from its primary; a start answers 400);
- any HA mode but a-p, because nothing else has been proven;
- in the engine: the gate's serial is not the `ha-peer` primary, a recorded member is missing
  from the cluster, the members are out of sync, or the gate reports HA while Polaris holds it
  as standalone (run discovery first).

### What a cluster run does differently

It holds every member asset Polaris has, not just the primary (rule 80): each member is down
once, the standby first. It names the members in `firmware.upgrade_started`, and the run lives
on the primary's asset. The secondary's card polls that run through the primary's asset
route, because `getRunForAsset` answers a run only through its own asset. The rule-113(g)
re-pin window opens on the primary's address as before. A cluster reached on a SHARED address
on the default certificate presents the other member's leaf after the failover, and since
2026-10-22 the window re-pins every change it sees.

### Rejected

- **A per-integration "Allow HA cluster upgrades" toggle.** Offered as the recommendation; the
  operator chose always-on.
- **Reading the secondary through its own reserved-management address.** Polaris does not
  learn that address (the primary's API does not report it, and discovery nulls a standby's
  IP), and a cluster may have none.
- **Sequencing members from Polaris.** FortiOS already does it, and the uninterruptible
  upgrade mode is built for exactly that.

### Still unproven

The whole run end to end through Polaris. The lab pair was already on the newest image
available, so only the live preflight was run against it (2026-10-23): members, primary and
sync were read correctly, and it stopped at "already current". Also unproven: a-a clusters,
three or more members, a cluster with no reserved management, an upgrade through
FortiManager's proxy, and a secondary that fails to come back on the image.
