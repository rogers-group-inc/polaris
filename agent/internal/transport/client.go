// Package transport carries the four HTTP endpoints the agent talks to:
//
//	POST /api/v1/agents/enroll     — public; one-shot enrollment token → bearer
//	POST /api/v1/agents/samples    — bearer; bulk-write samples per stream
//	POST /api/v1/agents/heartbeat  — bearer; bump lastSeenAt + refresh version
//	GET  /api/v1/agents/config     — bearer; resolved cadences + ETag short-circuit
//
// One *http.Client with a pinned TLS transport is reused across all calls.
// The bearer is stamped into the Authorization header for everything except
// /enroll (which uses the body's enrollmentToken field instead).
package transport

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/polaris/agent/internal/pinned"
)

// Client wraps the Polaris HTTP surface. Construct one via NewClient and
// reuse it for the life of the agent process.
type Client struct {
	baseURL string
	bearer  string
	httpc   *http.Client

	// AgentVersion is reported on /enroll and /heartbeat so the server
	// can render "v0.1.0" badges on the asset details page.
	AgentVersion string

	// CapEff is the process's effective-capability bitmask as the raw hex
	// string from /proc/self/status (Linux; "" elsewhere), reported on
	// /heartbeat so the server can render the VERIFIED privilege state
	// rather than the tier requested at install time. Set once by main.go
	// at startup — capabilities can't change for the life of the process.
	CapEff string
}

// NewClient builds a Client that pins TLS to ANY fingerprint in certPins.
// The bearer can be empty at construction time — callers Enroll() first,
// then set the returned bearer via SetBearer(). Phase 2 dual-pin: pass
// cfg.Pins() (the full set); pre-Phase-2 callers can pass a one-element
// slice — VerifyPeerCertificate handles both shapes identically.
func NewClient(baseURL string, certPins []string, bearer string) *Client {
	tr := &http.Transport{
		TLSClientConfig:       pinned.TLSConfig(certPins),
		ResponseHeaderTimeout: 15 * time.Second,
		IdleConnTimeout:       90 * time.Second,
	}
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		bearer:  bearer,
		// AgentVersion is filled in by main.go from the ldflag-stamped
		// `version` constant before any call that emits it (/enroll,
		// /heartbeat). The fallback string here is what shows up if
		// main.go forgets to set it — defensive only.
		AgentVersion: "0.0.0-unstamped",
		httpc:        &http.Client{Transport: tr, Timeout: 30 * time.Second},
	}
}

// SetBearer swaps the token the client uses for Authorization headers.
// Called once after /enroll returns the long-lived bearer.
func (c *Client) SetBearer(b string) { c.bearer = b }

// BaseURL returns the normalized server base URL (no trailing slash). Used
// by the verbose lifecycle logging in main so the "connecting to server"
// line names the target.
func (c *Client) BaseURL() string { return c.baseURL }

// ─── Enroll ───────────────────────────────────────────────────────────

type EnrollRequest struct {
	EnrollmentToken           string `json:"enrollmentToken"`
	OsPlatform                string `json:"osPlatform"`
	Arch                      string `json:"arch"`
	AgentVersion              string `json:"agentVersion"`
	Hostname                  string `json:"hostname,omitempty"`
	ServerCertFingerprintSeen string `json:"serverCertFingerprintSeen"`
}

type EnrollResponse struct {
	Bearer     string `json:"bearer"`
	AssetID    string `json:"assetId"`
	ConfigETag string `json:"configEtag"`
}

// Enroll posts the one-shot enrollment token + the cert pin we observed
// during the TLS handshake. Server cross-checks against the pin baked
// into our ManagedAgent row at install time, atomically mints a
// long-lived bearer, and returns it. Caller MUST persist the bearer to
// agent.conf before any other call — losing it requires a Reinstall.
func (c *Client) Enroll(req *EnrollRequest) (*EnrollResponse, error) {
	req.AgentVersion = c.AgentVersion
	if req.OsPlatform == "" {
		req.OsPlatform = runtime.GOOS // "linux" | "darwin" | "windows"
	}
	if req.Arch == "" {
		req.Arch = runtime.GOARCH // "amd64" | "arm64"
	}
	var out EnrollResponse
	if err := c.do("POST", "/api/v1/agents/enroll", req, &out, false); err != nil {
		return nil, fmt.Errorf("enroll: %w", err)
	}
	return &out, nil
}

