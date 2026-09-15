# Delivery channels

**Automations → Delivery.** The registry of ways Polaris can send something.
An automation's notify action names one or more channels; the channel knows how
to talk to the transport, and the action knows who to reach.

Gated by `automationManagement`.

---

## The six types

| Type | Transport | Recipient-routed? |
|---|---|---|
| **Email — SMTP** | email | yes |
| **Email — Microsoft 365 (OAuth)** | email | yes |
| **Web Push (browser & mobile)** | web push | yes |
| **Slack** | webhook | no — posts to its own channel |
| **Microsoft Teams** | webhook | no |
| **Pushbullet** | pushbullet | no |

"Recipient-routed" is the distinction that matters when you build an automation:
an email or push action has a **To list**, while a Slack or Teams action has a
destination baked into the webhook URL. That is why the automations list shows
the *channel* rather than people in a webhook action's recipient cell, and why
their test buttons live on this tab rather than in the wizard.

---

## Email — SMTP

| Field | |
|---|---|
| SMTP host | |
| **Security** | `none` · `starttls` · `ssl` |
| Port | auto-filled from Security — 25 / 587 / 465 |
| Username | |
| Password | **secret**, sealed at rest |
| From address | |

Security sits **above** Port on purpose: picking a security level fills the
conventional port in for you.

## Email — Microsoft 365 (OAuth)

| Field | |
|---|---|
| Tenant ID | |
| Client ID | |
| Client secret | **secret** |
| Send-as user | UPN or object ID |

**Azure side:** add the **`Mail.Send` application permission** to this app's
Enterprise application (App registration → API permissions → Microsoft Graph →
**Application** permissions → Mail.Send) and **grant admin consent**. The
send-as user must be a **licensed Exchange Online mailbox**.

## Web Push

**Web Push is a single on/off capability, not a destination.** There is one
singleton channel for the whole install.

| Field | |
|---|---|
| Contact subject | `mailto:` or `https:` — what push services contact you at |

Enabling it creates the singleton **and generates the VAPID keypair in one
call**. **Disabling it never deletes the keys**, because every existing browser
subscription is signed against them.

Recipients are chosen per notify action, not here. Enrollment is per browser and
driven by each user's own [notification preference](Navigation-and-Account#notification-preference)
— there is no "enable push" switch anywhere in Polaris
([rule 39](Business-Rules#rule-39)).

## Slack / Microsoft Teams

One field each: the **incoming webhook URL**, stored as a secret.

## Pushbullet

One field: the **access token**, stored as a secret.

---

## Testing a channel

Each row has a **Test** button. Unlike the wizard's test-delivery block — which
rewrites recipients to you and nobody else — a channel test goes wherever the
channel goes. For a Slack or Teams webhook that is the whole channel, which is
exactly what an operator expects when testing a webhook, and exactly why the
wizard refuses to offer it.

---

## Secrets

Every field marked secret is **sealed at rest** by the database layer
([rule 20b](Business-Rules#rule-20)): sealing is per-model, opening is
all-models, and raw SQL bypasses it entirely.

Two consequences:

- A secret is **never returned by a read path**. The edit form shows a
  masked sentinel; leaving it untouched keeps the stored value.
- The sealing key is `POLARIS_SECRET_KEY` from `.env`. **Losing it means losing
  every stored secret** — integration tokens, credentials and these channel
  secrets alike.

---

## What a send actually does

When an automation fires, each notify action expands into one **delivery
target** per channel, and each target into delivery rows.

Two things split a send that you may not expect:

- **Recipient timezone** — timestamps are rendered in each recipient's own zone.
- **Acknowledge capability** — at most **two** copies, never one per person
  ([rule 25](Business-Rules#rule-25)): one carrying the Acknowledge button, one
  with it pruned out for recipients whose role holds `alerts` below `write`.

Because of that, no single copy's To header is the whole audience — which is why
the `{email.recipients}` and `{push.recipients}` tokens scope to the **alert**
rather than to one send, and count delivery rows rather than outcomes.

**A Bcc is never named in that footer** ([rule 60](Business-Rules#rule-60)).

---

## When delivery fails

- A **dead push endpoint** surfaces only at send time. Polaris re-routes that
  one alert to the action's own email channel — once per dead endpoint, because
  the 410 also prunes the subscription and every later alert takes the
  fire-time path instead.
- A **recipient with no email address** is dropped, and the builder warns about
  it. (It warned about missing *push* devices long before it warned about this.)
- A failed send is retried on the next sweep. A reminder whose channel was dead
  retries and is still the one that reports a quiet-time hold.
