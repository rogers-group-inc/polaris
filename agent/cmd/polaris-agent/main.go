// Polaris Agent — pushes monitoring samples to Polaris over HTTPS with a
// pinned-leaf TLS handshake. Generic binary across deployments; per-install
// identity (server URL, cert pin, bearer) lives entirely in agent.conf.
//
// Lifecycle:
//
//  1. Load agent.conf. If no bearer is present, run /enroll using the
//     one-shot enrollment_token. On success, persist the bearer to
//     agent.conf and remove the enrollment_token.
//  2. Start the collect loop (response-time samples on a fixed interval).
//  3. Start the heartbeat loop (less frequent).
//  4. Run until SIGTERM. Graceful shutdown flushes the last in-flight
//     sample push, if any.
//
// Phase 3 ships steps 1+2+3 with one collector (response-time). Phases
// 4+5 add the SSH/WinRM install path (server side) and the rest of the
// collectors + the WebSocket pull side. Each phase is independently
// deployable; nothing in this binary's surface changes for the operator.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/polaris/agent/internal/collectors"
	"github.com/polaris/agent/internal/config"
	"github.com/polaris/agent/internal/scriptexec"
	"github.com/polaris/agent/internal/transport"
)

// verbose mirrors cfg.Verbose, set once in runAgent before the loops start.
// When true, the sample push paths emit the connect / send / validate /
// disconnect lifecycle lines. Read-only after startup so no syncing needed.
var verbose bool

// fmtFloatPtr / fmtU64Ptr / fmtIntPtr render the nil-able sample fields for
// the verbose log lines without panicking on a missing reading.
func fmtFloatPtr(p *float64) string {
	if p == nil {
		return "nil"
	}
	return fmt.Sprintf("%.1f", *p)
}

func fmtU64Ptr(p *uint64) string {
	if p == nil {
		return "nil"
	}
	return fmt.Sprintf("%d", *p)
}

func fmtIntPtr(p *int) string {
	if p == nil {
		return "nil"
	}
	return fmt.Sprintf("%d", *p)
}

// version is stamped at build time via -ldflags='-X main.version=<x>'.
// Default value is the literal contents of agent/VERSION at the moment
// of code-edit. Both `make all` (which reads VERSION via $(shell cat …))
// and the in-app build path (which reads it via Node's fs.readFile)
// stamp the same value here. `polaris-agent --version` reports it; the
// agent /heartbeat surfaces it server-side as ManagedAgent.agentVersion.
var version = "0.0.0-unstamped"

const (
	defaultResponseTimeIntervalSec = 60
	defaultHeartbeatIntervalSec    = 300
	// Telemetry default mirrors the server's tier-3 default for SNMP/REST
	// polled assets (60 s). System info (interfaces + storage) defaults
	// to 600 s — the OS readings change slowly and the full enumeration
	// has more overhead than a CPU snapshot.
	defaultTelemetryIntervalSec  = 60
	defaultInterfacesIntervalSec = 600
	defaultStorageIntervalSec    = 600
	// OS event-log poll cadence. The stream is opt-in (default OFF server-side)
	// so this only matters once an operator enables it; 60 s keeps fresh errors
	// flowing without hammering wevtutil/journalctl.
	defaultEventLogIntervalSec = 60
	// Process-inventory snapshot cadence. Heavier enumeration (every PID) +
	// current-state (no history), so a slower default than telemetry.
	defaultProcessInventoryIntervalSec = 300
	// Service-inventory snapshot cadence — current-state unit/service list,
	// same rhythm as the process inventory.
	defaultServiceInventoryIntervalSec = 300
	// Per-pinned-program CPU/RAM cadence — 60 s like host telemetry.
	defaultProcessTelemetryIntervalSec = 60
	// Per-pinned-program log-tail cadence — 60 s.
	defaultProcessLogIntervalSec = 60
	// Per-mapped-program connection-discovery cadence (Application Map) — 60 s,
	// riding the same per-minute rhythm as the pinned telemetry pass.
	defaultProcessConnectionsIntervalSec = 60
	// Process-control command poll cadence — 20 s (operator clicks Stop/Start/
	// Restart and expects it to act within seconds, not a minute).
	defaultCommandPollIntervalSec = 20
)

// ─── Loop pacing ───────────────────────────────────────────────────────────
//
// Every collection loop used to start in the same instant with a bare
// time.NewTicker, and several of them share a cadence: FOUR at 300 s
// (heartbeat, systemInfo, processInventory, serviceInventory) and FIVE at
// 60 s (telemetry, eventLog, processTelemetry, processLog,
// processConnections). A Go ticker keeps the phase it was created with, so
// those groups did not merely collide once at boot — they fired on the same
// tick for the life of the process, forever.
//
// That is visible from the other side of the network. On a two-core Windows
// host the 300 s boundary spawned `powershell -Command "Get-CimInstance
// Win32_Service"` and `tasklist /svc` at the same moment, which is most of a
// core-second, while the response-time probe — which times a /heartbeat
// round trip through this same process — was being measured. Both the CPU
// chart and the response-time chart grew a five-minute sawtooth that
// described the agent's own scheduling rather than the host.
//
// Two offsets fix it, and they fix different problems:
//
//   phase   Deterministic, per loop, from the table below. Spreads the loops
//           that share a cadence so the expensive ones cannot land together
//           ON THIS HOST. Deterministic rather than random so a given host
//           behaves the same across restarts and the spacing is testable.
//
//   jitter  Random, drawn ONCE per process and added to every loop equally
//           (so it slides the whole schedule without disturbing the phase
//           spacing). Spreads the FLEET, which the phase cannot: a bulk
//           deploy starts hundreds of agents within seconds of each other,
//           and with the phase alone every one of them would hit /samples on
//           the same wall-clock second of every minute, forever.
//
// The phases are capped inside one minute on purpose. A phase proportional
// to the interval would space the 300 s loops further apart, but it would
// also mean an operator who just installed the agent waits minutes for the
// first process list. A few seconds of separation is all the collision
// costs, so spreading the whole set across one minute buys the entire fix
// and the tab still fills in while they are looking at it.
//
// The phases are also what makes the separation PERMANENT. Every staggered
// cadence is a multiple of 60 s and every phase is inside [0, 60), so two
// loops stay exactly |phase_a - phase_b| seconds apart for the life of the
// process — their firing times can never converge. Add a cadence that is
// not a minute multiple, or give two loops the same phase, and the drift
// comes back on a period nobody will think to look for. pacing_test.go
// walks a simulated hour rather than trusting that reasoning.
//
// WHAT THE PHASES CANNOT DO — and it is worth knowing before leaning on
// them again. They stagger when a pass STARTS. They say nothing about how
// long it runs. On a single-vCPU VM every pass takes far longer than this
// table assumes, so a collector that started in its own slot is often still
// running seconds later, inside somebody else's. That is survivable for
// everything here except a MEASUREMENT: the host CPU reading used to be a
// 1-second window at phase 8, and a processConnections sweep from phase 57
// only had to overrun by 11 seconds to land in it and report the agent's own
// work as the host's load. The fix was to delete the window (see
// collectors/cputimes.go), not to move the phase — no arrangement of this
// table can hold a one-second hole open on a host where passes overrun.
// Never put a timing-sensitive measurement back behind a phase offset.

