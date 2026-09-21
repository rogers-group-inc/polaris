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


---

## Rule 66 — A measurement window may be counted in readings, and then the hold counts poll groups

A time window takes whatever samples landed inside it, which means the SAMPLE SIZE of an
aggregated automation is a function of how well the device happens to be working. `avg` over
an hour on a healthy device is the mean of sixty readings; on a device dropping three
quarters of its probes it is the mean of the seventeen that answered, under the same
threshold, wearing the same name, with nothing on screen saying the statistic changed. That
is not a rounding problem, it is two different rules sharing one definition — and it gets
worse exactly when the device is worst.

**`windowPolls` states the window as a COUNT of readings instead: the last N samples that
produced a value.** Misses are not counted, not filled, and not fabricated — a failed probe
writes a NULL `responseTimeMs` and simply is not a member of the window. What stretches under
loss is the WALL CLOCK the window spans, not the number of measurements in it, so the reading
means the same thing at 0% loss and at 40%: *when this device answers, this is how long it
takes*. `rollingAggregate` is the arithmetic, and its defining test is an equality — a holed
series and a clean series carrying the same N values produce the same number.

**Two shapes of window were considered and rejected before this one.** Filling a miss with
**0 ms** flatters a dying device: the Roanoke FortiAP that prompted this read 507 ms over the
polls it answered and would have read 144 ms with its 43 misses counted as zero, so the alert
would have CLEARED as the device got worse. Median does not rescue that — past 50% loss the
zeros ARE the distribution and the median is 0 — and it is the trap Zabbix's `icmppingsec`
is known for, where every latency trigger has to be guarded with `and icmpping=1`. Filling
with the **probe timeout** fails the other way: it poisons a latency metric into a loss alarm
that fires about a device whose successful responses are perfectly fine. The standard every
other NMS keeps — Nagios `check_icmp`'s `rta`/`pl` pair, SmokePing's median-of-replies with
loss as the line colour, the SRE convention that latency is measured over SUCCESSFUL requests
and failures are a separate availability signal — is that a failed probe's latency is
UNDEFINED rather than any number, and packet loss is its own metric with its own threshold
(business rule 29) and its own down detection (business rule 36).

**The hold composes with it, and only with it.** Under a time window `forPolls` is refused,
because there the window IS the period and a second clock on top would be two clocks doing
one job. Under a count window the readings are cut into DISJOINT GROUPS of N, so there is a
series of group aggregates to count and `forPolls` means *M consecutive GROUPS over the line*.
`reduceReadings` hands those group aggregates on AS the series, which is why every existing
mechanism keeps working untouched: `leadingRun` counts the run, `tierRuns` gives each severity
tier its own run against the same series, and the engine's fire/clear path never learns that
the numbers it is counting were derived. That composition is the thing a time window cannot
express: one 1500 ms spike inside an otherwise healthy 5-reading group never clears the
threshold, so the run never starts, while a genuine climb clears it in group after group.

**The groups step by N, never by 1, and that is the load-bearing half of the design.** The
first cut of this shipped as a ROLLING window recomputed at every reading, and the flaw was
statistical rather than mechanical: consecutive rolling windows overlap by N-1 samples, so
"sustained for 3" was three near-identical averages agreeing — barely more evidence than one,
while reading like three times as much. Disjoint groups are three INDEPENDENT looks at the
device, which is what an operator means by "it has been slow for a while". It also makes the
wall clock legible and predictable: time to alert is **groupSize x sustained** polls, not
groupSize + sustained - 1, which is what the builder's own labels now promise ("Poll Group
Size" of 10 held for 3 groups = 30 polls = 30 minutes at a 60s cadence). The consequence for
the engine is that `lookbackMsFor` sizes a count window from the PRODUCT of the two counts
rather than their sum — get that wrong and the hold can never be satisfied, because the query
excluded the readings the older groups needed. A trailing partial group is dropped for the
same reason a partial window is.

**Not enough readings is NO reading, never a partial window.** An aggregate over fewer than N
samples is a different statistic under the same threshold, so `rollingAggregate` returns
empty and the asset is skipped exactly as one that has reported nothing is skipped. This is
what bounds the feature's cost: `lookbackMsFor` reaches back over the wall-clock mirror of
both counts, doubled — enough for a device losing half its probes — and a device worse than
that produces too few readings to fill the window and abstains. Doubling rather than more is
a fleet-scale decision, not a correctness one: this fetch is already the heaviest thing an
automation does at 2000 assets, and a device at that loss rate is a packet-loss and
down-detection problem those metrics already own.

