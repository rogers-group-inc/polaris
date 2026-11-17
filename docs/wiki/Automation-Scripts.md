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
> The `automationScripts` key stops at `write` — it has no `fullwrite` rung. It
> is seeded `write` **only for admin-equivalent roles** and `none` for every
> other built-in role. That is the
> right default. Widening it is a decision about who may run code on your
> hosts, not about who may edit automations.
>
> Every surface in Polaris that touches this carries a human-review warning.
> Treat any script that reaches production the way you would treat a change to
> the hosts themselves.

| Gate | Grants |
|---|---|
| `automationScripts:read` | see the tab and run history |
| `automationScripts:write` | create, edit, delete, test-run, **and attach a script action to an automation** |

**+ Add Script** opens the editor. Each script is a card showing its
interpreter and run target, its timeout and the start of its sha256, with
**Test run**, **Edit** and **Delete** for `write`.

---

## A script row

| Field | |
|---|---|
| **Name** | unique across the registry |
| **Description** | free text |
| **Interpreter** | `bash` · `sh` · `powershell` · `cmd` · `python3` |
| **Body** | the script source, **≤ 64 KB** |
| **Runs on** | `server` (the Polaris server, the default) · `agent` (the triggering asset's agent) · `either` |
| **Default timeout** | 1–600 seconds, default **60**; a script *action* may override it |
| **Enabled** | a disabled script refuses to run |

Polaris computes a **sha256 of the body on every save**. That digest is what an
agent verifies before executing, and a client-supplied hash is never accepted.

### The audit trail is deliberate

- **Creating** a script writes a **warning**-level Event.
- **Changing the body** writes a warning Event carrying the **old and new
  sha256**. An edit that leaves the body alone writes an info Event.
- **Deleting** a script writes a warning Event carrying its last sha256.

Script tampering has to be visible in the audit log, and Events are shipped
off-host by the syslog and SFTP archivers.

### Deleting

Refused with a friendly 409 while any automation's actions or escalation tiers
reference the script. Run rows snapshot the script name and digest, so history
survives deletion.

### Exporting and importing

**Right-click a script** (or click its name) for its menu: **Edit**, **Test run**,
**Export** and **Delete**. Readers see only Export.

- **Export** downloads `<name>.script.json`: the name, description, interpreter,
  where it runs, the default timeout and the body. It does not carry the
  script's id, its sha256 (Polaris computes that again on save) or whether it is
  enabled.
- **+ Add Script → Import from file** fills the New script form from a
  `.script.json` export or from a plain script file (`.sh`, `.py`, `.ps1`,
  `.cmd`, `.bat`). For a plain file, the interpreter comes from the extension or
  the file's `#!` line, and the name from the file name. **Nothing is saved
  until you read the body and press Create script** — a script runs with full
  privileges, so an imported one gets the same review as one typed in.
- **Edit → Replace from file** loads a new version over an existing script.
  The script keeps its name, so every automation that runs it keeps running
  the new version. A plain script file replaces the body, and the interpreter
  when its extension or `#!` line names one; the run target, timeout and
  description stay as they were. A `.script.json` export replaces everything
  except the name. As with an import, nothing is saved until you read it and
  press **Save changes**.

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
| `POLARIS_RUN_ID` | this run's id (server runs) |
| `POLARIS_RUN_TOKEN` | this run's email pass — only when the action lets the script send email (below) |
| `POLARIS_API_URL` | the Polaris API on this host, e.g. `http://127.0.0.1:3000/api/v1` — with the pass |

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
> Ordinary argv quoting follows the C-runtime convention, which cmd.exe does not
> implement, so a naively quoted argument of `x" & <command> & rem "` would
> **execute `<command>`**. That is reachable rather than theoretical: `args` is
> a rendered template over alert context, so a device's own hostname can reach
> it.
>
> Polaris therefore `^`-escapes every metacharacter, wraps the command in the
> extra quote pair `/s` requires, and passes it verbatim so nothing re-quotes it.
> Arguments containing `"`, `%`, `!` or **any control character** are
> **refused with an actionable error rather than mangled** — cmd has no in-quote
> escape for a quote, expands `%` and `!` at parse time, and treats CR / LF /
> NUL / 0x1A as line or file enders.
>
> The Go agent applies the identical escaping (agent ≥ 0.17.2). The two move in
> lockstep.
>
> **If you can express the job in `powershell` instead, do.**

### The environment

The child process gets `process.env` **minus secret-shaped keys** — anything
matching `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `DATABASE_URL`, `SESSION`,
`CREDENTIAL`, `PRIVATE_KEY`, or ending in `_KEY`.

**This is not a privilege boundary** — authoring a script already requires an
RCE-equivalent permission. It exists because **stdout is stored on the run row
and rendered in the Scripts tab**: without the scrub, a one-line `env` would copy
`DATABASE_URL` and `POLARIS_SECRET_KEY` into a displayed, backed-up, unencrypted
column.

It is a **denylist**, so `PATH`, `HOME`, proxy and locale variables stay
inherited.

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

**The agent has 15 minutes to pick the script up.** An agent that is online
collects it within seconds. If the host is off or unreachable, the script waits
at most 15 minutes and is then **withdrawn**: it will never run, the run shows as
`failed` with the reason, and a warning Event is written. A host that comes back
later is not handed the old script. Polaris does not queue it again by itself;
if the automation's condition still holds, its next fire, reminder or escalation
queues a new run ([rule 155](Business-Rules#rule-155)).

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

## Sending email through Polaris

A script that runs on the **Polaris server** can send email through one of your
email delivery channels (SMTP or Microsoft 365), so it needs no mail settings
or password of its own ([rule 190](Business-Rules#rule-190)).

1. On the automation's **Script** action, tick **Let this script send email
   through Polaris**. Tick the email **Channels** to send through and fill
   **To**, **Cc** and **Bcc** exactly as on a **Send a notification** action:
   type a name or address, or use the **Address book** for people, roles,
   regions, tags, the asset's region users or its contacts. These are worked
   out when the automation fires, for the device that set it off; if To works
   out to nobody, the script is not run.
2. Each run then finds a one-time pass in `POLARIS_RUN_TOKEN` and the address to
   use in `POLARIS_API_URL`. The script sends with:

```python
import base64, json, os, urllib.request

body = {
    "subject": "TLS certificate renewed: intranet.example.com",
    "text": "The new certificate is attached.",
    "files": [{"filename": "intranet.pem", "contentType": "application/x-pem-file",
               "contentBase64": base64.b64encode(open("/tmp/cert.pem", "rb").read()).decode()}],
}
req = urllib.request.Request(
    os.environ["POLARIS_API_URL"] + "/script-runs/self/email",
    data=json.dumps(body).encode(), method="POST",
    headers={"Content-Type": "application/json",
             "Authorization": "Bearer " + os.environ["POLARIS_RUN_TOKEN"]})
print(urllib.request.urlopen(req, timeout=20).read().decode())
```

What the script can and cannot do:

- It sets the **subject, text and attachments**. It **cannot choose who
  receives the email**: the recipients come from the action. A request that
  names recipients is refused.
- Each email goes out as **one message per ticked channel**, with everyone in
  To able to see each other (use Bcc to hide an address). If one channel fails
  and another works, the send counts as sent and the failure is recorded in
  Events; if every channel fails the script gets a 502.
- Up to **3 emails per run**, up to **5 attachments**, **512 KB** of
  attachments in total. Programs and scripts (`.exe`, `.ps1`, `.js`, …) cannot
  be attached.
- The pass works only **while the run is running**, only from the Polaris host
  itself, and is erased when the run ends.
- Every email ends with a line naming the script and run, and every attempt is
  recorded in Events (`automation.script.email_sent` /
  `automation.script.email_failed`).
- Not available to a script that runs on an agent.

| Answer | Means |
|---|---|
| 200 `{ "sent": 1, "remaining": 2 }` | sent to that many recipients; that many sends left this run |
| 400 | the request is wrong (a missing subject, a blocked attachment type, too large) |
| 401 | no pass, a wrong one, or the run has ended |
| 403 | not called from the Polaris host |
| 409 | the channel was deleted or disabled |
| 429 | this run has already sent 3 |
| 502 | the channel could not send — the error says why |

A delivery channel a script action sends through cannot be deleted while the
automation uses it.

## Testing

Each script has a **Test run** button (`automationScripts:write`). It asks for
the **arguments** to pass (one string, as an automation's args template would
render), then — when an email channel exists — whether the test may send email.
A test's email goes **only to you**, at the address on your account. It starts a
**server-side** run and shows the status, exit code, stdout and stderr under the
card when it finishes. A script
that runs on `agent` only cannot be test-run from here — trigger it through an
automation on a real asset.

Script and `api_call` actions are **never offered** in an automation's
test-delivery block on the Summary step — the server refuses to run them from a
button, on purpose.

---

## Run history

Every run is kept as a row, read through the [API](API)
(`/automations/scripts/runs`, filterable by script, alert and status). The
Scripts tab itself shows only the result of a **Test run**.

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
- **Keep them short.** The default timeout is 60 seconds, and a
  long-running script is better as something the script *triggers* than
  something it waits on.
- **Prefer `api_call` where an HTTP request would do.** It does not need the
  RCE-equivalent grant.
- **Review the body, not the diff.** The warning Event records the digests
  precisely so that a change is reviewable — use it.