// loopPhaseSec is the deterministic per-loop offset, in seconds, applied to
// a loop's first fire and therefore to its ticker phase for the life of the
// process. Two rules, both pinned by pacing_test.go:
//
//   - every value is < 60, so it is shorter than the shortest cadence any
//     staggered loop runs at, and the agent is fully warmed up inside a
//     minute of install.
//   - loops that SHARE a default cadence are spread apart, and the two that
//     spawn a subprocess (processInventory's `tasklist`, serviceInventory's
//     PowerShell) are deliberately far from each other and from systemInfo.
//
// responseTime owns the zero mark alone. It measures a /heartbeat round
// trip through this very process, so it is the one thing every other loop
// has to get out of the way of — anything sharing its tick is being timed.
var loopPhaseSec = map[string]int{
	// Laid out across the minute in FIRING ORDER, not grouped by cadence.
	// Grouping by cadence is what the first attempt did, and it let a 60 s
	// loop and a 300 s loop two seconds apart slip through: every cadence
	// here is a multiple of 60, so a pair's spacing is whatever their phases
	// differ by, forever, regardless of which group they came from.
	"responseTime":       0,  // owns zero; everything else is measured around it
	"command":            2,  // 20 s poll, one cheap GET
	"heartbeat":          4,
	"telemetry":          8,  // cheap now: counter read + push, no sample window
	"systemInfo":         13, // full host enumeration
	"pathCheck":       16, // network-bound; see path_check.go
	"interfaces":         18,
	"storage":            22,
	"eventLog":           27, // journalctl / Get-WinEvent
	"processTelemetry":   32,
	"processLog":         37,
	"processInventory":   42, // spawns `tasklist /svc` on Windows
	"serviceInventory":   48, // spawns PowerShell + Get-CimInstance
	"serviceLog":         53,
	"processConnections": 57,
}

// maxLoopJitter bounds the per-process random slide. Twenty seconds is
// enough to smear a fleet across the server's ingest window without pushing
// any loop's first sample outside the minute the operator is watching.
const maxLoopJitter = 20 * time.Second

// loopJitter is drawn once, at package init, and shared by every loop.
//
// This leans on the global math/rand source being randomly seeded, which it
// has been since Go 1.20 — the whole point is that two hosts booting from
// the same image at the same second do NOT pick the same slide. If this ever
// runs somewhere that pins the seed (GODEBUG=randautoseed=0, or an older
// toolchain), every agent in the fleet lands on the same wall-clock second
// again and the phases below are all that is left. Nothing breaks; the
// server just sees the herd it used to.
var loopJitter = time.Duration(rand.Int63n(int64(maxLoopJitter)))

// loopStartDelay is the total wait before a loop's first fire: its phase
// plus this process's jitter, clamped so it can never reach a full interval
// (a 20 s command poll must not be delayed by a 45 s phase, and no loop
// should ever skip a whole cadence just to get in line).
func loopStartDelay(name string, interval time.Duration) time.Duration {
	d := time.Duration(loopPhaseSec[name])*time.Second + loopJitter
	if interval > 0 && d >= interval {
		d = d % interval
	}
	return d
}

// runLoop is the one shape every collection loop has: wait out this loop's
// start delay, optionally fire once, then tick forever. Centralised so a
// loop cannot be added back without a phase — the old bug was not that the
// offsets were wrong, it was that there were none.
//
// fireAtStart is false for the two loops whose startup work already ran
// inline at boot (heartbeat) or which have none (command).
func runLoop(ctx context.Context, name string, interval time.Duration, fireAtStart bool, fn func()) {
	if d := loopStartDelay(name, interval); d > 0 {
		select {
		case <-ctx.Done():
			return
		case <-time.After(d):
		}
	}
	if fireAtStart {
		fn()
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fn()
		}
	}
}

// intervalOr resolves a configured cadence in seconds to a Duration,
// falling back to the compiled default when agent.conf left it unset.
func intervalOr(configuredSec int, defaultSec int) time.Duration {
	if configuredSec > 0 {
		return time.Duration(configuredSec) * time.Second
	}
	return time.Duration(defaultSec) * time.Second
}

// ─── Server-pushed stream config (Phase 0 plumbing) ────────────────────────
//
// The agent historically ignored the /config `streams` map and ran every loop
// unconditionally. The opt-in eventLog stream changes that: it must honor the
// server's enabled flag + curation filter, delivered via /config and refreshed
// live on heartbeat-etag change and the WebSocket refresh-config frame.

type eventLogRuntimeCfg struct {
	enabled          bool
	minLevel         string
	channels         []string
	linuxMinPriority int
	maxPerPush       int
}

