# Business rule 93 — full narrative

> Written 2026-10-06 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 93](#rule-93) — A booked flash is approved when it is booked and judged when it fires — on time or not at all, and its recipients hear the outcome either way

<a id="rule-93"></a>

## Rule 93 — A booked flash is approved when it is booked and judged when it fires — on time or not at all, and its recipients hear the outcome either way

### The ask

2026-10-06. The operator asked to "add a button to the upgrade card to schedule an upgrade;
the user picks a date and time; when it finishes, successful or failed, they get an email with
the results; cancel and change the date/time". Rule 87 had only the click-to-run flash, which
means an operator who wants a switch upgraded at 2 am has to be awake at 2 am. Asked who the
email goes to, the operator chose: the scheduler's own profile email, plus any extra addresses
they type — and a booking with no address at all is refused, because a flash nobody hears about
is exactly the unattended change this feature must not create.

### Approved at booking: rule 87 does not get weaker because the flash is later

Rule 87's spine is "never an image nobody approved by name". A booking keeps it: the booking
dialog is the same approval dialog (the same image facts, the same backup radio, the same
checkbox), the `imageId` is REQUIRED, and `checkSchedulableUpgrade` runs the same image gates
`startFirmwareUpgrade` runs (both through the one private `approvedImageFor`) plus the check
that a device-admin login is bound. What is booked is *that image*, not "whatever is newest
then". So a newer primary uploaded after the booking does NOT get flashed in its place: when
the booking fires, `startFirmwareUpgrade` re-takes every gate, the booked image must still be
the offered primary or the eligible backup, and if the rotation has moved it the booking is
`refused` and the recipients are told why. Silently retargeting would be flashing an image
nobody approved for this device.

### Judged when it fires: health and topology belong to the moment of the flash

The booking deliberately does NOT take the device's health or topology gates. A switch that is
down at 3 pm may be fine at 2 am, and the reason for booking a 2 am flash is often precisely
that the afternoon is not a good time. Refusing the booking on the afternoon's state would make
the feature useless for the cases it exists for. Instead `checkSchedulableUpgrade` returns
today's `healthBlockers` as `warnings`, and the modal prints them ("checked again when the
upgrade is due — if it still holds then, the upgrade is not started and the recipients are told
why"). When the job fires a booking it goes through `startFirmwareUpgrade` with no shortcut, so
every gate — health, login, one live run per asset, topology, the file on disk — is taken at
the moment it matters.

### On time or not at all

`LATE_GRACE_MS` is 15 minutes. The job ticks every minute, so a booking is normally started
within a minute of its time; one first seen more than 15 minutes late means Polaris itself was
not running at the booked time (an update, a host reboot, an outage). It is then `missed`, not
started. The operator chose that time because it is a window — after hours, inside a change
slot — and a flash hours outside it is not the flash they approved. They are emailed, and can
book again.

### A conflict waits; everything else is final

Operators book batches: twelve switches in one closet for 02:00. Rule 87's topology gate
refuses a flash while a run is live on a connection-path ancestor, descendant or MCLAG peer,
so firing all twelve at 02:00 would have refused eleven. Two things answer it. First, the job
fires due bookings ONE AT A TIME, oldest first, inside a tick, so the topology gate sees the run
the previous booking just started. Second, the three refusals that clear on their own — a live
run on this device, on a related device, and the P2002 race on the one-live-run index — are a
distinct class, `FirmwareRunConflictError`. A booking that meets one is put back to `pending`
with `error` naming what it waits on (the card shows "Waiting: …") and is retried every tick
for up to `CONFLICT_WAIT_MS` (2 h) past its booked time; a waiting booking is exempt from the
15-minute late rule, since it was seen on time. After two hours it is `refused`. Every other
refusal is final immediately — a booking is a decision about this flash at this time, and
retrying a refusal like "the device is down" would turn a scheduled change into an unbounded
one.

### Claims, not locks

The job CLAIMS a booking with one conditional update (`pending` → `started` where still
`pending`); change and cancel are conditional the same way. So a tick racing an operator's
Cancel either fires it or cancels it, never both, and two overlapping ticks cannot fire one
booking twice. The database backs the service's own checks: a partial unique index allows one
`pending` booking per asset (two bookings a second apart still produce one), and a CHECK
requires at least one recipient.

### Recipients hear the outcome either way

Every terminal outcome is emailed: the run finished (succeeded, unverified, failed — from the
runner's `.finally`, after the terminal row and Event are written), the booking was refused,
it was missed, or the run was orphaned by a restart (`failOrphanedFirmwareRuns`). `notifiedAt`
is claimed before anything is sent, so the runner and the boot sweep cannot both email the same
booking. The email reuses the quiet-time summary's plumbing (rule 92): the channel is
`quietTimeSummaryService.resolveSummaryChannel` — with no policy and no held rows, the oldest
enabled email channel — and the letterhead is `applyBrandLetterhead`. One message per recipient,
each in that reader's own zone when the address is a Polaris user's (else the install's): a
per-reader message like the summary, not a split alert, so rule 25 is untouched. The template
is `utils/firmwareResultEmailTemplate.ts`; its device link degrades to the plain name when
`POLARIS_PUBLIC_URL` is unset. No email channel configured, or a send that fails, is a
`firmware.upgrade_schedule_email_failed` Event and `notifyError` on the booking — the booking's
own outcome is still recorded.

### Alternatives rejected

- **A `FirmwareUpgradeRun` row with status `scheduled`.** It would have muddied `startedAt`
  (a run that has not started) and the one-live-run partial index, which must only ever see a
  flash that is actually happening. A booking is its own table, linked to the run it starts.
- **pg-boss scheduling.** pg-boss is optional on an install, and the image lives on the web
  host's disk, where the runner's `setImmediate` must execute. A 60 s job on the web role, beside
  the image, needs neither.
- **Emailing click-to-run flashes too.** Not asked for; the operator who clicks is watching the
  card.

### Known gaps (2026-10-06)

- ~~The mobile SPA cannot book~~ — closed the same day (below).
- Never run against real hardware; the unit and integration suites use a fake device.
- The results email's wording has not been human-reviewed.

### Where it lives

`prisma/schema.prisma → FirmwareUpgradeSchedule` (migration
`20261006000000_firmware_upgrade_schedules`), `services/firmwareScheduleService.ts` (booking,
firing, the email), `services/firmwareUpgradeService.ts → checkSchedulableUpgrade` /
`FirmwareRunConflictError` / `StartUpgradeInput.scheduleId`, `jobs/startScheduledFirmwareUpgrades.ts`,
`utils/firmwareResultEmailTemplate.ts`, the `/assets/:id/firmware-upgrade/schedules` routes in
`src/api/routes/firmware.ts`, the Firmware card in `public/js/assets.js`
(`_openFirmwareApprovalModal` + `_fwApprovalModalHTML` — the one upgrade dialog, its
"Schedule for later" box and its `change` mode — `_fwScheduleFieldsHTML`, `_fwScheduleHTML`,
`_cancelFirmwareSchedule`), and the phone's OS row in `public/js/mobile/asset-detail.js`
(`fwConfirmBodyHtml`, `confirmFirmwareUpgrade`, `fwScheduleLineHtml`). Events:
`firmware.upgrade_scheduled`, `firmware.upgrade_rescheduled`,
`firmware.upgrade_schedule_cancelled`, `firmware.upgrade_schedule_refused`,
`firmware.upgrade_schedule_missed`, `firmware.upgrade_schedule_email_failed`; a booked run's
`firmware.upgrade_started` reads "Scheduled firmware upgrade started" and carries
`details.scheduleId`. Pinned by `tests/unit/firmwareSchedule.test.ts`,
`tests/integration/firmwareSchedule.test.ts`, and the schedule cases in
`tests/unit/assetFirmwarePanelDom.test.ts`, `tests/unit/mobileFirmwareUpgrade.test.ts` and
`tests/unit/firmwareUpgradeGates.test.ts`.

### 2026-10-06 (later) — one verb, and the phone books too

The first cut put **Schedule…** beside **Upgrade firmware to …** on the card. The operator
looked at it and asked for one button: "when the user clicks on upgrade, on the upgrade modal is
a check box to schedule it, then they can put in the date/time and save it" — and then for "the
same scheduling thing on the mobile page as well". So:

- **Desktop:** the card has ONE verb. Its dialog (`_fwApprovalModalHTML`) carries a "Schedule
  for later" box under the warning; ticking it reveals Run at + recipients and turns the button
  into "Schedule upgrade to …". A `blocked` device's card shows the same verb, and its dialog
  opens with the box ticked and LOCKED (mode `schedule-only`) — the gates refuse a flash now,
  and a booking re-takes them when due. A device with a pending booking gets no box (the dialog
  points at the booking); the booking's **Change…** reopens the same dialog in mode `change`.
- **Phone:** the OS row's confirm sheet (`fwConfirmBodyHtml`) gets the same box with the same
  three modes, a `blocked` device now shows the Upgrade verb too, and a pending booking sits in
  the row with Change / Cancel. Same routes, same rung (`assets:write`), primary image only.

Nothing server-side changed: the booking API, the gates and the email are as above.
