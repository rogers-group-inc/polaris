## Rule 187 — An Event that is written is forwarded to syslog — the hand-off never waits on the network, and a forwarding failure is never an Event

### What was found (2026-11-13)

The CQ-T010 batch 7 suite for `eventArchiveService` showed that nothing in `src/` read the
`eventSyslog` setting except its own settings functions and routes. The Events page's Settings
modal offered a Syslog tab with an **Enable syslog forwarding** box ("events are forwarded to a
remote syslog server in real time"), protocol, host, port, facility, minimum severity, format
and TLS files, and a **Test Connection** button that really did send one datagram — but no Event
was ever forwarded. It was the same shape as the NTP settings before rule 170: a working
settings card and test, and no consumer.

The operator decided (2026-11-14): **build it.**

### The decisions

- **Hook at the one write path.** Every Event goes through `eventLogService.logEvent` or
  `logEventsBatch` (no other module calls `prisma.event.create*`), so the forwarder sits
  there, after the row is written and after the retention `minLevel` drop. An Event the
  install chose not to keep is not forwarded either. The syslog minimum severity is a second,
  independent floor applied at flush.
- **Never slow or break an Event write.** `forwardEvents` is synchronous: it pushes onto a
  bounded array and schedules a flush with `setImmediate`. It never awaits the settings read
  or the network, and it swallows every exception. An Event write is often inside a request
  handler or a monitor tick; a dead syslog server must cost those nothing.
- **Bounded, oldest dropped.** At most `MAX_QUEUE` (10 000) messages wait, in the hand-off and
  again in a stream sink while the server is unreachable. When full, the OLDEST are dropped,
  because a collector that comes back wants the recent past. The drop count is logged with the
  next rate-limited warning.
- **Every role forwards its own Events.** web, monitor, discovery and dash all write Events.
  Routing them through one process (pg-boss, NOTIFY) would add a moving part and a delay for
  no gain: each Event is written by exactly one process, so each leaves exactly once. The
  cost is one connection per process to the collector, a handful.
- **Settings are cached 30 s per process.** Re-reading the setting per Event would add a
  query to every Event write. Saving invalidates the saving process's cache at once; the other
  processes follow within 30 s (documented on the wiki).
- **Formats.** RFC 5424 carries the Event's fields as structured data under SD-ID
  `polaris@32473` (the IANA documentation enterprise number; Polaris has no PEN of its own),
  so a collector can index `action`, `level`, `resourceType`, `resourceId`, `resourceName`
  and `actor` without parsing the message. MSGID is the action (printable ASCII, 32 max).
  RFC 3164 is `TIMESTAMP HOST polaris[pid]: action: message` in the process's local zone
  (which rule 170's timezone override sets). No UTF-8 BOM: many collectors display it as
  noise. Line breaks inside a message are flattened, because they would split a
  newline-framed message.
- **Framing.** RFC 5425 (syslog over TLS) requires octet counting, and RFC 6587 allows it for
  TCP, so RFC 5424 over a stream is `LEN SP MSG`. RFC 3164 has no such standard and is
  newline-framed, which is what every BSD-style receiver expects. UDP messages are capped at
  2048 bytes (RFC 5426's SHOULD), stream messages at 8192, cut on a UTF-8 character boundary.
- **One persistent connection, reconnect with backoff.** Opening a TCP / TLS connection per
  Event would cost a handshake per Event and leave TIME_WAIT sockets on a busy install.
  Backoff runs 1 s → 60 s, doubling, reset on a successful connect. Sockets and timers are
  `unref`'d so they never hold a process open at shutdown.
- **TLS always verifies.** The old Test button set `rejectUnauthorized: !!tlsCaPath`: with no
  CA path the server was not verified at all. Forwarding audit data to an unverified endpoint
  defeats choosing TLS. Now a CA path pins that CA; otherwise the system store plus the CAs
  uploaded under Server Settings → Trusted Certificate Authorities are trusted. That card
  already promised this ("CAs Polaris uses to verify remote servers — integrations, syslog
  and archive targets"), but nothing read it. Syslog is now the first consumer; the archive
  and integration halves of the promise are still open (recorded in the ledger).
- **A failure is never an Event.** "Syslog forwarding failed" written as an Event would itself
  be forwarded, failing again. Failures go to the process log, at most one warning a minute.
- **The Test button tests the real thing.** It used to send a hard-coded RFC 5424 line
  regardless of the chosen facility and format. It now formats a synthetic
  `event_syslog.test` Event with the forwarder's own formatter and sends it with the same
  framing and TLS options.
- **The settings body is validated.** The PUT stored `req.body` as given. It is now
  Zod-parsed: protocol / facility / severity / format enums, port 1–65535, host ≤ 253 with no
  whitespace or slash, unknown keys dropped.

### Rejected

- **Forwarding from the event archive job** (the nightly SFTP export). Syslog is promised as
  real time; a nightly batch is not that.
- **A pg-boss queue for forwarding.** Durable, but it turns every Event into a second row and
  a job, and syslog consumers already accept that UDP loses messages. A bounded in-memory
  queue is the conventional trade.
- **An Event per forwarding failure.** See above: it feeds itself.
- **Prometheus counters for forwarded / dropped messages.** Worth adding if operators ask;
  the rate-limited warning with the drop count covers diagnosis for now, and a new
  `polaris_*` metric needs the Grafana dashboard to move with it.