// processesRuntimeCfg holds the resolved processes-stream state from /config.
// The inventory + telemetry + log loops gate on `enabled`; `pinned` lists the
// operator-pinned programs (with log config) the telemetry/log loops collect;
// `mapped` lists the programs toggled for Application Map connection discovery
// (independent of `pinned` — mapped-only programs must not wake the
// telemetry/log loops, and vice versa).
type processesRuntimeCfg struct {
	enabled bool
	pinned  []transport.PinnedProcess
	mapped  []string
}

// servicesRuntimeCfg holds the resolved services-stream state from /config. The
// inventory loop gates on `enabled` (true whenever a live agent owns the host);
// `monitored` lists units pinned for per-unit journalctl tailing (Phase 2) and
// `mapped` lists units toggled for Application Map connection attribution
// (Phase 3).
type servicesRuntimeCfg struct {
	enabled   bool
	monitored []string
	mapped    []string
}

var (
	eventLogCfg      atomic.Value // eventLogRuntimeCfg
	processesCfg     atomic.Value // processesRuntimeCfg
	servicesCfg      atomic.Value // servicesRuntimeCfg
	cachedConfigETag atomic.Value // string
)

func loadEventLogCfg() eventLogRuntimeCfg {
	if v := eventLogCfg.Load(); v != nil {
		return v.(eventLogRuntimeCfg)
	}
	return eventLogRuntimeCfg{} // disabled until the first /config apply
}

func loadProcessesCfg() processesRuntimeCfg {
	if v := processesCfg.Load(); v != nil {
		return v.(processesRuntimeCfg)
	}
	return processesRuntimeCfg{} // disabled until the first /config apply
}

func loadServicesCfg() servicesRuntimeCfg {
	if v := servicesCfg.Load(); v != nil {
		return v.(servicesRuntimeCfg)
	}
	return servicesRuntimeCfg{} // disabled until the first /config apply
}

func loadConfigETag() string {
	if v := cachedConfigETag.Load(); v != nil {
		return v.(string)
	}
	return ""
}

// applyServerStreams stores the eventLog stream config from a /config response.
// Absent block → disabled. Idempotent; safe to call from multiple goroutines.
func applyServerStreams(resp *transport.ConfigResponse) {
	if resp == nil {
		return
	}
	cachedConfigETag.Store(resp.ETag)
	if s, ok := resp.Streams["eventLog"]; ok {
		eventLogCfg.Store(eventLogRuntimeCfg{
			enabled:          s.Enabled,
			minLevel:         s.MinLevel,
			channels:         s.WindowsChannels,
			linuxMinPriority: s.LinuxMinPriority,
			maxPerPush:       s.MaxPerPush,
		})
	} else {
		eventLogCfg.Store(eventLogRuntimeCfg{})
	}
	if s, ok := resp.Streams["processes"]; ok {
		processesCfg.Store(processesRuntimeCfg{enabled: s.Enabled, pinned: resp.PinnedProcesses, mapped: resp.MappedProcesses})
	} else {
		processesCfg.Store(processesRuntimeCfg{pinned: resp.PinnedProcesses, mapped: resp.MappedProcesses})
	}
	if s, ok := resp.Streams["services"]; ok {
		servicesCfg.Store(servicesRuntimeCfg{enabled: s.Enabled, monitored: resp.MonitoredServices, mapped: resp.MappedServices})
	} else {
		servicesCfg.Store(servicesRuntimeCfg{monitored: resp.MonitoredServices, mapped: resp.MappedServices})
	}
	// Path checks: the definition list IS the enable signal (an older
	// server sends none, so the loop idles). An explicit streams.pathCheck
	// {enabled:false} from a future server still switches it off.
	checks := resp.PathChecks
	if s, ok := resp.Streams["pathCheck"]; ok && !s.Enabled {
		checks = nil
	}
	pathCheckCfg.Store(pathCheckRuntimeCfg{checks: checks})
}

// refreshConfig fetches /config (using the cached ETag for a 304 short-circuit)
// and applies any change. Best-effort — a failure just means we keep the
// current config until the next refresh.
func refreshConfig(client *transport.Client) {
	resp, err := client.FetchConfig(loadConfigETag())
	if err != nil {
		if verbose {
			log.Printf("config refresh failed: %v", err)
		}
		return
	}
	if resp == nil {
		return // 304 — unchanged
	}
	applyServerStreams(resp)
}

