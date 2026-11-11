# Orphan-audit ledger

The working backlog of the orphaned-data audit of 2026-11-11. The question it asked: **what
does Polaris create automatically that, once the asset or configuration it belonged to is
deleted or changed, is left behind with no way for an operator to remove it through the UI?**

Every row was traced in code before it was written here (file and function named in the batch
commit that fixes it). "Suspected" marks a consequence that was reasoned, not traced.

A fix commit flips its row to `fixed@<sha>` in the same commit. Work one batch per worktree;
a batch that adds an invariant takes a business-rule number from `npm run rules:next`.

## Definitions

- **Orphan** — a row, array element, JSON entry, file, queued job or entry on a remote device
  that still points at something that no longer exists or no longer applies, **and** that an
  operator cannot remove from the Polaris UI.
- Something that ages out through a retention job is not an orphan (note the period).
- Something an operator can remove by hand but that fails **silently** is tracked in batch E:
  not an orphan by the definition, but the same family of bug.

## Status

| Batch | What | State |
|---|---|---|
| 0 | Queued agent commands, ownership stamps, disabled-account alerts, departing-account bookings | **done** — pushed `3d7bde734` |
| A | Asset delete / merge leftovers; ownerless private Discoveries | **done** — pushed `6054e6587` (rule 157) |
| B | Integration delete / disable / re-scope | **delete done** — this commit (rule 160); B.3, B.8, B.9, B.11 and the Fortinet / directory leftovers open |
| C | Tables that only grow | **retention done** — pushed `6054e6587` (rule 158); C.3, C.6, C.7, C.11 open |
| D | Leftovers outside the database (hosts, devices, disk) | open — D-D1 decided; D-D2, D-D3 defaulted |
| E | Removable by hand, but silent | open — no decisions needed |

## Decisions (operator, 2026-11-11)

| Id | Question | Answer |
|---|---|---|
| B-D1 | What happens to what a deleted integration discovered | **Keep the assets and networks and detach them cleanly** (remove that integration's source rows, tags and dependency edges; re-project from the remaining sources), **plus a tick-box in the delete dialog to decommission the assets no other source still reports.** The dialog shows the counts first |
| B-D2 | DHCP reservations pushed to a FortiGate when its integration is deleted | **Leave them on the device, and write an Event listing every entry left behind** |
| C-D1 | How long cleared alerts are kept | **A setting, default 365 days** (0 = keep forever) |
| D-D1 | Deleting an asset that has the Polaris Agent installed | **Warn about the agent and offer to attempt the uninstall first. If it succeeds, carry on. If it fails, say so and ask whether to continue with the delete** |

Not asked; defaulted by the implementer and open to change:

| Id | Default |
|---|---|
| B-D3 | `azure:` tags are stripped when the Arc integration is deleted or a machine leaves Arc (it is part of the clean detach of B-D1) |
| C-D2 | The subnet archive gains a Delete at Full Read-Write rather than a retention period — the operator has consistently preferred a visible, operator-decided removal over a silent automatic one |
| D-D2 | A quarantine release that cannot reach a gate keeps that gate on the record as still blocked, with a retry, rather than dropping it |
| D-D3 | An offboarding script is generated beside the onboarding one; Intune / Arc objects Polaris created are listed for removal |

## Batch 0 — done (rules 155, 48(e), 140(a), 140(b))

| # | Leftover | Fix |
|---|---|---|
| 0.1 | A script queued for an offline agent ran whenever the host reconnected; `AgentCommand` rows never deleted | fixed@e691d579c — 15-minute expiry, settle sweep, 90-day retention (rule 155) |
| 0.2 | `createdBy` on assets, maintenance schedules, path checks, group firmware bookings survived user / API-token delete | fixed@e691d579c — tombstone widened to every compared model and to tokens (rule 48(e)) |
| 0.3 | A disabled account still received alert email and web push | fixed@e691d579c — recipient index holds only enabled accounts; push subscriptions deleted on disable (rule 140(a)) |
| 0.4 | Reboots / firmware upgrades booked by a disabled or deleted account fired unseen | fixed@553ada257 — listed in the Disable / Delete dialogs with tick-to-cancel (rule 140(b)) |

## Batch A — done (rule 157)

| # | Leftover | Fix |
|---|---|---|
| A.1 | Pins naming a deleted asset in `PathCheck.assetIds`, `Contact.assetIds`, `MaintenanceSchedule.assetIds` | pruned by `assetRemovalService.afterAssetsDeleted` |
| A.2 | The same pins, automation `scope.assetIds` and Application Map rules naming a MERGED-AWAY asset — the survivor silently dropped out | re-pointed by `afterAssetMerged` |
| A.3 | Asset- / process-scoped `LogFlagRule` unreachable after its asset is deleted, still compiled | deleted on delete, moved on merge |
| A.4 | `AssetProcessConfig`, `AssetProcess`, `AssetService`, `AssetSdwanRule`, `AssetInventoryScrape` rows for a deleted asset | purged; process config moved on merge |
| A.5 | Commands / agent script runs waiting on a deleted device | withdrawn |
| A.6 | A path check's dead pin could not be unticked; a check pinned only to a dead host saved and ran nowhere | dead pins dropped on save (157(c)) |
| A.7 | `dns_resolved` reservations left by a BULK delete (`deleteMany` runs no hook) | released first (157(b)) |
| A.8 | A deleted user's private Discoveries unreachable by anyone | visible to `networkScan:fullwrite` when ownerless (157(d)) |
| A.9 | All of the above already sitting on existing installs | migration `20261111120000_orphan_asset_references` |

Deliberately not done in A: an automation's `scope.assetIds` is left alone on a DELETE (an
empty list means every device — rule 157(a)); it is in batch E as "silent".

