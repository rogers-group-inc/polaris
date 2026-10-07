# AI Assistant

A chat assistant in the bottom-right corner of every page, backed by a language
model **you run** — Ollama, LM Studio, vLLM, the llama.cpp server, LocalAI or
Open WebUI. Ask it about your devices, alerts, networks and events, have it build
a report you can download, ask it to help correlate an outage, or ask how
something in Polaris works.

> **It sees only what you can see.** Every lookup the assistant makes runs with
> **your** permissions — the assistant can never show you more than your role
> already can. It can only look things up: it never changes, acknowledges,
> pushes or deletes anything. See [rule 95](Business-Rules#rule-95).

---

## Turning it on

1. **Integrations → + Add Integration → Local AI Assistant.**
2. Fill in the model server:

| Field | |
|---|---|
| Assistant name | what people see in the chat window — its title, the button's tooltip and the greeting (blank = "Assistant"). The model is told to answer to it |
| Host / IP, Port | where the model server listens — Ollama's default port is `11434` |
| API path | `/v1` for Ollama, LM Studio, vLLM and llama.cpp; `/api` for Open WebUI |
| Use HTTPS / Verify TLS | for a server behind TLS; untick Verify for a self-signed lab certificate |
| API key | only if the server requires one; stored encrypted |
| Model | pick from the server's own list — **Load models** (or Test Connection) fills it. Each model is marked **✓ tool calling**, **✗ no tool calling** or **tool calling unverified**. Leave it on **Auto** to use the server's first tool-calling model |
| Allow loopback | tick only when the model server runs **on the Polaris host itself** (`localhost`). In a container, use the host's LAN address instead |

3. **Test Connection**, then **Create**.

Pick a model that supports **tool calling** — for example Qwen 2.5 / 3,
Llama 3.1 or newer, or Mistral Small. A model without it can chat, but cannot
look anything up. Larger models follow instructions and choose lookups better;
on modest hardware a 7–14B model is a reasonable start.

**How Polaris knows which models call tools.** The model list itself never
says. On **Ollama**, Polaris reads each model's reported capabilities, so the
marks are the server's own answer, and embedding-only models are left out of
the list. On other servers every model starts as *unverified*; **Check tool
calling** asks the selected model, once, to call a dummy tool and records
whether it did. That costs one model request, so it runs only when you ask.

### What creating it also does

Creating a Local AI Assistant integration also creates, for the **model server's own
use**:

- a **read-only role** named `llm-<integration name>` — it reads inventory,
  networks, alerts, events and maps, and **cannot** read credentials, API
  tokens, users, roles, sign-in settings, automation scripts or server settings;
- an **API token** bound to that role.

The token is shown **once**, with the Polaris API base URL. Give both to the
model server if you want it to call Polaris itself (an Open WebUI tool, an MCP
server, a script — see [REST API](API)). The chat in Polaris does **not** use
this token. Use **Regenerate Token** on the integration card if it leaks;
deleting the integration deletes the token and the role.

Because it creates a role and a token, adding a Local AI Assistant integration needs
**Read-Write on Roles and on API Tokens** as well as on Integrations.

### Who sees the button

Anyone whose role has **AI Assistant** at Read (every built-in role does, the
read-only role included) — once at least one Local AI Assistant integration is enabled.
To hide it from a role, set **AI Assistant** to None under
[Users → Roles](Users-Roles-and-Permissions).

---

## Using it

Click the round button in the bottom-right corner. The chat window opens:

- **Move** it by dragging the title bar; **resize** it from the top-left
  corner. **Double-click** the title bar to send it back to the corner, or the
  top-left corner to restore the default size.
- It stays put when you change page, and an answer that is still being written
  carries on — the next page shows *Still answering…* and then the answer.
  **Stop** is the only thing that stops it.
- **Esc** or the **–** button collapses it back to the button. If an answer
  finishes while it is collapsed, the button shows a dot.
- **Enter** sends; **Shift+Enter** starts a new line.
- Answers appear as they are written. While it works you see what it is doing —
  *looked up assets*, *checked alerts*, *searched the Polaris help*. **Stop**
  cuts an answer off; what was written so far is kept.

Talk to it normally — follow-up questions use the earlier conversation as
context. Some things to try:

- *What's down right now, and what do those devices hang off?*
- *What else alerted within an hour of fw-nsh-01 going down last night?*
- *Which networks are more than 80% full?*
- *Build a report of every FortiSwitch with its serial and firmware.*
- *How do I set up a maintenance window that repeats monthly?*

### Reports

When you ask for a report, list or export, the answer carries a **report card**
with a preview and **CSV**, **PDF** and **Markdown** download buttons. Polaris
runs the query itself (up to **5,000 rows**), so the rows are an extract from the
database, never typed by the model. The report is saved with the conversation:
reopening it later downloads the same figures you saw then.

### Help questions

Questions about using or configuring Polaris are answered from this wiki — the
assistant searches it first and links the page it used. If the help has nothing
on it, the assistant says so. Links in an answer can only point to a real page of
this wiki or to a page inside Polaris; any other link the model writes is shown
as plain text.

---

## Slash commands

Type **/** in the message box to see them. Keep typing to filter; **↑ / ↓** to
move, **Tab** or **Enter** to pick, **Esc** to close.

| Command | What it does |
|---|---|
| `/clear` | Clear this conversation and start over in the same thread |
| `/new` | Start a new conversation (this one stays in history) |
| `/history` | Open your past conversations |
| `/retry` | Ask for the last answer again |
| `/report <what>` | Build a downloadable report, e.g. `/report switches down in the last 24h` |
| `/docs <question>` | Answer from the Polaris help, e.g. `/docs how do maintenance windows work` |
| `/export [md\|pdf]` | Download this conversation, reports included |
| `/rename <title>` | Rename this conversation |
| `/delete` | Delete this conversation permanently |
| `/model [name]` | Show the model in use, or switch to another Local AI Assistant integration |
| `/help` | List these commands |

---

## Conversations

- Conversations are **saved** and reopen where you left off. The history button
  (or `/history`) lists them; rename or delete from there.
- They are **private to you** — no other user, administrators included, can
  read them.
- A conversation untouched for **90 days** is deleted automatically.
- Only the most recent turns (20 by default — *Messages of history sent* on the
  integration) are sent to the model with each question, so a very long
  conversation forgets its beginning; `/new` starts fresh.
- The [event log](Events) records that you asked something and which lookups
  ran — never what you asked or what was answered.

## Tuning (on the integration)

| Field | |
|---|---|
| Temperature | lower = more factual and repeatable; 0.2 is the default |
| Lookup rounds per answer | how many rounds of lookups one answer may take (default 6) |
| Rows per lookup | rows one lookup hands the model (default 200); reports go to 5,000 regardless |
| Messages of history sent | lower it for a model with a small context window |
| Response timeout | how long the model may go silent before the answer fails |
| Extra instructions | added to the assistant's instructions — site naming conventions, who to escalate to |

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No button | no **enabled** Local AI Assistant integration, or your role has AI Assistant set to None |
| "Connected, but model … is not on the server" | the model was removed from the server — pick another with **Load models**, or set it to Auto |
| Loopback refused | tick **Allow loopback**, or use the host's LAN address |
| It chats but never looks anything up | the model does not support tool calling — choose one that does |
| Answers arrive all at once instead of streaming | a proxy or load balancer in front of Polaris buffers responses; the answer still arrives |
| "Not permitted" in an answer | your role cannot read that area — the assistant is telling you, not failing |
| "Help is not available on this install" | the `docs/wiki` folder is missing from this install |

Rule: [95](Business-Rules#rule-95).
