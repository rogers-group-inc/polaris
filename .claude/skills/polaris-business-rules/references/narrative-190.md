## Rule 190 — A running server script may email through its action's own Polaris channel, to the addresses the action names and no one else, on a pass that dies with the run

### The ask (2026-11-16)

The operator wanted a Path Monitor automation that, when a site's TLS certificate is renewed
(business rule 85(c)), downloads the new certificate and emails it. The script half was
easy; the email half was not. A script had no way to send mail through Polaris: the runner
strips every secret-shaped variable from its environment (so a one-line `env` cannot copy
`DATABASE_URL` into the displayed stdout), and no API sent arbitrary mail through a channel.
The first answer was a script with its own SMTP settings in a 0600 file on the host, which
duplicates the channel the operator already configured and leaves a relay password on disk.

### The decision

Three designs were put to the operator; they chose the per-run pass.

- **Recipients belong to the action, not the script.** The operator names the channel and the
  addresses on the script action in the wizard, and they are SNAPSHOT on the run row at fire
  time. The request body has no recipient field at all (the route's schema is strict), so a
  script — or anything that steals its pass — cannot turn Polaris's relay on someone else.
- **No secret on the host.** The pass is minted when the process starts, travels only in the
  child's environment, and is stored as a sha256. It answers only while its run is `running`
  and inside that run's own timeout (plus 30 s), and the completion update wipes it. A copied
  pass dies with its run; there is nothing to rotate.
- **Loopback only.** The script runs on the Polaris host and is handed a 127.0.0.1 URL; the
  route refuses any other caller (`req.ip` and the socket both loopback), so behind nginx a
  remote request with a stolen pass is a 403. The path is CSRF-exempt like `/agents/` — the
  pass is the defense — so a call that forgot the header gets the pass's 401, not a CSRF 403.
- **Bounded and audited.** Three sends per run (an atomic `updateMany … emailsSent < 3`, so
  two concurrent sends cannot both take the last slot), five files, 512 KB in total (inside
  the app's 1 MB JSON limit), executable extensions refused, the subject stripped of line
  breaks, and a footer on every message naming the script and run. Each attempt writes
  `automation.script.email_sent` (info) or `automation.script.email_failed` (warning) with
  the recipients, subject and attachment names.
- **Server runs only.** An agent run would have to carry the pass off the host to use it, and
  its API URL would not be loopback. Save refuses the pairing; `requestScriptRun` refuses it
  again as a backstop.
- **Testable.** A Scripts-tab test run may ask for a pass; its only recipient is the signed-in
  tester's own address, so a test reaches nobody else.

Regular file attachments were added to the email channel for this (`EmailMessage.files`, both
SMTP and Microsoft 365) — until then it carried only the inline chart images an alert email
references by `cid:`.

### Rejected

- **A general `POST /delivery-channels/:id/send` behind a role-bound API token.** Simplest to
  build and usable from outside Polaris, but the token lives on disk and its holder chooses
  the recipients: a leak is an open relay.
- **Attach the script's output files to the alert's own Notify email.** No new API, but the
  Notify would have to wait for a queued script (the runner ticks every 5 s and drains two at
  a time), which is a new ordering contract in the action engine for one feature.

### 190(a) — the Notify picker, not a typed list (2026-11-17)

The first build gave the script action a single channel `<select>` and a comma-separated
address box. The operator asked for it to be the Notify action's recipient editor instead:
the channel checkboxes and the To / Cc / Bcc pill fields with their typeahead and address
book — "of course, it won't include web push." The point is that "who hears about this
certificate" should be stated the same way whether Polaris composes the email or a script
does, and that the people who already receive a site's alerts (its region's users, a role,
the asset's contacts) can be named without retyping their addresses.

- **Resolved at fire time, snapshot as addresses.** The pills are resolved when the
  automation fires, against the triggering device, by the resolver the reboot action already
  uses for its results email (`resolveRebootActionRecipients`) — so "Asset's L1 Region Users"
  means the people who own THIS device. The run row stores plain addresses; the script still
  never sees, chooses or widens the list, which is what rule 190 was about. A To that
  resolves to nobody fails the action rather than running a script that can email no one.
- **One message per channel, To visible.** A Notify action without Cc / Bcc fans out one
  email per To address; a script's send does not, because the cap is three SENDS per run and
  fanning out would make it three × N messages with no way for the script to see N. The
  wizard says so beside the fields, and Bcc is there for an address that should be hidden.
- **Several channels.** The checklist allows more than one, as Notify's does; each send goes
  through each ticked channel. A gone or disabled channel is skipped, a partial send is a
  success the failed channel's warning Event accounts for, and only an all-fail is the 502
  the script sees.
- **A recipient cap, not truncation.** A role or a tag can resolve to many people;
  `requestScriptRun` refuses past 200 addresses rather than silently dropping the rest.
- **Back-compat.** The rule-190 shape (`channelId` + `addresses`) still validates and loads in
  the wizard as one ticked channel and address pills in To; the builder writes only the new
  shape. The run row's `emailChannelId` became `emailChannelIds` (migration
  `20261117100000_script_run_email_recipients` copies any value across).

### Rule 190 — the invariant as stated in full

See `invariants-30-43.md` → 190. The implementation is `scriptRunEmailService.ts` (the pass,
the send, the test target), `automationScriptRunner.ts` (issue + clear), `routes/scriptRunSelf.ts`
(the endpoint), `notificationRuleService.assertActionRefs` (save checks) and
`actionReferenceService` (delete guard, broken references).
