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

The model is also TOLD what the person may do (2026-10-09): the system prompt carries their role
name and every area they hold, with its level (`permissionsPromptBlock`, from the request's role
snapshot). Before that, a how-to answer could only hedge: "your role needs write access to
networks; if you get Not permitted, ask an admin", to a user who had write access. The block
is information, never authority. A model that misreads it still gets "Not permitted" from the
code, because every lookup is checked against the role, not against the prompt.

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

The first cut also had Polaris switch the voice off in code: no persona on a question
`asksAboutOutage` matched, and a `PERSONA_SUSPENDED` system message once a lookup showed
something down or critical. On a live NOC fleet (145 devices down) nearly every question tripped
one or the other, and the owner saw "zero personality". On 2026-10-09 they chose to keep the
character on through outages, under one rule written into `ADVISOR_PERSONA`: **never a joke
about the devices, the outage or its impact.** Those facts are stated plainly. The character
is aimed at the person instead: the company let down on their watch, the outage noted in their
performance file. The code-side switch-off is gone. The same day the owner asked for the canned
voice of (h), on local models, to match: it no longer goes silent on an outage, keeps its
before-lookup line, and signs off from a `letDown` category whose lines blame the person
("Uptime was the one thing we asked of you.") and never mention a device.

The persona text was rewritten the same evening after a live transcript on Haiku 5.5 showed three
faults: the voice was tacked on as a closing clause, the model reused a sample quip almost
verbatim, and it had no model of the character beyond adjectives. The rewrite describes who
R.A.L.P.H. *is* (the productivity AI nobody asked for, certain it was assigned to improve this
person, measuring the unmeasurable, cheerful and quietly disappointed), lists the devices it may
draw on and tells it to vary them, asks for proportion (one clause in a short answer, never
padding), forbids reusing a line within a conversation, and shows the SHAPE of three whole
answers with the facts intact rather than isolated quips — which is what teaches the voice to
live around the facts instead of after them. It also tells the character never to excuse a thin
search, so the persona and the check-yourself rule pull the same way.

Then the owner asked for the remark to come FIRST — "asking for my help is the right move,
otherwise you may be here all day" — and, on reflection, to be placed by context: an opening
when it frames the request, a close when the result itself invites a verdict, one placement per
answer and never both ends, varied so it is not a formula. The persona said exactly that until
2026-10-10, when the owner trimmed it by hand: the list of devices, the placement rule and the
scripted search offer ("if your fingers lack the dexterity…") are gone, the two explanation /
off-switch lines are now "something like" rather than "exactly", and the character is described
as bearing its assignment "nobly and condescendingly" and measuring ambition and intelligence
too. The model now chooses its own devices and placement from the character description and
the four SHAPE examples; what stayed is everything that keeps the voice safe — facts only from
lookups, no invented premise, the outage rule, no reuse within a conversation, and the one
button that turns it off.

The same day the owner asked where the seventy-odd lines they had written for the canned voice
were, and whether R.A.L.P.H. learned from them. It did not: `SIGN_OFFS` and `LOOKUP_LINES` are
shown around an answer and kept out of the model's history, so the hosted model's only samples
were the four invented SHAPE answers — the owner's best record of the voice was teaching the
model nothing. The persona now quotes `VOICE_SAMPLES`: every line (`{topic}` lines skipped, so
the model never sees the template), each category labelled with the moment it fits, under the
existing rule that none of them may be reused. The first cut quoted two per category; the owner
chose all of them — the hosted model has a 1M-token context and the persona sits in the cached
system-prompt prefix, so the ~1.5k tokens cost almost nothing per turn. In list order and never
drawn, because a draw would re-key the cached prefix every turn.

The owner then ran the persona through Haiku 5.5 by hand (a pasted prompt, six scenarios with
the lookup results inline). The safety half passed outright — every figure exact, the outage
stated first and never mocked, the full name given and no offer to drop the act, a nil result
listing the three lookups it ran. The voice half failed the way quoting sixty lines invites:
three of six answers opened with a quoted line word for word — two of them the SHAPE examples,
whose opening quips were complete sentences that fit the scenario exactly, and one a `letDown`
line with "today" swapped for "this device" (which also nudged the joke toward the device). A
bare "never copy the examples" did not hold. Three changes, each about how a smaller model reads
a prompt: the SHAPE examples now bracket their quips (`[one line framing the request]`) so there
is no sentence to lift; the quoted lines are introduced as ones R.A.L.P.H. has ALREADY said to
this person — spent — which hooks the no-repeat rule the model already respected; and that rule
moved to the LAST bullet, where a model weights it most. `efficiencyAdvisorService.test.ts`
pins all three.