// ─── Samples ──────────────────────────────────────────────────────────

// ResponseTimeSample matches the server's ResponseTimeSampleSchema.
type ResponseTimeSample struct {
	Timestamp      string  `json:"timestamp,omitempty"` // RFC3339; server fills now() if empty
	Success        bool    `json:"success"`
	ResponseTimeMs *int    `json:"responseTimeMs,omitempty"` // pointer so we can send explicit null on failure
	Error          *string `json:"error,omitempty"`
	UptimeSec      *uint64 `json:"uptimeSec,omitempty"` // host uptime (sec); rides the probe path to Asset.lastUptimeSec + reboot detection
}

type SamplesBody struct {
	Stream  string      `json:"stream"` // "responseTime" | "telemetry" | "interfaces" | "storage"
	Samples interface{} `json:"samples"`
}

// TelemetrySample matches the server's TelemetrySampleSchema. cpuPct/memPct
// are 0..100 percentages; memUsedBytes/memTotalBytes are absolute bytes.
// Send one or the other (or both) — the server tolerates either shape.
// Temperatures is the per-sensor reading list when the OS exposes them
// (Linux /sys/class/thermal, lm-sensors on macOS, WMI on Windows).
//
// CPUCorePcts is the per-logical-core vector behind CPUPct (index = core id).
// It is agent-only — no other transport can break CPU down this way — and
// `omitempty` drops it entirely on a host that could not read it, which the
// server stores as null rather than as an empty core list.
//
// MemBuffersBytes / MemCachedBytes / MemFreeBytes are the bands
// MemUsedBytes is not; the four are reconciled by meminfo.go to sum exactly
// to MemTotalBytes. Swap is backing store and sums with nothing. All five are
// sent as a set or not at all.
type TelemetrySample struct {
	Timestamp       string                 `json:"timestamp,omitempty"`
	CPUPct          *float64               `json:"cpuPct,omitempty"`
	CPUCorePcts     []float64              `json:"cpuCorePcts,omitempty"`
	MemPct          *float64               `json:"memPct,omitempty"`
	MemUsedBytes    *uint64                `json:"memUsedBytes,omitempty"`
	MemTotalBytes   *uint64                `json:"memTotalBytes,omitempty"`
	MemBuffersBytes *uint64                `json:"memBuffersBytes,omitempty"`
	MemCachedBytes  *uint64                `json:"memCachedBytes,omitempty"`
	MemFreeBytes    *uint64                `json:"memFreeBytes,omitempty"`
	SwapUsedBytes   *uint64                `json:"swapUsedBytes,omitempty"`
	SwapTotalBytes  *uint64                `json:"swapTotalBytes,omitempty"`
	Temperatures    []TelemetryTemperature `json:"temperatures,omitempty"`
}

type TelemetryTemperature struct {
	SensorName string   `json:"sensorName"`
	Celsius    *float64 `json:"celsius"`
}

// InterfaceSample matches the server's InterfaceSampleSchema. One row per
// physical/virtual NIC the agent enumerates. Pointer counter fields so
// the server can distinguish "not reported" from "zero" — important for
// per-interval throughput derivation, which subtracts consecutive samples.
type InterfaceSample struct {
	Timestamp   string  `json:"timestamp,omitempty"`
	IfName      string  `json:"ifName"`
	AdminStatus *string `json:"adminStatus,omitempty"` // "up" | "down" | ...
	OperStatus  *string `json:"operStatus,omitempty"`
	SpeedBps    *uint64 `json:"speedBps,omitempty"`
	IPAddress   *string `json:"ipAddress,omitempty"`
	MACAddress  *string `json:"macAddress,omitempty"`
	InOctets    *uint64 `json:"inOctets,omitempty"`
	OutOctets   *uint64 `json:"outOctets,omitempty"`
	InErrors    *uint64 `json:"inErrors,omitempty"`
	OutErrors   *uint64 `json:"outErrors,omitempty"`
	IfType      *string `json:"ifType,omitempty"` // "physical" | "loopback" | "tunnel"
}