## Batch B — integration delete / disable / re-scope (delete done, rule 160)

Root cause shared by most rows: deleting an integration nulls the integration reference
(`onDelete: SetNull`) on what it discovered, and every clean-up sweep is keyed on that
reference, so the rows fall out of every sweep permanently. `DELETE /integrations/:id`
purges directory contacts and the `llm` role + token, and nothing else.

| # | Leftover | Consequence |
|---|---|---|
| B.1 | `AssetSource` rows of a deleted integration (`integrationId` NULL) | keep feeding `projectAssetFromSources` (hostname / OS / serial); count as "still claimed", so the asset can never be auto-decommissioned; ids embedding the integration id can never be re-adopted **→ fixed at delete time, and by migration `20261111140000_orphan_integration_sources` for vCenter / Arc / workload / Generic API kinds. **Still open:** dead `entra` / `ad` / `intune` / Fortinet source rows already on existing installs (those kinds can legitimately carry no integration, so the migration leaves them)** |
| B.2 | `azure:` tags after Arc is deleted / disabled / a machine leaves Arc | operators are blocked from removing them everywhere; stay in filters, tag-scoped RBAC, automation scopes **→ fixed for a DELETED Arc integration (stripped; migration covers existing installs). Open: disabled Arc, and a machine that leaves Arc (B.3)** |
| B.3 | `arc` source rows — there is no Arc absence pass at all | as B.1 **→ open — needs an Arc absence pass with rule 70's guards** |
| B.4 | Superseded `fortigate-endpoint` source rows; every `AssetFortigateSighting` row (no delete anywhere) | `syncEndpointDependencyEdges` reads sightings with no age filter **→ sightings deleted with the integration, and pruned by age (rule 158). Superseded `fortigate-endpoint` rows on a LIVE integration: open** |
| B.5 | Placement dependency edges (`source` = vcenter / unraid / truenas / proxmox) | suppression frozen at the last sync; an override masks, does not remove **→ fixed — deleted with the integration; migration covers existing installs** |
| B.6 | Pushed DHCP reservations on the FortiGate after the integration is deleted | `pushedTo` nulled, so a later release is local-only; the device keeps binding MAC to IP **→ decided: left on the device, listed in `integration.dhcp_entries_left`** |
| B.7 | Discovered assets, subnets and reservations of a deleted integration look live and manual | UI-removable, but nothing marks them **→ decided: kept; the delete dialog shows the counts and offers to decommission what nothing else reports** |
| B.8 | In-memory state per integration (`fmgWorker.workers`, token caches, Proxmox pools, labelled Prometheus gauges) | until restart; small and bounded **→ open — bounded, clears on restart** |
| B.9 | `monitorSettings` caches never invalidated across process roles | monitor role keeps a deleted / edited integration's cadences until restart (suspected runtime effect) **→ open** |
| B.10 | `DiscoveryRun` rows — no delete anywhere | grows; invisible **→ fixed — deleted with the integration (and swept by rule 158)** |
| B.11 | `DirectoryContactSource` rows if the purge fails during delete (suspected) | point at a dead id **→ open** |

Decisions needed:

- **B-D1** — when an integration is deleted, what happens to what it discovered? Options:
  (a) keep the assets / subnets, delete its source rows and re-project, so they become plain
  manual records; (b) offer in the delete dialog to decommission them; (c) refuse the delete
  while it still sources anything.
- **B-D2** — pushed DHCP reservations: un-push them as part of the delete (needs the device
  reachable), refuse the delete while any are pushed, or list them in the dialog and leave them.
- **B-D3** — `azure:` tags once Arc is gone: strip them automatically, or make them
  operator-removable.

## Batch C — tables that only grow (open)

| # | Table | State today |
|---|---|---|
| C.1 | `Notification`, `NotificationDelivery`, `QuietTimeSummary` (alert history) | fixed — `alertHistoryDays`, default 365 (rule 158) |
| C.2 | `NotificationRuleState` | fixed — idle `clear` rows deleted after 7 days (rule 158) |
| C.3 | `Conflict` (resolved) | **kept on purpose**: a rejected conflict suppresses re-raising (rule 139). Open question: prune ACCEPTED ones only |
| C.4 | `DiscoveryRun` | fixed — it is one row per integration, so the leftover was a deleted integration's row; pruned (rule 158) |
| C.5 | `AssetFortigateSighting` | fixed — pruned past `quarantine.sightingMaxAgeDays` (rule 158) |
| C.6 | `ArchivedSubnet` / `ArchivedReservation` | append-only, no purge, dead `blockId` |
| C.7 | `TopologyLayout` rows for location views that no longer exist | unreachable |
| C.7 | (note) | left for the topology work in flight — do not collide with `worktree-topology-views*` |
| C.8 | `User.hiddenMapRegionIds` ids of deleted regions | fixed — swept daily (rule 158) |
| C.9 | `TagAutoAssignment` rows for a deleted tag (edge case) | fixed — swept daily (rule 158) |
| C.10 | `NetworkScanRun` | fixed — 90 days, newest run of each Discovery kept (rule 158) |
| C.11 | `AssetProcessConfig` after a process is UNPINNED (asset still exists) | upsert-only; re-pinning revives the old log glob |