**Both counts keep their wall-clock mirrors.** `windowSec` beside `windowPolls` and
`forDurationSec` beside `forPolls` are what size the engine's sample fetch and what the prose
reads; the builder always writes them, and an API-authored rule that omits them gets the full
6-hour lookback rather than a guessed cadence. The BUILDER states the unit the rule actually
stores — "Measured over" with a minutes/polls picker, the breach counter appearing only
beside a count window (and beside a ratio's History, the other window with a free hold axis)
— and `tgStampWindowPolls` STRIPS the count from every leaf that must not carry it, because
the engine prefers `windowPolls` wherever it finds one and a leftover would keep measuring in
readings while the field, the sentence and the formula all said minutes.


---

## Rule 67 — A missed response-time poll is the timeout it cost, and an outage resets the window

Response time is the one metric whose FAILURE has a duration attached. Every other metric's
miss is an absence — the collector did not read a CPU percentage, and there is no number to
put there. A failed response-time probe waited the asset's full `probeTimeoutMs` and heard
nothing, which is a fact about how the device is behaving and is measured in the same unit as
the metric itself.

Business rule 66 dropped misses out of the count window, and for a general metric that is
right. For response time it is a hole: a device answering one poll in ten reads exactly as
fast as one answering every poll, because both windows contain only the answers. **A miss that
did not put the asset Down is therefore filled with `AssetMonitorSample.timeoutMs`** — the
resolved timeout for that asset AT PROBE TIME, recorded on the row by `recordProbeResult`
rather than re-resolved when the rule runs. Recorded for two reasons: a window of past probes
must use the timeout that actually applied to each one rather than whatever the setting says
today, and resolving per-asset monitor settings inside the engine's tick would mean widening
its deliberately tight asset select at 2000 assets. A failure with NO recorded timeout is a row
written before the column existed; those stay excluded, which is exactly the pre-feature
behaviour and self-heals within one window.

**What makes the fill safe is the reset.** Filling misses with the timeout is honest only while
the device is still considered reachable; through a real outage it would turn a latency metric
into a loss alarm, firing about the thing the down automation already owns — which is the
objection that sank "count a miss as the timeout" as a general rule, and the exact failure
business rule 29h exists to stop for packet loss in the metric next door. So **walking
newest-first, everything at and before the most recent `assetDown` probe is discarded.**
`assetDown` is stamped from the status the probe RESULTS in (`monitorStatusFor`), so the line
between "degraded" and "out" is the operator's own `missedPolls` (business rule 36) rather than
a second threshold invented here: an amber miss — below their threshold, not an outage yet —
still counts and is still filled, and only the misses their own automation calls Down reset
anything.

**The consequence is deliberate: a recovered device has no reading until its window refills.**
`rollingAggregate` refuses a partial window (business rule 66), so at a 60s cadence a device is
quiet for ten minutes after an outage. That is a settling period rather than a blind spot —
`down` was a different automation's subject the whole time, and the alternative is comparing an
average of one or two samples against a threshold meant for ten, at the moment a device is
least stable.

**Response time therefore DEFAULTS to a count window of 10** in the builder, and the unit is
chosen for the operator rather than offered neutrally: picking minutes for response time is
picking the denominator that floats. It is a default, not a lock — the number and the unit stay
editable — but the default only asserts itself on a draft that states no window at all, and
never after the operator has touched the picker (`data-touched`) or on a stored rule.
**Existing response-time rules were migrated** by the `V7` one-shot
(`seedBaselineAutomationsV7ResponseTimeWindowAt`), which unlike V5 does NOT spare edited rules:
V5 was adding a new knob whose default an operator might reasonably disagree with, while this
fixes what the existing knob MEASURES, and an edited rule is no less wrong than an unedited one.
It names every rule it changed and its old window in a warning Event, because it alters when
existing alerts fire and an operator must be able to see it happened and put a rule back.

## Rule 68 — What Polaris ships and what the operator owns are two different kinds of MIB

Polaris resolves a vendor's telemetry by MIB SYMBOL NAME, and the number behind
that name comes from a MIB. Since the vendor OID seed was removed (the uniform-SNMP
work, 2026-09) Polaris ships no vendor OID numbers in code at all, which makes
*which MIBs ship, and on what terms* an operator-facing question rather than an
implementation detail.

**Two kinds, and the difference is a promise.**

`services/stdMibs/` holds the generic IETF/IEEE modules. They are read off disk by
`oidRegistry.loadStandardLayer`, exist in every install, and are removable by
nobody — they change when the product is updated. That is correct for standards
every device speaks: there is nothing to opt out of, and interfaces, LLDP, PoE,
bridge/VLAN, `hrStorage` and ENTITY sensors therefore collect the moment SNMP does.

`services/vendorMibs/` holds a manufacturer's own public MIB, and it is **seeded,
not bundled**: `jobs/seedVendorMibs.ts` inserts each as a `MibFile` row at
manufacturer scope through `mibService.createMib` — the same function the upload
route calls, so a seeded MIB is parsed, dup-checked and registry-refreshed
identically to an uploaded one and there is no second code path to drift. It then
appears in the MIB Database like anything the operator uploaded, and **they can
delete it**. That is correct for a vendor's file: they may hold a newer one, may
object to it shipping, or may simply not run that gear.

The two must not be confused in the one direction that is silent. `stdMibs/` is
GLOBBED, so a vendor module dropped there becomes part of the layer nobody can
remove, and the only symptom is an operator unable to delete a file they never
asked for. `tests/unit/seedVendorMibs.test.ts` fails if a shipped vendor module
appears there, and fails again if any `stdMibs/` module anchors under `enterprises`.

**Seeding is fresh-installs-only.** The job skips any database where
`seedManufacturerProfilesSeededAt` is already stamped, because that marker can only
exist if an earlier release ran here — which makes this an upgrade. An existing MIB
Database is curated by its operator, and an upgrade that silently adds vendor
modules is editing their data. Measured on the owner's production fleet
(2026-09-16): 2,416 monitored assets, of which **zero** were Cisco. The ordering in
`app.ts` is load-bearing in both directions — the job runs before
`seedManufacturerProfiles` so the profiles it seeds resolve on their first readiness
check, and because it runs first the marker is still absent on a genuinely fresh
install. Flip the order and a fresh install would read itself as an upgrade and seed
nothing, for ever, without an error.

**A manufacturer profile is only ever an override.** It says which symbol *is* the
CPU, which pair *is* the memory — the half a MIB cannot tell you. It earns its place
only by saying something the generic MIBs cannot, and two vendors show both sides of
that test:

- **Cisco ships one.** `cpmCPUTotal5secRev` is the 5-second CPU where
  `hrProcessorLoad` is a 5-minute average on many IOS platforms, and
  `ciscoMemoryPoolUsed`/`Free` are per-pool bytes that HOST-RESOURCES-MIB's single
  RAM row cannot distinguish. Its `CISCO-SMI` anchor ships alongside, because the
  leaf modules resolve to nothing without it.
- **MikroTik ships neither profile nor MIB.** RouterOS reports CPU, memory and
  storage through HOST-RESOURCES-MIB, which Polaris already reads, so there is
  nothing to override. Its long-standing `cpu` row named `mtxrSystemUserCPULoad`, a
  symbol that exists in **no** MikroTik MIB (checked against MikroTik's own download
  and the LibreNMS mirror) and had therefore never resolved on any install. The one
  thing `MIKROTIK-MIB` does add — the `mtxrHealth` temperature sensor — is
  DISPLAY-HINT `d-1`, tenths of a degree, and needs scaling AT COLLECTION that no
  collector performs, so the row would have charted 315 instead of 31.5.

That second case is the rule's teeth: shipping a profile for a vendor the generic
MIBs already answer produces a page of `N UNRESOLVED` rows and a warning Event on
first boot, and an operator handed something broken-looking they never asked for.

**Both shipped pieces are deletable, and neither deletion is silent.** Without the
profile, `pickDbProfile` returns null, which is the collectors' signal to use the
standard MIBs — the device keeps being monitored and only the vendor-specific
figures are lost. Without the MIB, the profile's rows report `unresolved` and name
the module to re-upload. Nothing is unrecoverable, which is what makes shipping
either of them safe.

**A caution for anyone finishing the transform feature.** A unary transform on a
profile METRIC row is stored, shown in the Transform column, and never applied:
`applyTransform` has one call site in `src/`, the custom-widget collector. Scaling a
raw integer into its canonical unit at collection is a legitimate thing to build;
converting Celsius to Fahrenheit before storage is not, and must not ride along with
it — Polaris stores, rolls up and ALERTS in Celsius, and converts at render only
(`public/js/temp-unit.js`, `branding.temperatureUnit`). Rewriting stored values would
silently re-point every temperature automation's threshold and step each sensor's
history mid-series.

---

---

## Rule 69 — A reservation count is of addresses held, and a release is history

The IPAM Networks list has carried a Reservations column since the beginning, and until
2026-09-16 it was `prisma.subnet.findMany`'s unfiltered `_count.reservations`. That reads as
the obvious thing to show, and on a hand-curated network it is: an operator adds ten
reservations, the column says ten.

It stops being the obvious thing the moment the network is one Polaris discovered. **Polaris
soft-releases.** `reservationService` sets `status` to `released` when a reservation is given
up; `reservationStaleService` sets `expired` when one ages out; `subnetRefreshService` releases
the rows a FortiGate no longer reports. None of them delete. The only code that ever removes a
reservation row is `cleanupStaleDnsResolvedReleased`, and that covers one narrow `dns_resolved`
case. A reservation table is an append-mostly ledger, on purpose — the history is how an
operator answers "who had .47 in March".

So on a `/24` whose DHCP leases have cycled for a year, the unfiltered count is in the
hundreds. It was already a confusing number to read; it became an untenable one the moment a
percentage was put beside it, because 300 reservations on 254 usable addresses is 118% full.

### One numerator, stated once

The numerator is **active reservations carrying an address** — `status: "active"` AND
`ipAddress` not null. That is not a new definition invented for the column; it is what
`ipService.subnetCapacity` has always counted and what the IP panel's footer bar has always
drawn. The change made `subnetService.listSubnets` agree with them rather than adding a third
opinion, and a fourth surface that counts addresses takes the same filter. Three places
disagreeing about how full a network is would be three places an operator has to decide
between.

A **whole-subnet reservation** — `ipAddress` null, the row that sets the subnet's status to
`reserved` — is excluded from all of them. It consumes no individual address, so it belongs in
neither the count nor the numerator, and the operator already sees it: the Status column says
`reserved`.

### The denominator, and why it may be absent

`usableHostCount(cidr)` in `utils/cidr.ts` owns it, like every other piece of IP math — a `/24`
is 254, network and broadcast excluded, with the `/31` and `/32` special cases the RFCs
require. It is `null`, never 0, for IPv6 and for any CIDR the parser refuses. Zero would be
arithmetically convenient and a lie in the UI: a percentage of nothing renders as an empty bar,
and an empty bar is a positive claim that the network is free. The cell draws an em dash
instead (`polaris-ui-canon` → canon-tables-lists.md § Utilization bar, which carries the same
rule for a storage volume with no reading).

### The unfiltered count is not wrong — it answers a different question

There is exactly one kind of caller that needs it, and it is not a display: **what a cascade
removes.** Deleting a `Subnet` cascades to every reservation row it has, whatever the status,
and `subnetArchiveService.archiveSubnet` copies every row into `ArchivedReservation` with no
status filter at all. A confirmation saying "this will also delete 12 reservations" before
removing 240 rows is telling the operator something false at the one moment they are deciding
whether to proceed.

So `listSubnets` returns both, under names that say which is which: `_count.reservations`
(held) and `totalReservations` (every row). The delete and archive confirmations take the
second. That incidentally fixed something nobody had reported: the archive confirmation was
quoting the filtered-looking count while the success toast that follows it reports
`reservationCount` straight off `archiveSubnet`'s unfiltered `rows.length`, so on a churned
network the dialog and the toast named different numbers for the same operation.

---

---

## Rule 70 — Absence from a directory decommissions what the directory manages, and only when the read was whole

vCenter has had a disappearance sweep since 2026-08-28: a VM that leaves the inventory is
decommissioned, because a hypervisor's inventory is the definitive statement of which VMs
exist. Active Directory and Entra ID are the same kind of claim about the machines they
hold — an operator deleting a computer object or disabling a device account is performing
the decommission, and Polaris was not hearing it. Aging out on `lastSeen` eventually caught
those assets, months later, and only if nothing else kept touching them.

The whole difficulty is that **absence is not one signal**. Five different things produce a
device that is missing from a directory read, and exactly one of them is a deletion:

1. The object really was deleted, or the device was disabled in the directory.
2. The operator edited `ouInclude` / `ouExclude` / `deviceInclude` / `deviceExclude`.
3. `includeDisabled=false` dropped the device before the sync ever saw it.
4. The read was cut short — cancelled, or over the 10,000-object hard cap.
5. The search scope or the grant narrowed: a `baseDn` moved down a level, an OU delegated
   away, a service principal that lost `Device.Read.All` over half the tenant.

### The toggle, and why it is off

`decommissionMissing` defaults to **false** on both integrations. Polaris is installed by
strangers, and the first run of a sweep nobody asked for is a fleet-wide status change on
somebody else's estate — an install whose AD carries a decade of never-cleaned computer
objects gets a different answer from one with tidy hygiene, and only its operator knows
which it is. Off, the pass does nothing at all: the stale source rows are left in place too,
because deleting them is the same judgement wearing a smaller hat, and because a sweep that
deleted rows but skipped the status flip would leave the next run with nothing to notice.

### The three guards, in the order they fire

**`adSweepBlockedReason` / `entraSweepBlockedReason`** refuse the whole pass on cause 4 —
a scoped ("Discover Now") run, a cancelled or capped read — and on an empty one. Zero
computer objects under a `baseDn` that previously held a fleet is a bind or permission
answer far more often than an emptied domain; that is business rule 35's shrunken-read
reasoning, and `vcenterSweepBlockedReason` makes the identical call. The scoped check is
first so an operator is told the real reason rather than a plausible wrong one.

**`classifyDirectoryRows`** covers causes 2 and 3, and it can only do so because it is fed
the **raw** identifier set — every device the directory returned, snapshotted before the
name/OU filter and before the `includeDisabled` skip. That is the same trick
`partitionStaleVcenterSources` plays with `presentVmMorefs`, and it has the same second-order
payoff: re-widening a filter re-matches the same asset instead of orphaning its identity. It
sorts rows three ways, not two — `gone`, `disabled`, `alive` — because a disabled device has
not left the directory: the asset is decommissioned and its **source row is kept**.

**`absenceExceedsGuard`** is the last one, and it is the only thing that can see cause 5.
A narrowed `baseDn` returns a complete, non-empty, perfectly well-formed read that is simply
missing most of the estate; nothing in the shape of the answer betrays it. So the sweep
refuses outright when the vanished set exceeds `max(50, 20% of what this integration owns)`
— `directorySyncService.deleteExceedsGuard`'s formula, applied to assets instead of contacts.
The floor matters as much as the ratio: 20% of a 40-machine lab is eight rows, and refusing
ordinary turnover would need an operator every time a laptop is retired. The failure being
guarded against is categorical, not incremental.

### Ownership decides, not provenance

The vCenter sweep asks "does any other source still claim this device?" and leaves the asset
active if one does. The directory sweep asks a different question, because the answer to that
one is almost always yes: on a FortiGate-managed network nearly every workstation carries a
`fortigate-endpoint` row from a DHCP lease or an ARP sighting, and a rule that treated a
sighting as a claim would make the feature inert on exactly the fleets that need it.

So an asset is judged by **`Asset.discoveredByIntegrationId`** — the "Managed by" row on the
asset slide-over's System tab, which is ownership of the monitoring configuration rather than
discovery provenance. Managed by **this** integration, and the directory's word is final: a
sighting, a vCenter row, an Arc record or an agent check-in does not keep a deleted computer
object alive. Managed by **another** integration, and the sweep only drops its own stale
source row and says so — vCenter losing sight of a VM is not AD's business, and the reverse
holds too. Managed by **nothing** is treated as "this directory is as close to an owner as it
has", which is load-bearing rather than an edge case: `syncEntraDevices` has never stamped
`discoveredByIntegrationId` at all, unlike the AD, Windows-Server and Arc paths, so every
Entra-discovered asset is unowned and the sweep would otherwise skip the entire Entra estate.
(That asymmetry is worth fixing on its own terms — an unowned asset also cannot inherit the
integration's per-class monitoring block — but it is a monitoring-config change, not this one.)

An asset is only judged once **every** row this integration holds on it agrees: an Entra
device that left `/devices` but is still in Intune is still in the tenant. And a source kind
whose endpoint was not read this cycle — Intune switched off, or its call failed, which is
caught so an Intune outage cannot fail the whole run — leaves its rows alive. Not read is not
the same as not there.

### Where it sits

Both sweeps run as the last pass of their sync, after every upsert, through one shared
`sweepDirectoryAbsence` in `discovery/discoveryEngine.ts` — shared so two integrations cannot
drift apart on a pass that changes asset lifecycle state. `releaseAssetsForDecommission` runs
first so an open maintenance window is force-closed and the 30-second reconcile cannot
re-flip the status back (business rule 16's carve-out, the same one vCenter takes). Each
decommission writes an `asset.ad.decommissioned` / `asset.entra.decommissioned` Event naming
which of the two reasons applied. Time-based aging stays with `decommissionStaleAssets`; this
is the evidence-based path, the same division vCenter's sweep draws.

One bug surfaced alongside it: `EntraIdConfigSchema` never declared `includeDisabled`, so
`z.object`'s strip dropped it on every save and the modal's checkbox had done nothing since
the integration shipped — disabled Entra devices always synced as `decommissioned`. The AD
schema had always had the field.

## Rule 71 — A figure Polaris reports about itself accounts for itself, and a broken measurement says so

The Maintenance tab's Database card read **Current size 76.6 GB** directly above a table list
whose largest row was `events` at 1455 MB and whose every visible row summed to about 2.6 GB
(prod, 2026-09-17). Nothing on the card was a lie in isolation; there was simply no way to ask it
where the other 74 GB was.

Three gaps, none of them visible:

- **The total and the list had different scopes.** The total summed `pg_class.relpages` over every
  relation in the database; the list was `public`-schema-only. The pg-boss queue's schema and
  PostgreSQL's own catalog were therefore counted in the figure and structurally unlistable
  underneath it.
- **Every row was understated by its TOAST.** Rows counted heap plus indexes while the total
  counted `relkind = 't'` as well. For an ordinary table that is a rounding error; for a
  TimescaleDB chunk it is not, because a COMPRESSED chunk keeps its compressed batches in TOAST —
  10.6 MB of a 32.4 MB test hypertable.
- **The chunk fold had stopped working, and said so only in a log.** Sample-table bytes live in
  chunk relations under `_timescaledb_internal`; the card folded them back onto the hypertable via
  `_timescaledb_catalog`. TimescaleDB 2.30 — which this install took with the PostgreSQL 17 move a
  day earlier — replaced that catalog's `schema_name`/`table_name` with a single `relid`, so the
  query failed outright with `42703`, fell back to parent-only sizing, and reported all 28
  hypertables at their parent relation's size, which is approximately zero. A 15 GB table and an
  empty one look identical in that state.

### The parts are the whole, by construction

`services/dbSizeService.ts` is now the only thing that measures the database, and it attributes
**every relation to exactly one bucket**: an index to the schema of the table it indexes, a TOAST
relation to the table it stores for (a TOAST index takes two hops), and a TimescaleDB chunk —
compressed or not — to its user hypertable rather than to the internal schema it physically sits
in. The total is then the SUM of those buckets, not a separate query, so the headline figure and
the list explaining it cannot disagree. What is not one of Polaris's tables is still on the same
disk, so it is still named: the pg-boss job queue, the PostgreSQL catalog, other schemas, and an
`Unattributed` line that is zero on a healthy install and is the residual made visible when it is
not. The Total row at the foot of the list matches Current size.

Two consequences worth knowing as an operator. **Chunks are found by relation NAME prefix**
(`_hyper_<hypertableId>_<chunkId>_chunk…`, plus a `_compressed` suffix on 2.30 or a
`compress_hyper_…` name before it), not through the internal catalog — because 2.30 does not merely
rename things, it stops registering compressed chunks anywhere at all: no internal compression
hypertable, `compressed_chunk_id` zero, no `pg_depend` link. Nothing in the catalog points at a
compressed chunk relation, so a mechanically repaired join would have kept reporting confident,
wrong, smaller numbers. And **`database.sizeBytes` deliberately still means every relation in the
database**, because the disk-overflow reasons compare it against free space and the steady-state
projection subtracts the measured sample tables from it; scoping it to Polaris's own tables would
have quietly dropped pg-boss's bytes out of both while they occupy the same filesystem.

### A degraded measurement degrades visibly

This is the half that let the incident last. Polaris reads sizes from PostgreSQL's catalog rather
than by measuring the data directory, because `pg_database_size()` and `pg_total_relation_size()`
stat() every relfilenode behind a relation and a hypertable decomposes into hundreds of chunks —
at fleet scale that made the tab wait minutes. The trade-off is that a catalog figure is only as
fresh as the last `VACUUM`/`ANALYZE`, and a `pg_upgrade` does not carry planner statistics across
before PostgreSQL 18. So both ways these numbers can be wrong rather than merely unexplained are
reported in place:

- `sizing: "parent-only"` reaches the card as **"Hypertable sizing is degraded"**, naming the log
  line to grep for, because the alternative is a sample table reading 0 B and looking healthy.
- `neverAnalyzedRelations` counts relations with `reltuples = -1` and the card says **"N relations
  have never been vacuumed or analyzed"** with the `vacuumdb --analyze-in-stages` to run — those
  relations report zero pages whatever they hold, so every figure on the card understates until it
  is run. This is the normal state right after a restore or a major-version upgrade.

`capacityService` already applied this principle to filesystems: a volume it cannot measure is
reported as degraded rather than dropped from the list, after an unmeasured `/var` filled to 100%
on a least-privilege host while the card reported "All capacity checks passed". Rule 71 states it
once and extends it from the list of things measured to the numbers themselves. The corollary for
whoever maintains this: a TimescaleDB major upgrade is the risk event, and
`tests/integration/dbSize.test.ts` is what catches it — the unit tests cannot see a fold that
silently stops folding, which is exactly how this shipped.

---

## Rule 72 — A detection script asserts every prerequisite its remediation establishes, and a mode that establishes nothing refuses instead of reporting success

An operator paired the generated Windows SSH onboarding scripts under an Intune Remediation,
set it to run daily, and came back to a fleet that looked healthy. The detection script said
`ok: Polaris SSH onboarding present` on every endpoint it reached. The account it was supposed
to have prepared — `polaris-agent` — was not in the local Administrators group on any of them,
and was not on the machines at all.

Nothing had failed. Two omissions had lined up.

**The detection script never named the account.** It checked four things: the OpenSSH Server
capability, the `sshd` service, the existence of `administrators_authorized_keys`, and the
Polaris key inside it. All four were true. The account the key exists to authorize was outside
what it asked about, so the pair reported compliant and the remediation half — whose job was to
create that account — never ran again. In the Intune console this reads as a **Detection status**
of "Without issues" over a **Remediation status** of "Not run", which is indistinguishable from
a healthy endpoint.

**And existing-account mode never established anything.** `accountMode` defaults to `"existing"`,
because a created account has a sensible default name (`polaris-agent`) and an existing one does
not — the operator must name an account that is really out there. In that mode the emitted block
was two lines: print `Using existing account <name> (not created by this script)`, and carry on.
It did not check that the account was there. So the script proceeded to install the capability,
start sshd, append the Polaris public key to `administrators_authorized_keys`, apply the ACL sshd
demands, and exit 0 reporting `Polaris SSH onboarding complete` — having authorized a key for an
account that did not exist. Every later SSH attempt would fail at authentication with nothing on
either side saying why, which is the failure mode the whole generator exists to prevent.

The Linux half had never had either problem. `buildLinuxOnboardingDetectionScript` has always
checked the account and the sudoers drop-in as well as the key, and `LINUX_ACCOUNT_EXISTING_SH`
has always refused outright — `error: account $POLARIS_USER does not exist on this host`, exit 1
— when the named account is missing. Windows was the outlier, and the comment justifying it
("neither is observable as wrong without guessing at local policy") had been overtaken by the
onboarding script's own code, which already resolves Administrators by well-known SID precisely
because the name cannot be trusted.

### Both halves name the account

Windows detection now verifies, in order, that the account exists, that it is enabled, and that
it is a member of local Administrators — then the key, as before. Existing mode verifies the same
facts and **refuses** when they do not hold, rather than authorizing a key for nobody. It
verifies without mutating: an operator who chose "use my existing account" did not ask Polaris to
edit group membership, and silently promoting an account to administrator is a different act from
refusing to proceed.

The membership predicate is emitted into both scripts from a single constant, `POLARIS_PS_HELPERS`
— the same constant that carries the key-presence predicate, renamed from `POLARIS_KEY_PRESENT_FN`
when it stopped being about one predicate. This is not tidiness. A pair that answers "is this
account an administrator" two different ways has exactly two outcomes: it oscillates, remediating
forever against a condition detection will not accept, or it certifies an endpoint that cannot be
used. Sharing the text makes disagreement impossible rather than unlikely.

Three details inside that predicate are load-bearing, and each was observed rather than assumed:

- **The group is resolved by SID**, `S-1-5-32-544`, never the literal "Administrators". The name
  is localized and does not resolve on a German or French install.
- **`Get-LocalGroupMember` is not trustworthy alone on an Entra-joined endpoint.** Depending on
  the build it returns members whose SID no longer resolves as raw `S-1-12-1-…` strings, or it
  throws outright and yields nothing at all. The first is harmless — a SID cannot match an account
  name — but the second would make every such device fail the check forever, so the `catch` falls
  back to the WinNT provider, which enumerates the group without resolving every member.
- **Comparison is on the leaf name.** The same member reads `ROGERSGROUPINC\dmoore` from
  `Get-LocalGroupMember` and bare `dmoore` from the WinNT provider, and the configured account may
  itself carry a `DOMAIN\` prefix. The cost is that a local `svc` and a domain `CORP\svc` are
  indistinguishable here; the alternative is a check that silently answers "no" depending on which
  path the endpoint took, which is the failure this rule is about.

A domain account is invisible to `Get-LocalUser`, so for one of those the membership test is the
only observable half and the existence checks are skipped rather than failed.

### What stays out, and why the boundary matters

The firewall rule is still not checked. With no `polarisServerIp` configured there is no rule to
find, which makes it the one condition remediation could never satisfy — a detection that demanded
it would loop the pair forever against every install that left the firewall alone. That is the
same reasoning that keeps an unsupported Windows build at exit 0 with an `unsupported:` marker
rather than 1.

So the rule has two edges, not one. Assert every prerequisite the install genuinely fails
without — and assert nothing the remediation cannot go and fix, because a detection that can
never be satisfied is its own outage.

The downstream consequence is deliberate: because Windows detection now names the account, it can
no longer be rendered without one. `getOnboardingScript` used to carve Windows detection out of
its "enter the existing account first" refusal; that carve-out is gone, and both halves on both
platforms now refuse until the account is named. An operator who had published a detection script
before naming an account was publishing one that could not tell them anything.

See [Polaris-Agent](Polaris-Agent) for the card and the scripts it generates.

---

## Rule 73 — Planned downtime is reported as planned, and a scoped view of a window still reports the whole window

Maintenance is the one state Polaris deliberately hides from almost every surface it has.
`NOT_IN_MAINTENANCE` is spread across every down/warning/stale feed in `nocDashboardService`,
mirrored as `AND "status" <> 'maintenance'` in the raw-SQL ones and in `/summary`'s
`monitorAlerts` clause, because an in-window asset has its `monitorStatus` FROZEN — possibly at
`down` — and a frozen value is not live state (business rule 16). The consequence is that a
dashboard assembled from those widgets says nothing whatever about the devices that are down on
purpose: not that they are fine, not that they are working, nothing.

`maintenanceScheduleService.getActiveMaintenanceSchedules` and the Active Maintenance widget are
the counterpart, and being the only surface that speaks about planned work makes two things
load-bearing that are merely cosmetic elsewhere.

### It must not borrow the vocabulary of an outage

Every listing widget stamps a count pill on its header, and `setHeaderCount`'s fallback colour is
red — the generic "these are down" count, the same red the Down Assets and Down Interfaces totals
wear. Rendered over planned work on a NOC wall, a red 3 is a claim that something needs doing,
about the one set of devices where nobody should do anything. Maintenance rows carry no alert
severity either (there is no automation firing about them — they are silenced by definition), so
there is nothing for the severity palette to agree with. The pill is therefore NEUTRAL, stamped
through `setHeaderPills` directly rather than through the helper whose default is red. The same
reasoning already paints the Status Summary's maintenance tile and the Status Map's site dots
purple instead of red; this states it for a count.

### A narrowed view narrows the LIST, never the window

Every other NOC feed applies the widget's asset filter by dropping rows: a region-scoped Down
Assets shows the down assets in that region, which is exactly right, because each row IS a device.
A maintenance row is not a device — it is a SCHEDULE, and a schedule covers whatever mix of
devices its criteria and its explicit list happen to match. Narrowing it the ordinary way produces
a true-looking sentence that is false in the only way that matters: a switch-scoped board would
report "2 devices" about a window that has taken four down, and an operator reading it would size
the work, the blast radius and the return time against a number Polaris had quietly shrunk for
them.

So the rule inverts for this feed alone: **a schedule survives the filter when ANY of its devices
is in scope, and is then reported whole** — every device counted, every asset type named — with
`matchedCount` / `filtered` recording how much of it the filter actually claimed, which the widget
renders as "4 devices (2 in this scope)". Membership itself comes from open
`AssetMaintenanceWindow` rows, so the types named are the types actually held rather than the
types the criteria could match.

### The clock is the server's, and the countdown is not

A maintenance window is evaluated against the Polaris server's own wall clock, with no offset
stored anywhere (business rule 16's recurrence contract). A window end is therefore published in
BOTH forms and neither is redundant: `endsAt` is the server's wall-clock string, the only form
that may be DISPLAYED, and `endsAtUtc` is the same instant, the only form a "ends in 40m"
countdown can be computed from without assuming the viewer's clock agrees with the server's. A
surface that derives one from the other has re-introduced exactly the bug the string form exists
to prevent — a window painted on the wrong hour for every operator outside the server's zone.

### Acting on planned work is gated where the modal is, not where the widget is

The widget reads at `maintenanceManagement:read`, which is what the feed gates on. Its verbs —
Open schedule…, Disable schedule, + New schedule — all open or write through the Maintenance
editor, so they carry that editor's own `maintenanceManagement:fullwrite` gate and are withheld
entirely below it, on the `/dash` wallboard (no session to act with), and in a library preview. A
button that opens an editor whose every save 403s is worse than no button; the route stays the
control either way. A write made from there must also survive being off the Assets page: the
editor's post-save refresh calls `loadAssets()`, and `fetchAssetsPage` returns early with no table
to repaint rather than throwing into a silent unhandled rejection behind a write that succeeded.


## Rule 74 — A field Polaris writes onto a device is budgeted where the operator types it, and the budget is the device's

A DHCP reservation in Polaris carries a free-text `notes` column. On a network whose integration
pushes reservations, that column is not free text at all: it is the body of the FortiOS
`reserved-address` description, a field the device holds 255 characters of.

Polaris does not write the notes alone into it. It writes

```
Polaris/<user>: <notes> [<hostname>]
```

and both halves of the wrapper are load-bearing. The origin prefix is what lets a FortiGate admin
looking at the device's own DHCP page tell which reserved addresses Polaris owns and who pushed
them. The bracketed hostname at the END is what
`subnetRefreshService.extractHostnameFromDescription` reads back — it is the inverse of the
composer, and the reason a Polaris rebuilt from an empty database can re-derive hostnames from the
gate rather than losing them.

### The budget is computed, because everything inside the 255 competes

The username, the hostname and the notes all spend from the same 255. A service account called
`svc-ipam-automation` and a hostname like `sw-01-building-c-idf-3` together cost nearly 60
characters before the operator has typed anything. So the room left for notes is a function, not a
number: `reservationNotesBudget` composes the description with a one-character note and subtracts
that one character. Deriving it that way rather than restating the format means a later change to
the wrapper does not need the arithmetic changed with it — and cannot silently leave the two
disagreeing.

### The old cap was wrong twice

Until 2026-09-18 the composed string was capped at 64 characters and anything longer was sliced.
The number came from FortiOS 6.2, whose description field held 35; 7.x holds 255, and 6.2 has been
out of support for years.

The first cost is the obvious one: an operator typed a comment, Polaris saved it in full, and the
FortiGate received a third of it, with nothing said at either end. The Polaris row and the device
row disagreed about the reservation's own description and neither surface admitted it.

The second cost is worse, and is why this is a rule rather than a constant. A note long enough to
be cut takes the trailing ` [<hostname>]` with it. `extractHostnameFromDescription` anchors its
bracket branch to the end of the string, so on the next subnet refresh that branch stopped
matching — and its legacy branch, `^Polaris(/user)?: (.+)$`, matched instead and returned the
truncated NOTES as the device's hostname. A long enough comment renamed the thing it described.

### So the cap is the device's, and the refusal is at the keyboard

`RESERVED_ADDRESS_DESCRIPTION_MAX` is 255 — the device's number, not a compromise between device
versions — and `assertReservationDescriptionFits` throws a 400 naming the budget, what was typed
and how much to cut. It runs where nothing has happened yet: in `createReservationFlow`'s phase 3,
beside the MAC and `fortigateDevice` checks and before the row is written, and in
`updateReservation` before the MAC branch. Neither refusal has contacted a gate.

Refusing rather than truncating is the whole point. A truncation is a decision about the
operator's words made after they stopped looking; a 400 is the same decision handed back to them
while they can still act on it.

### Three boundaries, so the rule stays a rule and not a nuisance

**Only push-eligible subnets are judged.** Off one, `notes` is a `@db.Text` column with no device
field behind it, and a 300-character note is perfectly reasonable.

**An edit is judged only when it touches `hostname` or `notes`**, and then against what the update
will actually STORE — `undefined` means "not changing that field", so Prisma leaves the stored
value in place and so does the check. Judging the effective value unconditionally would strand
every row whose note predates this rule: the operator who came to change an expiry date would get
a 400 about a field they never touched, on every save, forever. Clearing or shortening such a note
is explicitly allowed, because the check reads the NEW value.

**The truncating backstop stays.** Several paths write these descriptions without passing through a
save the operator made: discovery-authored notes, the retry tick replaying a queued row, the
FortiSwitch/FortiAP auto-reserve pass. Those rows are not refused — they are sliced, exactly as
before. The `slice` is not dead code; it is what the gate boundary above hands off to.

### The browser counts along, and is checked against the server

`public/js/reservation-notes.js` is the shared budget module — the desktop IP panel's four
reserve/edit modals and both mobile sheets render a live "N of M characters left" under the notes
field, recomputed as the hostname is typed, and turn it into the refusal's wording once the note
goes over. It is advisory: the service is what refuses, and an API client that never loads a page
is held to exactly the same limit. It exists because the alternative is an operator typing 300
characters into a field that will take 223 of them and learning so from an error.

`tests/unit/reservationNotesBudgetDom.test.ts` asserts the module's `budgetFor` against the
server's own `reservationNotesBudget` across four shapes, which is what stops the mirror drifting
from the thing it mirrors.


<a id="rule-78"></a>

## Rule 78 — An automation may choose to speak for a silenced device, and then it must name who silenced it

Dependency suppression exists to stop a storm. When a FortiGate goes dark, every switch, access
point, server and camera behind it stops answering too, and without suppression each of them
raises its own Down alert about an outage that has exactly one cause. So a device behind a
confirmed-down parent is marked `dependencySuppressed`, `assetCanTrigger` drops it from every
automation (rule 37), and any alert already live on it is retired by the 60-second sweep (rule
16). For the NOC that is the right answer: one alert, on the gate, is the outage.

### The plant operator hears nothing

It is the wrong answer for the people who care about one device. The request that forced this
rule (2026-09-20) was a PLC on a plant switch, with the plant operators subscribed to the PLC's
down automation. When the switch died the PLC went Dep. Down, the automation went silent, and the
only string anywhere in Polaris naming the switch as the reason was an audit Event
(`monitor.dependency_suppressed … parent SW-PLANT-3 down`) that nobody on the plant floor reads.
The switch's own alert went to the network team. The people whose line had stopped were told
nothing at all.

The operator's words: *"if the parent switch actually goes down, then the plant operators will
still get an email saying the PLC is dependency down and they'll know which switch is
responsible."* Two demands, both load-bearing: the alert still goes out, and it names the cause.

### The opt-out is the down trigger's own

Silence stays the default. What changed is that a `monitor status is down` automation can opt out
of it, and only that automation: `trigger.alertWhenDependencyDown` rides the trigger JSON beside
`missedPolls`, for the same reason `missedPolls` does — both are properties of the down verdict,
not of the rule's delivery. `validateMissedPolls` refuses the key off a down-detection trigger and
inside a multi-condition trigger (a silenced device reports nothing the other conditions could
read), and the one reader, `ruleAlertsWhenDependencyDown`, is gated on `isDownDetectionTrigger`
so a key stranded on a retyped trigger can never turn a CPU automation into one that fires about
silenced devices. `triggerIdentityOf` ignores it: ticking the box must not purge the rule's state
rows and re-arm every debounce, the same protection the count has.

The wizard's catalog carries the key's name (`downDetection.dependencyDownKey`), so a browser
talking to a pre-upgrade server renders no control rather than one whose key the API would 400.

### It fires on the edge, not on the count

The engine's gate loop keeps an opted-in automation's dependency-suppressed devices in `active`,
and `resolveAssetStateReadings` hands each of them a SYNTHESIZED reading: `value: "down"`,
`dependencyDown: true`, the probe's own verdict kept aside as `ownMonitorStatus`. The alert
therefore fires the moment the reconciler flags the device, not when the device's own probe —
running at half cadence while suppressed — reaches the missed-poll count.

That was a decision, taken with the operator, and the reasoning is worth keeping. The device's own
count is the definition of down for a device Polaris can reach (rule 36). A device behind a dark
switch is not one Polaris can reach; its own probe is going to fail whatever the switch does, and
waiting for it to say so would tell the plant operator, minutes late, what the pill already says.
The parent's confirmed verdict is the evidence. A device that keeps answering over a redundant
path is still handled honestly: the synthesized reading holds the alert while the flag holds, and
the moment the flag clears the real status returns — `up` recovers the alert normally.

### The alert says what it is, and names who

Every surface says DEPENDENCY DOWN, because a message reading "monitorStatus = down (threshold
down)" would be the one thing this alert is not saying. Five template tokens carry it
(`utils/notificationTemplate.ts`), all present-but-empty on every other alert so the default body
prints them for free: `{dependency.summary}` is the whole notice — *DEPENDENCY DOWN — PLC-7 is
unreachable because its upstream device SW-PLANT-3 is down* — and rides a slate banner under the
headline (the Dep. Down pill's colour) that `pruneEmptyDivs` removes on every other send;
`{dependency.upstream}` and `{dependency.rootCause}` are fact rows; `{dependency.tag}` appends
` · DEPENDENCY DOWN` to the default subject; and `{dependency.headline}` is the
compact form — the state and who, without the device's own name.

That fifth token exists because of a hole a live dev run found, and it is worth
recording as the general shape of the mistake. The seeded "Asset down"
automation carries `messageTemplate: "{asset} is down"`, and an operator's own
template WINS over the generated default — correctly, it is theirs. But push,
Slack, Teams and Pushbullet send `Notification.message` and nothing else, so on
the very automation most likely to be covering a PLC, the plant would have been
paged with the one fact they already knew ("ASHF-FILE-01 is down") and none of
the reason. The email was fine; the surfaces the operator actually carries were
not. So the notice is APPENDED to their words rather than replacing them —
`"ASHF-FILE-01 is down — DEPENDENCY DOWN — upstream ASHF-CORE-SW1 is down (root
cause ASHF-EDGE-FG1)"` — and skipped when their template already renders the
notice itself, since it is a catalogued token they may have used. `{trigger.summary}` is replaced by
`dependencyTriggerSummary` (the device's own probe did not decide this alert, so "Monitor status
is down" would mislead), and the default in-app message — what push, Slack, Teams and the phone
show — is the rule name plus the whole sentence.

Naming who is the harder half, and it is not `evaluateSuppression`'s answer. That function
returns a boolean per asset and throws away which parent decided it; worse, the device directly
above is not always the device that is down. A PLC's switch may itself be Dep. Down under a dark
FortiGate — its own probe reads `down` too, since it is behind the gate — and naming the switch
would send the plant operator to a box that is a victim, not a cause. So
`dependencyTreeService.resolveDependencyBlame` walks UP. A parent is blamed as `dependency_test`,
`maintenance`, `suppressed` or `down`, in that order: the two overlays first because the operator
has already named the cause ("pretend THIS box went offline"), and `suppressed` BEFORE `down` so a
switch that is both keeps the walk going to the gate. The first blamed monitored parent is the
UPSTREAM; the walk continues while the blamed node is blamed only for being suppressed itself,
and the first node dark in its own right is the ROOT CAUSE. Unmonitored parents are transparent
and unmonitored HA standbys ignored, as in `isParentOk`; among redundant parents a definitive
reason outranks `suppressed` and hostname breaks the tie; the walk is bounded at sixteen hops and
says `truncated` on the cap or a cycle. `{dependency.rootCause}` is BLANK when it is the upstream
device itself, so the "Root cause" row prunes away instead of repeating the "Upstream device" row.

Two things the walk deliberately is not. It is not `connectionPathService.resolveConnectionPath`,
whose parent tie-break prefers an `up` parent — exactly the wrong bias when the question is who is
down. And it is not the reconciler Event's `parentAssetIds`, which is the whole effective parent
set (healthy redundant parents included) and never reaches past layer 1.

The walk loads the ancestor closure hop by hop through a cache the engine renews every tick, so
three hundred PLCs behind one switch load the switch and the gate once between them. It never
throws: a failed read yields null and the alert goes out worded without a name — *because a
device above it is down* — since "your PLC is dependency down" beats silence even when the switch
cannot be named. The name, the reason and the hop count are snapshotted on
`Notification.dependencyDown` + `dependencyBlame`, so the row still explains itself after the
dependency tree is recomputed and the flag is a COLUMN because three readers need it without
reading text: the sweep, the engine's handoff and the alert surfaces' badge. (`templateCtx` would
not do — that snapshot is written only when the rule composes or escalates, and the simplest
in-app-only automation writes none.)

### The flavour follows the flag

An alert raised while the device was Dep. Down and an alert raised because its own probe failed
are two different statements, and the operator chose that a change between them be heard. So the
alert's flavour follows the asset's `dependencySuppressed`: for an opted-in rule the engine tick
reads each live alert's `dependencyDown`, and a firing row whose reading disagrees with it goes
through `handoffDependencyFlavour` — soft-clear as `system:dependency-down` or
`system:dependency-released`, release the state row, audit `notification.superseded`, and fire
again in the other flavour. No reset actions run either way: nothing recovered, and mailing
"Resolved" about a PLC that is still dark would be a lie.

Both directions matter. A PLC alerts as plain Down a minute before the switch above it is
confirmed down (they miss polls together, and the smaller count wins); when it turns Dep. Down
the plain alert ends and the dependency-down alert goes out naming the switch — the "which switch
is responsible" message the operator asked for. On the way back, the switch recovers, the PLC is
released, and if the PLC is STILL down the dependency-down alert — now claiming a switch that is
fine — ends and a plain Down alert is raised: *and now it is the PLC itself*. Only a genuinely
met reading triggers the handoff; a released device reading `recovering` or `warning` is simply
held until it reads `up`, as every down alert is (rule 36).

The 60-second sweep normally does the first half a tick early: `clearSuppressedAlerts` still
retires a plain alert on a suppressed asset, and the next engine tick raises the dependency
flavour. The in-loop handoff exists for the race where the flag flips between the sweep and the
loop, and for the reverse direction, which the sweep cannot see.

### Three things the opt-out does not reach

**Maintenance still silences.** The carve-out in the gate loop is dependency-only: a device in a
maintenance window stays in `suppressedIds` whatever its automation says. Announced downtime is not
an outage to report (rule 16 wins), and an opted-in PLC automation must not page the plant every
time the switch above it is scheduled for a firmware update.

**Reminders and escalation still pause.** The operator asked for one notification. The escalation
sweep already pauses every live alert on a suppressed asset; an alert raised BY this rule is on a
suppressed asset by construction, so it inherits the pause with no new code and resumes — or ends
— when the upstream is back. That is the whole of "one notification": the first email goes out,
and nothing chases it until the picture changes.

**The sweep never retires a dependency-down row.** `clearSuppressedAlerts` adds
`dependencyDown: false` to its query. Without it the sweep would retire the alert the engine just
raised, the engine would raise it again on the next tick, and a plant operator would receive one
email a minute until the switch came back. The exclusion is in the query rather than a branch
because such rows must never even reach the asset lookup: they are the one alert that is SUPPOSED
to be live on a suppressed asset, and the engine owns their end.

### Where it shows

The Active Alerts widget, the asset's Notifications tab and the phone's alert list badge the row
"Dep. Down" in the same slate the Status pill wears, the widget's tooltip naming the upstream; the
audit Event carries `dependencyDown`, `upstreamAssetId` and `rootCauseAssetId` for a script or a
SIEM to follow; and a Test-delivery of an opted-in automation renders the dependency notice
against an invented upstream (`SAMPLE_UPSTREAM_HOSTNAME`), so the operator sees the banner and
the rows a real one carries.

Pinned by `tests/unit/notificationDependencyDownAlert.test.ts` (the engine half, including that an
automation WITHOUT the key still drops the asset and that maintenance still silences),
`tests/unit/dependencyBlame.test.ts` (the walk — same fixtures `dependencyTreeService.test.ts`
builds), `tests/unit/notificationSuppressionSweep.test.ts` (the exclusion), the template and
email-template suites (the tokens and the pruning), `tests/unit/downDetectionTriggerSchema.test.ts`
(where the key may live) and the wizard DOM suite (the Actions-step row, the key surviving a
Trigger-step re-collect, the strip on a composite).
