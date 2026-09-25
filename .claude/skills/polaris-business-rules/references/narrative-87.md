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

**`fullwrite` on the `firmware` key is the named act** rule 43(d) requires for a fourth rung.
Seeded `fullwrite` for admin-equivalent roles and `none` for everyone else including
`readonly`: nothing in the catalogue implied this act before, so nothing derives it, and even
the read rung shows new information (which devices are behind on firmware).

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

### What is deliberately not here

The bulk / fleet run fortiupgrade's scheduler performs (deepest-first ordering, concurrency);
the SSH + SFTP/TFTP fallback; a FortiGate-controller push for managed APs; an "available"
badge on the assets list (no per-row query on the list); the mobile SPA. And a bench test on
real hardware — the wiki says so, in the words a human must review before this reaches a
fleet: a flash that fails partway can leave a device unbootable.
