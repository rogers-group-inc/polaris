# Environment variables

Verbatim from CLAUDE.md → Environment Variables. `.env.example` carries the same catalogue with per-variable comments and is what a running install reads; keep the two in step.

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/polaris

# Direct-to-PostgreSQL URL for installs running PgBouncer in front of Postgres.
# When set, Polaris routes pg-boss, pg_dump backup/restore, and pg_stat_activity
# reads through this URL; Prisma still uses DATABASE_URL. Leave unset on direct-to-Postgres.
POLARIS_DB_DIRECT_URL=

# Prisma driver-adapter pool size (default 25). Raise for many monitored assets.
# Capacity Advisor card recommends + stages this value.
DATABASE_POOL_SIZE=25

# Other pool / worker env vars tunable via the Capacity Advisor:
#   POLARIS_PGBOSS_POOL_SIZE          (default 20)
#   POLARIS_MONITOR_PROBE_WORKERS     (default 24)
#   POLARIS_MONITOR_FAST_WORKERS      (default 24)
#   POLARIS_MONITOR_HEAVY_WORKERS     (default 24) — telemetry + systemInfo
#   POLARIS_MONITOR_FLOATING_WORKERS  (default 32) — cross-queue absorber
#   POLARIS_MONITOR_LLDP_WORKERS      (default 12)
#   POLARIS_MONITOR_STORAGE_WORKERS   (default 12)
#   POLARIS_MONITOR_PROCESSES_WORKERS (default 12) — agentless ssh/winrm processes
#   POLARIS_MONITOR_EVENTLOG_WORKERS  (default 8)  — agentless ssh/winrm OS event log
#   POLARIS_MONITOR_LOSS_SAMPLE_WORKERS  (default 24) — ICMP loss sweep (a uniform 5-echo burst at every eligible asset each cycle; business rule 30). One job is one CHUNK of up to 500 assets measured in ONE fping process, not one job per asset, so this pool sizes concurrent CHUNKS — a 2000-asset fleet needs four. Name kept from the retired per-asset sampler so an operator-set value survives the cutover
#   POLARIS_LOSS_SWEEP_INTERVAL_SEC   (default 60) — seconds between ICMP packet-loss sweeps. RAISE IT WHERE fping IS ABSENT: batched, one process serves 500 targets and 60s is affordable at any size; on the per-host fallback 300s cuts the process count fivefold with no loss of accuracy (the ratio still sums packets over each automation's own History window — only reaction time changes). Whatever is set, `resolveSweepIntervalSec` floors it at what the installed pinger can finish for the fleet size, so Polaris never publishes sweeps faster than they drain
#   POLARIS_PROBE_CONCURRENCY         (cursor mode probe + fastFiltered cap)
#   POLARIS_HEAVY_CONCURRENCY         (cursor mode telemetry + systemInfo + processes cap)

# Application Map connection-row retention (days) — DEFAULT SEED ONLY.
# asset_process_connections is now the flat `appMapConnections` retention entity
# (a single window, no detail/hourly/daily tiers) edited on Server Settings →
# Retention, and that Setting is authoritative. This var supplies its default the
# first time it's read, so an install that set it keeps its number until an
# operator saves the card. The same window bounds what the Application Map's
# "Seen within" filter can reach. Default 30.
POLARIS_PROCESS_CONN_RETENTION_DAYS=

# Per-waiter wait-timeout (ms) for the per-SNMP-agent serialization gate in
# monitoringService.withSnmpGate. Default 30000. All probe / telemetry /
# systemInfo / fastFiltered SNMP calls against the same host:port FIFO-
# serialize through this gate. When the currently-running collector wedges
# (e.g. dead-host net-snmp 60s timeout), queued callers behind it fail fast
# after this timeout with `SNMP gate timeout for <host:port> after <ms>ms`
# instead of all blocking the full upstream duration. The wedged slot itself
# still holds the gate until it returns; this timeout only bounds wait time
# for queued callers, not the wedge itself. Operator snmp-walks override the
# wait per-call to 50s (SNMP_WALK_GATE_WAIT_MS) to fit the SNMP Walk tab's
# 60s client countdown.
POLARIS_SNMP_GATE_WAIT_TIMEOUT_MS=30000

