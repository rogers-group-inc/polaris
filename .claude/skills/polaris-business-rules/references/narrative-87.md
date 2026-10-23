# Business rule 87 — full narrative

> Written 2026-09-25 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 85 is held by an in-flight worktree (connectivity
> checks) and 75 by another (alert grouping); 81 is a deliberate gap.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 87](#rule-87) — A firmware image is offered only to a device whose serial names the image's platform, and only forward; the flash takes a hold and never records a version it has not read back

<a id="rule-87"></a>

## Rule 87 — A firmware image is offered only to a device whose serial names the image's platform, and only forward; the flash takes a hold and never records a version it has not read back

### The request

The operator's requirement, 2026-09-24: *in Server Settings add a Repository tab. Much like
Manufacturer Profiles, the manufacturer list autopopulates, the device types known for that
manufacturer autopopulate under it, and the model numbers under each device type. The admin
uploads a firmware for that specific version, and sets a pre-configured credential for the
model, the device type, or the manufacturer — most specific wins. Then on asset details, if
the firmware is older than what is in the repository, there is an option to upgrade to what is
in the repo. The upgrade process can be pulled from fortiupgrade. Switches and access points
only.* Clarified the same day: single-asset only from the slide-in (no bulk run); keep
fortiupgrade's dependency awareness; two images per model (primary + backup, operator can
swap); an orphaned model node is flagged and given a delete; and the operator must approve the
exact image before anything is pushed.

### What fortiupgrade actually does

The tool (`rogers-group-inc/fortinet-updater`, README title "fortiupgrade") is a Node CLI that
already reads Polaris — `/assets`, `/connection-path`, `/mclag-peers`, and the maintenance
schedules — and then talks to each switch or AP DIRECTLY: its own web UI over HTTPS by
default, SSH plus an embedded SFTP (switch) or TFTP (AP) server on the operator's laptop as
the fallback. Never through the FortiGate, never through FortiManager; FortiGates are
report-only. Username + password only. The protocol was captured from browser sessions
against real switches, and the repo itself says a bench validation on real hardware is still
outstanding.

Three of its facts shaped this rule:

1. **The image header, not the file name, says what an image is for.** The first 512 bytes
   carry `S108FF-7.06-FW-build1164-260709-patch08`: platform token, version (7.06 + patch08
   = 7.6.8), build, product line. **The platform token is the device's serial prefix** —
   the first six characters of `Asset.serialNumber`. A file name (`FSW_108F_FPOE-v7-build1164`)
   carries a marketing name and the major + build only.
2. **The device platform is the serial, never the model string.** An FMG-discovered switch
   carries the literal model "FortiSwitch" until an SNMP identity query fills it in, and a
   model is operator-editable. A serial is neither.
3. **The comparison skips what it cannot compare, and indeterminate means "not newer".**
   Downgrades are never attempted; the switch's own compatibility check is consulted and a
   "downgrade" answer aborts.

### The decisions

**Transport: HTTPS to the device only.** The SSH/SFTP/TFTP fallback needs inbound ports on the
Polaris host — under Docker the web container publishes none, on RHEL it is a firewall rule
plus `CAP_NET_BIND_SERVICE` for UDP 69 — and the repo notes the switch SSH path is unreliable
(an FSR-112F downloaded the whole image and never flashed it). A FortiGate-managed FortiAP
usually has its local UI disabled, so the AP engine fails fast with "device web UI
unreachable" and the wiki says so. A FortiGate-controller push path for managed APs is a
follow-up, not a reason to ship a TFTP server in the app.