// StorageSample matches the server's StorageSampleSchema. One row per
// mountpoint; mountPath is the canonical path (e.g. "/", "/var", "C:").
type StorageSample struct {
	Timestamp  string  `json:"timestamp,omitempty"`
	MountPath  string  `json:"mountPath"`
	TotalBytes *uint64 `json:"totalBytes,omitempty"`
	UsedBytes  *uint64 `json:"usedBytes,omitempty"`
}

// EventLogSample matches the server's EventLogSampleSchema. One row per
// distinct OS event-log entry (Windows Event Log channel / Linux journald).
// Level is agent-normalized to "critical"|"error"|"warning"|"info"; Count
// collapses identical repeats within one poll. The host-side read cursor is
// NOT on the wire — it lives in a local state file.
type EventLogSample struct {
	Timestamp string  `json:"timestamp,omitempty"`
	Channel   string  `json:"channel"`
	Provider  *string `json:"provider,omitempty"`
	EventID   *int64  `json:"eventId,omitempty"`
	Level     string  `json:"level"`
	Message   string  `json:"message"`
	Count     int     `json:"count"`
}

// ProcessSample matches the server's ProcessSampleSchema. One row per program
// (aggregated by name across PIDs). Current-state inventory — the server
// full-replaces the asset's rows per push. cpuPct/memRssBytes are summed across
// instances. ServiceUnit is reserved for the Phase 4 control work (nil today).
type ProcessSample struct {
	Name          string   `json:"name"`
	InstanceCount int      `json:"instanceCount,omitempty"`
	CpuPct        *float64 `json:"cpuPct,omitempty"`
	MemRssBytes   *uint64  `json:"memRssBytes,omitempty"`
	ExePath       *string  `json:"exePath,omitempty"`
	Username      *string  `json:"username,omitempty"`
	StartedAt     *string  `json:"startedAt,omitempty"`
	ServiceUnit   *string  `json:"serviceUnit,omitempty"`
}

// ProcessTelemetrySample matches the server's ProcessTelemetrySampleSchema —
// per-pinned-program CPU/RAM, summed across the program's instances.
type ProcessTelemetrySample struct {
	Timestamp     string   `json:"timestamp,omitempty"`
	Name          string   `json:"name"`
	CpuPct        *float64 `json:"cpuPct,omitempty"`
	MemRssBytes   *uint64  `json:"memRssBytes,omitempty"`
	InstanceCount int      `json:"instanceCount,omitempty"`
}

