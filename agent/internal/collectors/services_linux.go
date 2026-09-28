//go:build linux

package collectors

import (
	"context"
	"log"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/polaris/agent/internal/transport"
)

// serviceInventoryOnce enumerates systemd .service units via systemctl. Three
// cheap reads, merged by unit name:
//   - `list-units --all`      → load/active/sub/description (every loaded unit,
//     including inactive-but-loaded + failed).
//   - `list-unit-files`       → enablement (enabled/disabled/static/...).
//   - `show -p Id,MainPID,...`→ MainPID + MemoryCurrent + CPUUsageNSec (one
//     batched call).
//
// CPU is the unit's whole cgroup (CPUUsageNSec) when systemd accounts it, else
// the main PID's own CPU time — the fallback misses a unit's child processes.
//
// Returns nil when systemctl is unavailable or the primary enumeration fails
// (server treats a nil push as a no-op). cgo-free; shells out with hard
// timeouts so a wedged systemctl can't stall the collection goroutine.
func serviceInventoryOnce() []serviceRaw {
	if _, err := exec.LookPath("systemctl"); err != nil {
		return nil
	}

	units := listUnits()
	if units == nil {
		return nil
	}
	enabled := listUnitFiles()          // unit → enablement state; best-effort
	details := showUnits(keysOf(units)) // unit → {mainPid, memBytes, cpu}; best-effort

	out := make([]serviceRaw, 0, len(units))
	for name, u := range units {
		s := &transport.ServiceSample{Unit: name, Platform: "systemd"}
		raw := serviceRaw{sample: s}
		if u.Description != "" {
			d := u.Description
			s.DisplayName = &d
		}
		if u.Load != "" {
			l := u.Load
			s.LoadState = &l
		}
		if u.Active != "" {
			a := u.Active
			s.ActiveState = &a
		}
		if u.Sub != "" {
			sub := u.Sub
			s.SubState = &sub
		}
		if e, ok := enabled[name]; ok && e != "" {
			s.EnabledState = &e
		}
		if d, ok := details[name]; ok {
			if d.mainPid > 0 {
				pid := d.mainPid
				s.MainPid = &pid
				if comm := readComm(pid); comm != "" {
					s.MainProcess = &comm
				}
			}
			if d.hasMem {
				mem := d.memBytes
				s.MemBytes = &mem
			}
			switch {
			case d.hasCPU:
				raw.cpuSec = float64(d.cpuNsec) / 1e9
				raw.hasCPU = true
				raw.cpuKey = "cgroup:" + strconv.Itoa(d.mainPid)
			case d.mainPid > 0:
				if sec, key, ok := pidCPUSeconds(int32(d.mainPid)); ok {
					raw.cpuSec, raw.cpuKey, raw.hasCPU = sec, key, true
				}
			}
		}
		out = append(out, raw)
	}
	return out
}

// listUnits runs `systemctl list-units --type=service --all --plain` and parses
// the PLAIN columnar output (see parseListUnits for why not `-o json`). Returns
// nil on failure OR on an empty parse — treating "no parseable rows" as a
// failure rather than a zero-service host is deliberate: the server
// full-replaces this asset's rows per push, so pushing an empty set on a parse
// regression would WIPE a real inventory. Any systemd host has services, so nil
// (skip, keep prior rows) is the safe choice, and it's logged so the anomaly is
// never invisible.
func listUnits() map[string]sysdUnit {
	out, err := runSystemctl(20*time.Second, "list-units", "--type=service", "--all", "--plain", "--no-legend", "--no-pager")
	if err != nil {
		log.Printf("serviceInventory: `systemctl list-units` failed: %v", err)
		return nil
	}
	m := parseListUnits(string(out))
	if len(m) == 0 {
		log.Printf("serviceInventory: `systemctl list-units` returned no parseable service rows — skipping (inventory left unchanged)")
		return nil
	}
	return m
}

// listUnitFiles maps unit → enablement (enabled/disabled/static/masked/...).
// Best-effort: an empty map just means the enablement column stays blank (it
// never nils the whole collection). Plain columnar output, same as listUnits.
func listUnitFiles() map[string]string {
	out, err := runSystemctl(20*time.Second, "list-unit-files", "--type=service", "--plain", "--no-legend", "--no-pager")
	if err != nil {
		log.Printf("serviceInventory: `systemctl list-unit-files` failed (enablement will be blank): %v", err)
		return map[string]string{}
	}
	return parseListUnitFiles(string(out))
}

// showUnits batches `systemctl show <units> -p Id,MainPID,MemoryCurrent` into a
// single call and parses the blank-line-separated property blocks. Best-effort.
func showUnits(units []string) map[string]unitDetail {
	res := map[string]unitDetail{}
	if len(units) == 0 {
		return res
	}
	args := append([]string{"show", "-p", "Id", "-p", "MainPID", "-p", "MemoryCurrent", "-p", "CPUUsageNSec", "--no-pager"}, units...)
	out, err := runSystemctl(25*time.Second, args...)
	if err != nil {
		return res
	}
	return parseShowUnits(string(out))
}

// readComm returns the program name of a PID from /proc/<pid>/comm ("" on miss).
func readComm(pid int) string {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/comm")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func runSystemctl(timeout time.Duration, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return exec.CommandContext(ctx, "systemctl", args...).Output()
}

func keysOf(m map[string]sysdUnit) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
