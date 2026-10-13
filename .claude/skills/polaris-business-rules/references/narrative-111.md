# Business rule 111 — full narrative

> Written 2026-10-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 111](#rule-111) — A stored secret follows its destination

<a id="rule-111"></a>

## Rule 111 — A stored secret follows its destination

### Where it came from

Part 5a of the fifth phase of the follow-up to the 2026-10-11 whole-repository security scan (F164, F208, F209, F211, F212, F191, F182, F183, F185). The shape is one pattern: Polaris stores a secret nobody can read back, and then lets a person with a LOWER grant choose where it is sent.

**Secrets are write-only by design.** An integration's token, an AD bind password and an SMTP password are masked on every read, so an `integrations:write` or `automationManagement:write` user cannot see them. The edit forms keep them usable: leave the field blank, or echo the masked placeholder back, and the stored secret is kept. That is right when the form is saving a rename. It is wrong when the same request also changes `host` — the server then sends the secret it just restored to the new host, and a caller who could never read the token has exfiltrated it to a server they run. The Generic API Preview and the unsaved Test Connection did the same thing without saving anything, and Test Connection looked the stored row up by `id` without checking its TYPE, so the password of one integration could be aimed at a host typed for another.

**The FortiGate token has a second lever.** Polaris authenticates to a FortiGate with the integration's fleet-wide token, at the address the firewall's asset record holds. `PUT /assets/:id` is an `assets:write` act, and typing a new address pins it. So an assets editor could point any managed firewall at a host they ran and wait for the next monitor tick to deliver the bearer token.

### The decision

**Restore only while the destination is unchanged.** `restoreStoredSecrets` is the single rule. The destination keys are `host`, `port`, `tokenUrl`, `baseUrl`, `security`, the transport flags (including the workload integrations' `useTls`), the TLS verification flags and Proxmox's `fallbackHosts` (compared as a set; a row stored before the list existed counts as an empty list, so adding a node is a move); a blank or masked secret with any of them moved is a 400 that names the field and says to type the secret again. Typing it is the proof the caller already holds it, and it is the only case in which a new destination is legitimate. An omitted key counts as unchanged — compared against what the request SENT, not against a config that a schema has since filled with defaults, which would otherwise read every default as a move.

**A secret stays with its own integration.** Test Connection with an `id` of another type is refused outright.

**Gate the lever, not the token's every use.** The alternative — withholding the integration token from any asset whose address was typed by hand — needs a change at every one of the eight collector call sites, and a cache of pinned addresses on the monitor role would race a pin made a second ago. Both are weaker than refusing the act that creates the hostile address: a new address on a device a Fortinet integration manages now needs `integrations` Read-Write. The built-in `assetsadmin` role (assets write, no integrations) can still edit everything else on the firewall, and can still clear an address or revert to the discovered one; what it can no longer do is retarget the token. A device no Fortinet integration manages is unaffected.

**Key it on the managing integration, not the asset type.** The first cut gated only `assetType: "firewall"`. A trace of the collectors showed none of them checks the type: the token goes to any asset whose `discoveredByIntegration` is Fortinet and whose polling method resolves to the REST path, and switches and APs are the only types diverted to the controller. So retyping a firewall to "server" and then moving its address stepped around the gate while the token kept flowing. The gate now follows `discoveredByIntegration`. It costs no endpoint edits: a Fortinet integration stamps itself only on the gates, switches and APs it manages, never on DHCP clients. A separate retype gate is unnecessary, since a retype alone sends nothing to a new address.

**The controller lookup trusts only the integration's own firewalls.** `resolveControllerMgmtIp` decides where a managed switch's or AP's controller calls go, with `fortigateApiToken`. It used to fall back to ANY `assetType: "firewall"` asset with the controller's name, a hand-made one included. The fallback existed for a gate whose `discoveredByIntegrationId` was cleared by an integration delete and recreate; FortiManager's CMDB lookup, already the next step, answers that case, so the fallback is gone. The same check guards every other route that writes the address: `POST /assets/:id/forward-lookup` (the DNS name is editable, so a resolved name is a typed address by another road) and `POST /assets/import-pdf` (an invoice row matched by serial), where it refuses the dry-run preview too so the browser's two-step import stops before anything is written. `PUT /assets/:id/primary-address` already refuses Fortinet devices.

### What it leaves open, on purpose

- **The REST-credential path.** A firewall can be monitored with a stored REST credential instead of the integration token; binding a credential someone else owns to an asset is the credential-use rule, a later part of this phase (5b).
- **Firmware flash** sends a bound device login to the asset's address and is covered by 5b with the same lever.
- **The error message is the only hint.** The edit modal shows the 400; it does not pre-empt it by clearing the Save button when the host field changes.
- **A raw API import that skips the preview** fails at the first managed-device row, after earlier rows were written.
- **Save-time scope.** Only secrets are bound. A changed host with NO secret stored saves as before.
