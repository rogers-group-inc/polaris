# Business rules 60–64 — full narrative

> Split out of `narrative-44-48.md` in 2026-09, which had reached the 1500-line reference-file
> ceiling. Rule numbers are a stable citation key and did not change; only the file holding
> them did.

Verbatim from BUSINESS-RULES.md: each rule records the decision *and the incident or constraint that forced it*. The invariant for each rule is in `invariants-30-43.md`; rule numbers are a stable citation key — never renumber.

- [Rule 60](#rule-60) — A footer that tells the reader who else knows must never name a Bcc
- [Rule 61](#rule-61) — Changing a credential ends every other session on it, and rotating your own must carry the CSRF token across
- [Rule 62](#rule-62) — An install is identified by something it persists, never by the name the runtime handed the process
- [Rule 63](#rule-63) — The complexity bar belongs to the operator, and a password that no longer meets it is replaced on the far side of the second factor
- [Rule 64](#rule-64) — A passkey is bound to the origin that issued its challenge, the install decides what a passkey is for, and it never names an account that does not already exist

<a id="rule-60"></a>

## Rule 60 — A footer that tells the reader who else knows must never name a Bcc

An alert that routes to both email and web push reaches two audiences that cannot see each
other. The person reading the email has no way of telling whether the on-call phone buzzed
thirty seconds ago or whether they are the only one who has heard about this, and that
question decides whether they pick the device up or leave it to whoever is already on it.
`{push.recipients}` put the push half of that answer in the footer.

The mail half was missing, and the reason it could not simply be read off the To header is
the part worth writing down. **No single copy's To line is the whole audience of an alert.**
When this shipped, a composed send split per recipient TIMEZONE (the body being re-rendered
per zone) and again per acknowledge CAPABILITY (rule 25's `splitAckVariants`). **Both splits
were removed on 2026-09-15** — for this exact reason, arrived at from the other end: an
operator looked at their own copy of a FortiAP-down alert, saw one address on the To line and
a footer naming two, and read it as Polaris mailing each recipient separately. A footnote
that has to explain away the header is a sign the header is wrong.

The line still earns its place, because three of the reasons never depended on the split. A
second notify action on the same automation mails its own recipient list. A reminder, and
every escalation tier, adds people the first copy never had — which is exactly the situation
an operator is trying to reason about when they look. A Cc rider is a reader the To line does
not name. So a reader who checks the To line to see who else is on this ALERT still gets a
confidently partial answer, and the partiality is invisible: the header looks complete.

**The second of those three reasons was the one that had to go, and it took the alert scope
with it (2026-09-16).** An operator read a reminder whose footer said `Email sent to <the
division manager>` and concluded their reminders were escalating over their head. They were
not: the manager sat on the T+30 tier and on no reminder at all. But the footer read every
delivery row the alert had ever produced, so from the moment tier 1 fired, every later
reminder named them — and the automation's own page, which showed the manager only under
Escalation, read as though it were lying.

"Who else knows about this alert" was an honest question and the answer was accurate. It was
simply not the question a line at the bottom of one email gets read as. A footnote on a
message is read as a claim about that message; no amount of correctness in the header comment
reaches the person holding the phone at 3am. So **both lines now scope to the SEND**: the fire
names the fire's recipients, a reminder names that reminder's, an escalation tier names the
tier's.

**The grain is the FAN-OUT, not the delivery row**, and that distinction is what keeps the
feature alive rather than quietly killing it. One `executeActions` call is one send:
`expandDeliveries` stamps the id it mints into every row's `meta.dispatch`, and
`buildRecipientBlocks` narrows on that stamp — in the query, because a weekend-long outage
reminding every five minutes leaves hundreds of rows hanging off one alert. Scoped to the
row instead, an automation that mails the NOC and pushes the on-call would stop telling the
NOC that the phone buzzed, which is the entire reason `{push.recipients}` was written. Scoped
to the fan-out, it still does: those are two actions of one fire. The sweep's repeat pass runs
one action per call, which is precisely what stops a reminder from borrowing a tier's
audience. A row carrying no stamp — queued before this shipped and still draining — falls
back to the alert-wide read rather than losing its footer, the same "a slightly-too-wide
answer beats no answer" posture the `meta.userId` stamp already takes.

Prod 2026-09-14 is the case that made it concrete. A FortiGate-down alert routed its reminder
to the site's two people at region level 1 and escalated hourly to the division at level 2.
Reading any one of those emails, none of the four recipients could see the other three: the
two site people were on a second copy split off by acknowledge capability, and the division
pair were only ever on the escalation. Each copy's To line was accurate and each was a quarter
of the picture. The first half of that has since been fixed at the source — the site pair are
one message again — and the second half cannot be: an escalation tier that has not fired yet
has no recipients to name.

So `{email.recipients}` renders beside its push sibling in the same 11px footer block, sourced
from the send's own email delivery rows, deduped by address across every copy and every notify
action of that fan-out. Both lines scope to the SEND rather than to the alert (see above —
they were alert-wide until 2026-09-16), and both count ROWS rather than outcomes — the email and the push drain in the same pass, sometimes the same
chunk, and a push service's 202 was never proof of delivery anyway ("sent to" is the honest
verb, the same reachability posture `preferenceWithholds` takes).

**The Bcc rule is the load-bearing half, and it is not where it looks.** A blind copy that
appears in a footer every recipient reads has stopped being blind, and the operator who Bcc'd
someone has been overruled by a footnote they never asked for. The obvious reading is that the
renderer filters Bcc out. It does not — it is never handed one. Both email paths put To, and
only To, in `NotificationDelivery.target`: the composed path joins the whole To line into a
single row, and the plain per-address path writes one address. `toAddressesOf` therefore
cannot reach a Bcc no matter what it parses. Cc IS named, being visible to everyone on that
copy already, and it comes from `meta.cc` alone; `meta.bcc` is read by nothing.

**That makes the invariant a property of `expandDeliveries`, not of the service that renders
the line.** The day a delivery row folds Bcc into `target`, or into `meta.cc`, this footer
unblinds it — silently, with no error, and with no test failing anywhere near the change that
caused it. `tests/unit/alertEmailRecipients.test.ts` pins both halves for that reason, and
this rule is the note on the door.

Two smaller decisions ride along. The email half deduplicates by ADDRESS rather than by
account, and prints the owning account's name only where one holds the address: a typed
address or an address-book contact has no account to name, which is the same "unknown means
deliver" posture rules 25 and 39 take, read the other way round. And the account lookup asks
for each address as WRITTEN and lower-cased rather than reading the whole user table, because
`User.email` carries no citext and an account stored with different capitalisation would
otherwise print as a bare address beside its colleagues' names.

Finally, the deferral registration differs between the two tokens, and the asymmetry is
deliberate rather than an oversight to tidy up. `isDeferredToken` matches the `push.` PREFIX,
so `{push.recipients}` is covered by the prefix. `email.recipients` is an ENUMERATED name in
`DEFERRED_TOKEN_NAMES`, beside `ack`, because an `email.` prefix would also swallow any future
`{email.*}` token that is NOT deferred. A token that is not registered is blanked at compose
time, before the delivery pass that would have filled it — the `{chart.trigger}` regression,
and the reason both tokens carry a test asserting they survive the compose passes literal.

<a id="rule-61"></a>

## Rule 61 — Changing a credential ends every other session on it, and rotating your own must carry the CSRF token across

Until 2026-09-14 an ordinary user could not change their own password. The only password
field in the product was the admin reset on `/users.html`, a page gated `users` — admin-only
in the built-in matrix — so a local account below that grant had to ask an administrator to
reset a password it already knew. This is the same reachability mismatch that moved TOTP
enrollment into the account menu, one surface over, and the two rows now sit together.

`PUT /auth/password` is gated on nothing beyond being logged in, which is worth stating
plainly because it looks under-gated and is not. **The body names no user.** It reads the
account out of `req.session.userId` and changes that one, so there is no target to
enumerate, no id to tamper with, and no permission that would mean anything — a grant to
"change passwords" is exactly the admin route, which is a different endpoint with a
different gate. What stands in for a permission here is the current password, and that is
the substantive difference from the admin reset: this route can prove the caller knows the
credential it is replacing, and `PUT /users/:id/password` structurally cannot. The two write
different Events for that reason — `user.password_changed` against the actor's own row, and
the admin `user.password_reset` at `warning` level, which is elevated precisely because it
is an unprovable act performed on somebody else's account.

**The revocation is the point of the feature, not a nicety attached to it.** Someone changes
their password because they think somebody else may have it. A live session does not consult
the password again, so without a revocation step the change accomplishes nothing against the
case that motivated it: the attacker's cookie keeps working until it expires on its own
schedule. `revokeOtherSessions` deletes every other non-expired `session` row whose `sess`
blob carries this `userId`, keeping only the caller's own `sid`.

That query is deliberately **best-effort raw SQL**, wrapped so that any failure returns zero
rather than propagating. The `session` table belongs to connect-pg-simple, not to Prisma's
schema — it is created by the session middleware at boot, it is absent on a first run before
anyone has logged in, and nothing in a migration guarantees its shape. `getOnlineUserIds` in
`users.ts` already reads it under the same posture and for the same reason. The ordering
matters too: the revocation runs AFTER the password write has committed, so a failure to
sign other sessions out can never roll back or fail a change the user has already been told
succeeded. The count comes back in the response so the UI can say how many were ended,
which is the only way the user learns it happened.

**The caller's own session is rotated but kept, and the carry is where this gets subtle.**
Rotating the session ID on a credential change is ordinary hardening. Doing it with
`req.session.regenerate()` alone breaks the page in a way nothing reports.

`csrfMiddleware` runs before the route and mirrors the session's `csrfToken` into a response
cookie on every request — so by the time the handler executes, the response already carries
the OLD token. `regenerate()` then throws that session away, `csrfToken` included, and the
middleware mints a replacement only on the NEXT request. The browser is left holding a
cookie from the session that no longer exists, the page's in-memory header value matches
that dead cookie, and the fresh session has a token matching neither. The password change
itself returns 200 and everything looks correct. The user's next write — any write, on any
page, possibly minutes later and about something unrelated — fails with "CSRF token missing
or invalid" until they reload.

So `rotateSessionKeepingIdentity` copies the identity fields and `csrfToken` across the
regenerate. Carrying the CSRF token gives up nothing: it is a per-session secret held by the
same browser that just proved it knows the password, and the fixation window a rotate closes
is the anonymous-to-authenticated transition, which is not what is happening here.

This is the kind of defect that ships. It throws nothing, it fails no test written near it,
and the symptom appears far from the cause — which is why the assertion is explicit:
`tests/integration/selfChangePassword.test.ts` performs a SECOND change over the same
supertest agent, reusing the same captured token, after the first rotated the session
underneath it. Drop the carry and that second call 403s. The same trap is documented from
the login side in `tests/integration/_helpers.ts`, where `authedAgent` has to issue an extra
GET after logging in to pick the regenerated token up; login gets away with it because the
browser does a full page navigation immediately afterward, and an in-page flow does not.

Two smaller decisions. The route is **rate-limited at the login ceiling** (10 / 15 min) —
its body carries the caller's current password, so it is a password-guessing surface in
every sense the login endpoint is, reachable by anyone who has stolen a session and never
touching the login limiter on the way. And it accepts **local accounts only**, refusing every
other `authProvider` with the reason rather than a bare 400: for an SSO, LDAP or App Proxy
account the directory owns the credential, and Polaris changing a local hash for such a user
would write a password that no login path consults.

<a id="rule-62"></a>

## Rule 62 — An install is identified by something it persists, never by the name the runtime handed the process

Polaris has no leader election. Two web roles against one database double-poll every device,
duplicate every alert, and race each other on `Asset.monitorStatus` — so four layers exist to
make that impossible rather than merely discouraged (docs/HA.md §5). The active-instance
heartbeat is the fourth and last, and the only one that can see the case the other three
cannot: two hosts deliberately pointed at **one** database. It works by writing
`Setting("ha.activeInstance")` every 30 seconds and refusing to boot when somebody *else*
holds a stamp younger than 90.

Everything about that turns on the word "else", and for its first release the answer was
`os.hostname()`.

On a container, a hostname is not a name. It is the container id, and the runtime mints a new
one every time the container is recreated — which is precisely what an image upgrade does. So
the sequence on every Docker upgrade was: the old container stamps, stops; the new container
starts, reads a stamp sixteen seconds old bearing a name that is not its own, concludes a
second Polaris is live, and exits 1.

```
"holder":"722cd35333e9","stampAgeMs":16088,"msg":"Refusing to start: another host holds a
fresh active-instance heartbeat on this database."
```

One install. One database. No second instance anywhere on the network. The guard was not
malfunctioning — it was answering the question it had been asked, and the question was wrong.

What made it more than a nuisance is where it stopped. Under `restart: unless-stopped` the
container retries and the stamp goes stale within ninety seconds, so the install comes up a
minute late and the operator sees a scary log line about an instance that does not exist.
Under a restart policy that does not retry — Unraid's one-shot container start, a plain
`docker run`, a foreground `compose up` that the operator Ctrl-C'd — it stops there. The
application is simply down, after an upgrade, with a fatal message accusing a second host.

The fix is to notice that the guard never wanted the process's name. It wanted to know which
**install** is running the schedulers, and an install's lifetime is the lifetime of its state
directory: the bind mount under Docker and Unraid, the install root on RHEL. So
`resolveInstanceId()` reads `POLARIS_HA_INSTANCE_ID` if the operator set one, otherwise a uuid
it generates once into `<STATE_DIR>/data/instance-id` and reuses forever after. A recreated
container, a cycled systemd unit and an in-app self-update all keep the same id; two hosts
pointed at one database still have two state directories, so the guard's real case is
completely unaffected. Only when that file cannot be written at all does it fall back to the
hostname, and then it logs a warning that names the consequence rather than failing the boot —
a bookkeeping row must never be the reason an application cannot start.

**The compatibility rule is deliberately the unfriendly one.** A stamp with no `instanceId`
was written by a release that predates the field, which means the peer that wrote it may
genuinely be a second live instance. Treating an unrecognized stamp as "probably me" would
reopen exactly the hole the layer exists to close, so an id-less stamp still compares on
hostname and still blocks. That costs one ninety-second wait on the upgrade that introduces
the id — the last one — and nothing after it.

**The second half of the fix is the shutdown.** A stamp outliving the process it describes is
what makes the window necessary at all, so `releaseActiveInstance()` now runs in the
SIGTERM/SIGINT handler and deletes the row. Two constraints shape it: it deletes only a stamp
that is *ours*, because a peer's live claim is the entire point of the mechanism, and it
latches a flag so a heartbeat tick already in flight cannot write the row back behind the
successor. A `kill -9`, an OOM kill or a host reset still leave the stamp behind — which is
correct, because those are the cases where nobody knows whether the old process is really
gone, and the ninety-second window is the right answer to that question.

**And there is a trap that this fix creates on the way past.** The HA standby keeps itself
warm by rsyncing `/opt/polaris` from the primary, and `deploy/ha/ha-rsync-exclude` is a
deny-list: everything not named in it **is** copied, node_modules and built agent binaries
included, deliberately, so a promoted standby does not have to run `npm ci` before it can
serve. A per-install identity file dropped into that tree without an exclude line would be
copied to the standby — and then both nodes would present the same identity, and layer 5 would
stop being able to tell them apart at all. The failure would never be visible: a guard that
correctly never fires and a guard that *cannot* fire produce byte-identical behaviour right up
until the day two instances really do run at once. Hence the exclude entry, the lockstep row in
`polaris-deploy` → high-availability.md, and the general form of the rule — anything that
identifies a node belongs on that deny-list the moment it is created.

<a id="rule-63"></a>

## Rule 63 — The complexity bar belongs to the operator, and a password that no longer meets it is replaced on the far side of the second factor

Polaris shipped one password bar: at least 8 characters, a lowercase letter, an uppercase
letter, a number, a special character. It lived as five Zod refinements in
`utils/password.ts`, folded there in 2026-09 precisely because it had been three verbatim
copies (admin create, admin reset, the setup wizard) and a fourth was about to join them.
That fold was the right move and it is what made the next one possible: when an operator
asked for the bar to be configurable, there was one place to change rather than four.

**A Zod object cannot be the bar any more, and pretending otherwise is the trap.** The schema
is built when the module is imported; the policy is a row in the `Setting` table that an admin
can edit at 3pm on a Tuesday. So `passwordPolicySchema` was reduced to what it can honestly
assert — a non-empty string of at most 1024 characters, the cap being a DoS guard rather than
a rule — and every route that stores a password now follows its `.parse()` with one call,
`assertPasswordMeetsPolicy()`. There are exactly four: `POST /users`, `PUT /users/:id/password`,
`PUT /auth/password`, and the setup wizard's first admin. The wizard's is asserted BEFORE any
provisioning, so a rejected password cannot leave a half-created database and an open pg
client behind, and it resolves to the defaults because `DATABASE_URL` is still empty at that
point — which is the right answer for a fresh install.

If a complexity rule ever reappears inside that schema, two places are enforcing the bar and
only one of them is configurable. That is the shape of the bug to watch for.

**The service fails to the defaults, and this is the opposite of the neighbouring one.**
`loginAccessService` fails OPEN when its Setting row cannot be read: there, a database blip
that became "nobody can log in locally" would be the exact lockout the feature exists to
prevent. `passwordPolicyService` fails to `defaultPasswordPolicy()` — the five original rules
— because here the hazard runs the other way: an install that quietly accepts `a` as an
administrator's password while its Setting row is unreadable. Both are "fail safe"; safe means
different things two files apart, and writing down which is which is the point of this rule.
`minLength` clamps to [8, 128] at parse and at save, 8 being NIST SP 800-63B's minimum for a
memorized secret, so a UI that offered 1 is not reachable even by a hand-edited row. Turning
all four character classes off is allowed and is not a misconfiguration — NIST actively
discourages mandatory composition rules, and an install that wants length alone is taking a
defensible position.

**Now the half that is a security control rather than a preference.** Raising the bar does
nothing to the passwords already stored, and an operator who raises it usually means both
things: new passwords must be better, AND the old ones should go. Polaris cannot re-check a
stored password against a new policy, because a hash is one-way. The only moment the question
can be answered is the login where its owner types the plaintext — which is also why the
timestamp approach was rejected: "changed before the policy took effect" would interrupt
every user whose password already complies, which is most of them.

So `forceChangeOnLogin` is evaluated at the password step, against the plaintext in hand. And
then it **waits**. A password-change token minted at the password step would let someone
holding a stolen password set a new one and collect the session that was withheld, without
ever facing TOTP or a passkey. That is an MFA bypass wearing a policy's clothes, and it would
look entirely reasonable in a diff. The flag therefore rides from the password step to the far
side of the second factor on the pending token itself (`utils/mfaPending.ts` gained
`mustChangePassword` alongside `purpose` and `methods`), and only once every factor is
satisfied is a `purpose: "password-change"` token issued. The purposes are checked on consume
and the token is burned even on a mismatch, so an MFA token cannot be spent at the
password-change endpoint and vice versa.

That token buys one thing: set a conforming password, receive the session. It is single-use,
five minutes long, and consumed only AFTER the write lands — a failed update leaves the user
holding a token they can retry with rather than stranded at a login screen with no way
forward. The route also refuses a new password equal to the old one; under a stable policy the
complexity check catches that first (the old password is non-conforming by definition, or
there would have been no demand), but the policy can be relaxed inside those five minutes, and
re-submitting the password that triggered the demand satisfies its letter and none of its
point.

`tests/integration/forcedPasswordChange.test.ts` drives the whole flow against a TOTP-enrolled
account. The three cases in its "MFA-ordering invariant" block are the regression test for the
bypass, not a nicety — they were confirmed to go red against a build that moved the demand in
front of the second factor.

The admin is asked which they want, rather than having it inferred: the Settings tab offers
"Apply to new passwords only" and "Require a change at next sign-in" as two radios, and
turning the second ON prompts with what it will do to everyone whose password no longer fits.
The default is off, because an upgrade must never start refusing logins on its own.

<a id="rule-64"></a>

## Rule 64 — A passkey is bound to the origin that issued its challenge, the install decides what a passkey is for, and it never names an account that does not already exist

A passkey is the only credential Polaris can offer that is both unphishable and nothing to
type, and the only stronger login path that does not require an identity provider to exist —
which matters for a FOSS product installed by strangers, most of whom have no Entra tenant.

**Local accounts only**, enforced at the route and re-checked at verification. An SSO or LDAP
account's credentials belong to its identity provider; a passkey registered against one would
be a second, Polaris-owned way into an account whose owner believes it is centrally
controlled, and it would not appear anywhere in that directory's own audit trail.

**The install decides what a passkey IS.** `passkeyConfig.mode` is `off`, `login`
(passwordless), `second-factor`, or `both` — the default. "Both" is the default because
enabling passkeys refuses nothing: passwords keep working, registration is opt-in per user,
and an install that never opens the tab is exactly as reachable as it was. The FOSS posture
rule is that an upgrade must not start DENYING logins; it says nothing about offering a
stronger one. There is one consequence worth stating plainly: under a mode that includes
`second-factor`, registering a passkey makes that account's login two-step, exactly as
enrolling TOTP does. That is the security gain and it is also a lockout risk, which is why
`DELETE /users/:id/passkeys` exists — the counterpart of the TOTP reset, for the same lost
device.

**`requireUserVerification` is what licenses a passkey to be the whole login.** With it on
(the default), the authenticator proves a human is present AND verified — a PIN, a
fingerprint, a face — before it will sign, which is two factors inside one gesture. That is
why a passkey login is stamped `mfaVerified` and skips the TOTP step. Turn it off and the
claim stops being true, so the passwordless route mirrors the flag into the session rather
than asserting verification that did not happen. The mode and the UV flag are edited on the
same card because they are one decision.

**The Relying Party is derived from the request, not configured.** Polaris's deployment
posture says TLS terminates anywhere, `POLARIS_PUBLIC_URL` may be unset, and one install is
legitimately reached at more than one name — so nothing in configuration reliably knows the
domain a browser is talking to. `utils/webauthnRp.ts` reads it off the Host header. That is
safe HERE, and only because the browser is the real enforcer: it refuses to run a ceremony
whose rpId is not a registrable suffix of the page's own origin. A forged Host can therefore
produce a ceremony that fails in the browser, or — for a caller already authenticated and
forging their own requests — a credential bound to a domain they control, which lets them into
nothing they did not already have.

The rpId and origin are then **pinned into the ceremony at issue time**
(`utils/webauthnChallenge.ts`) and replayed at verification. Re-deriving them at verify would
check the assertion against whatever the SECOND request claimed to be — a mismatch that ought
to be an error becomes a silent success. The same store gives the ceremony its purpose, and a
registration token is not spendable at the login endpoint even though both hold a challenge.
It lives in memory rather than in the session, because a passkey login begins with no session
at all and the session store is a database table: an unauthenticated caller could create rows
by hammering the options endpoint. A capped map — 5000 entries, oldest evicted — cannot be
grown into a disk problem whatever the rate limiter is set to.

**Two supported deployment shapes cannot have passkeys, and both say so.** WebAuthn requires a
secure context, and an RP ID must be a domain: a lab VM on plain HTTP at 10.0.0.5 is a real
Polaris install that simply cannot host them. `resolveRelyingParty` returns a REASON rather
than throwing, so the availability endpoint can tell the login page which of the two it hit
and the page can leave the button undrawn — instead of showing one that produces an opaque
`SecurityError` in a credential dialog.

**A third shape looks exactly like the first from inside Express and is not it: TLS terminated
at a reverse proxy Polaris was never told to trust.** `req.protocol` reads "https" only when
`trust proxy` is set for the deployment's hop count (`utils/trustProxy.ts`), so an install
behind nginx / Caddy / Traefik / Nginx Proxy Manager / an ALB with `TRUST_PROXY` unset reports
itself as plain HTTP — and "put Polaris behind TLS" is advice that operator has already taken.
So when the request carries a proxy's own claim that the browser hop was HTTPS
(`forwardedProtoClaim` reads `X-Forwarded-Proto`, `X-Forwarded-Scheme`, RFC 7239 `Forwarded`
and `X-Forwarded-Ssl` — wider than Express, because it is recognizing a proxy rather than
believing one), the reason names THAT header and `TRUST_PROXY` instead. The claim is never
honored: a spoofable header must not grant a secure context `req.secure` withheld, believing
it would only produce a ceremony the browser then rejects, and the setting it asks for is the
same one that decides whose IP the login rate limiter counts. It is read to write a better
sentence, and for nothing else.

**The browser is the only side that can see the fourth shape — a proxy that rewrites Host.**
The RP is derived from the Host header that reached Polaris, so a proxy forwarding its own
upstream name produces an rpId that is not a registrable suffix of the page's origin, and the
browser answers that with a bare `SecurityError` naming no cause. `PolarisWebAuthn.unavailableHere(rpId)`
(`public/js/webauthn.js`) compares the availability payload's `rpId` against
`location.hostname` and says which header is at fault; the account modal prints it and the
login page silently withholds the button, because the reason describes the install's plumbing
to someone who has not yet signed in.

**The passwordless options endpoint names no credentials.** `allowCredentials` is left empty
on purpose: naming a user's authenticators before they have authenticated would turn the
endpoint into an oracle for "does alice exist, and how many keys does she have". The browser
is asked for any discoverable credential for this RP and the assertion names the account,
which is exactly why registration demands `residentKey: "required"`. The second-factor step
DOES name them — the caller has already proved the password, so listing them tells them
nothing new, and naming them is what lets a non-discoverable security key take part — and it
binds the assertion to that account with `expectUserId`, because without that binding anyone
holding any passkey on the install could finish somebody else's half-completed login.

**Every refusal is the same sentence.** Unknown credential, bad signature, an account that has
since become SSO-managed, a signature counter that went backwards — all "that passkey was not
recognized". "That credential is not registered here" is a fact worth learning to someone
probing with a key they control. The counter check is the one clone signal WebAuthn gives, and
it is narrower than it first appears: most platform authenticators pin the counter at 0
forever, so only a DECREASE from a non-zero value is evidence of anything.

**And unlike every other credential path in Polaris, it never provisions.** SAML, OIDC and
LDAP all find-or-provision a user, because an identity provider vouching for someone is a
reason to create an account. A passkey vouches for a credential. A discoverable credential
resolving to no row is an authentication failure, not a signup.

Finally, the operational trap. A pre-session ceremony endpoint needs FOUR registrations to be
correct, and each missing one fails in a different silent direction: the route itself; an entry
in `LOGIN_CREDENTIAL_PATHS` (`app.ts`) if it can end in a session — miss it and a
source-restricted install is reachable from anywhere with nothing in the UI to show it; a CSRF
exemption, because a login page has no session and therefore no token — miss it and the
endpoint 403s every caller; and a `passkeyCeremonyLimiter` mount. The CSRF entry is
`/api/v1/auth/passkeys/login`, and the segment-boundary match in `isExemptPath` is what keeps
`/passkeys/register` and `/passkeys/:id` — mutating session routes one segment away —
protected. A bare `startsWith` would exempt every one of them, which is the mistake the HA
enrollment entry already made once (rule 50's neighbourhood).

---

## Rule 65 — A delivery test is a specimen of the alert, not a rehearsal against live inventory

The automation wizard's Summary step carries a **Test delivery** block: one button per
distinct delivery the draft would perform, each firing ONE action of the draft — saved or
unsaved — through the exact path a real alert takes. It exists because authoring an
automation used to be a blind flight; the only way to learn whether the SMTP channel
authenticates, whether Web Push reaches your phone, or whether the audit Event lands was to
save the rule and provoke a real trigger.

It was built on a reasonable-sounding premise: a test should look exactly like the real
thing, so it should be **about** a real thing. `resolveTestReading` ran the engine's own
`previewRule` and picked the device the draft would actually fire on — matches come back
sorted meets-first — so the email quoted a real current reading, on a real sensor, for a real
device, with that device's last hour charted underneath.

What came out the other end was an ordinary-looking alert email carrying a live hostname, a
management IP, a site code parsed out of the device's own admin description, and the model of
the switch it was about. Nothing in it said "test": the `[TEST]` marker lives in
`Notification.message`, and the default email body deliberately does not print `{message}`
(the trigger sentence above it says the same thing, and printing both read as a log line
stapled to a headline). A reader — or anyone the mail was forwarded to — had no way to tell
it from an outage.

The premise is what was wrong. A test email is sent **on demand**, by anyone holding
`automationManagement:fullwrite`, to an address they type at the keyboard, and it lands in an
inbox nobody treats as inventory. Against that, "looks exactly like the real thing" is worth
much less than it costs. So a test is now a **specimen**: the same email, the same layout, the
same pruning behaviour, made of facts that are invented end to end.

### Where the facts come from

`utils/sampleAlertDevice.ts` holds the device. Its values are drawn from the ranges reserved
for documentation, so nothing in a test email can ever collide with something real:

- IPv4 from **192.0.2.0/24** (RFC 5737 TEST-NET-1)
- MAC from **00:00:5E:00:53:00–FF** (the RFC 7042 documentation block)
- every name **"Example"-prefixed** — `EXAMPLE-SWITCH-01`, `Example Networks`,
  `Example Site: Building A, Floor 1`, `EXAMPLE-TMP1`, `Example-SLA`

`sampleDimensionFor(metric)` does the same job for the sub-asset a test should name, per
metric family: a sensor name for `hwSensorValue` / `hwSensorAlarm`, a
`"<healthCheck>|<link>"` pair for the SD-WAN metrics (the chart code parses it apart, and a
bare name charts nothing), an interface for the port-scoped ones, null for everything else.
Without that, a test of a sensor or path automation could not show the operator the chart the
real alert leads with — the very thing they are testing.

`SAMPLE_ALERT_DEVICE` deliberately carries **no `id`**, and the test `Notification` carries
**no `assetId`**. Both absences are load-bearing rather than incidental:

- A test belongs to no device, so it can never appear on a real asset's alert list — the one
  place a stray test alert used to be visible for the hour before
  `clearExpiredTestAlerts` sweeps it.
- `{asset.link}` renders empty, so `pruneDeadLinks` drops the "Open device" button. A button
  that opens nothing is worse than no button; the acknowledge page falls back to
  `/automations.html` the same way.
- `alertChartService` has no asset to query, which is what routes it to the generated series.

### No reading is quoted

`triggerSummary` already had the behaviour this needed. Given no value it falls back to
stating the **condition** — "Response time (median over 5 minutes) is above 500 ms",
"Monitor status is down" — rather than a bare subject, which reads as a broken template. That
sentence is the one the operator wrote in the builder and the one they are checking the
wording of, so a test now passes `value: null` deliberately.

The alternative was a made-up number, and a made-up number in the headline position reads as
a measurement. The only honest number available would have been some real device's, which is
the thing being removed.

### The charts are generated

`sampleChartSeries` (in `alertChartService.ts`, behind `buildAlertCharts(null, …,
{sampleData: true})`) produces each series instead of reading it. It is pure and
deterministic — the same test email twice draws the same picture, which is what makes "did
the chart change?" a meaningful question while someone edits a template — and each series is
shaped like its real counterpart: a ramp on CPU, a spike on response time, a quiet stretch
and a burst on packet loss, an SLA line the SD-WAN path crosses near the right edge. The
sensor trace is generated in the install's own display unit, because the chart and the
sentence above it must not disagree about °C versus °F.

Two things it deliberately does **not** invent: fail spans and SD-WAN down spans. Those bands
do not mean "a bad reading" — they mean *Polaris measured nothing here* and *the device
declared this member dead*. Drawing them on a device that does not exist teaches a reader the
wrong thing about what the picture means, on the one send whose whole job is to teach them
what the picture means.

Dropping the charts entirely was the other option and was rejected: a test email whose whole
chart section is missing does not answer the question the button is pressed to ask.

### The marking is not a token

The obvious implementation was a `{test.notice}` token in `DEFAULT_ALERT_HTML` /
`DEFAULT_ALERT_TEXT`, deferred like `{chart.*}` and `{brand.header}` and filled from
`Notification.testRun` at delivery. It was rejected, and the reason generalizes:

> A token in the default body is marking the operator can delete — by customizing the email,
> or simply by having customized it before the token existed.

Every notify action can carry its own `emailComposition`, and the wizard prefills it from the
default template, so a rule customized last year holds a frozen copy of a body with no such
token in it. On the one email that must never be mistaken for an outage, the marking has to
be something no template controls.

So `markEmailAsTest` (`utils/alertEmailTemplate.ts`) is applied in
`notificationDeliveryService.emailMessageFor`, on **both** compose branches, as the **last**
thing that touches the message — after every substitution and every pruning pass:

- `[TEST] ` prefixed to the subject (idempotent, so a template that already says TEST does not
  say it twice) — this is all a phone's lock screen shows
- a banner table above the card, before the severity bar
- a block above the plain-text body, which is what a pager gateway or a text-only client
  renders

Push, Slack, Teams and Pushbullet bodies need none of this: they print
`Notification.message` directly, and that string has carried its `[TEST]` prefix since the
feature shipped. The email was the one surface where the marker was composed away.

### What this costs, and what to keep true

The test no longer proves that *this* automation would fire on *that* device — but it never
reliably did: the preview picked whatever currently matched, which on an unfiring draft was
"any device reporting the metric at all". What the button is for, and still answers, is "does
this channel work, and what does the message look like".

When adding a new `{asset.*}` token, add its field to `SAMPLE_ALERT_DEVICE` as well as to the
engine's `ASSET_DETAIL_SELECT`. The specimen's value is that it prunes the same rows the real
alert prunes; a field missing here mails a blank row for a fact a real alert prints, and the
test quietly stops being faithful without anything failing.