// ProcessConnectionSample matches the server's ProcessConnectionSampleSchema —
// one socket fact for a MAPPED program (Application Map). Kind selects which
// fields are meaningful (listen: local*, outbound: remote*, inbound: remoteIp +
// localPort); the rest are omitted and the server fills sentinels.
type ProcessConnectionSample struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`  // listen | outbound | inbound
	Proto      string `json:"proto"` // tcp | udp
	LocalAddr  string `json:"localAddr,omitempty"`
	LocalPort  int    `json:"localPort,omitempty"`
	RemoteIp   string `json:"remoteIp,omitempty"`
	RemotePort int    `json:"remotePort,omitempty"`
	// Owning systemd unit / Windows service (Phase 3), when the PID's cgroup
	// resolved one — lets the server attribute the socket to a unit. "" when
	// unknown or the row came only via a mappedProcesses (by-name) pin.
	Unit string `json:"unit,omitempty"`
}

// ProcessLogSample matches the server's ProcessLogSampleSchema — one row per
// tailed log line for a pinned program.
type ProcessLogSample struct {
	Timestamp string  `json:"timestamp,omitempty"`
	Name      string  `json:"name"`
	Level     *string `json:"level,omitempty"`
	Message   string  `json:"message"`
	Source    *string `json:"source,omitempty"`
}

// ServiceSample matches the server's ServiceSampleSchema. One row per systemd
// unit (Linux) or Windows service (SCM). Current-state inventory — the server
// full-replaces the asset's rows per push (delete-replace). Platform selects
// the state vocabulary; the server derives `controllable` from it.
type ServiceSample struct {
	Unit         string  `json:"unit"`
	Platform     string  `json:"platform"` // "systemd" | "windows"
	DisplayName  *string `json:"displayName,omitempty"`
	LoadState    *string `json:"loadState,omitempty"`
	ActiveState  *string `json:"activeState,omitempty"`
	SubState     *string `json:"subState,omitempty"`
	EnabledState *string `json:"enabledState,omitempty"`
	MainPid      *int    `json:"mainPid,omitempty"`
	MainProcess  *string `json:"mainProcess,omitempty"`
	MemBytes     *uint64 `json:"memBytes,omitempty"`
}

// ServiceLogSample matches the server's ServiceLogSampleSchema — one journalctl
// line for a pinned unit (Phase 2). Same shape as ProcessLogSample with `unit`.
type ServiceLogSample struct {
	Timestamp string  `json:"timestamp,omitempty"`
	Unit      string  `json:"unit"`
	Level     *string `json:"level,omitempty"`
	Message   string  `json:"message"`
	Source    *string `json:"source,omitempty"`
}

type SamplesResponse struct {
	Accepted int `json:"accepted"`
	Rejected int `json:"rejected"`
}

// PushSamples POSTs one stream's worth of samples. The bearer-bound
// assetId is stamped server-side; we never send our own assetId on the
// wire. Returns the {accepted, rejected} counts the server reports.
func (c *Client) PushSamples(body *SamplesBody) (*SamplesResponse, error) {
	if c.bearer == "" {
		return nil, errors.New("PushSamples called without a bearer token — enroll first")
	}
	var out SamplesResponse
	if err := c.do("POST", "/api/v1/agents/samples", body, &out, true); err != nil {
		return nil, fmt.Errorf("samples: %w", err)
	}
	return &out, nil
}

// ─── Heartbeat ────────────────────────────────────────────────────────

type HeartbeatResponse struct {
	OK         bool   `json:"ok"`
	ConfigETag string `json:"configEtag"`
}

// ─── SystemInfo ───────────────────────────────────────────────────────

// SystemInfoBody mirrors the server's SystemInfoSchema. All fields
// optional; omitempty on the struct + the agent's "strip-blanks"
// pre-send pass keeps the wire compact.
type SystemInfoBody struct {
	Hostname      string `json:"hostname,omitempty"`
	OS            string `json:"os,omitempty"`
	OSVersion     string `json:"osVersion,omitempty"`
	KernelVersion string `json:"kernelVersion,omitempty"`
	KernelArch    string `json:"kernelArch,omitempty"`
	Manufacturer  string `json:"manufacturer,omitempty"`
	Model         string `json:"model,omitempty"`
	SerialNumber  string `json:"serialNumber,omitempty"`
	BiosVersion   string `json:"biosVersion,omitempty"`
	PrimaryMAC    string `json:"primaryMac,omitempty"`
	PrimaryIP     string `json:"primaryIp,omitempty"`
	AgentVersion  string `json:"agentVersion,omitempty"`
}

// PushSystemInfo POSTs the host identity blob. Server upserts the
// per-agent AssetSource row and re-projects the asset; same agent
// pushing the same blob is a no-op DB-side.
func (c *Client) PushSystemInfo(body *SystemInfoBody) error {
	if c.bearer == "" {
		return errors.New("PushSystemInfo called without a bearer token — enroll first")
	}
	var out struct {
		OK bool `json:"ok"`
	}
	if err := c.do("POST", "/api/v1/agents/system-info", body, &out, true); err != nil {
		return fmt.Errorf("system-info: %w", err)
	}
	return nil
}

// ─── Agent commands ───────────────────────────────────────────────────

// Command is one pending command from the server. The only supported action is
// "run_script" (an automation script run, whose spec rides Payload — see
// internal/scriptexec). Process/service start/stop/restart control was removed;
// any other action is refused by the agent.
type Command struct {
	ID      string          `json:"id"`
	Action  string          `json:"action"` // "run_script"
	Target  string          `json:"target"` // script name
	Payload json.RawMessage `json:"payload,omitempty"`
}

// FetchCommands polls for pending commands. The server marks them "sent" so a
// slow agent doesn't re-run them.
func (c *Client) FetchCommands() ([]Command, error) {
	if c.bearer == "" {
		return nil, errors.New("FetchCommands called without a bearer token — enroll first")
	}
	var out struct {
		Commands []Command `json:"commands"`
	}
	if err := c.do("GET", "/api/v1/agents/commands", nil, &out, true); err != nil {
		return nil, fmt.Errorf("commands: %w", err)
	}
	return out.Commands, nil
}

// ReportCommandResult posts the outcome of executing one command.
func (c *Client) ReportCommandResult(commandID string, success bool, errMsg, resultState string) error {
	return c.ReportCommandResultFull(commandID, success, errMsg, resultState, nil, "", "")
}

// ReportCommandResultFull is ReportCommandResult plus the run_script result
// fields (exit code + captured output, ≤64 KB each — scriptexec caps them).
// exitCode nil = unknown (refused / killed before exit).
func (c *Client) ReportCommandResultFull(commandID string, success bool, errMsg, resultState string, exitCode *int, stdout, stderr string) error {
	if c.bearer == "" {
		return errors.New("ReportCommandResult called without a bearer token — enroll first")
	}
	body := map[string]interface{}{"commandId": commandID, "success": success}
	if errMsg != "" {
		body["error"] = errMsg
	}
	if resultState != "" {
		body["resultState"] = resultState
	}
	if exitCode != nil {
		body["exitCode"] = *exitCode
	}
	if stdout != "" {
		body["stdout"] = stdout
	}
	if stderr != "" {
		body["stderr"] = stderr
	}
	var out struct {
		OK bool `json:"ok"`
	}
	if err := c.do("POST", "/api/v1/agents/command-result", body, &out, true); err != nil {
		return fmt.Errorf("command-result: %w", err)
	}
	return nil
}

// Heartbeat is the fallback the agent uses to bump lastSeenAt + refresh
// agentVersion when there's no live WebSocket. The returned ConfigETag
// lets the agent know whether it needs to refresh /config — when it
// matches the agent's cached etag we can skip the round-trip.
func (c *Client) Heartbeat() (*HeartbeatResponse, error) {
	if c.bearer == "" {
		return nil, errors.New("Heartbeat called without a bearer token — enroll first")
	}
	body := map[string]string{"agentVersion": c.AgentVersion}
	if c.CapEff != "" {
		body["capEff"] = c.CapEff
	}
	var out HeartbeatResponse
	if err := c.do("POST", "/api/v1/agents/heartbeat", body, &out, true); err != nil {
		return nil, fmt.Errorf("heartbeat: %w", err)
	}
	return &out, nil
}

// ─── Config ───────────────────────────────────────────────────────────

type StreamConfig struct {
	Enabled     bool `json:"enabled"`
	IntervalSec int  `json:"intervalSec"`
	TimeoutMs   int  `json:"timeoutMs"`
	// eventLog-only curation filter (other streams omit these). Delivered so
	// the agent collects only the channels/severity the operator wants. All
	// omitempty so the wire stays compact + older servers parse fine.
	MinLevel         string   `json:"minLevel,omitempty"`
	WindowsChannels  []string `json:"windowsChannels,omitempty"`
	LinuxMinPriority int      `json:"linuxMinPriority,omitempty"`
	MaxPerPush       int      `json:"maxPerPush,omitempty"`
}

// PinnedProcess is one operator-pinned program the agent should collect
// per-minute CPU/RAM + logs for (Feature C). LogSource = "auto" | "journald-unit"
// | "file-glob"; LogPathGlob is the operator-typed wildcard path (empty = auto).
type PinnedProcess struct {
	Name        string `json:"name"`
	LogSource   string `json:"logSource"`
	LogPathGlob string `json:"logPathGlob"`
}

type ConfigResponse struct {
	ETag      string                  `json:"etag"`
	Streams   map[string]StreamConfig `json:"streams"`
	Monitored bool                    `json:"monitored"`
	// Feature C — programs pinned for per-minute telemetry + log tailing.
	PinnedProcesses []PinnedProcess `json:"pinnedProcesses,omitempty"`
	// Application Map — programs toggled for connection discovery (listening
	// ports + outbound/inbound peers). Independent of PinnedProcesses: a
	// mapped-only program must not wake the telemetry/log loops. Absent on
	// older servers → the connections loop idles.
	MappedProcesses []string `json:"mappedProcesses,omitempty"`
	// Service dimension — units the operator pinned for per-unit journalctl
	// tailing (MonitoredServices; the serviceLog loop) and for connection
	// attribution on the Application Map (MappedServices). Absent on older
	// servers → both service loops idle.
	MonitoredServices []string `json:"monitoredServices,omitempty"`
	MappedServices    []string `json:"mappedServices,omitempty"`
	// Phase 2 dual-pin: the current set of acceptable leaf-cert SHA-256
	// fingerprints (canonical pin + any operator-staged additional pins).
	// Empty slice means "field not present" — older Phase 1 servers don't
	// emit this and the agent should leave its existing pin set untouched.
	CertFingerprints []string `json:"certFingerprints,omitempty"`
	// Agent-run connectivity checks this host is a source of (server ≥ the
	// connectivity release; empty below agent 0.21.0 or when the host runs
	// none). The list IS the enable signal — empty means the loop idles.
	ConnectivityChecks []ConnectivityCheckDef `json:"connectivityChecks,omitempty"`
}

// ─── Connectivity checks ───────────────────────────────────────────────────
//
// Hand-mirrored by the server: AgentCheckDef in
// src/services/connectivityCheckService.ts (the definition) and
// ConnectivitySampleSchema / ConnectivityTracerouteSchema in
// src/api/routes/agents.ts (the two sample streams). Rename a field here and
// the other side silently reads its zero value.

// ConnectivityBodyExpect is connectivityChecks[].expectBody.
type ConnectivityBodyExpect struct {
	Mode          string `json:"mode"` // contains | regex | exact
	Value         string `json:"value"`
	CaseSensitive bool   `json:"caseSensitive"`
}

// ConnectivityTracerouteDef is connectivityChecks[].traceroute. Zeros take the
// defaults (every 5th run, 30 hops, 3 probes, 1000 ms per probe).
type ConnectivityTracerouteDef struct {
	Enabled        bool `json:"enabled"`
	EveryNRuns     int  `json:"everyNRuns"`
	MaxHops        int  `json:"maxHops"`
	ProbesPerHop   int  `json:"probesPerHop"`
	ProbeTimeoutMs int  `json:"probeTimeoutMs"`
}

// ConnectivityCheckDef is one connectivityChecks[] entry from GET /agents/config.
type ConnectivityCheckDef struct {
	ID              string                    `json:"id"`
	Name            string                    `json:"name"`
	Kind            string                    `json:"kind"`   // http | https | tcp | icmp
	Target          string                    `json:"target"` // URL (http/https), host:port (tcp), host (icmp)
	IntervalSec     int                       `json:"intervalSec"`
	TimeoutMs       int                       `json:"timeoutMs"`
	ExpectStatus    string                    `json:"expectStatus"` // "" → any 2xx
	ExpectBody      *ConnectivityBodyExpect   `json:"expectBody"`
	VerifyTLS       bool                      `json:"verifyTls"`
	KeepBodyExcerpt bool                      `json:"keepBodyExcerpt"`
	Traceroute      ConnectivityTracerouteDef `json:"traceroute"`
	// sha256 of the definition server-side; rides inside the agent's own
	// definition hash, so an edit re-baselines the check.
	Revision string `json:"revision"`
}

// ConnectivitySample is one row of stream "connectivity" — one check run.
// Pointer fields are optional on the wire: "not measured" must never be sent
// as 0 (a 0 ms latency or a status of 0 is a reading, and a wrong one).
type ConnectivitySample struct {
	CheckID       string   `json:"checkId"`
	Timestamp     string   `json:"timestamp"` // RFC3339Nano UTC, run start
	OK            bool     `json:"ok"`
	LatencyMs     *float64 `json:"latencyMs,omitempty"`
	DNSMs         *float64 `json:"dnsMs,omitempty"`
	ConnectMs     *float64 `json:"connectMs,omitempty"`
	TLSMs         *float64 `json:"tlsMs,omitempty"`
	TTFBMs        *float64 `json:"ttfbMs,omitempty"`
	HTTPStatus    *int     `json:"httpStatus,omitempty"`
	BodyMatched   *bool    `json:"bodyMatched,omitempty"`
	BodySha256    string   `json:"bodySha256,omitempty"`
	BodyBytes     *int     `json:"bodyBytes,omitempty"`
	BodyExcerpt   string   `json:"bodyExcerpt,omitempty"`
	Error         string   `json:"error,omitempty"`
	ResolvedIP    string   `json:"resolvedIp,omitempty"`
	TLSNotAfter   string   `json:"tlsNotAfter,omitempty"`
	TLSIssuer     string   `json:"tlsIssuer,omitempty"`
	TracerouteRan bool     `json:"tracerouteRan"`
}

// ConnectivityHop is one TTL of a traceroute. IP "" = no reply at that TTL;
// RttMs has one entry per probe, -1 for a probe that timed out.
type ConnectivityHop struct {
	TTL   int       `json:"ttl"`
	IP    string    `json:"ip"`
	Rdns  string    `json:"rdns,omitempty"`
	RttMs []float64 `json:"rttMs"`
}

// ConnectivityTraceroute is one row of stream "connectivityTraceroute".
type ConnectivityTraceroute struct {
	CheckID       string            `json:"checkId"`
	Timestamp     string            `json:"timestamp"`
	DestinationIP string            `json:"destinationIp"`
	Complete      bool              `json:"complete"`
	Reason        string            `json:"reason"` // scheduled | transition
	Note          string            `json:"note,omitempty"`
	Hops          []ConnectivityHop `json:"hops"`
}

// FetchConfig pulls the resolved cadences + which streams are agent-mode.
// `ifNoneMatch` is the agent's cached etag — pass it through to short-
// circuit when nothing changed (server returns 304 → this function
// returns a nil *ConfigResponse and a nil error).
func (c *Client) FetchConfig(ifNoneMatch string) (*ConfigResponse, error) {
	if c.bearer == "" {
		return nil, errors.New("FetchConfig called without a bearer token — enroll first")
	}
	req, err := http.NewRequest("GET", c.baseURL+"/api/v1/agents/config", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.bearer)
	if ifNoneMatch != "" {
		req.Header.Set("If-None-Match", ifNoneMatch)
	}
	resp, err := c.httpc.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified {
		return nil, nil // unchanged — caller keeps cached config
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("config: status %d", resp.StatusCode)
	}
	var out ConfigResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("config: decode: %w", err)
	}
	return &out, nil
}

// ─── Internal HTTP helper ─────────────────────────────────────────────

func (c *Client) do(method, path string, body, out interface{}, withBearer bool) error {
	var rdr io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal: %w", err)
		}
		rdr = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, c.baseURL+path, rdr)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if withBearer {
		if c.bearer == "" {
			return errors.New("bearer required but unset")
		}
		req.Header.Set("Authorization", "Bearer "+c.bearer)
	}
	resp, err := c.httpc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		buf, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("status %d: %s", resp.StatusCode, strings.TrimSpace(string(buf)))
	}
	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return fmt.Errorf("decode: %w", err)
		}
	}
	return nil
}