# Process role (multi-process deployment). Unset = "all" = single process runs
# every subsystem (default; unchanged single-process behavior). Split via:
#   web | monitor | discovery | dash — set per service unit / container, NOT in .env.
# Capability gating lives in src/utils/role.ts (roleConfig); boot path branches
# on it in src/app.ts. See "Multi-process architecture" in the skill references (formerly ARCHITECTURE.md) and
# docs/INSTALL.md. Companion vars: POLARIS_DISCOVERY_WORKERS (discovery role,
# default 2), POLARIS_MONITOR_REPLICAS (required on web role — Capacity Advisor
# uses it to size pools + max_connections across the process group; setup
# scripts write it from --monitor-replicas, and the web role warns at boot
# when it's unset in split-role mode).
POLARIS_ROLE=

# App
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

# Interface the FIRST-RUN SETUP WIZARD binds to. Only consulted while
# DATABASE_URL is unset; once provisioned the wizard never runs again. The
# wizard is unauthenticated BY CONSTRUCTION (it exists to create the first
# account), so until it is finished whoever reaches it first chooses the admin
# password, the database and the secrets. 127.0.0.1 restricts it to the host —
# finish the wizard over an SSH tunnel. Unset binds 0.0.0.0, which is the
# default because a container can only reach the wizard through a published
# port and a remote server is usually browsed to; loopback-by-default would
# make a fresh `docker compose up` unreachable. The boot banner states which
# way it went.
POLARIS_SETUP_BIND=

# Session — required in production; server refuses to boot without it
SESSION_SECRET=changeme

# Reverse-proxy trust — leave unset on direct-to-internet deployments. Set to a
# hop count, "loopback", or CIDR only when behind a real proxy.
TRUST_PROXY=

# Active-instance heartbeat kill switch (HA). Production-only guard: the web
# role refuses to boot when another hostname holds a <90s-old
# Setting("ha.activeInstance") stamp. "off" disables it. See docs/HA.md and
# high-availability.md.
POLARIS_HA_HEARTBEAT=

# /health AND /health/ready bearer token — auto-generated at first-run setup.
# Clearing reopens both endpoints and surfaces a `health_token_unset` watch
# reason on Maintenance tab. /health is liveness (checks nothing, the setup
# wizard polls it); /health/ready is readiness (200 only on a writable primary,
# 503 in-recovery/db-error/timeout) and is what a load balancer should monitor.
HEALTH_TOKEN=

# /metrics bearer token — auto-generated at first-run setup. Endpoint leaks
# fleet recon data if unset; surfaces a `metrics_token_unset` watch reason.
METRICS_TOKEN=

# Encryption key for secrets stored in the DB (32 bytes as 64 hex chars) —
# Credential.config, Integration.config, NotificationChannel.config and the
# secret-bearing Setting rows. Auto-generated at first-run setup and by every
# deploy/setup-* script — including onto an EXISTING .env on re-run, so an
# install that predates the feature picks one up. The multi-container
# docker-compose stack is the exception (it presets DATABASE_URL, so the wizard
# never runs): supply it in ./state/.env yourself. When UNSET the
# sealing in db.ts is a NO-OP and those values are stored as PLAINTEXT (the
# pre-2026-08 behavior, so an in-app update never breaks a running install);
# the absence surfaces a `secrets_key_unset` watch reason. Setting it and
# restarting seals existing rows via the backfillSecretEncryption job. KEEP A
# COPY OFF-HOST: sealed secrets are unrecoverable without it, and a backup
# restored onto a host with a different key needs its device + integration
# secrets re-entered (logins and SSO are unaffected). In managed deployments,
# inject it from Azure Key Vault the way SESSION_SECRET is delivered.
POLARIS_SECRET_KEY=