Still open in C: C.3 (accepted conflicts only?), C.6 (archive Delete, per the C-D2 default),
C.7 (topology layouts), C.11 (process config on unpin).

## Batch D — leftovers outside the database (open)

| # | Leftover | Consequence |
|---|---|---|
| D.1 | The agent stays installed and running when its asset is deleted or merged away | 401s forever; the Uninstall button went with the asset |
| D.2 | A quarantine release that cannot reach a gate clears the local record anyway | the MAC stays blocked on that gate with no record and no retry |
| D.3 | A quarantined ghost merged away (suspected) | unpush is keyed by asset id |
| D.4 | Onboarding artefacts: service account, authorized key, sudoers file, Intune remediation, Arc run-command | no removal path; key rotation appends, so old keys stay authorized |
| D.5 | Backup files beyond the 50-entry history; off-host copies never pruned | unlisted, undeletable from the UI |
| D.6 | Firmware files with no row / rows with no file after an interrupted upload; `.incoming` leftovers | no reconcile either way |
| D.7 | Agent WebSocket session survives a revoke or an asset delete | until the agent stops or the web role restarts |
| D.8 | Browser `localStorage` keys embedding site / integration ids | cosmetic |

Decisions needed:

- **D-D1** — deleting an asset that has an agent: refuse until the agent is uninstalled,
  uninstall as part of the delete (needs the host reachable), or warn and proceed.
- **D-D2** — quarantine release with an unreachable gate: keep the failed targets on the
  record for retry (the asset stays "partly released"), or keep today's behaviour and add a
  visible list of stranded entries.
- **D-D3** — onboarding: generate an offboarding script (and delete the Intune / Arc objects
  Polaris created), or document the manual removal only.

## Batch E — removable by hand, but silent (open; no decisions needed)

| # | Leftover | Today |
|---|---|---|
| E.1 | A deleted notification channel still named in automations, alert groups, escalation tiers, firmware / reboot bookings | delivery silently skipped |
| E.2 | A deleted automation script named in per-action escalation, severity-band actions, reset actions, alert groups | the delete guard checks only two of the eight action locations |
| E.3 | A deleted MIB still named in `Asset.*MibId` / `MonitorClassOverride.*MibId` | nothing cleared |
| E.4 | A deleted credential in `NetworkScan.methods[].credentialIds` (suspected) | not checked on delete |
| E.5 | An automation's `dimensionFilter.checkId` / `widgetId` / `stateProbeId` naming a deleted object | the rule goes silently dead |
| E.6 | A firing alert frozen forever when its path check, custom widget or state probe is deleted | only Alerts → Clear ends it |
| E.7 | Tag rename / delete not carried into `User.otherTags`, `GroupMapping.otherTags`, condition trees | write scope and routing silently dropped |
| E.8 | Region rename not carried into condition trees; a hand-applied `region:` tag on a block | rule stops matching |
| E.9 | `dns_resolved` reservation surviving a SWEEP decommission (`updateMany` skips the reconcile; rule 40(k) nulls the address the periodic job scans by) | active system reservation on an address a retired device holds |
| E.10 | A pushed reservation that EXPIRES (`expireStaleReservations`) is not un-pushed | the device entry stays; rediscovered later |
| E.11 | A full-subnet reservation that expires leaves `Subnet.status = reserved` | manual edit |
| E.12 | An automation's `scope.assetIds` naming a deleted asset (left on purpose by rule 157(a)) | matches nothing; shown in the wizard |
| E.13 | Stale SD-WAN rule rows when collection stops on a monitored gate | alert readings have no age gate, so a rule frozen at "down" may never recover (suspected) |
| E.14 | A role granted through a group mapping survives the mapping's deletion | documented choice in `ssoProvisioning`; listed for review |

## Checked and found clean

Kept so nobody re-audits them: sample and rollup hypertables (tiered retention, 7 / 30 / 365
days by default); `Event` (configured retention); completed script runs (90 days); the alert
engine's own clean-up on rule delete / disable / re-scope / regroup; alert groups; quiet-time
flush on schedule delete; path-check delete (sources and windows cascade, schedules repaired);
profile delete; maintenance reconcile; credential delete (refused while in use);
firmware image delete; infra reservations on asset delete / decommission; tag rename onto
assets, subnets, blocks, port tags; region rename and delete; user delete (sessions, passkeys,
saved items); role delete (refused while held).
