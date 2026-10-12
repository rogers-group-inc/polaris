# Business rule 105 — full narrative

> Written 2026-10-12 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 105](#rule-105) — Text an operator types reaches a command line, a script or a generated connection only after it has been checked, and is checked again where it is used

<a id="rule-105"></a>

## Rule 105 — Text an operator types reaches a command line, a script or a generated connection only after it has been checked, and is checked again where it is used

### Where it came from

A whole-repository security scan on 2026-10-11, run before the repository was announced publicly, reported eight findings with one shape: a value an operator can type was accepted by a route and later placed, as text, into something that executes or is opened elsewhere. They were fixed together as the first phase of the follow-up and this rule is the common statement of them.

### The eight, and what each fix does

**Archive export (F162, the one rated high).** `POST /events/archive-test` handed an unvalidated body to `testConnection`, which put `${username}@${host}` into an `ssh` argv. ssh reads a leading `-` as an option, so a username of `-oProxyCommand=<command>` ran that command through a shell as the Polaris service account, from a caller holding only `events:write`. The settings are now parsed in the route, checked by `assertSafeArchiveSettings` when saved, when tested and again before every export (a value stored before the check existed must not reach a command line), and every destination follows `--`. The same service still sets `StrictHostKeyChecking=no`; that is a separate finding, handled with the other host-key verification defaults.

**The agent server URL (F163).** The override was checked for a scheme and for parsing as a URL, and `new URL()` accepts a quote in a path. The value is returned by `inferOwnServerUrl`, written into `agent.conf` and replaced, as text, into `$serverUrl = '__SERVER_URL__'` in the PowerShell installer and upgrader that run on Windows hosts over WinRM or SSH. A single quote closed the literal and the rest ran as PowerShell on every Windows host Polaris touched. `utils/agentServerUrl.ts` rebuilds the URL from allowlisted parts. A stored value that fails is skipped with a warning rather than failing every install, and the five replace sites call the assertion so a script is never built from a URL that fails it.

**The onboarding scripts (F173, F174).** `assertValidServerIp` accepted anything `isValidCidr` accepted, and `isValidCidr` handed the string to `netmask`, which reads its mask with `parseInt` — `10.0.0.0/24` followed by a line break and anything else was "valid". The value is written into a `#` comment line of the generated script, where a line break begins an executable line, in both the Windows script run as SYSTEM and the Linux script run as root. `isValidCidr` now requires the whole string to be a CIDR, which is the root fix because the helper is used in 26 other places. `assertValidServerIp` also refuses control characters and line separators explicitly, and the PowerShell literal helper doubles the four typographic single-quote characters PowerShell treats as quotes.

**The jsign jar (F198).** The signing settings stored any string as the path to the jar, and the next agent build ran `java -jar` on it as the service user. The logo upload writes attacker bytes to a predictable path after checking only the leading image magic bytes, and a PNG-prefixed JAR is still a valid JAR because Java reads the zip directory from the end of the file. The path is no longer a setting. Installs that set one are told once, in the log, where the jar must be: `tools/jsign.jar`, or the `POLARIS_JSIGN_JAR` environment variable, which is operator-installed like the unit files and so trusted, but must still be an absolute path to a `.jar`.

**The log path glob (F194).** The agent runs `filepath.Glob` on the value, opens every match and ships each appended line to the server, as LocalSystem on Windows, root on macOS and a dynamic user on Linux. `assets:write` could therefore read any file the agent could open, or point it at `\\attacker\share\x` and make a Windows host authenticate to an SMB listener. The shape check refuses network, device and relative paths and `..`; setting a new glob needs `assets=fullwrite`, the grant rule 43 already ties to deploying and driving agents. Only a CHANGE is judged, so an operator without that grant can still resave the log source with the glob as it stands, and can clear it. A stored glob that fails the shape check is withheld from agents. The agent itself is unchanged in this fix, so no fleet upgrade is needed; an agent-side allowlist of log roots remains a possible later step because it would require a release.

**The asset address (F257).** `ipAddress` was any non-empty string and was joined with CRLF into a downloaded `.rdp` file, an `ssh://` link and the `ssh` / `mstsc` command the operator copies and pastes into a shell. The API now accepts only the characters an address or hostname uses, including the address an agent reports about itself, and the browser refuses to build any of those outputs from an address or default username that carries more.

**JSON bodies (F227).** An automation's `api_call` body template substituted device-reported token values raw, so a quote in a hostname could close the string it sat in and add members to the document. A body that parses as JSON once its tokens are filled (each token read as `0`, valid both inside a string and as a bare value) now gets every substituted value JSON-escaped. A body that is form-encoded or plain text is rendered exactly as before, because escaping it would change what existing automations send.

### Why check twice

Every one of these fields reached a command or script by a path other than the route that validates it: a stored Setting saved by an earlier release, an environment variable, a value another route writes, a row restored from a backup. A check at the route alone protects only values typed after it shipped. So each is checked where it is saved and again where it is used, and where the use is the dangerous one (a script, an argv) the second check throws rather than repairs.

### What it deliberately does not cover

Output encoding for HTML is a different defect with a different fix (phase 3 of the same follow-up). Outbound requests to operator-chosen hosts are rule-104-shaped and are handled separately. Nothing here makes a regular expression safe to run (see `utils/regexSafety.ts`).