# Standalone /metrics listener for the non-HTTP roles (monitor, discovery) in
# the multi-process split. Unset on single-process (POLARIS_ROLE unset / =all)
# and web roles — those expose /metrics on the main HTTPS listener. Set
# per-process when running split so Prometheus can scrape work-duration /
# probe / sample-write / discovery histograms that live in each consumer's
# in-memory registry. Systemd units default to 910N (monitor instance N) and
# 9110 (discovery). POLARIS_METRICS_BIND defaults to 127.0.0.1; set to
# 0.0.0.0 only when Prometheus runs off-host.
POLARIS_METRICS_PORT=
POLARIS_METRICS_BIND=

# Dash wallboard listener — the unauthenticated read-only /dash surface
# (polaris-dash.service, POLARIS_ROLE=dash; also boots in-process under
# role "all" so dev serves /dash on :3001). Disabled by default; the on/off
# toggle + source-IP scope (rfc1918 / all / custom CIDR allow-list; unauthorized
# sources are silently dropped) live in the
# `dashConfig` Setting (Server Settings → Web Server → Dash Wallboard) and
# propagate to the dash process within ~10s via dashSettingsService's TTL
# cache. Serves as the built-in readonly role (dashRoleSnapshotService stamps
# req.roleSnapshot); layout persists per-browser in localStorage. Bind is
# forced to 127.0.0.1 in proxy mode (nginx `location /dash` proxies to it);
# POLARIS_DASH_BIND applies only outside proxy mode. The RFC1918 gate trusts
# X-Forwarded-For per TRUST_PROXY — widening TRUST_PROXY weakens it.
POLARIS_DASH_PORT=3001
POLARIS_DASH_BIND=

# Reverse-proxy (nginx) front-end — nginx terminates TLS. Polaris listens
# HTTP-only on 127.0.0.1. Both required (fail-fast at boot). Fresh installs
# wire these via deploy/setup-*.sh; existing installs migrate via
# deploy/migrate-to-nginx.sh. See deploy/nginx/polaris.conf for the
# reference HTTP/2 + HTTP/3 nginx config.
POLARIS_PROXY_CERT_PATH=
POLARIS_PUBLIC_URL=

# TimescaleDB chunk compression window (days). Default 7. 0 disables.
# At the default, detail tables compress almost nothing: the compression and
# retention policies both key off a chunk's end plus their own window, so a
# 7-day detail retention drops each chunk about when it becomes compressible
# (real install: 146 MB compressed of 89 GB, 2026-09). The 10-30× saving lands
# on the 30d/365d rollups. Set it BELOW detail retention to compress detail.
TIMESCALE_COMPRESS_AFTER_DAYS=7

# Persistent-state dir. When set, .env / .setup-complete / data/backups /
# public/uploads all live under this dir (Docker pins to /app/state).
POLARIS_STATE_DIR=

# Git repository the in-app updater fetches/pulls from. When SET, it's applied
# to the `origin` remote before every update check/apply (ensureUpdateRemote in
# src/services/updateService.ts), overriding whatever the install was cloned
# from — point at a fork or internal mirror. When UNSET, the existing `origin`
# remote is left untouched (updates come from wherever the install was cloned).
# The Application Updates card surfaces the active repo + its source
# (GET /server-settings/updates/repo). The deploy/update-{linux.sh,windows.ps1}
# fallback scripts read the same var and repoint origin in lockstep.
#
# Charset-restricted to [A-Za-z0-9._~:/@+-] (isSafeRepoUrl in updateService).
# Anything else is IGNORED in favour of the existing origin, with an error
# logged naming the value. The in-app updater interpolates this into a SHELL
# command, and $(...) / backticks expand inside the double quotes it lands in,
# so the quoting that looks like it handles this does not. The two fallback
# SCRIPTS are unaffected either way — bash "$ENV_REPO" and PowerShell
# $UpdateRepo pass already-expanded data as one argument, never a string the
# shell re-parses. That difference is the whole reason only the Node path
# needed a guard.
POLARIS_UPDATE_REPO=