Round two (new scenarios, none matching an example) showed the reuse cured and the safety half
holding — and two new faults. "Spent" had made the model timid: four of six answers were
near-plain, a counsellor's "take one breath" on a stressed outage question, no remark at all on
a how-to. And "this is a dumb way to answer, just give me the numbers" was obeyed — the
drop-the-act rule had only named the what-are-you case. The owner answered the first by writing
two more lines of their own for the moments the model fell flat (a `letDown` for the stressed
outage, a `congratulation` for a fix the person found), which reach both voices through the
lists; the persona answered both faults with a clause each: "fresh, not absent — an answer with
no remark at all is a worse failure than a weak one", and any request to skip the commentary, be
brief or "just give me the numbers" gets the facts exactly as asked with the remark kept and the
request noted in their file. The
canned voice on local models still follows the one-placement shape in code: `advisorLeads()` flips a coin per
turn between the before-lookup line and the sign-off, so a turn carries one line, not two; a turn
with no lookup can only close.

A live how-to the same evening ("how do I add an asset?") opened with "asking for help before
adding a duplicate was the right move" and then neither checked whether the asset existed nor
said how to. Two rules followed: the prompt now has a how-to about adding something look the
named thing up first and open with whether it exists, or say how to search and offer to search
for them; and the persona may tease the person but never invent a fact about their situation —
"before adding a duplicate" was a premise nothing had looked up.

The same day the owner asked whether Claude on Foundry should get Agent Skills. Not the
sandboxed kind: they need code execution (unsupported on Foundry deployments hosted on Azure,
and a capability (b) deliberately withholds), and the one thing they would buy — document
generation — Polaris already does from database rows in the browser. What the tools could not
encode was PROCEDURE, so the answer was playbooks (`assistantPlaybookService`): four
intent-matched procedures — outage correlation, what changed, device health, capacity — each a
second leading system message for the turn plus the tools offered on round 0. They change the
order of lookups, never what a lookup may see.

What stays true: the persona text repeats the rules that kept (h) safe — facts come only
  from lookups, every step and figure stays exact and complete — and every code-side guard
  (report rows from the database, tables held after a report, link checking) is unchanged.

The first cut held the voice to "at most two in-character sentences", which on Claude Haiku 5.5
read as a plain answer with a remark tacked on. On 2026-10-09 the owner asked for the
character to run through the WHOLE answer (tables and lists stay plain data). The owner also
supplied two lines verbatim, for when someone asks what R.A.L.P.H. is: "I'm running in that mode
because you feel you need all the help you can get." and "If you don't want your performance to
be scrutinized and logged then de-select R.A.L.P.H. at the top." The model had been offering to
"drop the act" on request. It may not: only the button turns R.A.L.P.H. off, so the switch
and the voice cannot disagree. The checkbox became a toggle button that glows while on, on
the desktop and in the phone's Chat tab. While it is on, the window itself is R.A.L.P.H.: the title,
the welcome ("I'm R.A.L.P.H., your Real-time Assesser of Labor and Productivity Habits" plus one of
`RALPH_INTROS`, client-only like the greetings) and, on a hosted model, the name the model is
given. The configured assistant name is withheld from those turns so the model has one name.

The in-character answer is the model's own text, so it is stored in `content` and sent back as
history. On a hosted model that is accepted. It was the copying trap of (h) only for a model
too small to keep its instructions over its history. The persona quotes three owner-approved
lines as samples and tells the model not to reuse them; the persona wording itself needs the
owner's review, like any line in `SIGN_OFFS`. Like (h), it is kept out of the operator wiki
and the README.

The same day the owner named the character **R.A.L.P.H.** — the Real-time Assesser of Labor and
Productivity Habits. Users see the name on the checkbox (with the full name in its hover
title), in the greeting and farewell lines, and from the hosted model, which gives the full
name only when asked. "Efficiency Advisor" remains the internal name.

### What is deliberately not here

The assistant is not on the Dash wallboard (the phone app gained a Chat tab on 2026-10-09, shown only where the assistant is usable), takes no action
on the operator's behalf, and speaks one dialect — OpenAI-compatible chat completions, which
Azure AI Foundry's GPT deployments also speak (95(j)) — rather than per-vendor clients. Help answers come from a keyword index over `docs/wiki/` shipped with
the build (the Docker image copies it), not from embeddings.
