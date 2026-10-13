# Business rule 112 — full narrative

> Written 2026-10-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 112](#rule-112) — Aiming a stored credential is allowed, and recorded

<a id="rule-112"></a>

## Rule 112 — Aiming a stored credential is allowed, and recorded

### Where it came from

Part 5b of the fifth phase of the follow-up to the 2026-10-11 whole-repository security scan (F179, F180, F181, F189, F200, F203, F204, F213, F214, F219). Every finding has the same shape: a caller picks a stored credential by id — one they may only see masked, or not at all — and a destination they control, and Polaris sends the secret there. The places: an asset's credential slots (edit, create, bulk-monitor), the SNMP walk and the MIB walk, a Network Discovery's methods, a path check's HTTP credential, the firmware device-login bindings and the flash that uses them, and the per-class credentials on an integration's config or a manual-tier class override. Credentials → Test already refuses this for a credential the caller does not own (rule 43); none of these did.

### The decision

**Trust the operator, record the act.** The owner's ruling (2026-10-13): whoever may edit an asset must be able to test a credential against it, so the scan's recommended fix — require credential ownership at every one of these sites — was rejected. The same trust extends to the two places that aim at operator-typed addresses rather than inventory: a Discovery (`networkScan:write`) and a path check (`pathChecks:write` + `credentials:read`). Both permissions already mark a trusted operator, and one rule everywhere is easier to reason about than two.

What the trust costs is an audit trail. Every act that points a stored credential at a destination writes one Event per credential (`services/credentialUseAuditService.recordCredentialUse`):

- `credential.used` (info) — the caller created the credential, or holds Credentials Full RW.
- `credential.borrowed` (warning) — everyone else, including a bearer token (no username, so nothing is "theirs") whose role lacks Full RW, and anyone using an UNOWNED credential (`createdBy` null, the rows that predate the column).

The Event is on the credential (`resourceType: "credential"`, `resourceId` = its id), carries `assetId` when there is one, and its `details` hold `via`, `credentialOwner`, `borrowed` and `destination`. Filtering the Events page by `credential.borrowed` is the after-the-fact review the owner asked for.

**A use is a change, not a save.** The edit forms post every field back, so recording each save would bury the signal. An asset write records a slot only when it names a credential it did not name before, and records every attached credential when the address moved (clearing the address is not a move). A Discovery save records added credentials, or all of them when the targets changed; a manual run records all of them, because the person running a shared Discovery need not be its author. A path check records on create, on a new credential or a re-aim (the same `reAimed` test the server-source gate uses), and on every Test run. An integration save or class override records the `…CredentialId` paths that changed (`changedCredentialRefs`). A firmware binding records each save that names a credential (bindings are rare); a flash records the login it resolves, when started and when booked — a scheduled flash fires with no request behind it, so the booking is the human act.

**The audit never fails the request.** `recordCredentialUse` does one `findMany` for the credentials and one `createMany` for the rows, and swallows its own failure. It is awaited after the write it describes, so a refused write records nothing.

### What it leaves open, on purpose

- **Routine monitoring is not recorded.** The poller sends attached credentials every tick; logging those would be thousands of rows a minute and say nothing new. The act worth recording is the person choosing the destination.
- **Agent install is not part of it.** It is `assets:fullwrite` (deploy-class), it already writes an `agent.install` Event naming the credential, and the bulk route picks SSH or WinRM per asset inside the service, so the route cannot say which credential went where.
- **Inherited credentials.** An asset with no credential of its own, polled with one from its integration's class block, sends that credential to its new address when the address moves; the asset write records only the slots on the asset row.
- **Transport identity.** Whether the destination proves who it is — SSH host keys, WinRM and firmware TLS, the archive SFTP — is phase 5c.

### 2026-10-13: a reboot records its credential too

Rule 114 (reboots) landed the same day as this rule, on a branch opened before it merged. A reboot sends a stored credential to a device exactly as a flash does, so it records the same way: `rebootService.recordRebootCredentialUse` writes `credential.used` / `credential.borrowed` with `via: "device.reboot"` and the gate's address as the destination, from `POST /assets/:id/reboot` and when a reboot is booked (`POST /assets/:id/reboot/schedules`). The integration's own token and the agent are not stored credentials and record nothing.