func main() {
	confPath := flag.String("conf", config.DefaultPath(), "path to agent.conf")
	showVersion := flag.Bool("version", false, "print the agent version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	// On Windows, the binary may be launched by the Service Control Manager
	// (sc.exe / Start-Service) rather than from a console. tryRunAsWindowsService
	// detects that case via svc.IsWindowsService and hands off to the SCM
	// dispatcher (which calls runAgent from inside its Execute method).
	// On non-Windows or when run from a console, the stub returns false and
	// we fall through to the standard signal-driven main loop. See
	// service_windows.go for the Windows-only handler implementation.
	if tryRunAsWindowsService(*confPath) {
		return
	}

	ctx, cancel := signalContext()
	defer cancel()
	runAgent(ctx, *confPath)
}

// runAgent is the shared agent runtime — loads config, enrolls if needed,
// starts every collect / heartbeat / WS goroutine, and blocks on ctx until
// the caller cancels it. Callable from both main() (console / Unix daemon
// path) and the Windows Service handler's Execute() (under SCM).
func runAgent(ctx context.Context, confPath string) {
	cfg, err := config.Load(confPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	if err := cfg.Validate(); err != nil {
		log.Fatalf("invalid config: %v", err)
	}

	client := transport.NewClient(cfg.ServerURL, cfg.Pins(), cfg.BearerToken)
	// Stamp the ldflag-set version into the client so /enroll and
	// /heartbeat report the version this binary was built at.
	client.AgentVersion = version
	// Effective capabilities (Linux; "" elsewhere) — heartbeat reports them so
	// the server renders the VERIFIED privilege state, catching units that
	// grant less than the requested tier (the SYS_PTRACE-only regression).
	// Read once: caps are fixed for the life of the process.
	client.CapEff = collectors.SelfCapEff()

	// Latch verbose lifecycle logging from agent.conf. Diagnostic only —
	// off by default; an operator sets `verbose = true` to trace the
	// telemetry round-trip on a single host.
	verbose = cfg.Verbose
	if verbose {
		log.Printf("verbose logging enabled — tracing sample push lifecycle to %s", client.BaseURL())
	}

	// Step 1: enroll if we don't have a bearer yet.
	if cfg.BearerToken == "" {
		if err := enroll(cfg, client); err != nil {
			log.Fatalf("enrollment failed: %v", err)
		}
	}

	// Step 2 + 3 + 4: three independent loops.
	//   - responseTimeLoop pushes samples on a fixed interval.
	//   - heartbeatLoop bumps lastSeenAt + reads any config etag change.
	//   - wsLoop holds the outbound WebSocket open for on-demand probes.
	// Each runs on its own goroutine so a stall in one doesn't starve
	// the others (a probe-now stuck behind a hung-host check would
	// silently block heartbeats otherwise).
	go responseTimeLoop(ctx, cfg, client)
	go heartbeatLoop(ctx, cfg, client)
	go telemetryLoop(ctx, cfg, client)
	go interfacesLoop(ctx, cfg, client)
	go storageLoop(ctx, cfg, client)
	go systemInfoLoop(ctx, cfg, client)
	go eventLogLoop(ctx, cfg, client)
	go processInventoryLoop(ctx, cfg, client)
	go serviceInventoryLoop(ctx, cfg, client)
	go serviceLogLoop(ctx, cfg, client)
	go processTelemetryLoop(ctx, cfg, client)
	go processLogLoop(ctx, cfg, client)
	go processConnectionsLoop(ctx, cfg, client)
	go pathCheckLoop(ctx, cfg, client)
	go commandLoop(ctx, cfg, client)
	go wsLoop(ctx, cfg, client)

	<-ctx.Done()
	log.Println("Polaris Agent: shutting down")
}

// enroll posts the one-shot token to /api/v1/agents/enroll, persists the
// returned bearer, and updates the in-memory client. Mutates cfg in place.
func enroll(cfg *config.Config, client *transport.Client) error {
	if cfg.EnrollmentToken == "" {
		return errAndExit("no enrollment_token in agent.conf — has /enroll already succeeded?")
	}
	hostname, _ := os.Hostname()
	resp, err := client.Enroll(&transport.EnrollRequest{
		EnrollmentToken:           cfg.EnrollmentToken,
		Hostname:                  hostname,
		ServerCertFingerprintSeen: cfg.CertFingerprint,
	})
	if err != nil {
		return err
	}
	log.Printf("enrolled — assetId=%s", resp.AssetID)

	cfg.BearerToken = resp.Bearer
	cfg.EnrollmentToken = "" // one-shot is now consumed
	cfg.AgentID = resp.AssetID
	if err := cfg.Save(); err != nil {
		return errAndExit("enrollment succeeded but persisting agent.conf failed: " + err.Error())
	}
	client.SetBearer(resp.Bearer)
	return nil
}

func responseTimeLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	runLoop(ctx, "responseTime", intervalOr(cfg.ResponseTimeIntervalSec, defaultResponseTimeIntervalSec), true, func() {
		pushOne(client)
	})
}

func pushOne(client *transport.Client) {
	// Time the round-trip from agent to Polaris via a /heartbeat ping —
	// that's what operators actually want to know ("how reachable is
	// this host's path to Polaris right now"), not a process-local
	// liveness noop. Heartbeat is the right probe target: bearer-gated,
	// cheap server-side, runs through the same pinned TLS transport
	// the rest of the agent uses (so a TLS / cert / firewall failure
	// surfaces the same way real traffic would).
	sample := collectors.ResponseTimeOnce(func() error {
		_, err := client.Heartbeat()
		return err
	})
	resp, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "responseTime",
		Samples: []*transport.ResponseTimeSample{sample},
	})
	if err != nil {
		// Best-effort logging — repeated failures should be visible in
		// the host's journal but mustn't crash the agent (transient 5xx
		// is normal during Polaris restart).
		log.Printf("push responseTime sample: %v", err)
		return
	}
	if verbose {
		log.Printf("responseTime sent: success=%v rttMs=%s -> accepted=%d rejected=%d",
			sample.Success, fmtIntPtr(sample.ResponseTimeMs), resp.Accepted, resp.Rejected)
	}
}

func heartbeatLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	// These two are the one thing that must NOT wait for a phase offset.
	// The immediate heartbeat is how the UI learns the host is alive within
	// seconds of install, and refreshConfig is what tells the opt-in streams
	// (eventLog, processes) whether they are enabled — every other loop is
	// downstream of it, so delaying it would delay the whole agent's first
	// useful tick rather than spreading anything out.
	_, _ = client.Heartbeat()
	refreshConfig(client)

	// The recurring half takes its phase like everything else. Sharing the
	// 300 s cadence with systemInfo, processInventory and serviceInventory is
	// exactly the pile-up the offsets exist to break up.
	runLoop(ctx, "heartbeat", intervalOr(cfg.HeartbeatIntervalSec, defaultHeartbeatIntervalSec), false, func() {
		hb, err := client.Heartbeat()
		if err != nil {
			log.Printf("heartbeat: %v", err)
			return
		}
		if hb != nil && hb.ConfigETag != "" && hb.ConfigETag != loadConfigETag() {
			refreshConfig(client)
		}
	})
}

// telemetryLoop pushes a CPU+memory+temperatures sample on its own
// cadence (default 60 s, configurable via telemetry_interval_sec in
// agent.conf). The CPU figure covers the whole gap between two passes —
// the collector reads cumulative counters and never blocks — so THIS
// LOOP'S CADENCE IS THE AVERAGING WINDOW: lengthen telemetry_interval_sec
// and the chart smooths out, shorten it and it sharpens.
func telemetryLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	runLoop(ctx, "telemetry", intervalOr(cfg.TelemetryIntervalSec, defaultTelemetryIntervalSec), true, func() {
		pushTelemetryOne(client)
	})
}

