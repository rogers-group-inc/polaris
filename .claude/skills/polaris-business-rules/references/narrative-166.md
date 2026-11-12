# Business rule 166 — full narrative

> Written 2026-11-11 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 166](#rule-166) — What SSH onboarding puts on a host, Polaris can also take off it; a rotated key is retired, not forgotten

## Rule 166 — What SSH onboarding puts on a host, Polaris can also take off it; a rotated key is retired, not forgotten

**How it was found.** The 2026-11-11 orphan audit looked at what Polaris leaves outside its own database. The SSH Deployment card generates a script that an operator runs across a fleet as root / SYSTEM. On every host it leaves a standing administrative path in: the Polaris public key in an authorized-keys file, in "create" mode a local account (an administrator on Windows), on Linux a `NOPASSWD:ALL` sudoers drop-in, and optionally a firewall allowance for TCP/22. Polaris could generate all of that and remove none of it. Two cases followed.

- **A host that leaves.** A server is retired from monitoring, a site is sold, an organisation stops using Polaris. Every artefact stays. The only way to remove them was to read the onboarding script and undo it by hand, per platform, and get the details right (the Windows key lives in one group-wide file with a strict ACL; removing the wrong line or resetting the ACL locks out other administrators).
- **A key that is rotated.** "Regenerate keypair" replaces the private key and the card warns that every endpoint must re-run the onboarding script. That run APPENDED the new key. The old key stayed authorized on every host forever. The usual reason to rotate a key is the suspicion that someone else has it, and that is exactly the case in which leaving it authorized is the failure.

**The decision.** The operator's standing preference through this audit is that leftovers are made visible and removed by a deliberate act, not silently. The defaulted decision D-D3 was "generate an offboarding script beside the onboarding one". Rotation is different in kind: the operator already decided to retire the key by rotating it, so removing it needs no second decision.

**What it does.**

- **Rotation retires the key.** `generateKeypair` reads the public key it is about to replace before it overwrites the credentials, and stores it in the card's setting as `retiredPublicKeys` (newest first, the last `RETIRED_KEY_LIMIT` = 10; public halves only). The same key held by both managed credentials is retired once.
- **The onboarding script removes retired keys.** With a retired key on record, the remediation script for each platform gains one step after it authorizes the current key: remove every line whose key BODY matches a retired key, keep every other line as it was. On Windows that step sits before the script re-applies the file's ACL. With nothing retired the scripts are byte-for-byte what they were, so an install that has never rotated publishes nothing new.
- **Detection follows (rule 72).** A detection script asserts every prerequisite its remediation establishes. Remediation now establishes "no retired Polaris key is authorized", so with a retired key on record both detection scripts exit 1 on a host that still authorizes one. In practice a rotation already fails detection everywhere (the new key is absent); this closes the case of a host that was remediated between the rotation and the upgrade that taught the script to strip.
- **An offboarding script per platform.** `GET /server-settings/agents/windows-ssh/script?kind=offboarding`, the third button on the card. It removes the current key and every retired key; the account, in "create" mode only and only while it still carries the marker onboarding stamped on it (the Windows account Description, the Linux GECOS comment); on Linux the sudoers drop-in, only while it carries the "Managed by Polaris" header; and the Polaris firewall allowance. It keeps going past a failure, reports each step, and exits 1 if anything could not be removed.

**What the offboarding script deliberately leaves, and says it leaves.**

- **An account onboarding did not create.** In "existing" mode the account was there first. It is not removed, disabled or taken out of a group.
- **The SSH server.** Other people may depend on it. Not stopped, not disabled, not uninstalled.
- **Windows' own OpenSSH firewall rule.** Onboarding disables it when it scopes TCP/22 to the Polaris server (rule 76). Offboarding removes the Polaris rule and does not re-enable the built-in one: the result is a closed port, which is the safe state for a script that removes access, and the script prints the one command that restores the Windows default.
- **The Polaris Agent.** Uninstalling it is Polaris's job, over the very access this script removes, so the order matters: uninstall the agent from Polaris first. The script warns when the agent is still installed.
- **Intune and Azure Arc objects.** The Remediation Polaris published to Intune and the Run Command resources it created in Arc are not deleted by anything yet. An onboarding Remediation that is still assigned will put everything back on its next cycle; the script header and the wiki say to unassign it first. Tracked in `docs/ORPHAN-AUDIT-LEDGER.md`.

**Why "only what carries our marker".** A script that removes an account named `polaris-agent` because Polaris is configured with that name would delete an account that predates Polaris on any host where the name happened to be taken, and onboarding in "create" mode skips creation when the account already exists. The marker is the evidence that the onboarding script made it. The same reasoning holds for the sudoers file. The cost is that an account an administrator has since re-described is left behind, with a line saying so.

**Why the strippers match on the key body.** The comment on a key line is free text; the detection and remediation scripts have always compared "algorithm + base64" for that reason. The strip helpers (`polaris_strip_keys`, `Remove-PolarisKeys`) reuse the same comparison, so a key whose comment someone edited is still removed and another key that merely shares a prefix is not. The shell helper writes a temp file beside the original, copies the original's mode and owner onto it, and renames it over — sshd refuses an authorized_keys with the wrong owner or mode. The PowerShell helper rewrites the file in place so its ACL is untouched, and empties rather than deletes a file that held only Polaris keys.

**Inputs.** Same contract as the onboarding builders (rule 107): every value is validated and emitted as a single-quoted literal; a malformed retired key is refused, not escaped.

**Verification, and its limits.** The shell stripper is executed by the unit suite against a scratch authorized_keys wherever bash exists, and every Linux script shape is checked with `bash -n`. The PowerShell scripts were parsed with the PowerShell parser and `Remove-PolarisKeys` was run by hand against a scratch file when written; the suite pins them by text. Neither offboarding script has been run on a real endpoint: account removal, the sudoers and firewall steps, and the mode / owner preservation on a real Linux filesystem are unexercised (Git Bash on NTFS does not model file modes).

**Permissions and scale.** The script route keeps its gate (`serverSettingsSystem:read`): the scripts carry public keys only. Nothing here runs per asset or on a schedule.

Pinned by `tests/unit/sshOffboardingScript.test.ts` and the "rule 166" cases in `tests/unit/windowsSshOnboarding.test.ts`.
