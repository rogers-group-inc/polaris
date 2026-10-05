// Package config reads the agent's runtime configuration from a single
// INI-style file: /var/lib/polaris-agent/agent.conf on Linux (writable
// via systemd's StateDirectory= so the agent can persist its bearer
// after /enroll — /etc/ is read-only under ProtectSystem=strict),
// /etc/polaris-agent/agent.conf on macOS,
// %ProgramData%\Polaris\agent\agent.conf on Windows.
//
// The file is generated server-side by agentInstallService at install time
// and is unique per install — the binary itself is generic across all
// Polaris deployments; per-install identity lives entirely here.
//
// Wire shape (intentionally tiny — no nested sections, no quoting rules):
//
//	server_url        = https://polaris.example.com:3000
//	cert_fingerprint  = sha256:ab12cd34...                       (legacy, single-pin)
//	cert_fingerprints = sha256:ab12cd34...,sha256:ef56gh78...    (Phase 2 dual-pin set)
//	bearer_token      = polaris_xK9rT2pQwL3mNs7v...
//	agent_id          = 7f2e9a1c-... (optional, used in WS subprotocol)
//	enrollment_token  = polaris_... (present until first /enroll succeeds; then removed)
//
// Pin set parsing: if `cert_fingerprints` is present, parse the
// comma-separated list and that's the pin set. Otherwise fall back to
// `cert_fingerprint` (single-pin agent.conf written by pre-Phase-2 installers).
// On Save() we always write BOTH keys so a downgrade to a pre-Phase-2 agent
// binary keeps working with the canonical pin.
//
// `bearer_token` is the long-lived bearer issued by /enroll. On a fresh
// install only `enrollment_token` is present; on first run the agent posts
// it to /api/v1/agents/enroll, receives a bearer, and rewrites the file
// with bearer_token populated and enrollment_token removed. From that
// point on the agent only needs server_url + cert_fingerprint + bearer_token.
package config