func pushTelemetryOne(client *transport.Client) {
	sample := collectors.TelemetryOnce()
	if verbose {
		log.Printf("connecting to server (%s)", client.BaseURL())
		log.Printf("sending telemetry: cpuPct=%s memPct=%s memUsedBytes=%s memTotalBytes=%s temperatures=%d",
			fmtFloatPtr(sample.CPUPct), fmtFloatPtr(sample.MemPct),
			fmtU64Ptr(sample.MemUsedBytes), fmtU64Ptr(sample.MemTotalBytes), len(sample.Temperatures))
	}
	resp, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "telemetry",
		Samples: []*transport.TelemetrySample{sample},
	})
	if err != nil {
		if verbose {
			log.Printf("server disconnected — telemetry send FAILED: %v", err)
		} else {
			log.Printf("push telemetry sample: %v", err)
		}
		return
	}
	if verbose {
		log.Printf("server connected — telemetry sent (1 sample)")
		log.Printf("validating telemetry was received correctly...")
		if resp.Accepted >= 1 && resp.Rejected == 0 {
			log.Printf("telemetry received correctly by server (accepted=%d rejected=%d)", resp.Accepted, resp.Rejected)
		} else {
			log.Printf("WARNING: telemetry NOT fully received (sent=1 accepted=%d rejected=%d)", resp.Accepted, resp.Rejected)
		}
		log.Printf("server disconnected (request complete)")
	}
}

// interfacesLoop pushes per-NIC counter samples (default 600 s).
// Slower cadence than telemetry because the full enumeration is
// heavier and interface state changes slowly compared to CPU load.
// Operators wanting sub-minute history on a specific NIC pin it via
// monitoredInterfaces and the server's fast-cadence path picks it up.
func interfacesLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	runLoop(ctx, "interfaces", intervalOr(cfg.InterfacesIntervalSec, defaultInterfacesIntervalSec), true, func() {
		pushInterfacesOne(client)
	})
}

// collectionTimeout is the maximum time we allow an OS-level collector
// (StorageOnce, InterfacesOnce) to run before abandoning it. These
// collectors call statfs()/ioctl() syscalls that can block indefinitely
// on a hung filesystem or stalled kernel subsystem — without this guard
// the loop goroutine freezes and stops sending all subsequent samples.
// The spawned sub-goroutine leaks on timeout but will eventually unblock
// when the kernel gives up; the loop itself continues to the next tick.
const collectionTimeout = 30 * time.Second

func pushInterfacesOne(client *transport.Client) {
	type res struct{ s []*transport.InterfaceSample }
	ch := make(chan res, 1)
	go func() { ch <- res{collectors.InterfacesOnce()} }()
	var r res
	select {
	case r = <-ch:
	case <-time.After(collectionTimeout):
		log.Printf("push interfaces samples: collector timed out after %.0fs", collectionTimeout.Seconds())
		return
	}
	if len(r.s) == 0 {
		if verbose {
			log.Printf("interfaces: collector returned 0 rows — nothing to send")
		}
		return
	}
	resp, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "interfaces",
		Samples: r.s,
	})
	if err != nil {
		log.Printf("push interfaces samples: %v", err)
		return
	}
	if verbose {
		log.Printf("interfaces sent: rows=%d -> accepted=%d rejected=%d", len(r.s), resp.Accepted, resp.Rejected)
	}
}

// storageLoop pushes per-mountpoint usage samples (default 600 s).
// disk.Usage can block briefly on a sluggish filesystem; gopsutil's
// Partitions(false) filters out the network mounts and pseudo-fs that
// most often cause those stalls.
func storageLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	runLoop(ctx, "storage", intervalOr(cfg.StorageIntervalSec, defaultStorageIntervalSec), true, func() {
		pushStorageOne(client)
	})
}

func pushStorageOne(client *transport.Client) {
	type res struct{ s []*transport.StorageSample }
	ch := make(chan res, 1)
	go func() { ch <- res{collectors.StorageOnce()} }()
	var r res
	select {
	case r = <-ch:
	case <-time.After(collectionTimeout):
		log.Printf("push storage samples: collector timed out after %.0fs", collectionTimeout.Seconds())
		return
	}
	if len(r.s) == 0 {
		if verbose {
			log.Printf("storage: collector returned 0 rows — nothing to send")
		}
		return
	}
	resp, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "storage",
		Samples: r.s,
	})
	if err != nil {
		log.Printf("push storage samples: %v", err)
		return
	}
	if verbose {
		log.Printf("storage sent: rows=%d -> accepted=%d rejected=%d", len(r.s), resp.Accepted, resp.Rejected)
	}
}

// eventLogLoop ships curated OS event-log entries when the server has enabled
// the eventLog stream for this asset. The loop goroutine always starts but
// stays idle (pushEventLogOne returns early) until the server flips enabled —
// so toggling collection on/off takes effect live via the heartbeat/WS config
// refresh, no agent restart needed. Default cadence 60 s; agent.conf can
// override via event_log_interval_sec.
func eventLogLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	stateDir := filepath.Dir(cfg.Path())
	runLoop(ctx, "eventLog", intervalOr(cfg.EventLogIntervalSec, defaultEventLogIntervalSec), true, func() {
		pushEventLogOne(client, stateDir)
	})
}

func pushEventLogOne(client *transport.Client, stateDir string) {
	ec := loadEventLogCfg()
	if !ec.enabled {
		return // stream off — nothing to collect
	}
	filter := collectors.EventLogFilter{
		MinLevel:         ec.minLevel,
		Channels:         ec.channels,
		LinuxMinPriority: ec.linuxMinPriority,
		MaxPerPush:       ec.maxPerPush,
	}
	// Guard the OS collector with the shared 30 s timeout — wevtutil /
	// journalctl can stall on a wedged subsystem; the spawned goroutine leaks
	// on timeout but the loop continues (same trade-off as interfaces/storage).
	type res struct{ s []*transport.EventLogSample }
	ch := make(chan res, 1)
	go func() { ch <- res{collectors.EventLogOnce(stateDir, filter)} }()
	var r res
	select {
	case r = <-ch:
	case <-time.After(collectionTimeout):
		log.Printf("push eventLog samples: collector timed out after %.0fs", collectionTimeout.Seconds())
		return
	}
	if len(r.s) == 0 {
		return // no new entries — normal, send nothing
	}
	resp, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "eventLog",
		Samples: r.s,
	})
	if err != nil {
		log.Printf("push eventLog samples: %v", err)
		return
	}
	if verbose {
		log.Printf("eventLog sent: rows=%d -> accepted=%d rejected=%d", len(r.s), resp.Accepted, resp.Rejected)
	}
}

