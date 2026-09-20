# Polaris Agent

Lightweight Go binary installed on remote hosts (Linux/macOS/Windows × amd64/arm64) that pushes monitoring samples back to Polaris. Generic across deployments — per-install identity lives in `agent.conf`.

## Building

```sh
go mod tidy     # one-time: resolve dependency checksums into go.sum
make all        # produce all 6 platform binaries under dist/<version>/
make dev        # local-arch build for quick iteration (./polaris-agent)
```

Binaries are static (`CGO_ENABLED=0`); copying one file to the target host is sufficient.

Dependencies: just one — `github.com/gorilla/websocket` for the outbound pull-side WebSocket. The HTTP push path uses only stdlib `net/http`.

## Configuration

Written by `agentInstallService` on the Polaris server side at install time. Operators don't edit it by hand.

```ini
# /etc/polaris-agent/agent.conf  (Linux/macOS)
# %ProgramData%\Polaris\agent\agent.conf  (Windows)

server_url       = https://polaris.example.com:3000
cert_fingerprint = sha256:ab12cd34...      # leaf SHA-256, pinned at install
bearer_token     = polaris_xK9rT2pQwL...   # populated by /enroll on first run
enrollment_token = polaris_...             # one-shot; consumed on first /enroll
agent_id         = 7f2e9a1c-...            # assetId, used for WS subprotocol
```

Optional knobs (defaults if omitted):

```ini
response_time_interval_sec = 60
heartbeat_interval_sec     = 300
```

## Running

The install script registers the agent as a system service:

| OS | Mechanism |
|---|---|
| Linux | systemd unit at `/etc/systemd/system/polaris-agent.service` (Phase 4) |
| macOS | launchd LaunchDaemon at `/Library/LaunchDaemons/com.polaris.agent.plist` (Phase 4) |
| Windows | Windows Service via `New-Service` (Phase 4) |

For development you can run the binary directly:

```sh
./polaris-agent -conf /path/to/agent.conf
```

## Wire protocol

| Endpoint | Method | Auth |
|---|---|---|
| `/api/v1/agents/enroll` | POST | enrollment token in body (one-shot) |
| `/api/v1/agents/samples` | POST | bearer (Authorization header) |
| `/api/v1/agents/heartbeat` | POST | bearer |
| `/api/v1/agents/config` | GET | bearer; `If-None-Match` short-circuit |
| `/api/v1/agents/ws` | WS upgrade | bearer in `Sec-WebSocket-Protocol` (Phase 3b) |

### The `telemetry` sample

The host CPU/memory row (`internal/collectors/telemetry.go`) carries more than
the aggregate pair every other transport can produce. Fields beyond
`cpuPct` / `memPct` / `memUsedBytes` / `memTotalBytes` are agent-only and null
on every server-side collector:

| Field | Meaning |
|---|---|
| `cpuCorePcts` | Per-logical-core utilisation, array index = core id, one decimal. Capped at 512 cores (the server's Zod schema refuses more). Omitted entirely — not sent as `[]` — when the per-core read fails. Stored on the DETAIL tier only; the hourly/daily rollups carry the aggregate alone. |
| `memBuffersBytes` / `memCachedBytes` / `memFreeBytes` | The memory bands `memUsedBytes` is not. Reconciled per-OS by `internal/collectors/meminfo.go` so that **used + buffers + cached + free == total, exactly**, on Linux, Windows and macOS alike. Sent as a set or not at all. |
| `swapUsedBytes` / `swapTotalBytes` | Swap (Linux) / **page file** (Windows). Not part of the four-band sum. |

Two per-OS traps `meminfo.go` exists to absorb, and which any change there has
to keep absorbing:

- **Windows reports no cache through the API gopsutil uses.**
  `GlobalMemoryStatusEx` folds free and standby together into `ullAvailPhys`,
  so `VirtualMemoryStat.Cached` is 0 on every Windows host. The real figure is
  `PERFORMANCE_INFORMATION.SystemCache` from `GetPerformanceInfo`, **in pages**
  — multiply by `PageSize` or you report a ~4096× cache.
- **`mem.SwapMemory()` is the COMMIT CHARGE on Windows**, not the page file.
  Commit charge counts every private committed page whether or not it was ever
  written to disk, so a healthy host reads several GB "swapped" against a
  nearly empty page file. The page file itself comes from `EnumPageFilesW`.

## Security

- **TLS leaf pinning** — agent does NOT trust system roots; only the SHA-256 baked into `agent.conf` at install time matches. Rotating the pin requires the operator to re-run install with a re-keyed Polaris server.
- **Per-agent bearer** — bound to a single `assetId` server-side. A stolen bearer can only write samples for the one asset it was issued for.
- **Config file mode 0600** — the bearer is the only sensitive material on disk; only the agent's service user reads it.

## Phasing

| Phase | Adds |
|---|---|
| 3a | HTTP push: enroll, samples (responseTime), heartbeat, config-fetch |
| 3b (current) | WebSocket pull side: outbound dial w/ pinned TLS, reconnect-with-backoff, probe-now-request / probe-now-response, refresh-config |
| 4 | Remote install via SSH/WinRM from the Polaris UI |
| 5 | Telemetry / interfaces / storage / LLDP collectors |
| 6 | OS event-log collector (opt-in `eventLog` stream): wevtutil (Windows) / journalctl (Linux), per-channel cursor in `eventlog-cursors.json`, server-pushed enable flag + curation filter honored via `applyServerStreams`. Server curates entries into the audit Events tab. |
| 7 | Process inventory (`processInventory` stream, gated on `processes` stream = agent): gopsutil enumeration aggregated by program name, current-state full-replace into the asset Services tab's *Include processes* view. |
| 7b | Per-pinned-program CPU/RAM telemetry (`processTelemetry` stream, 1/min): instantaneous CPU via prime→sleep→read delta over the pinned PIDs, summed by name, into the AssetProcessSample time-series. Pinned set + log config delivered via `/config`'s `pinnedProcesses`. |
| 7c | Per-pinned-program log tailing (`processLog` stream): journald-by-`_COMM` (Linux, cursored) + cross-platform file-glob tailing (per-file byte offset; rotation-aware), per `pinnedProcesses[].logSource`/`logPathGlob`. Cursors in `processlog-cursors.json`; first run seeds at tail (no history dump). |
| 8 | Process control (Phase 4): service/unit resolution in the inventory collector (Linux `/proc/<pid>/cgroup` → `*.service`; Windows `tasklist /svc` → service short-name) sets `controllable`. `commandLoop` polls `GET /agents/commands`, executes via `systemctl <action> <unit>` (Linux) / `net stop|start` + `sc query` (Windows), and reports to `POST /agents/command-result`. Action + target re-validated agent-side (strict charset, exec-with-args — no shell). Operator-initiated only. |