import (
	"bufio"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Config carries the values loaded from agent.conf. Mutated in-place when
// the agent enrolls (bearer fills in; enrollment empties); persisted via
// Save() to the same path the file was loaded from.
type Config struct {
	path string // absolute path; not stored in the file itself

	ServerURL       string
	CertFingerprint string // "sha256:<lowercase-hex>" — canonical / legacy single pin
	// Phase 2 dual-pin set. If non-empty, this REPLACES CertFingerprint for
	// pin verification. Always contains CertFingerprint as the first element
	// (canonical pin) plus any staged additional pins. Load() populates from
	// `cert_fingerprints` line if present, else from `cert_fingerprint`
	// (single-element). Save() writes both keys for downgrade safety.
	CertFingerprints []string
	AgentID          string
	BearerToken      string
	EnrollmentToken  string

	// Optional knobs — leave empty for defaults.
	ResponseTimeIntervalSec     int
	HeartbeatIntervalSec        int
	TelemetryIntervalSec        int
	InterfacesIntervalSec       int
	StorageIntervalSec          int
	EventLogIntervalSec         int
	ProcessInventoryIntervalSec int
	ProcessTelemetryIntervalSec int
	ProcessLogIntervalSec       int
	ServiceInventoryIntervalSec int
	// Installed-software cadence (default six hours, see main.go).
	SoftwareInventoryIntervalSec int
	CommandPollIntervalSec      int

	// Verbose turns on per-push lifecycle logging (connect / send / validate
	// / disconnect) for the sample streams. Diagnostic only — set
	// `verbose = true` in agent.conf. Default false so production agents
	// stay quiet (success paths normally log nothing).
	Verbose bool
}

// DefaultPath returns the canonical agent.conf path for the running OS.
// Operators with non-standard layouts override via the POLARIS_AGENT_CONF env.
func DefaultPath() string {
	if v := os.Getenv("POLARIS_AGENT_CONF"); v != "" {
		return v
	}
	switch runtime.GOOS {
	case "windows":
		base := os.Getenv("ProgramData")
		if base == "" {
			base = `C:\ProgramData`
		}
		return filepath.Join(base, "Polaris", "agent", "agent.conf")
	case "linux":
		// /var/lib/ rather than /etc/ — systemd's StateDirectory exposes
		// this path to the DynamicUser as writable; /etc/ is read-only
		// under ProtectSystem=strict so cfg.Save() after /enroll would
		// fail there and the agent would loop on the consumed token.
		return "/var/lib/polaris-agent/agent.conf"
	default: // darwin, others — launchd plist doesn't use ProtectSystem
		return "/etc/polaris-agent/agent.conf"
	}
}

// Load reads + parses the file at path. Missing keys are returned as empty
// strings; Validate() decides what's required for a given lifecycle stage.
func Load(path string) (*Config, error) {
	f, err := os.Open(path) //nolint:gosec // operator-controlled file path
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	defer f.Close()

	cfg := &Config{path: path}
	sc := bufio.NewScanner(f)
	lineNo := 0
	for sc.Scan() {
		lineNo++
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			return nil, fmt.Errorf("%s:%d: missing '='", path, lineNo)
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		switch key {
		case "server_url":
			cfg.ServerURL = val
		case "cert_fingerprint":
			cfg.CertFingerprint = strings.ToLower(val)
		case "cert_fingerprints":
			// Comma-separated list. Lowercased + de-spaced per element.
			// Empty elements skipped (trailing comma or "a,,b").
			for _, p := range strings.Split(val, ",") {
				p = strings.ToLower(strings.TrimSpace(p))
				if p != "" {
					cfg.CertFingerprints = append(cfg.CertFingerprints, p)
				}
			}
		case "agent_id":
			cfg.AgentID = val
		case "bearer_token":
			cfg.BearerToken = val
		case "enrollment_token":
			cfg.EnrollmentToken = val
		case "response_time_interval_sec":
			fmt.Sscanf(val, "%d", &cfg.ResponseTimeIntervalSec)
		case "heartbeat_interval_sec":
			fmt.Sscanf(val, "%d", &cfg.HeartbeatIntervalSec)
		case "telemetry_interval_sec":
			fmt.Sscanf(val, "%d", &cfg.TelemetryIntervalSec)
		case "interfaces_interval_sec":
			fmt.Sscanf(val, "%d", &cfg.InterfacesIntervalSec)
		case "storage_interval_sec":
			fmt.Sscanf(val, "%d", &cfg.StorageIntervalSec)
		case "event_log_interval_sec":
			fmt.Sscanf(val, "%d", &cfg.EventLogIntervalSec)
		case "process_inventory_interval_sec":
			fmt.Sscanf(val, "%d", &cfg.ProcessInventoryIntervalSec)
		case "process_telemetry_interval_sec":
			fmt.Sscanf(val, "%d", &cfg.ProcessTelemetryIntervalSec)
		case "process_log_interval_sec":
			fmt.Sscanf(val, "%d", &cfg.ProcessLogIntervalSec)
		case "service_inventory_interval_sec":
			fmt.Sscanf(val, "%d", &cfg.ServiceInventoryIntervalSec)
		case "software_inventory_interval_sec":
			fmt.Sscanf(val, "%d", &cfg.SoftwareInventoryIntervalSec)
		case "command_poll_interval_sec":
			fmt.Sscanf(val, "%d", &cfg.CommandPollIntervalSec)
		case "verbose":
			v := strings.ToLower(val)
			cfg.Verbose = v == "true" || v == "1" || v == "yes" || v == "on"
		default:
			// Unknown key — ignored to stay forward-compatible with newer
			// installer scripts writing keys this agent version doesn't read.
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	// Pin-set normalization. If the file had `cert_fingerprints` we already
	// populated the slice; if it only had legacy `cert_fingerprint`, project
	// that into the slice so callers always read CertFingerprints. Also
	// guarantee CertFingerprint is filled (= the canonical / first pin) so
	// the legacy single-pin code path keeps working alongside the set-aware
	// one. Phase 2 dual-pin / [[prod-cert-rotation]].
	if len(cfg.CertFingerprints) == 0 && cfg.CertFingerprint != "" {
		cfg.CertFingerprints = []string{cfg.CertFingerprint}
	} else if len(cfg.CertFingerprints) > 0 && cfg.CertFingerprint == "" {
		cfg.CertFingerprint = cfg.CertFingerprints[0]
	}
	return cfg, nil
}

// Pins returns the active set of acceptable leaf-cert SHA-256 fingerprints.
// Always non-empty after Load() succeeds (Validate() rejects an empty set).
// Use this from TLS verification and config-diff checks.
func (c *Config) Pins() []string {
	if len(c.CertFingerprints) > 0 {
		return c.CertFingerprints
	}
	if c.CertFingerprint != "" {
		return []string{c.CertFingerprint}
	}
	return nil
}

// SetPins replaces the pin set. Keeps CertFingerprint synced to the first
// element (canonical) so legacy single-pin readers stay consistent. A
// no-op when the new set is byte-identical to the current set — caller
// (transport.client) uses this to detect "config push didn't change pins"
// and skip the Save().
func (c *Config) SetPins(pins []string) bool {
	if equalLowerSlice(c.CertFingerprints, pins) {
		return false
	}
	normalized := make([]string, 0, len(pins))
	for _, p := range pins {
		p = strings.ToLower(strings.TrimSpace(p))
		if p != "" {
			normalized = append(normalized, p)
		}
	}
	c.CertFingerprints = normalized
	if len(normalized) > 0 {
		c.CertFingerprint = normalized[0]
	}
	return true
}

func equalLowerSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if strings.ToLower(strings.TrimSpace(a[i])) != strings.ToLower(strings.TrimSpace(b[i])) {
			return false
		}
	}
	return true
}

// Save rewrites the config file with the current in-memory values.
// Atomic via write-to-tempfile + rename so a crash mid-write doesn't
// leave the agent with a corrupt config.
func (c *Config) Save() error {
	dir := filepath.Dir(c.path)
	tmp, err := os.CreateTemp(dir, "agent.conf.*.tmp")
	if err != nil {
		return fmt.Errorf("create tempfile: %w", err)
	}
	defer os.Remove(tmp.Name()) // no-op on success after rename

	w := bufio.NewWriter(tmp)
	fmt.Fprintln(w, "# Polaris Agent configuration. Managed by agentInstallService at install")
	fmt.Fprintln(w, "# time and rewritten by the agent on enrollment. Do not edit by hand.")
	fmt.Fprintf(w, "server_url        = %s\n", c.ServerURL)
	// Always write BOTH keys. Pre-Phase-2 agent binaries only read
	// `cert_fingerprint`, so an operator-driven downgrade keeps the
	// canonical pin. Phase 2 binaries prefer `cert_fingerprints` (full set).
	fmt.Fprintf(w, "cert_fingerprint  = %s\n", c.CertFingerprint)
	pins := c.CertFingerprints
	if len(pins) == 0 && c.CertFingerprint != "" {
		pins = []string{c.CertFingerprint}
	}
	fmt.Fprintf(w, "cert_fingerprints = %s\n", strings.Join(pins, ","))
	if c.AgentID != "" {
		fmt.Fprintf(w, "agent_id         = %s\n", c.AgentID)
	}
	if c.BearerToken != "" {
		fmt.Fprintf(w, "bearer_token     = %s\n", c.BearerToken)
	}
	if c.EnrollmentToken != "" {
		fmt.Fprintf(w, "enrollment_token = %s\n", c.EnrollmentToken)
	}
	if c.ResponseTimeIntervalSec > 0 {
		fmt.Fprintf(w, "response_time_interval_sec = %d\n", c.ResponseTimeIntervalSec)
	}
	if c.HeartbeatIntervalSec > 0 {
		fmt.Fprintf(w, "heartbeat_interval_sec     = %d\n", c.HeartbeatIntervalSec)
	}
	if c.TelemetryIntervalSec > 0 {
		fmt.Fprintf(w, "telemetry_interval_sec     = %d\n", c.TelemetryIntervalSec)
	}
	if c.InterfacesIntervalSec > 0 {
		fmt.Fprintf(w, "interfaces_interval_sec    = %d\n", c.InterfacesIntervalSec)
	}
	if c.StorageIntervalSec > 0 {
		fmt.Fprintf(w, "storage_interval_sec       = %d\n", c.StorageIntervalSec)
	}
	if c.EventLogIntervalSec > 0 {
		fmt.Fprintf(w, "event_log_interval_sec     = %d\n", c.EventLogIntervalSec)
	}
	if c.ProcessInventoryIntervalSec > 0 {
		fmt.Fprintf(w, "process_inventory_interval_sec = %d\n", c.ProcessInventoryIntervalSec)
	}
	if c.ProcessTelemetryIntervalSec > 0 {
		fmt.Fprintf(w, "process_telemetry_interval_sec = %d\n", c.ProcessTelemetryIntervalSec)
	}
	if c.ProcessLogIntervalSec > 0 {
		fmt.Fprintf(w, "process_log_interval_sec       = %d\n", c.ProcessLogIntervalSec)
	}
	if c.ServiceInventoryIntervalSec > 0 {
		fmt.Fprintf(w, "service_inventory_interval_sec = %d\n", c.ServiceInventoryIntervalSec)
	}
	if c.SoftwareInventoryIntervalSec > 0 {
		fmt.Fprintf(w, "software_inventory_interval_sec = %d\n", c.SoftwareInventoryIntervalSec)
	}
	if c.CommandPollIntervalSec > 0 {
		fmt.Fprintf(w, "command_poll_interval_sec      = %d\n", c.CommandPollIntervalSec)
	}
	if c.Verbose {
		fmt.Fprintln(w, "verbose                    = true")
	}
	if err := w.Flush(); err != nil {
		return fmt.Errorf("flush: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close tempfile: %w", err)
	}
	// 0600 — config holds the bearer; only the agent's service user reads it.
	if err := os.Chmod(tmp.Name(), 0o600); err != nil {
		return fmt.Errorf("chmod tempfile: %w", err)
	}
	if err := os.Rename(tmp.Name(), c.path); err != nil {
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// Validate checks the minimal set of fields the agent needs for one of two
// lifecycle stages:
//
//	pre-enroll:  ServerURL + CertFingerprint + EnrollmentToken
//	post-enroll: ServerURL + CertFingerprint + BearerToken
//
// At least one of EnrollmentToken / BearerToken must be present.
func (c *Config) Validate() error {
	var missing []string
	if c.ServerURL == "" {
		missing = append(missing, "server_url")
	}
	if c.CertFingerprint == "" {
		missing = append(missing, "cert_fingerprint")
	}
	if c.BearerToken == "" && c.EnrollmentToken == "" {
		missing = append(missing, "bearer_token or enrollment_token")
	}
	if len(missing) > 0 {
		return fmt.Errorf("agent.conf missing required key(s): %s", strings.Join(missing, ", "))
	}
	if !strings.HasPrefix(c.CertFingerprint, "sha256:") {
		return errors.New("cert_fingerprint must start with sha256:")
	}
	return nil
}

// Path returns the file path the config was loaded from. Useful for Save().
func (c *Config) Path() string { return c.path }
