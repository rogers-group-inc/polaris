# Business rule 123 — full narrative

> Written 2026-10-20 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 123](#rule-123) — An agent host's pinned identities are archived while it is decommissioned, and its agent's return is a question, not a reinstatement

<a id="rule-123"></a>

## Rule 123 — An agent host's pinned identities are archived while it is decommissioned, and its agent's return is a question, not a reinstatement

**The incident.** An operator's agent install on a Windows host failed with
`Host denied (verification failed)` on the agent card. They asked whether the
SSH keys Polaris generates were broken. They were not: that is ssh2's message when
the `hostVerifier` callback answers false, i.e. rule 21 / 113(a) refused because
the host key presented at that address did not match the one pinned for it. The
pin is keyed by the ADDRESS Polaris dialed (`SshHostKey`, unique `host, port`, no
Asset relation), so anything that puts a different SSH server on a pinned address
— a rebuilt host, a reinstalled OpenSSH capability, or an IP handed to another
machine — is refused until someone deletes the pin under Pinned server identities.
That page lives in Server Settings, which an asset operator rarely visits, and
the asset itself showed no thumbprint at all.

**The ask.** When an asset that had an agent is decommissioned, the warning should
say that its pinned SSH thumbprint is decommissioned too; the Sources tab should
show the thumbprint; and if the decommissioned asset's agent connects again, a
conflict should ask about reinstating the thumbprint. Decided with the operator
(2026-10-20), each from offered options:

- **Archive, not delete.** The live pin leaves `ssh_host_keys` (so a reused address
  pins afresh instead of refusing), but its fingerprint is kept on the agent row so
  the conflict can offer "reinstate this exact key". Deleting outright would leave
  the conflict nothing better than trust-on-first-use again.
- **WinRM certificate pins too.** Windows agents install over WinRM, whose
  `TlsCertPin` has the same address-keyed shape and the same failure mode, so the
  two are archived and reinstated together.
- **Accept = restore pin + reactivate.** The conflict's Accept sets the asset back to
  `active` and reinstates; monitoring stays off (decommission clamped it, rule 10),
  because turning polling back on is a separate operator choice.
- **The Sources tab's Polaris Agent card shows them**, live or archived.

**Why "exactly while decommissioned", not "at the decommission click".** Status is
written by many paths: the asset PUT route (edit form, bulk State menu, phone),
`decommissionStaleAssets`, the directory / workload / Generic API decommission sweeps,
`maintenanceScheduleService`. Hooking each would be eight call sites and a ninth one
forgotten later. So the invariant is a STATE — archive held ⇔ asset decommissioned —
held by two writers: the PUT route at the moment of the change (so the operator sees
the effect immediately) and `reconcileAgentHostPins` every 10 minutes for the rest,
which is also what makes the rule symmetric: an asset any path brings back gets its
pins back. Both writers claim the transition with a conditional `updateMany` on
`hostPinsArchivedAt` inside the transaction, so the PUT hook and the job never both
archive or both reinstate.

**Why an address another live asset answers to is left alone.** The pin protects
whatever answers there. If two records share an address (rule 40's duplicate-IP
state, or a hostname another asset also carries), archiving because ONE of them was
decommissioned would lower the other's guard. Decommissioned assets don't count —
they are the ones giving addresses up.

**Why reinstating never overwrites.** While the asset was away, another machine may
have been given the address and pinned its own key. Overwriting that with the old
key would make Polaris refuse the machine actually there, which is the incident in
reverse. The skipped endpoints are reported on the reinstate Event (warning level)
and comparing them stays the operator's call under Pinned server identities.

**Why the check-in is a conflict, not an automatic reactivation.** An agent
presenting its bearer proves only that the agent.conf still exists somewhere — a
cloned VM, a restored backup, a box someone forgot to wipe. Whether that is "the
host is back" is a human fact. So `verifyBearer`, the single choke point every
agent HTTP and WebSocket request passes, selects the one extra column and — when the
archive is held — calls `noteArchivedAgentCheckin`, throttled per agent per process
and fire-and-forget so it never slows or fails an agent request. One pending
conflict per asset is refreshed with the latest check-in address rather than
duplicated. Reject keeps the asset decommissioned and is keyed on the archive's
timestamp, so the same decommission stays quiet while a later decommission (a new
archive) may ask again. Accept changes the asset's status, so beyond
`discoveryConflicts:write` it takes the `assets:write` the edit form takes.

**Why the warning is a preview endpoint.** The bulk State menu can decommission
hundreds of rows; one `GET /host-pins` per row would be hundreds of requests before
a confirm dialog. `POST /assets/decommission-preview` answers for the whole selection
with one query per pin table, and returns agent hosts only — a selection with none
shows the same confirm it always did. A failed preview never blocks the change; the
server archives regardless.

**Rejected alternatives.**
- *An Asset FK on `SshHostKey`.* The table's own comment says why not: a host is often
  pinned before it exists as an asset, and the key is the address dialed.
- *Archive every decommissioned asset's pins, agent or not.* Out of scope by the ask,
  and the archive needs a row to live on; an agentless host's pins stay where they are.
- *Revoke the agent's bearer on decommission.* Would make the check-in invisible —
  the very signal the conflict is built on — and uninstalling stays the explicit verb
  on the Agent card.