// processInventoryLoop ships the current-state process inventory (one row per
// program, aggregated by name) when the server has resolved the processes
// stream to "agent". Like eventLog, the goroutine always starts but stays idle
// until the server enables the stream — toggling takes effect live via the
// config refresh. Default cadence 300 s (process_inventory_interval_sec in
// agent.conf overrides). Sends an empty list too, so unpinning the last process
// and stopping a program clears stale inventory rows server-side.
func processInventoryLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	runLoop(ctx, "processInventory", intervalOr(cfg.ProcessInventoryIntervalSec, defaultProcessInventoryIntervalSec), true, func() {
		pushProcessInventoryOne(client)
	})
}

func pushProcessInventoryOne(client *transport.Client) {
	if !loadProcessesCfg().enabled {
		return // processes stream not resolved to agent — nothing to collect
	}
	type res struct{ s []*transport.ProcessSample }
	ch := make(chan res, 1)
	go func() { ch <- res{collectors.ProcessInventoryOnce()} }()
	var r res
	select {
	case r = <-ch:
	case <-time.After(collectionTimeout):
		log.Printf("push processInventory samples: collector timed out after %.0fs", collectionTimeout.Seconds())
		return
	}
	if r.s == nil {
		return // collector failed to read the process table — skip (don't wipe inventory)
	}
	resp, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "processInventory",
		Samples: r.s,
	})
	if err != nil {
		log.Printf("push processInventory samples: %v", err)
		return
	}
	if verbose {
		log.Printf("processInventory sent: rows=%d -> accepted=%d rejected=%d", len(r.s), resp.Accepted, resp.Rejected)
	}
}

// serviceInventoryLoop pushes the current-state systemd unit / Windows service
// list on a fixed cadence (full-replace server-side). Gated on the services
// stream being enabled (true whenever a live agent owns the host).
func serviceInventoryLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	runLoop(ctx, "serviceInventory", intervalOr(cfg.ServiceInventoryIntervalSec, defaultServiceInventoryIntervalSec), true, func() {
		pushServiceInventoryOne(client)
	})
}

func pushServiceInventoryOne(client *transport.Client) {
	if !loadServicesCfg().enabled {
		if verbose {
			log.Printf("serviceInventory: stream disabled by server config — skipping")
		}
		return // services stream not enabled — nothing to collect
	}
	type res struct{ s []*transport.ServiceSample }
	ch := make(chan res, 1)
	go func() { ch <- res{collectors.ServiceInventoryOnce()} }()
	var r res
	select {
	case r = <-ch:
	case <-time.After(collectionTimeout):
		log.Printf("push serviceInventory samples: collector timed out after %.0fs", collectionTimeout.Seconds())
		return
	}
	if r.s == nil {
		// No service manager, or enumeration failed (the collector logs the
		// specific reason). Skip rather than push an empty set — a full-replace
		// with zero rows would wipe the asset's inventory server-side.
		if verbose {
			log.Printf("serviceInventory: collector returned no data — skipping (inventory left unchanged)")
		}
		return
	}
	resp, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "serviceInventory",
		Samples: r.s,
	})
	if err != nil {
		log.Printf("push serviceInventory samples: %v", err)
		return
	}
	if verbose {
		log.Printf("serviceInventory sent: rows=%d -> accepted=%d rejected=%d", len(r.s), resp.Accepted, resp.Rejected)
	}
}

// processTelemetryLoop samples CPU/RAM for the operator-pinned programs once a
// minute (Feature C). Gated on the processes stream resolving to agent AND at
// least one pinned program; otherwise idle.
func processTelemetryLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	runLoop(ctx, "processTelemetry", intervalOr(cfg.ProcessTelemetryIntervalSec, defaultProcessTelemetryIntervalSec), true, func() {
		pushProcessTelemetryOne(client)
	})
}

func pushProcessTelemetryOne(client *transport.Client) {
	pc := loadProcessesCfg()
	if !pc.enabled || len(pc.pinned) == 0 {
		return
	}
	names := make([]string, 0, len(pc.pinned))
	for _, p := range pc.pinned {
		names = append(names, p.Name)
	}
	type res struct {
		s []*transport.ProcessTelemetrySample
	}
	ch := make(chan res, 1)
	go func() { ch <- res{collectors.ProcessTelemetryOnce(names)} }()
	var r res
	select {
	case r = <-ch:
	case <-time.After(collectionTimeout):
		log.Printf("push processTelemetry samples: collector timed out after %.0fs", collectionTimeout.Seconds())
		return
	}
	if len(r.s) == 0 {
		return
	}
	resp, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "processTelemetry",
		Samples: r.s,
	})
	if err != nil {
		log.Printf("push processTelemetry samples: %v", err)
		return
	}
	if verbose {
		log.Printf("processTelemetry sent: rows=%d -> accepted=%d rejected=%d", len(r.s), resp.Accepted, resp.Rejected)
	}
}

// processLogLoop tails logs for the operator-pinned programs (Feature C).
// Gated on the processes stream resolving to agent AND >=1 pinned program.
func processLogLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	stateDir := filepath.Dir(cfg.Path())
	runLoop(ctx, "processLog", intervalOr(cfg.ProcessLogIntervalSec, defaultProcessLogIntervalSec), true, func() {
		pushProcessLogOne(client, stateDir)
	})
}

