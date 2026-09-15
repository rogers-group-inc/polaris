# Automation scripts

**Automations → Scripts.** A registry of operator-authored scripts that
automations can run — on the Polaris server, or on the device that triggered the
alert.

> ## Read this before you enable it
>
> **This is an RCE-equivalent surface.** A server script runs as the `polaris`
> service user. An agent script runs as the agent's user — unprivileged on
> Linux, **LocalSystem on Windows**. Anyone who can write a script here, or
> attach one to an automation, can execute arbitrary code on your estate.
>
> The `automationScripts` key is seeded `fullwrite` **only for
> admin-equivalent roles** and `none` for every other built-in role. That is the
> right default. Widening it is a decision about who may run code on your
> hosts, not about who may edit automations.
>
> Every surface in Polaris that touches this carries a human-review warning.
> Treat any script that reaches production the way you would treat a change to
> the hosts themselves.

| Gate | Grants |
|---|---|
| `automationScripts:read` | see the tab and run history |
| `automationScripts:fullwrite` | create, edit, delete, test-run, **and attach a script action to an automation** |

---

## A script row

| Field | |
|---|---|
| **Name** | unique across the registry |
| **Description** | free text |
| **Interpreter** | `bash` · `sh` · `powershell` · `cmd` · `python3` |
| **Body** | the script source, **≤ 64 KB** |
| **Run target** | `server` · `agent` · `either` |
| **Timeout** | default seconds; a script *action* may override, up to 600 |
| **Enabled** | a disabled script refuses to run |

Polaris computes a **sha256 of the body on every save**. That digest is what an
agent verifies before executing, and a client-supplied hash is never accepted.

### The audit trail is deliberate

- **Creating** a script writes a **warning**-level Event.
- **Changing the body** writes a warning Event carrying the **old and new
  sha256**.

Script tampering has to be visible in the audit log, and Events are shipped
off-host by the syslog and SFTP archivers.

### Deleting

Refused with a friendly 409 while any automation's actions or escalation tiers
reference the script. Run rows snapshot the script name and digest, so history
survives deletion.

---

## Writing a script

### What the script receives

**Not** arguments by default, and not alert context on the command line. Alert
context rides **environment variables**:

| Variable | Holds |
|---|---|
| `POLARIS_ALERT_ID` | the triggering alert's id (empty on a test run) |
| `POLARIS_RULE` | the automation's id |
| `POLARIS_ASSET` | the triggering asset's id |

Use those. A script that needs more should call back into the
[REST API](API) with a bearer token bound to a suitably narrow role.

### Arguments

A script *action* may carry an **args template** using the same `{token}`
vocabulary as an email body — so `{asset}` and `{asset.ip}` are available.

**The rendered string travels as a single argv entry.** It is never concatenated
into a shell string, on either the server or the agent.

> ### The `cmd` exception — read this if you use it
>
> `cmd /c` **has no argv**. It re-parses the raw command line, in which `&`,
> `|`, `<`, `>`, `(`, `)` and `^` are operators — so on that path, cmd.exe *is*
> the shell.
>
> Until 2026-09 Polaris handed it a Node-quoted argv, and Node quotes with the
> C-runtime convention cmd.exe does not implement. An argument of
> `x" & <command> & rem "` **executed `<command>`**. That was reachable rather
> than theoretical: `args` is a rendered template over alert context, so a
> device's own hostname can reach it.
>
> Polaris now `^`-escapes every metacharacter, wraps the command in the extra
> quote pair `/s` requires, and passes it verbatim so nothing re-quotes it.
> Arguments containing `"`, `%`, `!` or **any control character** are
> **refused with an actionable error rather than mangled** — cmd has no in-quote
> escape for a quote, expands `%` and `!` at parse time, and treats CR / LF /
> NUL / 0x1A as line or file enders.
>
> The Go agent carries the identical fix (agent ≥ 0.17.2). The two move in
> lockstep.
>
> **If you can express the job in `powershell` instead, do.**

### The environment