# PEM bundle of extra CAs Node should trust, for networks that re-sign HTTPS
# with an internal CA. Node ships its OWN CA store and ignores the OS one, so a
# root the whole host trusts is still rejected inside Polaris and inside npm —
# the fingerprint is npm failing UNABLE_TO_GET_ISSUER_CERT_LOCALLY while the
# code-pull step of the same update succeeds (that path is OpenSSL, which does
# read the system store). Cisco Umbrella's intelligent proxy is the DNS-layer
# variant: the registry resolves to an Umbrella address (146.112/16), so the
# firewall never shows the real destination — same fix, its root in the OS store
# (prod, 2026-09-10). The in-app preflight message says whether THIS process has
# the variable, whether the file exists, or that the bundle lacks the CA.
#
# Read by NODE ITSELF at process start, not by the app, so it only works as a
# real environment variable: it takes effect from .env because the shipped units
# load that file with systemd's EnvironmentFile=, which exports it before node
# execs. A value the app merely parses later would be too late. `sudo` scrubs
# it, so deploy/update-linux.sh reads it back out of .env and re-supplies it to
# every npm/npx call (its app_node helper).
#
# EXTENDS the built-in roots rather than replacing them, so it is safe to leave
# set on a network that does not intercept — which is why deploy/setup-*.sh
# detect the host's bundle and write it on fresh installs
# (/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem on RHEL,
# /etc/ssl/certs/ca-certificates.crt on Debian). Windows has no system PEM: the
# root must be exported from the certificate store to a file.
#
# Also covers the app's own egress once running — Entra/Graph, Azure Arc, the
# IEEE OUI refresh, weather/map tiles, webhook delivery. Operator runbook,
# including how to recover an install whose update already failed this way:
# docs/INSTALL.md → "Networks that inspect TLS".
NODE_EXTRA_CA_CERTS=

# Public hostname the agent embeds in agent.conf when POLARIS_PUBLIC_URL isn't
# set (no scheme/port override). POLARIS_PUBLIC_URL wins when both are set.
POLARIS_PUBLIC_HOST=

# How many old agent binary versions to retain under data/agents/ when the
# Maintenance → Polaris Agent → Clean up button (or post-build auto-prune)
# runs. Newest-first; excludes the current manifest version + any in use by a
# live ManagedAgent. Default 3 (two rollback targets). 0 = prune all removable.
POLARIS_AGENT_KEEP_VERSIONS=3

# Diagnostic: "1" makes the web role log one info line per inbound agent
# /samples push (stream, count, first telemetry cpu/mem) + an enqueue line.
# Off by default; pair with the agent-side `verbose = true` to trace a round-trip.
POLARIS_AGENT_SAMPLE_LOG=

# Go toolchain for the in-app agent Build feature (forwarded to GOTOOLCHAIN on
# `go build`). Default "local" uses the host Go; "auto" downloads the version
# pinned in agent/go.mod on demand. Offline hosts must stay on "local".
GOTOOLCHAIN=local

# Diagnostic: "1"/"true" makes the ghost-merge job (collapsing duplicate-hostname
# NULL-MAC AssetSources into the canonical asset) log what it WOULD merge with no
# writes. Use when investigating unexpected merge behavior. Unset for normal ops.
POLARIS_GHOST_MERGE_DRY_RUN=
```

> Notification delivery secrets (SMTP password, M365 client secret, Pushbullet
> token, Slack/Teams webhook URL, Web Push VAPID key) are NOT env vars — they're
> stored (masked) in the `NotificationChannel` registry, managed on the
> Automations → Delivery tab, same as Integration / Credential secrets.

Configured via the UI, not env vars: Azure SAML SSO (Server Settings → Security → Identification), syslog forwarding + SFTP archival (Server Settings → Integrations). HTTPS is managed by nginx — the cert at `POLARIS_PROXY_CERT_PATH` is operator-owned; Polaris reads it for the agent-pin fingerprint exposure only.

Copy `.env.example` to `.env` before running.