**The credential is an `http` Credential in a new `form` mode**, not a new type. It carries
username + password like basic/digest, but it is a device's own login form, not an HTTP auth
scheme: `validateHttpConfig` keeps both carriers for it, the HTTP-check widget writer refuses
it, the probe treats it as unauthenticated (guessing Basic would post the device's admin
password to whatever answered), and `POST /credentials/test` answers that it is verified by
the upgrade engine signing in. Bindings live in their own table with the
`ManufacturerProfileMetricOverride` scope shape — manufacturer / device type / model, three
partial unique indexes — and a binding whose credential was deleted is SKIPPED so it cannot
shadow a wider one (rule 49's posture: absent is not an error).

**Model organizes, platform protects.** The tree is keyed by `Asset.model` because that is
what the operator sees and files under. The gate is the image's platform token equalling
`platformFromSerial(serial)` AND `isStrictlyNewer`. An upload whose platform no asset under
that model carries is accepted with a warning naming the prefixes that ARE there; a
filename-only image is stored with `platform: null` and never offered. When two model nodes
both hold a matching primary (the literal "FortiSwitch" beside "FortiSwitch S108FF"), the
node named by the asset's own model wins, else the newest.

**Two images per model, primary and backup, enforced by the database.** A new upload becomes
primary, the displaced primary becomes backup, the displaced backup is deleted (row, file,
Event) — refused whole when a run is flashing it. Two partial unique indexes make the cap a
constraint; the make-primary swap steps through a transitional `swapping` value because those
indexes are checked per statement. Only the PRIMARY is offered unasked; the backup is named in
the approval dialog when it is also strictly newer.

**The operator approves the image by name.** `POST /assets/:id/firmware-upgrade` REQUIRES
`imageId`, which must be the offered primary or the eligible backup — the same gate — and the
UI's approval dialog lists version, build, platform, file name, sha256, the model node and the
device's serial, with the button dead until a checkbox is ticked. A click can never push an
image nobody looked at.

**Health and topology gates, taken from fortiupgrade's scheduler and reduced to one device.**
Refused: `down` / `warning` / `recovering`, `dependencySuppressed`, an unmonitorable status
(rule 10), no address, no login at any scope, a live run on this asset, on an ancestor or
descendant on its connection path, or on its MCLAG peer. Allowed: `maintenance` (a window is
exactly when you flash) and unmonitored (the hold no-ops, as it does for an agent upgrade).
The partial unique index on `(assetId) WHERE status IN (queued, running)` answers the race
two clicks a second apart would otherwise win.

**The flash takes a `firmware-upgrade` MaintenanceHold (rule 80), 45 minutes.** A hold window
has no schedule row, so `dependencyTreeService` reads `suppressChildren` as true — everything
behind a rebooting switch is suppressed for free (rule 38). Released in the runner's `finally`
BEFORE the terminal Event (the `failUpgrade` ordering, rule 80a), by `failOrphanedFirmwareRuns`
at web-process boot, and by the reconcile's expiry as the backstop.

**The engine never writes `Asset.osVersion`.** Projection owns it for a Fortinet-infra asset
(asset-source-projection); a direct write would be drift the next run overwrites and a second
firmware-changed Event. The run row records `verifiedVersion` — what the device said after it
came back — and asks for a scoped rediscover, which is what makes the asset record and the
firmware-changed Event say the new version. The availability read reports `pending-discovery`
in between so the button does not re-offer a flash that already happened.

**`fullwrite` on the `firmware` key was the named act** rule 43(d) requires for a fourth rung
(2026-09-25). Seeded `fullwrite` for admin-equivalent roles and `none` for everyone else
including `readonly`: nothing in the catalogue implied this act before, so nothing derives it,
and even the read rung shows new information (which devices are behind on firmware).
**Superseded 2026-09-26 by the operator:** "the rbac for repository: they can see the
repository; read-write can upload new firmware to the repository; asset read-write are able to
flash firmware." The flash is now `assets:write` and the card's reads `assets:read`; the
`firmware` key is none / read / write and governs the Repository alone; migration
`20260926000000_firmware_key_repository_only` rewrites stored `fullwrite`. The trade the
operator accepted: every Assets Read-Write role — `networkadmin` and `assetsadmin` by default —
can now reboot network hardware, where before only admin-equivalent roles could. A per-asset
`GET /assets/:id/firmware-upgrade/runs/:runId` (`getRunForAsset`, 404 on another asset's run)
replaced the card's use of the Repository's run read, which would otherwise have refused an
assets-only operator mid-flash. See rule 43(g).

### Rejected alternatives

- *A new credential type.* Clear in the picker, but a fourth username/password type when the
  http type already models "a login for a device", and the picker filter is one line.
- *Reusing an SSH credential.* Lists SSH rows for an HTTPS upgrade, and the engine does not
  speak SSH.
- *Writing `osVersion` on success.* See above — projection owns it.
- *A queue.* The image is on the web process's disk (uploads land there) and pg-boss is
  optional; the agent upgrade already runs this way. The cost is a restart mid-flash orphaning
  the run, which the boot sweep names rather than hides.
- *Deleting the model node when its assets are gone.* The images are still on disk; an
  invisible 100 MiB is worse than an amber row with a delete button.

### Follow-on (2026-09-25): the `firmwareVsPrimary` automation field

The operator asked for "an informational automation for when an asset's firmware differs from
what is selected as primary". Modelled as an **asset-state field**, not a change type: the
condition is continuous (a device stays behind until someone flashes it or re-selects the
primary), it must clear on its own when either side moves, and nothing emits an Event at the
moment the two start to differ — an upload, a Make primary, or a discovery run can each cause
it. `services/firmwareRepositoryService.ts → firmwareVsPrimary` is the pure half (the same
manufacturer / device type / serial-prefix match the card uses, own model node preferred), and
the engine resolves it from ONE `findMany` over the image table per evaluation, comparing in
memory — never a query per asset at 2000. Readings are `current` / `older` / `newer`; `newer` is
deliberately a reading and not folded into `current`, because an operator who makes an older
image primary has a fleet that differs from it, and the field reports the difference rather
than judging which side is right. The **no-reading** posture is fortilinkStatus's (rule 59): a
device the Repository cannot place yields nothing, so `!= current` is never true of a printer.
The baseline automation "Firmware differs from repository primary" ships as seed set V9 with
its own marker, informational, `!= current`, scoped to switches + access points, auto reset.
Anchor is `lastSystemInfoAt` (falling back to the probe tick) because that pass and discovery
are what refresh `osVersion`; `METRIC_STREAM` says `systemInfo` for the same reason.

### Follow-on (2026-09-25): the hold outlives the engine until monitoring answers

The first real run on prod (a FortiAP 234F, 7.4.6 → 7.6.5) confirmed the new version and
released its hold, and the next two SNMP polls then missed — the response-time chart shows
the shaded window ending and two zero readings just outside it. Nothing was wrong: the
engine proves the device back over its **web UI** (the old session refused, a fresh login
reading the version), and the AP's HTTPS came up minutes before its SNMP agent, which is
what Polaris's monitoring polls. Releasing on "the engine is done" was releasing on the
wrong service. `firmwareUpgradeService.ts → holdUntilMonitorAnswers` now keeps the hold
open after an `upgraded` or `unverified` outcome until the first successful
`AssetMonitorSample` recorded after the engine finished — the signal the status machine and
every automation actually read — with the run in a visible `recovering` stage ("Waiting for
monitoring to answer"). It reads the sample table rather than asking the monitor, because on
a split-role host another process writes it. Capped at `recoveryWaitMs` (10 min) so a device
that never answers is judged normally rather than silenced, and the hold's own `expiresAt` is
pushed past the cap so the 45-minute TTL cannot lapse mid-wait. A `failed` run still
releases at once: a flash that went wrong is an incident. An unmonitored device has no hold,
so nothing is waited for. Pinned by the "keeps the maintenance window open" block in
`tests/unit/firmwareUpgradeGates.test.ts`.

### Follow-on (2026-10-13): the wait asks the device; the scheduler never will

An operator flashing a FortiSwitch watched the run sit in "Waiting for monitoring to
answer" while the switch already answered their pings. Two things were true. A managed
FortiSwitch's response-time probe asks the parent FortiGate's switch-controller and counts
only `Connected`, so ICMP answering is not monitoring answering. And the bigger one: nothing
was asking at all. The hold parks the asset at status `maintenance`, and
`MONITOR_CANDIDATE_WHERE` drops that status from every scheduled poll, so the wait above
read a table that no scheduled pass could write to. On every agentless device it sat out the full
10-minute cap and then logged that monitoring "did not answer" (it had never been asked).
Only an agent's pushes or an operator's Poll Now could end it early. `holdRecoveryWait.ts →
probeWhileHeld` now runs `probeAsset` (the Poll Now probe, through the four-tier polling
method) on every poll of the wait and records a success through `recordProbeResult`, the
same sample, status machine and uptime/reboot path the scheduler uses. A failed probe is
not recorded: the device is inside the window that exists so it is not judged yet. The
sample table stays the release signal, because an agent-polled host's probe is a synthetic no-op.
The cap-warning now reads "the device did not answer its monitoring probe". Rule 115's reboot
wait shares the code and the fix. Pinned by the probe cases in
`tests/unit/holdRecoveryWait.test.ts`.

### Follow-on (2026-09-25): a switch login is judged by the session, never the redirect

The first prod FortiSwitch run failed at sign-in with "the switch rejected the username or
password" while the same credentials worked in a browser and in the fortiupgrade CLI. A curl
of the engine's exact request showed why: FortiSwitchOS 7.6.6 (`Server: PRODUCT/7.7.7`)
answers a GOOD password with `302 Location: /login`, setting a quoted `APSCOOKIE_<n>`
(carrying an `AuthHash`) and an `ssession` cookie. The port had added a check fortiupgrade
never had — "a redirect to /login is a refusal" — and that check is right for every OTHER
request (an expired session is sent to the login form) and wrong for the login itself.
`fortiswitchHttps.ts → switchLogin` now matches fortiupgrade: a session cookie must be set,
then a page that needs a session (`GET /`) must not bounce to the form; and a refusal quotes
what the switch answered ("the login answered HTTP 302 → /login and a page that needs a
session answered HTTP 302 → /login") so the next firmware's quirk is readable from the run
log. A bad password on 7.6.6 still gets an anonymous `ssession`, which is why "a cookie was
set" alone is not the verdict either. Pinned by the `fsw766` cases in
`tests/unit/fortiswitchHttpsEngine.test.ts`; the happy case fails against the old code with
the prod message.

### Follow-on (2026-09-25): flash progress is a fraction, not a percent

The same prod switch (S124FF, 7.6.6 → 7.6.8) then flashed with the card reading "Erasing
flash 1%" four minutes in, a sliver on "Writing image 0%", "step 6 of 40", and "Verifying
image" never lighting before the card jumped to Rebooting. The switch reports each stage as
a **0..1 fraction** — erase an exact 1 once done, the others long decimals — which
fortiupgrade's capture had recorded and the port had not: a finished erase drew as 1%, and
because the card marks the next row active only at 100, write and verify never became active
at all. `fortiswitchHttps.ts → switchStatus` now converts to percent (clamped, one decimal)
at the one place the device is read, so `FirmwareProgress` stays a percent everywhere else.
The step counter is dropped from the card: fortiupgrade saw it pinned at 6/40 for a whole
nine-minute flash, and so did prod. The fake switch in `fortiswitchHttpsEngine.test.ts` and
`scripts/mock-firmware-devices.mjs` now report fractions and a pinned 6/40 like the real one;
the happy-path test fails against the old engine (`expected 1 to be 100`).

### 2026-10-06 — FortiGates

The operator asked to "add the ability to upgrade the firmware of FortiGate firewalls", and
for the binding: "in the repository, when the user sets the credential to be used they can
select from the existing credentials as well as from the integration's api token". FortiGate
images run to ~250 MB. HA cluster members are refused for now (operator decision).

**A third engine, `fortigate-https`** (`services/firmwareEngines/fortigateHttps.ts →
upgradeFortiGate`). Unlike the switch and AP engines it is not a transcription of a captured
browser session — it is the documented FortiOS REST surface, and it has **never run against a
real FortiGate**. Auth is a bearer API token, or an admin login through `POST /logincheck`
whose `ccsrftoken` / `ccsrftoken_<port>_<id>` cookie is echoed as `X-CSRFTOKEN`; no CSRF
cookie (two-factor, a pre-login disclaimer, a forced password change) is refused after ONE
attempt, because every attempt counts toward the admin lockout — and the verify loop stops
after two auth rejections for the same reason. Preflight reads `monitor/system/status` (serial
cross-check, version + build), `cmdb/system/ha` (anything but `standalone`, or unreadable, is
refused) and the already-current check. The image goes to `monitor/system/firmware/upgrade`
(`source=upload`) as streamed multipart; a non-auth refusal is retried ONCE as JSON with
`file_content` base64-encoded on the fly (`deviceHttp.ts → Base64Encode`, Content-Length
precomputed by `base64Length`) — no 330 MB buffer. A connection dropped after the whole body
went counts as taken: the gate reboots as soon as it has written the image.

**The lab run, same day (2026-10-06).** The operator put `FGT_61F-v8.0.1.F-build0245-FORTINET.out`
(99.7 MB) on the workstation and asked for the two lab spokes to be upgraded, one through the
API token and one through an admin login — FortiGate 61F, FortiOS 7.6.7 build3704 → 8.0.1
build245, driven by the engine directly (not through a Polaris stack). What it settled:

- **The header guess held.** A FortiGate `.out` is a gzip stream whose embedded file NAME is
  the token — `FGT61F-8.00-FW-build0245-260909-patch01-F-260421` — inside the first 512 bytes,
  so `parseFortinetImageHeader` reads platform `FGT61F`, 8.0.1 build 245, family `firewall`,
  unchanged, and the platform equals both spokes' serial prefix.
- **Multipart is accepted.** Both gates took the streamed multipart upload (~7 s for 99.7 MB);
  the JSON-base64 retry never fired, so it remains unproven on hardware.
- **The token path worked first time:** upload answered at 15 s, the gate stopped answering by
  46 s, and answered on v8.0.1 build245 at 274 s.
- **The login path was WRONG, twice.** On 7.6.7, `POST /logincheck` answers 200 with the
  (gzipped) login page and sets no cookie whatever the password — the browser login moved to
  `POST /api/v2/authentication`, JSON `{ username, password }` (found by reading the gate's own
  `/login/main.js`; `secretkey` is refused with LOGIN_FAILED). The verdict is the body's
  `status_message`: LOGIN_FAILED still sets `session_key_<port>_<hash>` and
  `ccsrf_token_<port>_<hash>` cookies, so "a CSRF cookie was issued" — the old success test —
  would have passed a failed login. And the cookie is `ccsrf_token_…`, which the original
  `/^ccsrftoken/` never matched (the gate names it in `GET /api/v2/service/login-config` →
  `ccsrf_token_cookie_name`). Logout is `DELETE /api/v2/authentication`; it did not require the
  CSRF header, the firmware POST was sent with it and was accepted. The engine now tries the
  JSON login first and falls back to `/logincheck` only when no JSON verdict comes back (an older
  build answers an unknown `/api/v2` path with 401 or 404, which says nothing about the password).
  `deviceHttp.ts → decodeBody` inflates gzip answers, which FortiOS sends unasked.
- **The login path then worked end to end on SPK2:** upload answered at 16 s, down by 47 s, the
  first verify at 275 s met "socket hang up" (the web server was up before the REST API), the
  retry 20 s later read v8.0.1 build245 — `verifyRetries` earning its keep.
- **Still unproven:** the `/logincheck` fallback on a pre-7.4 gate, the base64 retry, HA refusal
  against a real cluster, and any of it run through Polaris itself (holds, the card, the run row).

**HA members are refused twice.** `firmwareUpgradeService.ts → haClusterOf` reads
`fortinetTopology.haMode` / `haRole` and marks the card `unsupported` and refuses at start and
at booking (rule 93); the engine refuses again from the gate's own `system/ha`, because
discovery's record can lag a cluster being formed.

**Bindings gain a `source`.** `credential` names a form login (any type) or, on a Firewall
scope only, a `restapi` Credential; `integration-token` (Firewall scope only, `credentialId`
null — a CHECK) resolves at run time to the token of the integration that discovered the gate
(`Asset.discoveredByIntegrationId`): a standalone FortiGate integration's `apiToken` /
`verifySsl` / `port`, or a FortiManager's `fortigateApiToken` / `fortigateVerifySsl` — the
FMG/FortiGate parity is in that one resolver. A binding that cannot sign in to THIS device
falls through to the next scope rather than shadowing it (rule 49's posture, as for a deleted
credential): a token on a switch or AP, an integration-token whose integration has no token or
no longer exists. The token is the API admin's: its profile needs System read-write.

**Size.** `FIRMWARE_MAX_IMAGE_BYTES_BY_TYPE` — 100 MiB switch / AP (the FortiSwitch endpoint's
own ceiling), 300 MiB firewall; multer and nginx's firmware `location` take the largest (300m).
An install whose nginx config is not re-rendered keeps 100m and a FortiGate upload dies at
nginx with 413; the Repository's error names the fix.

**Consequence.** `firmwareVsPrimary` reads `FIRMWARE_ASSET_TYPES`, so FortiGates now get
readings; the baseline automation is still scoped to switches + access points (seed
unchanged), so it fires for a gate only once an operator adds Firewall to its scope.

**Rejected.** *A FortiGuard-download source* (`source=fortiguard`): the gate fetches its own
image, which bypasses the Repository's approve-by-name — the operator would approve a version
string, not bytes with a sha256. *An FMG-proxied upload*: a 250 MB body through FortiManager's
JSON-RPC proxy. *An HA cluster upgrade*: deferred — one member's upgrade reboots the cluster
and needs its own orchestration. **Nothing here has been validated on hardware**; the
`fortinet-api-conventions` plugin gets an entry after the first lab run.

### What is deliberately not here

The bulk / fleet run fortiupgrade's scheduler performs (deepest-first ordering, concurrency);
the SSH + SFTP/TFTP fallback; a FortiGate-controller push for managed APs; an HA-cluster
FortiGate upgrade (2026-10-06); an "available"
badge on the assets list (no per-row query on the list); the Repository on the mobile SPA
(the phone gained the per-asset upgrade on 2026-09-26 — the asset sheet's OS row, primary
image only, the same POST and gates; `public/js/mobile/asset-detail.js` → Firmware upgrade
block). And a bench test on
real hardware — the wiki says so, in the words a human must review before this reaches a
fleet: a flash that fails partway can leave a device unbootable.

### Follow-on (2026-10-15): the record catches up from the device's own reading

Operator report: "the firmware upgrade card in asset details is supposed to update every 10
minutes, but it's not" — both halves: the open card never re-read, and a flashed (or
upgraded-elsewhere) device kept its old `osVersion`, so the card kept offering the upgrade, until
an integration discovery happened to run. The scoped rediscover above is not enough on its own:
it covers only a Polaris flash, and only when that rediscover lands.

The engine STILL never writes `Asset.osVersion`. What changed is who else may contribute it:
`services/fortinetLiveVersionService.ts → reconcileFortinetLiveVersions` records the firmware
the device reports to the monitor path as an ENRICHMENT `AssetSource` row (`fortinet-live`,
externalId = assetId, `observed.osVersion` only), ranked in `OS_VERSION_RULES` directly above
`fortigate-firewall` / `fortiswitch` / `fortiap` and below the in-guest kinds. Two readers,
neither issuing a call of its own: the FortiLink sweep (`fortinetLinkStateService`, every
FortiGate-managed switch / AP, 60 s, from the controller row's `os_version`) and the FortiOS
REST response-time probe of a Fortinet-discovered firewall (`system/status` read with
`envelope: true`, `version`; shaped by `fortigateLiveVersionFor` to the integration's discovery
format — FMG `7.4.5`, standalone `v7.4.5`). Acted on only when `compareFirmwareVersions` says
the version MOVED against the asset's current value, so a format difference never writes and a
steady fleet of 2000 costs an in-memory compare per device; an in-memory last-recorded map stops
a projection that keeps choosing another source from re-recording every pass. A real change
upserts the row, re-projects, writes osVersion alone, and logs one `asset.firmware.changed`
(`actor: system:monitor`, `source: fortinet-live`).

The card (`public/js/assets.js → _scheduleFirmwareRefresh`, mirrored on the phone sheet)
re-reads `GET /assets/:id/firmware-upgrade` every 10 minutes while it is on screen, redraws only
when the answer changed, and waits another interval while the tab is hidden or a run poll owns
the card. Pinned by `tests/unit/fortinetLiveVersion.test.ts`, the `fortinet-live` block of
`tests/unit/assetProjection.test.ts`, and the live-firmware block of
`tests/unit/fortinetLinkState.test.ts`.

Rejected: writing the live value into the discovery kind's own row (FortiManager's dvmdb copy of
a gate's version can lag, so discovery and monitor would overwrite each other and audit a
firmware change each time); a scoped re-discovery whenever the versions differ (a whole gate's
discovery to learn one string). Known gap: a FortiGate polled by ICMP / SNMP / the
`fortimanager` method has no live reader and still waits for discovery. A live row that stops
being refreshed (a gate moved off `rest_api`) keeps outranking discovery until the asset's next
live reading.


### Groundwork (2026-10-23): what upgrading a real HA pair showed, for when Polaris does it

HA members are still refused. This section records the lab run that a future HA-upgrade
feature should be built from. The operator asked for it: *"write down what you learned about
upgrading the ha pair so that we can build in ha pair firmware upgrades to polaris at some
point"*. The vendor facts are mirrored in the fortinet-api-conventions plugin (`fortios-rest.md`,
Firmware upgrade).

**The cluster.** The lab's HUB1 pair: two FortiGate 61F, `mode a-p`, group LAB-HA, HUB1-a
(FGT61FTK23009069, priority 255) primary, HUB1-b (FGT61FTK24006008, priority 128),
`override disable`, `session-pickup enable`, `upgrade-mode uninterruptible`, heartbeat on
internal4, and `ha-mgmt-status enable` with **internal1 as the reserved management
interface**. 172.22.128.101 is HUB1-a's own internal1 address, and 172.22.128.105 is HUB1-b's. So the
address Polaris discovered and pins is ONE MEMBER's, not the cluster's. A failover does not move
it, and it is unreachable whenever that member is rebooting. Polaris had no address for HUB1-b
at all (standby IP nulled). .105 was found by a TLS sweep of the subnet and confirmed with
the same API token (the API admin and its trusthost are synced config, so one token reaches
both members).

**The run.** 7.6.7 build3704 → 7.6.8 build3744, done outside Polaris with the same multipart
`POST /api/v2/monitor/system/firmware/upgrade` (`source=upload`) the FortiGate engine sends,
to the PRIMARY's address only:

| time (UTC) | HUB1-a @ .101 | HUB1-b @ .105 |
|---|---|---|
| 00:47:10 | upload starts; primary, 7.6.7 | secondary, 7.6.7 |
| 00:48:07 | | down (rebooting) |
| 00:50:53 | | back, 7.6.8, secondary |
| 00:51:12 | **upload request answers** (HTTP 200, 242 s after it began) | |
| 00:51:17 | secondary, still 7.6.7 (failover done) | **primary**, 7.6.8 |
| 00:51:29 | down (rebooting) | |
| 00:54:15 | | secondary again |
| 00:54:25 | back, 7.6.8, **primary** | |
| 00:57:18 | one API timeout (6 s), answering again at 00:57:34; no reboot | |

What follows for an implementation:

- **Send the image once, to the primary.** FortiOS distributes it and runs the order itself:
  the secondary first, then failover, then the old primary. Polaris does not sequence members.
- **The upload request blocks until the secondary is upgraded and the cluster has failed
  over** (242 s here, against ~8 s for a standalone 61F). The engine's upload response timeout
  must allow several minutes per secondary member, or it will report a failure for an upgrade
  that is going fine. An answer is not "the gate is about to reboot"; it is "half the cluster is
  done".
- **Two reboots, about 8 minutes end to end.** Each member was unreachable ~3 minutes on its
  own address. Data-plane continuity through the cluster addresses was NOT measured.
- **The primary role came back to HUB1-a without being asked**, ~3 minutes after its reboot
  began. That was with override off and the higher priority on HUB1-a. Do not assume which
  member is primary at the end, and do not treat a role change as a failure.
- **Let the cluster settle before calling it done.** The primary dropped one API call ~3 minutes
  after it came back, with no reboot. A verify loop that gives up on the first miss after
  "both on target" would misreport this.
- **Verify per member, by serial.** Success is both serials reporting the target version from
  their own `monitor/system/status`. The cluster view (`monitor/system/ha-peer`, read from
  either member) lists both serials and the primary flag, but no addresses or versions.
- **Hold both assets, and anything behind the cluster, for the whole window** (rule 80): one
  member is down twice over ~8 minutes. A hold on the primary alone would let the standby, or
  the dependency tree, alert.
- **Discovery after the run recorded both versions correctly** (`asset.firmware.changed` for
  HUB1-a and HUB1-b), so verification can lean on a scoped re-discovery as single-gate runs do.

**Certificates (rule 113).** Both members served the same CA-issued `*.rogersgroupinc.com`
(`admin-server-cert star_rogersgroupinc_com_2026`, synced config) before, during and after.
No pin changed, and this upgrade did not regenerate the built-in certificates either. But
the built-ins are per member: `Fortinet_GUI_Server`, the 7.x default HTTPS certificate,
CN "FortiGate", has a different fingerprint on each member, and `Fortinet_Factory` names each
member's own serial (`Fortinet_SSL` is synced). So:

- A cluster reached on **per-member reserved management addresses** keeps one pin per member
  address, and a failover changes nothing. This is the lab's shape.
- A cluster reached on a **shared address that moves with the primary**, running the
  **default certificate**, presents the other member's certificate after every failover. Pinning
  refuses it, and every collector loses the gate until a person trusts it, and again on fail-back.
  An HA upgrade guarantees two such failovers. The upgrade must open the rule-113(g) window on
  that shared address and keep it through BOTH members' reboots. Since 2026-10-22 the window
  re-pins every change, so this works. A failover Polaris did NOT cause still needs a person,
  unless pins learn the partner. A factory certificate names its member's serial, and discovery
  knows the partner's serial, which makes that a plausible design (unbuilt).
- Caution when reading the built-ins: one read through the secondary's address returned the
  PRIMARY's `Fortinet_Factory` (HUB1-a's serial), and the same read after the upgrade returned
  HUB1-b's own. Do not infer a member's identity from one certificate download made through its
  address.

**Still unknown, so test before building:** how long the cluster addresses actually drop
traffic, a cluster without reserved management interfaces (only the shared address), active-active,
three or more members, a vcluster, an upgrade through FortiManager's proxy, and what FortiOS
does when the secondary fails to come back on the new image (whether the primary still
flashes itself).

### Follow-on (2026-10-23): the pair belongs to a platform, not to a model node

"Two images per model" (above) assumed one platform per model node, which held for the
FortiManager switch and AP nodes it was designed around. It failed on the first mixed
fleet. A standalone FortiGate integration records every gate's model as the literal
`FortiGate` (FortiOS `modelName`), so a 61F and a 601E share one node. On 2026-10-22, uploading
the 601E image there demoted the 61F image to backup with no warning, and a third platform's
upload would have deleted it. Matching was already per platform (`findUpgradeCandidates`), so
the demoted 61F image was simply never offered again. Every 61F looked up to date.

The pair is now per platform under a node. The two partial unique indexes key on
`(manufacturer, assetType, model, COALESCE(platform, ''))`, in migration `20261023000000`. An
image with no recognised platform (never offered) shares one pair per node, as before.
`registerUploadedImage` rotates only its platform's pair, `setPrimaryImage` swaps only with its
platform's primary, and `deleteImage` promotes only its platform's backup. The same migration
repairs installs the old rule already hit: a backup whose platform has no primary under its
node is promoted. The old index allowed one backup per node, so at most one row per node moves.
The Repository tab groups a node's rows by platform. Its upload warning names every platform that has a
backup rather than guessing which one the file is for, because the platform is read from the
image header on the server.

Rejected: recording the real model for standalone FortiGates (FortiOS `model`, e.g. `FGT61F`),
so each platform gets its own node. That would rename every existing standalone gate's model
and diverge from FortiManager's naming, and it fixes nothing for an operator who files two
platforms under one node by hand. It may still be worth doing on its own merits.

Pinned by the "PLATFORM under the node" cases in `tests/unit/firmwareImageRotation.test.ts` and
the grouping case in `tests/unit/firmwareRepositoryTreeUi.test.ts`. The migration was run
against a database holding the 2026-10-22 broken state (61F demoted beside a 601E primary, plus
a healthy switch pair): the 61F came back as primary and the switch pair was untouched.
