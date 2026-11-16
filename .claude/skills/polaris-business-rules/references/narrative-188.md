## Rule 188 — An uploaded Trusted CA adds trust to every outbound TLS connection that verifies — never replaces the built-in roots, never touches a connection with verification off

### What was found (2026-11-14)

Server Settings has a **Trusted Certificate Authorities** card: upload a CA certificate and,
it said, Polaris uses it "to verify remote servers when Polaris connects to integrations,
syslog, and archive targets". Nothing read the uploads. `serverSettingsService.addCertificate`
stored them in the `certificates` setting and `listCertificates` listed them back, and that was
all: an operator whose vCenter, FortiManager or LDAP server carries a certificate from an
internal CA still had to turn "verify TLS" OFF for that integration. The syslog forwarder
(rule 187, built 2026-11-14) became the first reader.

The operator decided (2026-11-16): **the trusted CAs should be used for integrations.**

### The decision

- **One process-wide store, not a `ca` per transport.** Polaris reaches integrations through
  at least a dozen TLS paths: node:https agents (vCenter, Proxmox, TrueNAS, Unraid, the
  Generic API, the AI integration, device HTTP for firmware), undici `fetch` and its
  dispatchers (FortiOS / FMG REST, webhooks), `tls.connect` (DoT, WinRM, probes) and ldapts
  (LDAPS). Threading a `ca` option through each would miss the next one somebody adds.
  `tls.setDefaultCACertificates()` (Node 22.19 / 24.5) replaces the store EVERY connection
  uses when it names no `ca` of its own, so one call covers them all. Verified on Node 24
  with a self-signed server: node:https, `fetch` and `tls.connect` all refused it before
  and trusted it after.
- **Adds, never replaces.** The store set is always the process's ORIGINAL default (captured
  once, before any upload is applied) plus the uploads. Replacing the roots would break every
  public endpoint (Microsoft Graph, Azure, ArcGIS). Recomputing from the captured baseline
  means removing a CA really removes it, instead of the live store accumulating.
- **Verification off stays off.** An integration with "verify TLS" unticked passes
  `rejectUnauthorized: false`; a CA store does not change that. The point of the card is to
  let operators turn verification ON for internal servers, not to second-guess the toggle.
- **Every role, refreshed.** monitor and discovery make most integration connections, and
  the upload happens on web. Each role applies the store at boot (before any job connects)
  and re-reads it every 30 s, the same arrangement as the timezone override (rule 170). The
  web role applies an upload or removal at once. A connection already open keeps the trust it
  was opened with until it reconnects.
- **A bad upload cannot break TLS.** Each upload is parsed as X.509 first; a malformed one is
  skipped (and counted in the log), never handed to `setDefaultCACertificates`, which would
  throw and leave the whole store unapplied.
- **Audited.** Adding trust is security-relevant: whoever can upload a CA can, with network
  position, impersonate any server Polaris verifies. Uploads and removals now write
  `certificate.ca_added` / `certificate.ca_removed` at warning level, with the actor. Before
  this rule they wrote nothing.
- **SSH is out of scope.** The SFTP / SCP event archive (and every SSH transport) trusts a
  server by its pinned host key (rules 21, 107); certificate authorities play no part. The
  card used to promise "archive targets"; it now says the archive uses the host key.

### Rejected

- **A `ca` option per integration.** Precise, but each transport is a place to forget, and the
  next integration added would silently not honour the card.
- **`NODE_EXTRA_CA_CERTS` written by Polaris.** It is read once at process start, so an upload
  would need a restart of every role — and Polaris does not restart itself in a container
  (rule 99). It remains the documented route for a CA the operator manages on the host, and
  it is part of the captured baseline.
- **Applying uploads only to integrations.** The same internal CA usually signs the SMTP relay,
  the syslog collector and the OIDC provider; a store that trusted it for one and not the
  others would be a second surprise of the kind this rule fixes.