The child process gets `process.env` **minus secret-shaped keys** — anything
matching `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `DATABASE_URL`, `SESSION`,
`CREDENTIAL`, `PRIVATE_KEY`, or ending in `_KEY`.

**This is not a privilege boundary** — authoring a script already requires an
RCE-equivalent permission. It exists because **stdout is stored on the run row
and rendered in the Scripts tab**: before the scrub, a one-line `env` copied
`DATABASE_URL` and `POLARIS_SECRET_KEY` into a displayed, backed-up, unencrypted
column.

It is a **denylist**, so `PATH`, `HOME`, proxy and locale variables stay
inherited and existing scripts keep working.

### Caps and limits

| | |
|---|---|
| Body | 64 KB |
| stdout / stderr | 64 KB each, then capped — an over-cap kill is classified as a **failure**, not a timeout |
| Timeout | up to 600 s, then **SIGKILL** |
| Temp file | mode **0600**, under the state directory, **always** removed |
| Interpreter | resolved to a known **absolute path** where one exists on disk, falling back to a PATH lookup only when none does |

That last one matters: an install with a non-standard layout must keep running,
but the inherited `PATH` should not get first say in which binary executes your
scripts.

---

## Where a script runs

### `server`

Executed by the `runAutomationScripts` job on a 5-second tick, on the `web` (or
`all`) role.

**Execution never happens inline** in the alert engine or the delivery drain. A
wedged script must not stall alert evaluation or deliveries — so a run is a
queued row, claimed with a status re-check so two processes cannot double-run
it, and a stuck-running sweep flips rows past `timeout + 60 s`.

### `agent`

Queued as an `AgentCommand` on the **triggering asset's** agent, which is
preflighted *before* the run row is created: the agent must be **installed**,
**active**, and at **version ≥ 0.13.0**.

The agent is a **satellite** — it never self-acts and refuses unknown actions.
For a script it:

1. **Verifies the sha256** against the body it was handed. A mismatch refuses.
2. Refuses unknown interpreters, and **platform-mismatched** ones — `bash`,
   `sh` and `python3` are refused on Windows; `cmd` is refused off Windows.
3. Writes the body into a **0700 temp directory**, always removed.
4. Runs it with the same argv posture, timeout and 64 KB caps as the server.
5. Reports exit code, stdout and stderr back.

Remember the privilege: **LocalSystem on Windows**, and on Linux whatever tier
the agent unit runs at.

### `either`

The action decides. The run target on the action must be compatible with the
script's, or the request is refused before a run row exists.

---

## Testing

Each script has a **Test** button (`automationScripts:fullwrite`) that starts a
**server-side** run and polls for its exit code and output.

Script and `api_call` actions are **never offered** in an automation's step-6
test-delivery block — the server refuses to run them from a button, on purpose.

---

## Run history

**`/runs`** on the Scripts tab, or the per-script view.

| Column | |
|---|---|
| Script name + sha256 | **snapshots**, so history survives deletion or a body change |
| Run on | `server` / `agent` |
| Asset | agent runs: the triggering device |
| Args | the rendered template snapshot |
| Status | `pending` · `running` · `succeeded` · `failed` · `timeout` |
| Exit code, stdout, stderr | capped at 64 KB each |
| Requested by | `system:automation`, or the operator who pressed Test |
| Timestamps | requested / started / completed |

Rows are pruned after ~90 days. Every run also writes an
`automation.script.run` Event.

The alert link (`notificationId`) deliberately carries **no foreign key** — the
alert lifecycle is independent, and alerts get cleared and pruned on their own
schedule.

---

## Good practice

- **Make scripts idempotent.** A reminder or an escalation tier can fire the
  same action again, and a run can be retried.
- **Exit non-zero on failure**, and write the reason to stderr. Both are stored
  and both are visible.
- **Do not print secrets.** stdout is stored, displayed, and included in
  backups.
- **Keep them short.** The default timeout is seconds, not minutes, and a
  long-running script is better as something the script *triggers* than
  something it waits on.
- **Prefer `api_call` where an HTTP request would do.** It does not need the
  RCE-equivalent grant.
- **Review the body, not the diff.** The warning Event records the digests
  precisely so that a change is reviewable — use it.