func pushProcessLogOne(client *transport.Client, stateDir string) {
	pc := loadProcessesCfg()
	if !pc.enabled || len(pc.pinned) == 0 {
		return
	}
	type res struct{ s []*transport.ProcessLogSample }
	ch := make(chan res, 1)
	go func() { ch <- res{collectors.ProcessLogOnce(stateDir, pc.pinned, 0)} }()
	var r res
	select {
	case r = <-ch:
	case <-time.After(collectionTimeout):
		log.Printf("push processLog samples: collector timed out after %.0fs", collectionTimeout.Seconds())
		return
	}
	if len(r.s) == 0 {
		return
	}
	resp, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "processLog",
		Samples: r.s,
	})
	if err != nil {
		log.Printf("push processLog samples: %v", err)
		return
	}
	if verbose {
		log.Printf("processLog sent: rows=%d -> accepted=%d rejected=%d", len(r.s), resp.Accepted, resp.Rejected)
	}
}

// serviceLogLoop tails journalctl for the operator-pinned UNITS (Phase 2,
// service dimension). Gated on the services stream being enabled AND >=1 pinned
// unit (monitoredServices). Rides the process-log cadence (60s).
func serviceLogLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	stateDir := filepath.Dir(cfg.Path())
	runLoop(ctx, "serviceLog", intervalOr(cfg.ProcessLogIntervalSec, defaultProcessLogIntervalSec), true, func() {
		pushServiceLogOne(client, stateDir)
	})
}

func pushServiceLogOne(client *transport.Client, stateDir string) {
	sc := loadServicesCfg()
	if !sc.enabled || len(sc.monitored) == 0 {
		return
	}
	type res struct{ s []*transport.ServiceLogSample }
	ch := make(chan res, 1)
	go func() { ch <- res{collectors.ServiceLogOnce(stateDir, sc.monitored, 0)} }()
	var r res
	select {
	case r = <-ch:
	case <-time.After(collectionTimeout):
		log.Printf("push serviceLog samples: collector timed out after %.0fs", collectionTimeout.Seconds())
		return
	}
	if len(r.s) == 0 {
		return
	}
	resp, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "serviceLog",
		Samples: r.s,
	})
	if err != nil {
		log.Printf("push serviceLog samples: %v", err)
		return
	}
	if verbose {
		log.Printf("serviceLog sent: rows=%d -> accepted=%d rejected=%d", len(r.s), resp.Accepted, resp.Rejected)
	}
}

// processConnectionsLoop collects listening ports + outbound/inbound peers for
// the operator-MAPPED programs once a minute (Application Map). Gated on the
// processes stream resolving to agent AND at least one mapped program.
func processConnectionsLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	// No agent.conf knob for this one — it rides the compiled default.
	runLoop(ctx, "processConnections", intervalOr(0, defaultProcessConnectionsIntervalSec), true, func() {
		pushProcessConnectionsOne(client)
	})
}

func pushProcessConnectionsOne(client *transport.Client) {
	pc := loadProcessesCfg()
	sc := loadServicesCfg()
	// Collect when the operator mapped at least one program (by name) OR one
	// unit (mappedServices, Phase 3). Independent gates — a unit can be mapped
	// without pinning its backing program and vice versa.
	if len(pc.mapped) == 0 && len(sc.mapped) == 0 {
		return
	}
	type res struct {
		s []*transport.ProcessConnectionSample
	}
	ch := make(chan res, 1)
	go func() { ch <- res{collectors.ProcessConnectionsOnce(pc.mapped, sc.mapped)} }()
	var r res
	select {
	case r = <-ch:
	case <-time.After(collectionTimeout):
		log.Printf("push processConnections samples: collector timed out after %.0fs", collectionTimeout.Seconds())
		return
	}
	// Zero rows → no push: absence never deletes server-side (rows age out),
	// so an empty scrape has nothing to say.
	if len(r.s) == 0 {
		return
	}
	resp, err := client.PushSamples(&transport.SamplesBody{
		Stream:  "processConnections",
		Samples: r.s,
	})
	if err != nil {
		log.Printf("push processConnections samples: %v", err)
		return
	}
	if verbose {
		log.Printf("processConnections sent: rows=%d -> accepted=%d rejected=%d", len(r.s), resp.Accepted, resp.Rejected)
	}
}

// commandLoop polls for operator-issued process-control commands and executes
// them via the OS service manager (Phase 4). The server only ever queues a
// command for a resolved, controllable service/unit; the agent re-validates the
// action + target before acting and reports the outcome. No config gate — the
// poll is cheap and the server returns commands only for this agent.
func commandLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	runLoop(ctx, "command", intervalOr(cfg.CommandPollIntervalSec, defaultCommandPollIntervalSec), false, func() {
		pollAndRunCommands(client)
	})
}

func pollAndRunCommands(client *transport.Client) {
	cmds, err := client.FetchCommands()
	if err != nil {
		if verbose {
			log.Printf("command poll failed: %v", err)
		}
		return
	}
	for _, c := range cmds {
		switch c.Action {
		case "run_script":
			runScriptCommand(client, c)
		default:
			// The agent only accepts run_script. Process/service start/stop/
			// restart control was removed (Satellite-posture change), so a
			// stop/start/restart action — or anything else a newer/stale server
			// queued — is refused explicitly instead of silently dropped.
			if rerr := client.ReportCommandResult(c.ID, false, "agent does not support action \""+c.Action+"\" (process/service control was removed)", ""); rerr != nil {
				log.Printf("command result report failed (id=%s): %v", c.ID, rerr)
			}
			log.Printf("unsupported command action %q refused (id=%s)", c.Action, c.ID)
		}
	}
}

