# Business rule 167 — full narrative

> Written 2026-11-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 167](#rule-167) — A thing something still uses is not deleted: the delete says who uses it

## Rule 167 — A thing something still uses is not deleted: the delete says who uses it

**How it was found.** The 2026-11-11 orphan audit's last batch was the leftovers an operator CAN remove by hand, but that nothing tells them about. Four of them have one shape: a registry object is referenced by a bare id inside a JSON column or a plain string column, with no foreign key, and deleting the object left the reference pointing at nothing.

- **A notification channel** (E.1). Notify actions name channels by id. `deleteChannel` checked nothing. The automation kept firing, its alert was raised, and the delivery was skipped. Nothing on the automation's page, in Events or in the alert said that the page nobody received had nowhere to go.
- **An automation script** (E.2). The delete did have a guard, written when an action could live in two places: a rule's own actions and its rule-level escalation tiers. Actions now live in eight (per-action tiers, each severity band's actions and tiers, the all-clear list, reset actions and their escalation-reset overrides), and on alert groups as well as automations. A script named in any of the other six could be deleted out from under it.
- **A MIB** (E.3). An asset, and a class monitoring setting, can pick a MIB per stream (six columns each). A deleted MIB stayed selected; the picker showed a blank and the stream fell back to whatever the resolver does with an id it cannot find.
- **A credential** (E.4). `deleteCredential` already refuses for assets, class settings, integration defaults and path checks. A Discovery lists the credentials it tries in `NetworkScan.methods[].credentialIds` — JSON — and that was not checked, so a Discovery went on running with a method that could no longer authenticate.

**The decision.** The existing precedent on three of the four services is to refuse the delete and name the users (the credential guard, the script guard, the path-check restriction), and it matches the operator's preference through this audit for a visible, deliberate act over a silent one. The alternative — delete and strip the references — would quietly change what an automation does or how a device is polled, on the say-so of someone who was deleting something else. So: **the delete answers 409 and says who still uses it.** The operator repoints those, then deletes.

**What it does.**

- `actionReferenceService.findActionReferrers(match)` loads every automation and alert group once and walks each through `allRuleActionRefs`, the canonical walk over every place an action lives (a pre-v2 rule's legacy targets are folded in by `normalizeRuleToV2` first). `scriptReferrers` and `channelReferrers` are predicates over it; the channel one also counts firmware upgrades and reboots that are still booked and list the channel for their notices. Because it rides the one walker, a ninth action location added there is covered here with no change — which is exactly how the script guard fell behind.
- `deleteScript` and `deleteChannel` refuse with the referrers' names (five, then "+N more").
- `deleteMib` refuses while any of the six stream columns on an asset or a class setting holds the MIB, naming up to five assets and counting the class settings.
- `deleteCredential` gains the Discovery check. A PUBLIC Discovery is named; a private one is only counted, because a private Discovery's name belongs to its owner and a 409 that names a row the caller cannot see is a disclosure (the reasoning already recorded on `NetworkScan.name`).

**What it does not do.** It does not repair references that already dangle on an existing install: an automation whose channel was deleted last year still delivers nothing. Finding and showing those is a separate piece, open in `docs/ORPHAN-AUDIT-LEDGER.md` with the rest of batch E (a rule whose `dimensionFilter` names a deleted check, widget or probe; tag and region renames not carried into condition trees; and the others). It does not stop a channel being DISABLED, which is a deliberate, visible state.

**Scale.** Each check runs only on a delete. The automation walk is two unpaged reads of small tables (automations, alert groups); the MIB check is two indexed-or-small counts and a five-row read; the Discovery check reads the Discovery table once.

Pinned by `tests/unit/actionReferenceService.test.ts` (one case per action location, for a channel and for a script), `tests/unit/automationScripts.test.ts`, `tests/unit/credentialUsage.test.ts` and `tests/integration/deleteGuards.test.ts`.
