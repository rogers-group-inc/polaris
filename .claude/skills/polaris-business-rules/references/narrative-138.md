# Business rule 138 — full narrative

> Written 2026-11-02 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 138](#rule-138) — A live firmware flash can be aborted, and nothing that restarts Polaris goes ahead while one is live unless the operator aborts it

<a id="rule-138"></a>

## Rule 138 — A live firmware flash can be aborted, and nothing that restarts Polaris goes ahead while one is live unless the operator aborts it

**What prompted it (2026-11-02).** A FortiSwitch 124E-FPOE was flashed 7.6.6 → 7.6.8 from its
asset card. The run log stopped at "session expired during the flash — signing in once more"
(14:41Z), and at about 15:00Z the card said "failed at deploying: Polaris restarted during the
upgrade; the device may still be flashing — verify its version by hand". The switch was in
fact on 7.6.8: the flash had worked and only the run had died. The web process restarted 25
minutes into a run that had a 30-minute budget, the boot sweep (`failOrphanedFirmwareRuns`) did
what it is for, and the maintenance window ended at the restart, not at any timeout.

Nothing anywhere had said a flash was running. A discovery shows in the nav bar's operations
panel from every page, and the in-app updater asks "a discovery is running — abort it and
continue?" before it restarts Polaris. A flash, which restarting kills far more expensively,
had neither.

The operator's words: "when a firmware is being updated, add the status of the upgrade to the
nav bar, just like discoveries. include the asset name, the person performing the upgrade, and
the step that it's on. include an abort button. when performing an in-app update warn the user
that a firmware upgrade is in progress and ask if it should be aborted to continue. update the
logs of the update if it was aborted and by whom it was aborted".

### The decisions

- **The panel is the discoveries' panel.** The firmware rows go in `#query-status` beside the
  running discoveries and the client queries, with the same Abort ✕, so there is one place to
  look for "what is running". Each row: *Upgrading <asset> → <version>* (the asset name opens
  its slide-over), then *by <who> · <stage>* and, for a FortiSwitch, the flash's own percent.
  Read at `assets:read` — whoever can open the asset can watch its flash; the ✕ only at
  `assets:write`, the grant that starts one (rule 43(g)). The poll is self-paced like the
  update panel's: 5 s while a flash is live, 15 s otherwise, nothing while the tab is hidden;
  the card nudges it when it starts a flash. At 2000 assets the read is one indexed query on
  `status` returning a handful of rows, never the 500-line `log`.
- **Abort stops Polaris; it cannot stop a device.** The confirm, the log, the error and the
  Event all say so once the device has been told to flash: from `deploying` on, and on a
  FortiGate / FortiAP once the upload reached 100 % (the upload IS the trigger on those). Before
  that the device is untouched — a FortiSwitch that had the image staged is un-staged — and
  the messages say it still runs its old firmware.
- **`failed` / `aborted`, not a new status.** The run's `status` stays in the four-value
  vocabulary every consumer already reads (the card, the group executor's member states, the
  booked-run email's outcome map, the Events calendar, the phone); `result` carries `aborted`
  and `error` names the aborter. A new status would have had to be taught to all of them for no
  behaviour any of them wants to differ: an aborted member skips what is upstream of it exactly
  as a failed one does.
- **The hold is released at once.** The operator asked Polaris to stop, and the usual reason is
  to restart it — a hold left open would only expire 45 minutes later. The cost, said in the
  confirm, is that a device still flashing may alert as it reboots.
- **The abort is cooperative, but not slow.** The engines already took an `AbortSignal` and
  checked it between stages, but nothing passed one, and `sleep` RESOLVED on abort — so a
  signal would have turned every poll loop into a hot spin against the device until its
  deadline. `sleep` now rejects with an `AbortError` (which each engine's catch already reports
  as "cancelled"), `DeviceHttpClient` destroys the request in flight on abort (an upload
  included), and the recovery wait (`holdRecoveryWait`, shared with reboots) ends on it. An
  aborted request rejects with an `AbortError`, never a `DeviceConnectionError`: the engines
  read a dropped connection on deploy as "the flash has started", which an abort is not.
- **The abort answers with the run as it ended.** `abortFirmwareRun` waits (≤ 30 s) for the
  runner to write its terminal row, so the updater that called it restarts onto a finished
  run, not an orphan. The runner is found through an in-process registry (`liveRuns`) filled
  BEFORE `setImmediate` schedules the runner, so an abort between the 202 and the first tick
  still reaches it. A run in the table that no runner is driving (a restart already orphaned
  it) is closed directly, saying so.
- **The updater and Restart refuse on the server, not only in the browser.** `POST
  /updates/apply` and `/restart` answer 409 `firmware-upgrade-running`, naming each run, its
  stage and who started it; only `abortFirmwareRuns: true` lets them through, and then every
  live run is aborted in the CALLER's name with the reason ("to apply an in-app update" / "to
  restart Polaris"). The browser asks first when it can list the runs, and falls back to the
  409 when it cannot (a role with Server Settings → Data but no `assets:read`). The routes' own
  gate is enough to abort: whoever may restart Polaris may stop what the restart would kill.
  Restart is covered as well as the update because it kills a flash just the same.

### What is deliberately not here

- A pause, or "abort and keep watching". The device does not pause, and a Polaris that keeps
  watching is exactly what a restart cannot do.
- The command-line updater (`deploy/update-linux.sh`). It runs outside the app and stops the service
  regardless; the boot sweep still names what it orphaned.
- A group upgrade's next member. Aborting one member does not cancel its group; an operator who
  wants the group to stop cancels it as before (rule 122). A group tick between the abort and
  the restart could start another member, which the restart then orphans.
