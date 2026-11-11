# Business rule 164 — full narrative

> Written 2026-11-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 164](#rule-164) — A quarantine release that cannot reach a FortiGate still releases, remembers the gate, and keeps trying

## Rule 164 — A quarantine release that cannot reach a FortiGate still releases, remembers the gate, and keeps trying

**How it was found.** The 2026-11-11 orphan audit looked at what Polaris writes onto other systems and can then lose track of. A quarantine is a MAC block pushed to every FortiGate that has recently seen the device. Releasing it un-pushes the block from each of those gates and restores the asset's status and monitoring. The un-push is best-effort by design: `releaseQuarantine` collects the gates it could not reach in `failedToUnpush`, restores the asset anyway, and sets `quarantineTargets` to `[]`.

So after a release with one unreachable gate, Polaris held nothing that said the block was still there. The asset read `active`. Its target list was empty. The device was still blocked at one site. The only trace was a warning Event — and Events are pruned after the retention period, seven days by default — and nothing ever tried that gate again. A week later there was no record anywhere, in Polaris or its Events, of why a "released" device could not get on the network in one building. The same happened, permanently, for a gate reached through an integration that had been deleted while the quarantine was active.

**The decision (operator, 2026-11-11).** I first defaulted this to "keep the asset quarantined until every gate has released", and on reading the code put it to the operator as a real choice instead, because that default changes what the release API returns to SIEM clients and leaves a device unmonitored (a quarantined asset's monitoring is parked, rule 10). Three options: **release, remember, retry**; stay quarantined until all clear, with an override; or leave it as it is. The operator chose the first.

**What it does.**

- **Release is unchanged for the caller.** The asset is restored, the response is the same `{ assetId, newStatus, unpushedFrom, failedToUnpush, message }` with a 200, and a SIEM integration that calls release sees what it always saw.
- **The gates that still hold the block are remembered on the asset**, in a new column `Asset.quarantineStranded`: for each, the FortiGate, the integration it was reached through, the reason, when it first failed, when it was last tried, and how many attempts so far. A gate whose integration no longer exists is remembered too — it can never be retried, but it must still be visible.
- **Polaris retries on its own.** `jobs/retryStrandedQuarantine.ts` runs every 15 minutes and retries each entry whose backoff has elapsed: 15 minutes after the first failure, doubling, capped at six hours. A gate that was down for a maintenance window clears within minutes of coming back; one that is gone for good costs four attempts a day until someone dismisses it. An entry already absent from the device counts as cleared (the un-push has always treated absence as success).
- **The operator can act.** The asset's Quarantine tab shows a "Still blocked on N FortiGate(s)" section — whatever the asset's status, since it is no longer quarantined — with **Retry** (try now) and **Dismiss** (stop tracking, without touching the device). Dismiss is for a gate that is gone for good, or once the entry has been removed there by hand; it confirms first and is written to Events at warning, because after it Polaris no longer knows the block may exist.
- **A new quarantine supersedes it.** If the asset is quarantined again and the push reaches a gate that was stranded, that gate holds the block on purpose again and comes off the stranded list.

**Why a column and not `quarantineTargets`.** The existing list means "where this asset IS quarantined", and code reads it that way: the drift check, the status endpoint, the token-scope guards, the panel's target table. Leaving entries in it on an asset whose status is `active` would have every one of those readers describing a quarantine that is not in force. A stranded entry is a different fact — a leftover on a device Polaris could not reach — so it has its own list, and `status` and `quarantineStranded` are independent.

**Why the write lives in one module and the reads in another.** `releaseQuarantine` (in `assetQuarantineService`) writes the list through the pure helpers in `utils/quarantineStranded.ts`. The retry and dismiss live in `quarantineStrandedService`, which imports the un-push and the transport builder; if the quarantine service imported it back there would be a cycle. The retry re-reads the row before it writes and folds its outcome into whatever is stored then, so a dismiss or a second release that landed while the gates were being called is not overwritten.

**Permissions.** Retry and Dismiss take the release gate: `assetsQuarantine:write` with the asset in the caller's write scope (rule 141(e)). A bearer token scoped to some integrations may only touch gates reached through them, exactly as it may only release a quarantine it could have made (rule 114(d)).

**What it does not do.** It does not re-block anything, and it does not change who may quarantine. It does not cover an asset that is DELETED while it has stranded entries — the list goes with the row and the block stays on the device, unrecorded; quarantined assets cannot be deleted, but a released one with stranded entries can. That, and a quarantined ghost merged away, are tracked in `docs/ORPHAN-AUDIT-LEDGER.md`. Stranded entries from releases made before this rule are not recoverable: the Events that recorded them carry no reliable pointer back to a gate, and most have been pruned.

**Deployment shapes and scale.** FortiManager and standalone FortiGate take the same path: the transport is built by `buildTransportForIntegration`, which dispatches on the integration type. The job runs in the web / all role only, since it calls devices. On an install with nothing stranded — the normal state — a tick is one read that returns no rows; the column is `[]` on every asset and the read selects only the id. Each stranded asset costs one or two device calls per due attempt, at most four a day once the backoff is at its ceiling.

Pinned by `tests/unit/quarantineStranded.test.ts` (the list, the backoff, the panel section) and `tests/integration/quarantineStranded.test.ts` (release, retry, the background pass, dismiss, token scope).
