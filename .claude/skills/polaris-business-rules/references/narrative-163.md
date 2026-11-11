# Business rule 163 — full narrative

> Written 2026-11-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 163](#rule-163) — An agent is never left on a host silently: deleting its asset warns, offers the uninstall, and records what stays

## Rule 163 — An agent is never left on a host silently: deleting its asset warns, offers the uninstall, and records what stays

**How it was found.** The 2026-11-11 orphan audit looked at what Polaris leaves outside its own database. The clearest case was the Polaris Agent. `ManagedAgent` has a cascading foreign key to its asset, so deleting the asset — from the row menu, the edit modal or the bulk delete — removed the agent's row, and with it the bearer token, the Agent card and its Uninstall button. Nothing touched the host. The binary, the systemd unit or Windows service, `agent.conf` with its now-dead token, and (where it had been granted) the reboot marker and polkit rule all stayed installed and running. The agent kept calling home and being refused with 401, indefinitely; the daemon does not uninstall itself on a 401. The only code that removes those files is the uninstall script, and the only way to run it from Polaris had just been deleted along with the record.

The delete routes guarded two things — a quarantined asset is refused, a managed switch or AP gives its reservation back first — and said nothing about an agent. The same thing happened, less visibly, on a merge: when both records have an agent the survivor keeps its own and the absorbed record's agent row cascades away.

A third leftover sat beside it. `agentChannelService.detach` handles a `"revoked"` reason, but nothing ever passed it: revoking a token, force-removing an agent and deleting the asset all left the agent's WebSocket session and its 30-second ping timer alive until the agent stopped or the web role restarted, and the eventual disconnect Event named a record that no longer existed.

**The operator's decision (2026-11-11).** Three options were offered: refuse the delete until the agent is uninstalled, uninstall as part of the delete, or warn and proceed. The operator chose none of them as stated, and wrote instead: *warn about the agent, but offer to attempt to uninstall it first; if it succeeds, good; if not, inform the user and ask whether to continue with the delete.* That is the rule.

**Why the conversation lives in the browser.** An uninstall is asynchronous: `DELETE /assets/:id/agent` revokes the token at once, starts the remote work in the background, and the row either disappears (success) or lands on `uninstall_failed` with the reason. A server-side "delete, uninstalling first" would have to hold a request open for minutes or invent a job to report back — and it still could not ask the operator the question the decision turns on. So the three delete paths call one browser function, `confirmAssetDeletion(ids, plainMessage)` in `public/js/assets-panel.js`:

1. It asks the server which of the assets have an agent (`POST /assets/agent-hosts`). With none, it is the plain confirm the delete always had.
2. With any, a dialog names them and says what deleting the record does and does not do. **Uninstall, then delete** is the primary action; **Delete anyway** and **Cancel** are beside it.
3. Choosing the uninstall starts it on each agent host (four at a time on a bulk delete) and polls the agent until its record is gone, it reports `uninstall_failed`, or three minutes pass. Nothing is deleted while this runs.
4. If every uninstall succeeded the delete follows by itself. If any failed, a second dialog lists each host with the reason, says plainly that nothing has been deleted, and asks: **Cancel**, **Delete anyway**, or — on a bulk delete — **Delete the other N only**, which deletes everything except the hosts whose agent is still there.

Closing a dialog at any stage (the X, Escape, an off-click) is a cancel. The dialogs are stacked overlays (`buildOverlay`), not the shared modal, because one of the callers is the edit modal: a cancel must land the operator back on their unsaved edits, exactly as the plain confirm did.

**Permissions.** Deleting an asset is `assets:write`; uninstalling an agent is `agentDeploy:write` (rule 43a), a narrower grant. An operator who can delete but not deploy sees the warning with the uninstall button locked and the reason stated, and can still delete — the decision is theirs, and now it is an informed one. The agent lookup is `assets:read`: it says nothing the Agent card does not.

**The record.** The server never refuses the delete — an API client, or an operator who has decided, may leave an agent behind. What it guarantees is that this is never silent. `assetWriteService → deleteAsset` and `bulkDeleteAssets` read the agents BEFORE the delete (afterwards nothing knows one was there) and then call `agentOrphanService.recordAgentsLeftOnHosts`, which closes each agent's session and writes one warning Event per host, `agent.left_on_host`, naming the host, the reason, the agent version and its install state. `assetMergeService → mergeAssets` does the same for the absorbed record's agent when both sides had one; a merge that MOVES the agent to the survivor strands nothing and records nothing. The Event is filed against an `agent` resource, not the asset: the asset id no longer resolves, and an Event pointing at a deleted record cannot be opened.

If the operator took the uninstall and it succeeded, the agent row is already gone when the delete runs, so no Event is written — correctly, since nothing was left.

**Closing the session on revoke.** `agentTokenService.revokeBearer` now detaches the agent's WebSocket session, passing the `"revoked"` reason the channel already knew how to log at `info`. That covers the uninstall, the force-remove and — through `recordAgentsLeftOnHosts` — the asset delete and merge. Sessions live in the web role, which is also where every one of those calls is made.

**What this does not do.** It does not uninstall anything without being asked. It does not cover a decommission, where the record and the agent both stay and rule 123 owns what happens next. It does not reach the two automatic ghost merges or the conflict-resolution absorb, where an absorbed record carrying an agent the survivor also has would still be dropped unrecorded — both are rare (an endpoint ghost has no agent) and are tracked in `docs/ORPHAN-AUDIT-LEDGER.md`. And it does not help with an agent already stranded by a delete made before this rule: there is no record of those to act on.

**Deployment shapes.** Nothing here depends on how Polaris is installed or how users sign in. The uninstall itself needs the host reachable over SSH or WinRM with a credential on file, which is exactly why its failure is an expected branch with its own dialog rather than an error.

Pinned by `tests/unit/assetDeleteAgentDialogDom.test.ts` (the conversation) and `tests/integration/agentLeftOnHost.test.ts` (the lookup, the Event on delete / bulk delete / merge, the revoke).
