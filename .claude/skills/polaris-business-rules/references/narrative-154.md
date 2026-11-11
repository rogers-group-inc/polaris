# Business rule 154 — full narrative

> Written 2026-11-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 154](#rule-154) — A command queued for an agent runs soon or not at all

## Rule 154 — A command queued for an agent runs soon or not at all

**How it was found.** An audit on 2026-11-11 asked what Polaris creates automatically that an operator cannot remove through the UI once the thing it belonged to is gone. The most serious answer was the agent command queue. An automation's script action that targets the agent (`automationScriptService.requestScriptRun`) writes an `AgentCommand` row carrying the whole script body, and the agent collects it on its next poll (`agentCommandService.fetchPendingCommands`). That read selected on the agent and `status = "pending"` and nothing else.

So a script queued while the host was unreachable waited. There was no expiry, no cancel button, no cancel route, and no code anywhere that deleted an `AgentCommand` row. The script ran — as root on Linux at the ptrace tier, as LocalSystem on Windows — whenever the host next polled: hours or days later, after the alert had cleared, after the automation had been disabled, edited or deleted. Repeated fires and escalation tiers queued more copies. The preflight in `requestScriptRun` requires `installStatus = "active"`, which says the agent is installed, not that it is listening, so an offline host passed it.

This is the worst kind of late action: a remediation script is written for the situation that raised the alert ("the service is hung, restart it"; "the disk is full, clear the cache"), and running it against a host that has since recovered, been repaired by hand, or been repurposed is at best noise and at worst an outage Polaris caused. The reboot path already knew this — rule 115 withdraws a reboot command the agent does not pick up within `agentAckMs` (150 s) — but the script path had no equivalent.

**The decision.** A queued command is good for a fixed window, `AGENT_COMMAND_TTL_MS` (15 minutes), and after that it is dead. Three pieces:

1. **The gate.** `fetchPendingCommands` selects only commands requested inside the window. This is the part that makes the rule true: it holds on every process role, between sweeps, and even if the sweep never runs. It applies to every action; a reboot's own 150 s withdrawal is shorter and unaffected.
2. **The settlement.** `expireStaleAgentCommands` marks expired commands `failed` (with the reason), fails the linked `AutomationScriptRun` with one warning `automation.script.run` Event (`reason: "expired"`), and times out a run the agent took but never reported (`timeoutSec` + `AGENT_RUN_RESULT_GRACE_MS`, 5 minutes). Without it the run history showed `pending` or `running` forever — the stuck sweep in `automationScriptRunner` covered `runOn: "server"` only, and `pruneOldRuns` deletes only finished runs, so those rows were never pruned either. It rides the script runner's tick, throttled to once a minute.
3. **The retention.** `pruneOldAgentCommands` deletes non-pending commands older than `AGENT_COMMAND_RETENTION_DAYS` (90, matching script runs). Each `run_script` row holds up to 64 KB of script body, and the table had no retention at all.

**Why 15 minutes.** An online agent polls every ~20 s and is woken over its WebSocket the moment a command is queued, so a healthy host picks a command up in seconds. The window has to cover a reboot in progress, a short network blip and an agent restart during an upgrade — minutes, not hours. It must not cover "the host was off overnight". Fifteen minutes is the same order as the holds Polaris takes for its own operations (rule 80) and comfortably longer than the reboot acknowledgement.

**Why not tie it to the alert.** Withdrawing a command when its alert clears looks more precise and is wrong: a script on a reset or resolved action list is queued *because* the alert cleared. The alert's state is not a proxy for whether the script is still wanted; elapsed time is.

**Why not a cancel button instead.** A cancel button helps only an operator who knows a command is queued and is watching. The failure this rule closes is the one nobody is watching: the host comes back at 03:00. A cancel control can be added on top; it cannot replace the expiry.

**What it does not do.** It does not re-queue. An automation that still wants the script fires again while its condition holds (a reminder, an escalation tier, or the next trigger), and that fire is judged against the host as it then is. A late result from an agent that was slow rather than gone still overwrites a `timeout` with what actually happened (`recordCommandResult`).

**Deployment shapes.** The gate is a plain `WHERE` and needs nothing from the host. The sweep runs where the script runner runs (the web / all role, `runsSchedulers`); a split-role install loses nothing on the monitor or discovery processes because they never deliver commands — the agent's poll lands on the web role. At 2000 assets the sweep's cost is proportional to commands that expired since the last minute, never to the fleet: one `updateMany`, two bounded `findMany` (500 rows), batched writes.

Pinned by `tests/unit/agentCommandExpiry.test.ts` and `tests/integration/agentCommandExpiry.test.ts`.
