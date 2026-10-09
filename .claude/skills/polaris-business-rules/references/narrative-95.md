# Business rule 95 — full narrative

> Written 2026-10-07 as its own file (one file per rule from 78 on). Rule numbers are a
> stable citation key — never renumber. 81 is a deliberate gap.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 95](#rule-95) — The assistant answers as the person asking, only reads, and never types a figure into a report

<a id="rule-95"></a>

## Rule 95 — The assistant answers as the person asking, only reads, and never types a figure into a report

### The ask

2026-10-07. The operator asked for "a new integration for a local LLM that will be used as a
chat bot": a floating icon in the bottom-right corner that expands into a draggable chat
window, where people can ask for reports on any criteria (downloadable) and ask the model to
correlate issues — and, added mid-design, ask how to use or configure Polaris. Their sketch had
the integration create a role and an API token and hand them to the LLM server, "so the local
LLM can perform look ups on the current database". Conversations were to be human-like, stream
as they are written, be saved, and take slash commands (`/clear` and the rest) with a popup
listing them as `/` is typed.

### (a) Lookups run as the person asking — not as the bot

The sketch's literal shape — the model server holds a Polaris token and calls the API itself —
has one consequence the operator was asked about and rejected: everyone who chats would see
whatever the BOT's role can read, including data their own role hides. A `user` with no
`events` read could ask the bot for the audit log and get it. So the chat runs the other way
round: Polaris sends the model the tool definitions, the model asks for a lookup, and Polaris
runs it with the chatting user's own request — `hasPermission(req, key, "read")` first, the
same region scope the Alerts page applies to alerts — and a role without the key gets "Not
permitted" back, which the system prompt tells the model to relay rather than work around. The
`assistant` key therefore can never widen a role; it only decides whether the widget is offered.
It is READ_ONLY and seeded `read` on every role but the token roles, including the protected
`readonly` — which, being uneditable, could otherwise never be granted it.

### (b) Read-only, because model output is untrusted

Tool results carry text that came off the network — hostnames, descriptions, alert messages —
and a model can be steered by text in its context. With only read tools, the worst a poisoned
hostname can do is make the model say something wrong to a person who could already read the
same rows. No tool writes, acknowledges, pushes, probes, or reads a credential, token, account,
role, auth setting, automation script or server setting. The answer is rendered through an
escape-first Markdown renderer that emits a fixed tag set and only http(s) / same-origin links.

### (c) A report's rows come from the database

"Create reports that can be downloaded" invites the model to write a table. A model asked for
120 rows will happily produce 120 plausible ones. `create_report` takes a source list tool and
its filters and Polaris re-runs it server-side with a 5000-row cap; the client receives rows
straight from the query, and the model only learns how many there were. The download (CSV —
with spreadsheet formulas neutralized —, PDF or Markdown) is therefore a database extract with
a title the model chose, and the stored copy is a snapshot, so reopening a conversation
downloads the figures the user saw at the time.

### (d) Conversations belong to one person

A conversation contains whatever its owner could see, so it is that owner's data: every query
is scoped to the session user and a foreign id answers 404 — no admin view, by design. Tool calls
and their results are never stored (re-derived per turn), so a saved thread cannot replay data
its owner has since lost. The audit Event (`assistant.chat`) records that a turn happened and
which lookups it ran — never the question or the answer. A bearer token cannot use the
assistant routes at all: it has no user to own a conversation.

### (e) Retention

The operator wanted conversations saved; unbounded saving of chats that quote inventory is a
liability. `assistant.retentionDays` (default 90) prunes idle conversations from the hourly
`pruneEvents` job in one batched delete, and a user's history is capped at 200 threads.

### (f) The role and token the integration mints

The operator's role + token still exist — for the model HOST's own use (an Open WebUI tool, an
MCP server, a script), not for the chat. Creating an llm integration requires `roles` write and
`apiTokens` write, because it does what those keys gate; it mints `llm-<name>` with read on
every key that has a read rung except credentials, API tokens, users, roles, authentication,
automation scripts and server settings, and a token bound to it, shown once alongside the API
base URL. Deleting the integration removes the token then the role; Regenerate Token replaces
the token. A role added later does not gain new keys automatically.

### (g) Loopback, and only loopback

A local model very often listens on the Polaris host itself (Ollama's default is
`localhost:11434`), which the integration SSRF guard refuses. "Allow loopback" lifts the block
for 127/8, ::1 and `localhost` only; link-local and the cloud metadata address stay refused.

### (h) The Efficiency Advisor speaks through Polaris, not the model

2026-10-07. The owner asked for an optional personality — a patronizing productivity AI that
congratulates you and then tells you to get back to work — built from a list of quotes, and
asked whether it would work across models. The first build put the persona in the system
prompt. Against qwen2.5:7b with the real prompt and tools it parroted one sample quote on
nearly every answer, signed off a critical device-down alert with a quip, and — once the
wording pushed harder — stopped calling its tools and invented an IP for a device that does
not exist and a network count. A personality strong enough to be heard on a small model was
strong enough to break rule 95's "facts come from tools".

So the model never sees it. The owner sorted the quotes into categories; Polaris picks the
category from what the turn actually did (a lookup that found something, found nothing, was
refused; a how-to answer; small talk; a frustrated or complaining question) and shows one line
when the first lookup starts and one under the answer. The lines are stored in their own
columns, not in the answer, because a model that sees them in its history copies them — the
same trap as text-mode tool calls. Nothing is said on an outage, an error or a Stop, and a
line already shown is withdrawn when a lookup turns up something down or critical. The voice
is identical on every model, which answers the original question. It is a per-user checkbox
in the chat window, off by default, and the owner chose to keep it out of the README and the
operator wiki.

### (i) Memory is grounded in what the person typed

2026-10-09. The owner asked whether each user could have their own memory saved in Polaris for
the local model to use, and chose memory the MODEL writes automatically over memory the user
types. The (b) argument is why that needed a clause rather than a tool: a lookup result carries
text off the network, and a model steered by a hostname can be steered into a write. Without
memory the damage ends with the turn; with it, the poisoned sentence rides the system prompt of
every turn after. So the write is judged in code, not by the prompt. `remember` stores a
sentence only when at least 70 % of its meaningful words (stemmed) appear in the message the user
typed THIS turn — the model may rephrase "I manage Nashville" as "Manages Nashville", but cannot
store a sentence nobody typed. `forget` needs that message to ask for a removal or a change, so
text in a lookup cannot wipe someone's memory either. Both are limited to one per turn.

A second filter runs on every write, the user's own included: no IP, network or MAC (memory
about the fleet would replay data a role change later hides — the reason (d) never stores tool
results), no link, nothing that looks like a password, key, token or connection string, and no
"ignore your instructions" phrasing. Entries are capped at 200 characters, 25 per user and 2000
characters in all, which also bounds what memory costs a small context window; the block rides
the system prompt, so `fitHistory` counts it.

Memory is the owner's like a conversation: every query is scoped to the session user, another
user's entry answers 404, there is no admin view, and the rows go with the user. The audit
Events (`assistant.memory.added` / `.removed` / `.cleared`) say who changed it and how many
entries there are — never the text, because the event log is readable by other roles. The
chat window's Memory drawer lists every entry with who wrote it, and a turn that remembered or
forgot something says so under the answer in Polaris's words. A per-user "Remember things"
switch (on by default) withholds both the block and the tools without deleting anything.

Rejected: encrypting entries at rest (rule 20b) — the credential filter keeps secrets out, and
conversations, which hold more, are not encrypted either; a nightly model pass that distils
memory from conversations — it would write from text the user did not just type, which is the
injection path this clause exists to close.

### What is deliberately not here

The assistant is desktop-only for now (not the phone SPA or the Dash wallboard), takes no action
on the operator's behalf, and speaks one dialect — OpenAI-compatible chat completions — rather
than per-vendor clients. Help answers come from a keyword index over `docs/wiki/` shipped with
the build (the Docker image copies it), not from embeddings.