// runScriptCommand executes one server-pushed automation script via the
// scriptexec sandbox (sha256-verified, temp file, timeout, output caps) and
// reports status + exit code + captured output. See internal/scriptexec for
// the security posture.
func runScriptCommand(client *transport.Client, c transport.Command) {
	payload, err := scriptexec.ParsePayload(c.Payload)
	if err != nil {
		if rerr := client.ReportCommandResultFull(c.ID, false, err.Error(), "failed", nil, "", ""); rerr != nil {
			log.Printf("command result report failed (id=%s): %v", c.ID, rerr)
		}
		log.Printf("run_script %s refused: %v", c.Target, err)
		return
	}
	res := scriptexec.Run(payload)
	success := res.Status == "succeeded"
	var exitCode *int
	if res.ExitCode >= 0 {
		exitCode = &res.ExitCode
	}
	errMsg := ""
	if !success {
		errMsg = res.Stderr
		if len(errMsg) > 1024 {
			errMsg = errMsg[:1024]
		}
	}
	if rerr := client.ReportCommandResultFull(c.ID, success, errMsg, res.Status, exitCode, res.Stdout, res.Stderr); rerr != nil {
		log.Printf("command result report failed (id=%s): %v", c.ID, rerr)
	}
	log.Printf("run_script: %s -> %s (exit=%d)", c.Target, res.Status, res.ExitCode)
}

// systemInfoLoop pushes host identity (hostname / OS / vendor / model
// / serial) on the heartbeat cadence (default 300 s). Host identity
// doesn't change between firmware updates, so most pushes are no-ops
// server-side (same observed blob → same projection → no Asset write).
// Cheaper than its own cadence + matches the operator's intuition
// that "agent is alive AND I know what it is" is one signal.
func systemInfoLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	runLoop(ctx, "systemInfo", intervalOr(cfg.HeartbeatIntervalSec, defaultHeartbeatIntervalSec), true, func() {
		pushSystemInfoOne(client)
	})
}

func pushSystemInfoOne(client *transport.Client) {
	info := collectors.SystemInfoOnce(version)
	body := &transport.SystemInfoBody{
		Hostname:      info.Hostname,
		OS:            info.OS,
		OSVersion:     info.OSVersion,
		KernelVersion: info.KernelVersion,
		KernelArch:    info.KernelArch,
		Manufacturer:  info.Manufacturer,
		Model:         info.Model,
		SerialNumber:  info.SerialNumber,
		BiosVersion:   info.BiosVersion,
		PrimaryMAC:    info.PrimaryMAC,
		PrimaryIP:     info.PrimaryIP,
		AgentVersion:  info.AgentVersion,
	}
	if err := client.PushSystemInfo(body); err != nil {
		log.Printf("push system-info: %v", err)
	}
}

// wsLoop holds the outbound WebSocket to Polaris open. Server-pushed
// frames land in handleServerFrame: `probe-now-request` runs the relevant
// collector synchronously and writes a `probe-now-response` back through
// the same socket; `refresh-config` triggers a /config refetch via the
// HTTP transport.
func wsLoop(ctx context.Context, cfg *config.Config, client *transport.Client) {
	dialer, err := transport.NewWSDialer(cfg.ServerURL, cfg.Pins(), cfg.BearerToken)
	if err != nil {
		log.Printf("ws: dialer setup failed: %v", err)
		return
	}
	dialer.RunWithReconnect(ctx, func(_ context.Context, conn *transport.WSConn, f *transport.Frame) error {
		switch f.Type {
		case "hello":
			// Server says it accepted the upgrade. Nothing to do.
			return nil
		case "commands-pending":
			// Server enqueued a command (e.g. an automation script run) and is
			// nudging us to fetch it now instead of waiting for the ~20s command
			// poll. Run in a goroutine so we don't block the WS frame handler;
			// the server's atomic claim (pending→sent) means a concurrent poll
			// can't double-execute the same command.
			go pollAndRunCommands(client)
			return nil
		case "refresh-config":
			// Server is telling us something changed (operator edited
			// cadences, staged a cert pin, etc.). Best-effort refetch —
			// failure here just means we'll see the change at the next
			// normal poll.
			resp, err := client.FetchConfig("")
			if err != nil {
				log.Printf("ws: refresh-config: fetch failed: %v", err)
				return nil
			}
			// Apply any stream-config change (e.g. operator toggled the
			// eventLog stream or its filter) live without waiting for the
			// next heartbeat.
			applyServerStreams(resp)
			// Phase 2 dual-pin: if the server's pin set differs from what we
			// have on disk, save the new pin set and exit cleanly so systemd
			// cycles us with the updated agent.conf live. The reconnect
			// post-restart establishes new TLS with the updated pin set,
			// which is what lets the agent survive a cert rotation initiated
			// by the operator AFTER the staging push. See cross-cutting/
			// polaris-agent → "Cert pin rotation" in the polaris-agent skill (cross-cutting-polaris-agent.md).
			if resp != nil && len(resp.CertFingerprints) > 0 {
				if cfg.SetPins(resp.CertFingerprints) {
					if err := cfg.Save(); err != nil {
						log.Printf("ws: refresh-config: failed to save updated pin set: %v", err)
						return nil
					}
					log.Printf("ws: refresh-config: pin set updated (%d pins) — exiting for systemd restart",
						len(resp.CertFingerprints))
					os.Exit(0)
				}
			}
			return nil
		case "probe-now-request":
			// Operator clicked "Probe now" on the asset details page.
			// Run the appropriate collector synchronously and emit the
			// response frame keyed by request id.
			var payload struct {
				Stream string `json:"stream"`
			}
			_ = json.Unmarshal(f.Payload, &payload)
			var resp transport.ResponseTimeSample
			if payload.Stream == "responseTime" {
				resp = *collectors.ResponseTimeOnce(func() error {
					_, err := client.Heartbeat()
					return err
				})
			}
			resPayload, _ := json.Marshal(map[string]interface{}{
				"success":        resp.Success,
				"responseTimeMs": resp.ResponseTimeMs,
				"error":          resp.Error,
			})
			return conn.SendFrame(&transport.Frame{
				Type:    "probe-now-response",
				ID:      f.ID,
				Payload: resPayload,
			})
		default:
			log.Printf("ws: unrecognized frame type %q", f.Type)
			return nil
		}
	})
}

func signalContext() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	sigc := make(chan os.Signal, 1)
	signal.Notify(sigc, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigc
		cancel()
	}()
	return ctx, cancel
}

func errAndExit(msg string) error {
	log.Fatal(msg)
	return nil // unreached
}
