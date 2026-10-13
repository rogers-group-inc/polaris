# Business rule 112 — full narrative

> Written 2026-10-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 112](#rule-112) — A device reboots only on an opt-in held where the authority lives, and a reboot Polaris sends is proved, not assumed

<a id="rule-112"></a>

## Rule 112 — A device reboots only on an opt-in held where the authority lives, and a reboot Polaris sends is proved, not assumed

### Where it came from

An operator request (2026-10-13): reboot FortiGates, FortiSwitches, FortiAPs and agent-managed servers and workstations from the asset, now or on a schedule, with every reboot on the record. Before this, nothing in Polaris rebooted a device on purpose — a firmware flash (rule 87) rebooted one only as a side effect, and the agent's process-control verbs had been removed outright (the Satellite posture). A reboot is the most disruptive thing Polaris can do to a device short of a flash: a FortiGate takes every network, tunnel and VPN user behind it down for minutes, a switch every port.

### The decision

**The opt-in sits with the thing that holds the authority, not with the button.** The `assets:write` grant decides WHO may press the button — the firmware precedent (rule 43(g)): whoever may edit an asset may take it down on purpose. WHETHER a device can be rebooted at all is decided where the power to do it lives:

- **A stored credential** carries `allowReboot` — only the three kinds that can reboot a Fortinet box (SSH: `execute reboot`; a REST API token: `system/os/reboot`; a device admin login, the firmware repository's `http` form login). SNMP and WinRM refuse the flag rather than store a promise nothing can keep, and an http credential switched off form login drops it with the login. Flipping it is named on the `credential.updated` Event at warning level.
- **The FortiManager / FortiGate integration** carries `allowReboot` for its own API token, identical on both dialogs (the parity convention). Without it, a fleet discovered through FortiManager — most of the managed estate, whose gates carry no per-device credential — could not be rebooted at all, and the alternative of a per-gate credential for every device was the burden the integration token exists to remove.
- **An agent host** carries the opt-in ON THE HOST. The Linux agent runs as the hardened DynamicUser with NoNewPrivileges and no CAP_SYS_BOOT (`utils/agentUnit.ts`), deliberately unable to reboot anything. The opt-in grants exactly one thing through the mechanism the OS already has for it — a polkit rule letting the `polaris-agent` user (or unit) ask systemd-logind to reboot — plus a root-owned marker the agent requires before it acts. CAP_SYS_BOOT was rejected: `reboot(2)` is an immediate, unclean restart with no shutdown, and the capability cannot be scoped. A reinstall was rejected as the way to change it: the unit is untouched, so turning reboots on or off later is one short script over the stored install credential (`agentRebootPermissionService`). On Windows the service is LocalSystem and could reboot regardless, so the marker is the opt-in rather than a privilege boundary. `rebootCapable` is what the agent REPORTS (marker present and logind's `CanReboot` = `yes` for it), so the button is offered only when the host says the rule took.

The first opt-in that applies wins, in that order, and the run records which one (`RebootRun.authority`), so the Event says who could do it as well as who did.

**A managed switch or AP is restarted through its gate.** A FortiAP's own web UI is normally disabled once a FortiGate manages it, and a FortiLink switch's local login is rarely set up. The gate's `managed-switch/restart` and `managed_ap/restart` reach both. The gate's API is addressed by the child's `controllerFortigate` NAME (fortinetParentKey's header: an API call keeps the name); the gate asset is resolved only to find a stored credential and to label the run. The restart takes the switch's NAME (`mkey` = its switch-id), which a FortiLink fleet may rename away from the serial, so the run looks the device up on the gate by serial first — which also proves the gate manages it now. The gate's HA state is irrelevant there: only the child reboots.

**An HA FortiGate is refused** (the rule-87 posture): rebooting one member fails the cluster over, which Polaris does not orchestrate. Refused at the click from discovery's stamp, and again from the gate's own `system/ha` when the run starts — an unreadable HA mode is a refusal, not a guess.

**The device that answers must be the asset.** A direct reboot reads the box's serial first and refuses a mismatch — an address reassigned since discovery must not reboot whatever now holds it.

**Sent is not done.** A reboot request is the one call whose answer may never arrive: the box can drop the connection as it goes down. So the send distinguishes a clear refusal (an HTTP error, an auth failure, a CLI error — `failed`) from a lost answer (watch and see), and the run is `succeeded` only on PROOF the device cycled: its boot time moved (FortiOS `web-ui/state` → `utc_last_reboot`; the agent's reported `bootTime`), its controller saw it drop and rejoin (or its FortiLink `join_time` advanced), the SSH port closed and reopened, or monitoring's own uptime check moved `Asset.lastRebootAt` past the start. Accepted but never seen to go down is `unverified` — the operator is told to check the device rather than told it rebooted.

**Polaris causes the downtime, so it holds the alerts** (rule 80): a `device-reboot` hold, taken when the run starts, just before the request goes out (a booking takes nothing until it fires), extended while the run watches, kept until the device's own monitoring answers (`holdRecoveryWait`, shared with the firmware runner), released before the terminal Event so a failure can alert; an agent's reattach releases it too, and its 20-minute cap covers a run nothing is watching any more.

**An unacknowledged agent command is withdrawn.** The agent polls; an offline host would pick up a queued reboot whenever it returned — hours later, at a time nobody chose. A command not picked up within `agentAckMs` is marked failed so it never ships, and the agent reports its acknowledgement BEFORE it takes the host down (there is no one left to say so afterwards).

**A booking is the rule-93 shape**: approved when booked (something may reboot the asset), judged when it fires (every gate again), on time or not at all (15 min late = missed), a related live reboot makes it wait, and its recipients hear the outcome either way.

### Alternatives rejected

- **A single `reboot` permission key.** It would decide who may press the button, which `assets:write` already does; it would not answer whether a given device may be rebooted, which is the question that needed answering per credential, integration and host.
- **Rebooting a managed switch or AP over its own login.** Fails exactly where a reboot is most often needed — a misbehaving AP whose local UI is off.
- **Trusting the 200.** A FortiGate accepts `system/os/reboot` and then, rarely, does not reboot; a lost answer is common because it does. Neither can be told apart without watching.

### Lab validation (2026-10-13)

FortiOS 7.6.7 build3704 and 8.0.1 build245 (the 5-gate lab): the three REST endpoints exist on both (405 to GET, from the gate's own `/api/v2/monitor/?action=schema`, which also gave the parameter names); the CLI forms `execute switch-controller switch-action restart swtp <switch-id>` and `execute wireless-controller reset-wtp <serial>` from the CLI's `?` help. Rebooted through Polaris, every one `succeeded` on proof: a FortiLink FortiSwitch (gate saw it go Idle → Connected) and a CAPWAP FortiAP (its `join_time_raw` advanced) through their HA gate with the integration token; a standalone FortiGate over REST with the integration token (`utc_last_reboot` moved), over the SSH CLI (its SSH port closed and reopened) and over the device admin login; a booked reboot fired by the job ~20 s after its time, its missing email channel recorded on the booking; the HA gate itself was refused. On a MONITORED gate the `device-reboot` hold put the asset in maintenance with a "Reboot" window the moment the run started. Two corrections the lab forced: a managed switch's `join_time` is a date STRING (an AP's `join_time_raw` is epoch seconds), and the admin-login link must sign in again after the reboot — the first run carried the dead pre-reboot session, read every refusal as "still down" and failed a gate that had come back. A lab gate's clock ran ~7 min behind, which is why proof compares the device's boot time with its OWN earlier value, never with Polaris's clock.
