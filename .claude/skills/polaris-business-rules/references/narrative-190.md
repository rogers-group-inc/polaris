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

### Rule 190 — the invariant as stated in full

See `invariants-30-43.md` → 190. The implementation is `scriptRunEmailService.ts` (the pass,
the send, the test target), `automationScriptRunner.ts` (issue + clear), `routes/scriptRunSelf.ts`
(the endpoint), `notificationRuleService.assertActionRefs` (save checks) and
`actionReferenceService` (delete guard, broken references).
