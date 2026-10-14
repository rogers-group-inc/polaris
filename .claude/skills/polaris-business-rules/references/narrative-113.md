# Business rule 113 — full narrative

> Written 2026-10-13 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 113](#rule-113) — A server proves it is the one Polaris pinned before a secret is sent

<a id="rule-113"></a>

## Rule 113 — A server proves it is the one Polaris pinned before a secret is sent

### Where it came from

Part 5c of the fifth phase of the follow-up to the 2026-10-11 whole-repository security scan (F168, F172, F193, F207, F223, F232). Four transports sent a password or token to whatever answered on an address:

- **SSH** (agent install / upgrade / uninstall, agentless collection, the SSH monitor probe, the AD bind-password fallback). Rule 21 built trust-on-first-use host-key pinning but made it opt-in per credential, so every credential created before 2026-08, the Polaris-managed deployment credentials and the AD fallback (which builds a config with no flag) accepted any host key.
- **WinRM over HTTPS** — Basic auth with a Windows password, and the agent enrollment token — checked the certificate only with `verifyTls: true`, which almost no install sets because WinRM listeners present self-signed certificates.
- **The firmware engines** (FortiGate / FortiSwitch / FortiAP logins and FortiOS tokens) ran with `rejectUnauthorized: false` unless a FortiGate token's integration verified; the switch and AP engines could not verify at all.
- **The event-archive export** ran ssh / scp / sftp with `StrictHostKeyChecking=no`, and the prune job deleted the events even when the export had just failed.

### The decision

**Trust on first use, everywhere, by default.** The owner chose TOFU over CA verification because CA verification is what installs already decline (self-signed WinRM and device certificates are the norm) and TOFU needs no operator action. What it detects is a server CHANGING after it was first seen; what it cannot detect is a server already impersonated at the moment of the first pin. That trade is stated in the wiki rather than implied away.

(a) **SSH: on unless explicitly off.** `buildHostVerifier` returns a verifier for every config except `verifyHostKey: false`. Rule 21's table, verifier, fail-closed behaviour and mismatch Event are unchanged; only the default moved.

(b) **TLS certificate pins for the HTTPS transports that carry a secret without a CA check.** `TlsCertPin` (one row per dialed host:port) holds the leaf certificate's SHA-256; `tlsCertPinService.verifyOrPinCert` stores on first sight, accepts a match and refuses a change with a warning `tls.cert.mismatch`. The check runs in `utils/pinnedTlsAgent.ts`: the agent opens the TLS socket in `createConnection`, waits for `secureConnect`, checks the certificate, and only then hands the socket to the request — so the Authorization header or login form is never written to an unchecked server. Node's `checkServerIdentity` cannot do this (it is skipped whenever the chain fails, which is every self-signed certificate, and it is synchronous). Session resumption and keep-alive are off on the agent so every connection is checked. Wired into `winrm.soapPost`, `monitoringService.probeWinRm` and `firmwareEngines/deviceHttp` whenever the connection does not verify a CA (`verifyTls: true` keeps the ordinary verified request). The Windows Server integration uses `fetch`, which verifies the chain, and is unchanged.

(c) **Fortinet serial pre-check on firmware logins.** A Fortinet factory certificate names the device's serial (subject O "Fortinet", CN the serial). `deviceHttp.fortinetSerialPrecheck` refuses one that names a different serial than the asset's `expectedSerial` before any login is sent — a wrong or redirected address is caught even before anything is pinned. A certificate the operator installed (any other subject) is left to the pin.

(d) **Event archive.** ssh / scp / sftp run with `StrictHostKeyChecking=accept-new` and `UserKnownHostsFile=<state>/data/archive_known_hosts` — OpenSSH's own TOFU. A FILE rather than a `ssh_host_keys` row because the OpenSSH binaries read keys, not the fingerprints the table holds. On an HA install the file rides the periodic file sync to the standby, since `data/` is not in `deploy/ha/ha-rsync-exclude`. A refusal reads "The archive server's SSH host key has changed …"; **Forget host key** (`POST /events/archive-forget-host-key`, audited `event_archive.host_key_forgotten`) is the recovery. A failed export now **skips that hour's prune** and writes `event_archive.export_failed` (warning), so the rows the archive was meant to keep are never deleted with no copy.

**Recovery is one place.** Server Settings → Polaris Agent → Windows SSH Deployment → **Pinned server identities** lists SSH host keys and TLS certificates together, each with an audited Delete (`ssh.host_key.deleted`, `tls.cert.deleted`) that re-opens first-use trust for that endpoint. (Since 113(f) the TLS table is also on Server Settings → Web Server, and a changed certificate is trusted in place rather than deleted — see below.)

### What changes on an existing install

Nothing is refused on upgrade: both pin tables start empty for the newly covered connections, and the first connection after the update pins whatever answers. A server that is later rebuilt, re-keyed or re-certified is refused until its pin is deleted. The event table can grow while the archive is broken, because pruning waits for a successful export.

### What it leaves open, on purpose

- **Pins are per address**, not per asset (the owner's choice, option (a)): on DHCP space an address that moves to a different machine reads as a mismatch and needs a manual Delete. Automatically dropping a pin when an address changes owner was rejected — an attacker able to fake that change could reset the pin.
- **The first pin is trusted.** TOFU cannot catch a server impersonated before Polaris first connected.
- **The archive pin lives in a file**, not in Pinned server identities; it is cleared with Forget host key in the archive settings.

### 113(e)-(g) — the FortiOS transport, re-trust, and Polaris's own upgrades (2026-10-14, re-scan phase 12)

Rule 113 pinned WinRM and the firmware engines but not the transport that carries the most valuable token: every FortiOS and FortiManager request with `verifySsl` off — discovery, monitoring, DHCP and quarantine pushes, and for a FortiManager in proxy-bypass mode the FLEET-WIDE FortiGate token sent to each gate's management address — went through an undici agent that accepted any certificate (F10, F66). The per-asset REST credential probe and authenticated HTTP checks did the same (F6, F7).

Owner decision 2026-10-14 (option a): pin that transport too, and fix re-trust first, because a FortiGate fleet would lean on it far harder than a few WinRM listeners did. The old recovery — delete the pin, and whatever answers next is trusted — had three faults for a fleet: nothing said a gate had stopped polling, the delete opened a window in which anything could be pinned, and the table was buried in the agent SSH card. Now a refused certificate is recorded on the pin, the capacity card says which servers changed, the table (Server Settings → Web Server, and the agent card) shows the old and new fingerprints and trusts exactly the one compared, and the owner asked for each gate's pins on its Sources tab — under the discovering integration, two rows for a FortiManager in proxy-bypass mode (the FortiManager, and the gate), one in proxy mode. A firmware upgrade may regenerate a FortiGate's certificate, so Polaris's OWN upgrade opens a short re-pin window from the reboot; an upgrade done elsewhere still needs a person, which is the point.

Built and found on the way: undici's connector caches TLS sessions, and a resumed session hands back no peer certificate — the third connection to a pinned gate was refused for "presenting no certificate". The pinned connector disables session caching, as `PinnedTlsAgent` already did; `tests/integration/tlsPinnedDispatcher.test.ts` drives real HTTPS with two certificates through first pin, refusal (nothing reaches the server), trust and the window.
