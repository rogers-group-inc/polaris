# Business rule 119 — full narrative

> Written 2026-10-14 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 119](#rule-119) — What a monitored host gives Polaris, or lets Polaris write, cannot be redirected by another account on that host — and cannot take Polaris down

<a id="rule-119"></a>

## Rule 119 — What a monitored host gives Polaris, or lets Polaris write, cannot be redirected by another account on that host — and cannot take Polaris down

### The findings

The 2026-10-13 re-scan of main (phase 13 of the fix plan) found four ways an unprivileged
account on a monitored host could reach past its own files through something Polaris did
with root or Administrator rights, and one way the host itself could stop Polaris:

- **F63 / F67 — Linux and macOS staging.** Install, upgrade, uninstall and reboot-permission
  uploaded `/tmp/polaris-agent.bin`, `/tmp/polaris-agent.conf` (with the enrollment token)
  and `/tmp/polaris-agent-install.sh`, then ran `sudo -n bash /tmp/polaris-agent-install.sh`.
  SFTP opens with create/truncate and sets the mode only on a NEW file, so a user who
  `touch`ed those names first (and `chmod 666`) kept ownership: they read the token and
  could rewrite the script or binary before root ran it. `fs.protected_regular` is 0 by
  default on RHEL 8 and does not exist on macOS.
- **F64 / F67 — Windows staging.** The PowerShell scripts went to
  `C:\Windows\Temp\polaris-agent-*.ps1`. Any standard user can create a file there and keeps
  CREATOR OWNER rights over it after the administrator's upload lands in it.
- **F68 — the process-log tailer.** The agent reads operator-chosen log globs with root /
  LocalSystem / CAP_DAC_READ_SEARCH. `os.Stat` + `os.Open` followed symlinks and junctions,
  and a saved offset past the end reset to 0 — so the account owning the log directory could
  swap a file for a link to `/etc/shadow` and the agent shipped it to Polaris line by line.
- **F8 — a `null` agent frame.** `JSON.parse("null")` then `frame.type` threw inside the ws
  message listener, outside every try/catch; the crash handler exited the web role. One
  compromised agent host could keep the UI and the API down by reconnecting in a loop.

### What was built

**A directory per run** (`src/utils/remoteStaging.ts`). Linux / macOS: `umask 077 && mktemp -d
/tmp/polaris-agent.XXXXXXXXXX` as the SSH user — atomically new, mode 0700, owned by that
user, so nobody else can create, swap or read a file inside. Only exactly what mktemp returns
is accepted (a strict regex), so the path needs no quoting in the root command, which removes
the directory after the run while keeping the script's exit code. Windows: a random directory
under `[IO.Path]::GetTempPath()` of the SSH session — the administrator's own
`%LOCALAPPDATA%\Temp`, which standard users cannot enter; a profile whose TEMP resolves to
`C:\Windows\Temp` is refused rather than silently used. `%ProgramData%` was considered and
rejected: standard users can create folders there, so the PARENT could be someone else's.

**The binary is checked by root.** The staged installer and upgrader take the directory as $1
and the binary's SHA-256 as $2 and refuse a mismatch before `install`. Inside a private
directory this is belt and braces, but it also makes a truncated or substituted upload fail
loudly instead of installing.

**The tailer never follows a link** (agent 0.27.0). Each match is `Lstat`ed; symlinks,
junctions and reparse points are skipped, and so is a link in a wildcard-matched directory
component (otherwise `/var/log/*/app.log` could be pointed anywhere) — a link the operator
typed literally in the glob is followed, because they chose it. The open itself refuses links
(`O_NOFOLLOW`, `FILE_FLAG_OPEN_REPARSE_POINT`) and checks the handle is a regular file, so a
swap between the check and the open still fails. **Hard links** are the one way left to make a
root-only file appear in the directory as a regular file, so a file with more than one link is
skipped too. The first build seeded every new identity at end of file instead; that dropped the
lines written between a normal rotation and the next poll, so a rotated-in file (one link, new
identity) is read from 0 again, and an old cursor with no saved identity adopts the current one
rather than resetting.

**A bad frame closes its own socket.** `asFrame` accepts only an object with a string `type`;
the listener's body is wrapped so any throw detaches that agent's session.

### What it changes on an existing install

- Nothing to do. The next install, upgrade, uninstall or reboot-permission change stages the new
  way; the SSH user's passwordless sudo (`NOPASSWD:ALL`, from the onboarding script) already
  covers the new command shape.
- After the agent upgrade to 0.27.0, a process-log glob that matches a symlinked or hard-linked
  file stops tailing it; the agent log says which path and why (processLog has no status
  channel to the server). A backup tool's hard-link snapshot of a live log is the realistic
  legitimate case.
- Windows: a file with any reparse attribute (deduplicated, OneDrive placeholder) is refused —
  rare for a live log.

### Not proven

- Never run on a real host; the Linux tests ran in podman (golang 1.26), the Windows junction
  and hard-link tests on the dev host, macOS only cross-compiled.
