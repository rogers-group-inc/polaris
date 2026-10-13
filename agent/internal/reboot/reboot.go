// Package reboot is the agent half of an operator-requested host reboot
// (Polaris business rule 114).
//
// The agent reboots its host ONLY when the host carries the opt-in marker
// that Polaris's install / "enable reboots" step wrote as root — a file the
// agent itself cannot create (on Linux the unit's ProtectSystem=strict keeps
// /etc read-only to it). On Linux the agent runs unprivileged
// (NoNewPrivileges, no CAP_SYS_BOOT), so the reboot is a request to
// systemd-logind, which a polkit rule installed beside the marker allows for
// the polaris-agent user; Windows runs as LocalSystem, where the marker is
// the whole opt-in.
//
// Capable() is what heartbeat reports as `rebootCapable`, so the server only
// offers a reboot a host will actually perform. It is cached — heartbeat
// rides every response-time probe — and Invalidate() drops the cache when the
// server says the config changed.
package reboot

import (
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/host"
)

const capableTTL = 5 * time.Minute

var (
	mu        sync.Mutex
	cachedAt  time.Time
	cachedVal bool
)

// Capable reports whether this host lets the agent reboot it: the opt-in
// marker is present and the OS will honour the request (see capable()).
func Capable() bool {
	mu.Lock()
	defer mu.Unlock()
	if !cachedAt.IsZero() && time.Since(cachedAt) < capableTTL {
		return cachedVal
	}
	cachedVal = capable()
	cachedAt = time.Now()
	return cachedVal
}

// Invalidate forgets the cached Capable answer.
func Invalidate() {
	mu.Lock()
	cachedAt = time.Time{}
	mu.Unlock()
}

// Allowed reports whether the opt-in marker is present — the gate the
// command itself checks, independent of the cache.
func Allowed() bool { return markerPresent() }

// BootTime is the host's boot time in unix seconds, 0 when unknown.
func BootTime() uint64 {
	bt, err := host.BootTime()
	if err != nil {
		return 0
	}
	return bt
}

// Reboot asks the OS to reboot after delay. It returns once the request is
// handed off (or refused); the caller reports to Polaris BEFORE calling it.
func Reboot(delay time.Duration, comment string) error {
	return reboot(delay, comment)
}
