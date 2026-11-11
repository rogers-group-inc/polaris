# Business rule 160 — full narrative

> Written 2026-11-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 160](#rule-160) — Deleting an integration keeps what it discovered and detaches it; nothing it wrote goes on speaking for it

## Rule 160 — Deleting an integration keeps what it discovered and detaches it; nothing it wrote goes on speaking for it

**How it was found.** The 2026-11-11 orphan audit traced `DELETE /integrations/:id`. It purged directory-synced contacts, deprovisioned the `llm` role and token, deleted the row, and left everything else to the schema — and the schema's answer for nearly every reference to an integration is `onDelete: SetNull`. That would be harmless if anything later looked for rows with a null integration. Nothing does. Every clean-up sweep Polaris has — the directory absence sweep, vCenter's Pass E, the workload sync's Pass E, the Generic API disappearance sweep, the stale-subnet and stale-firewall passes — is keyed on the integration id. The moment the foreign key nulled that column, what the integration had written dropped out of every sweep permanently.

What that left, concretely:

- **`AssetSource` rows that kept speaking.** A deleted vCenter's `vcenter-vm` rows kept their `observed` blobs. `projectAssetFromSources` takes only `sourceKind`, `inferred` and `observed`, so a dead row went on outranking live sources for hostname, operating system and serial. Worse, every absence sweep decommissions an asset only when no non-enrichment source row remains — so a dead row from a deleted AD, Entra or FortiGate integration counted as "still reported", and that asset could never be auto-decommissioned by anything.
- **`azure:` tags nobody could remove.** Arc mirrors Azure tags onto assets and every operator write path deliberately preserves them (`withArcOwnedTags`, the bulk-tag service, the tag registry's refusal to edit an `azure:` row). Only an Arc run strips one. With the Arc integration deleted they stayed in filters, in tag-scoped write permissions and in automation scopes, with no way to take them off.
- **Hypervisor placement edges frozen in place.** VM → host and container → host edges (`AssetDependencyParent.source` = `vcenter` / `unraid` / `truenas` / `proxmox`) are delete-replaced only inside that platform's own sync. With the integration gone they went on suppressing alerts for a topology nothing was refreshing; an operator override masks such an edge but does not remove it.
- **A FortiGate's sightings and the integration's discovery-run row**, neither of which any code path deleted.
- **DHCP reservations on the device.** A reservation pushed to a FortiGate keeps `pushStatus = "synced"` while `pushedTo` is nulled. A later release in Polaris then computes "nothing to un-push" and releases locally only — the device keeps binding that MAC to that address with no Polaris record, and nothing says so.

**The operator's two decisions (2026-11-11).** Both were put as three-way choices.

*What happens to what it discovered* — keep and detach, offer to decommission, or refuse the delete while anything is still sourced. The operator chose **keep and detach cleanly, with a tick-box in the delete dialog to decommission the assets no other source still reports**. The inventory is not the integration's to take with it: deleting an integration is very often "we are replacing how we read this fleet", not "this fleet is gone". But an administrator who *is* retiring the fleet should not have to find its assets afterwards, so the dialog offers it, unticked, with the count and how many of those are being monitored right now.

*Pushed DHCP reservations* — list them with tick-to-remove, always un-push first, or leave them and record it. The operator chose **leave them on the device and write an Event listing every entry left behind**. Un-pushing needs the device reachable at the moment of deletion, and an integration is frequently deleted precisely because the device or its manager is gone. The Event (`integration.dhcp_entries_left`, warning) names each entry — address, MAC, hostname, network, device, scope and entry ids — so there is a record of exactly what is out there and where.

**What "detach" does** (`integrationDetachService.detachIntegration`, called from the route BEFORE `prisma.integration.delete`, while the id still finds its rows):

1. Writes the DHCP Event.
2. For an Azure Arc integration, strips `azure:` tags from the assets it sourced (implementer default B-D3: it is part of a clean detach).
3. Deletes the placement edges that platform wrote, touching either end.
4. Deletes its `AssetSource` rows, its sightings, and its finished discovery-run row.
5. When the box was ticked, decommissions the assets nothing else reports — releasing infra reservations and maintenance holds first, exactly as the discovery sweeps do — with one Event per asset.
6. Afterwards, best-effort: the `azure:` registry rows nobody carries are reconciled and the computed dependency tree is rebuilt.

A failure in any step throws before the integration row is deleted, so the operator can try again with everything still addressable. The asset rows keep whatever field values they last had; they simply stop being overwritten, which is what "becomes a plain manual record" means.

**"Nothing else reports it".** An asset is a decommission candidate when, once this integration's rows are gone, it has no non-enrichment source row left (`ENRICHMENT_SOURCE_KINDS` — SNMP answering is not a claim), it is not already decommissioned, and it is owned by this integration or by nothing (`discoveredByIntegrationId`). Ownership decides, as in rule 70: an asset another integration owns only loses this one's row. A `manual` row counts as a claim — an operator made that record.

That last point is where the first implementation was wrong, and the test caught it before it shipped. The "other sources" query was written `NOT: { integrationId }`. In SQL `NULL <> x` is unknown, not true, so that form silently drops every row with no integration at all — the operator's own `manual` row and the Polaris Agent's among them. An asset an operator had created by hand, which the integration merely also reported, read as "nothing else reports it" and would have been decommissioned when the box was ticked. It is now spelled `OR: [{ integrationId: null }, { integrationId: { not: id } }]`, with a comment, and `tests/integration/integrationDetach.test.ts` pins the hand-made asset staying active.

**Who may tick the box.** Deleting an integration is `integrations:write`. Decommissioning is an act on assets, and a fleet-wide one, so the tick-box needs Full Read-Write on Assets: `GET /integrations/:id/delete-preview` returns `canDecommission`, the dialog locks the box with the reason for a caller without it, and `DELETE …?decommission=true` is refused with 403 before anything changes.

**Existing installs.** Migration `20261111140000_orphan_integration_sources` removes what integrations deleted before this release left behind — but only for source kinds that are written with an integration id on every sync (vCenter, Azure Arc, Unraid / TrueNAS / Proxmox, Generic API). For those a null integration id has exactly one cause. Kinds that can legitimately carry no integration are left alone: `manual`, `polaris-agent`, the SNMP enrichment rows, and the `entra` / `ad` / `intune` / Fortinet rows that the legacy shadow-write derives from an asset tag with whatever `discoveredByIntegrationId` the asset had. It also removes placement edges whose child no longer has a source row from that platform, and `azure:` tags on assets with no Arc source row left. Dead Fortinet, directory and Entra source rows on existing installs are therefore NOT cleaned by the migration; they are tracked in `docs/ORPHAN-AUDIT-LEDGER.md`.

**What this rule does not do.** It does not un-push anything from a device (decided). It does not delete assets or networks. It does not handle a machine that leaves Arc while the Arc integration still exists — there is no Arc absence pass, which is its own ledger row. It does not evict the per-integration in-memory state (`fmgWorker`'s workers, token caches, labelled gauges), which is bounded and clears on restart. And it does not address disabling or re-scoping an integration, only deleting one.

**Adding an integration type.** A new type that writes anything keyed to itself — a source kind, a tag namespace, a placement-edge `source` — must be added to the detach service, and, if its source kind always carries an integration id, to the migration's pattern for a future clean-up. `polaris-change-impact` → cross-cutting/integration-type-onboarding.md carries the checklist line.

Pinned by `tests/integration/integrationDetach.test.ts` and `tests/unit/integrationDeleteDialogDom.test.ts`.
