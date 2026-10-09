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

### (j) A provider is a transport, not a policy

2026-10-09. The owner runs Qwen locally and wants Azure AI Foundry in production, where the
organisation routes all inference through Foundry. The choice was a Provider field on the
existing `llm` integration, not a new integration type. A new type would have needed its own
copy of the role and token provisioning, the conversation store and the assistant routes, and
every guarantee in (a)–(i) would then have to be kept true in two places. With a field, Foundry
changes only how a request is ADDRESSED and AUTHENTICATED: the path (`/openai/v1/...`, or the
dated deployments path), the `api-key` header or an Entra ID client-credentials bearer, and the
fact that Foundry cannot list deployments. That last one is why Test Connection sends one
tiny chat round instead of reading a model list. All of it lives in `llmService.ts`, so the
chat orchestrator, the tool layer and the memory feature never learn which provider answered.
Rows made before this have no `provider` and read as `openai`. Nothing about them changes, and
their first plain save does not count as a "move" that drops the tool-calling verdict.

Secrets went where the existing ones already go. The key reuses `apiToken`, and the service
principal's secret `clientSecret`. Both are in `SECRET_CONFIG_KEYS`, so they are sealed at rest
and masked on read with no new code. The Edit form sends both blank to mean "keep", so the
test routes restore them from the stored row BEFORE the shape check, which requires them for
Azure. The Entra token is cached under a hash of the secret, so a rotated secret never reuses
a token minted with the old one.

Reasoning deployments (o-series, gpt-5) refuse `temperature`. Polaris offers an "Omit
temperature" box, and also retries once without the parameter when Azure answers 400 naming
it, so a missed tick costs one request, not an outage. Rejected: the Responses API (a
different dialect for no gain here) and a `max_completion_tokens` setting (deferred until
someone needs it).

Later the same day the owner chose Claude Haiku 5.5 on Foundry. Claude deployments do not
speak chat completions: they serve Anthropic's Messages API at `/anthropic/v1/messages`, with
`x-api-key` or an Entra token for `https://ai.azure.com/.default`. So that is a third API shape,
`anthropic`. The owner chose Anthropic's official SDK (`@anthropic-ai/foundry-sdk`) over another
hand-rolled transport. The SDK is the supported path, it tracks the event-stream format as
Anthropic changes it, and it handles retries. The cost is two npm dependencies.

Three things the SDK does not decide, kept in `llmService.ts`:
- **credentials:** every one is passed explicitly, because the SDK otherwise falls back to
  `ANTHROPIC_FOUNDRY_*` environment variables, and a variable left on a host would silently
  change who Polaris authenticates as;
- **idle timeout:** the SDK's timeout ends when the response headers arrive, so Polaris keeps
  its own idle watchdog on the stream;
- **thinking replay:** Claude's thinking blocks must go back unchanged with the tool calls they
  preceded, so a round's raw blocks ride the next round's assistant message.

No `temperature` is ever sent to Claude, because current Claude models refuse non-default
sampling.

### (k) On a hosted model, the Efficiency Advisor is the model's own voice

2026-10-09, the same day as (j). With Azure AI Foundry in place, the owner asked for a fuller
personality than canned quotes. The model in mind was a hosted Claude (Haiku 5.5, 1M-token
window). The owner decided:
- **local model server:** the code-picked lines of (h), unchanged;
- **Azure AI Foundry:** the model speaks in character;
- **both:** nothing unless the person ticked Efficiency Advisor.

(h) is not overturned. What failed in (h) was a 7B model holding a persona and the task at the
same time. The decision is that a hosted model can do both, so the voice is chosen by provider,
not by a per-model guess (`advisorVoice`). The two voices never mix: on Azure no canned
preface or sign-off is shown, because a scripted line beside a model already in character
reads as two people talking.

What Polaris still decides in code:
- **when the voice is absent:** a question `asksAboutOutage` matches gets no persona at all;
- **when it stops:** a lookup `lookupShowsOutage` matches appends `PERSONA_SUSPENDED` as a
  system message after that round's tool results, so the rest of the turn is plain;
- **what stays true:** the persona text repeats the rules that kept (h) safe — facts come only
  from lookups, the answer comes first, at most two in-character sentences — and every
  code-side guard (report rows from the database, tables held after a report, link checking)
  is unchanged.

The in-character answer is the model's own text, so it is stored in `content` and sent back as
history. On a hosted model that is accepted. It was the copying trap of (h) only for a model
too small to keep its instructions over its history. The persona quotes three owner-approved
lines as samples and tells the model not to reuse them; the persona wording itself needs the
owner's review, like any line in `SIGN_OFFS`. Like (h), it is kept out of the operator wiki
and the README.

### What is deliberately not here

The assistant is desktop-only for now (not the phone SPA or the Dash wallboard), takes no action
on the operator's behalf, and speaks one dialect — OpenAI-compatible chat completions, which
Azure AI Foundry's GPT deployments also speak (95(j)) — rather than per-vendor clients. Help answers come from a keyword index over `docs/wiki/` shipped with
the build (the Docker image copies it), not from embeddings.
