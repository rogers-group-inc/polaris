//go:build windows

package collectors

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"time"

	"github.com/polaris/agent/internal/transport"
)

// maxServiceDescriptionRunes caps a service description on the wire. Real ones
// are a few hundred characters; the cap keeps one oversized row from failing
// the server's schema and with it the whole full-replace push.
const maxServiceDescriptionRunes = 2000

// serviceInventoryOnce enumerates Windows services via one CIM query. State +
// StartMode map onto the same activeState/enabledState fields the systemd path
// uses (an automatic service with DelayedAutoStart reports "auto-delayed");
// loadState/subState stay nil (no SCM equivalent).
//
// Memory, CPU and the program name come from the service's process (ProcessId),
// read once per distinct PID. Services that share a svchost.exe share a PID, so
// each of them reports that whole process's figures — the Services tab marks
// such rows as shared rather than the agent guessing a split.
// Returns nil when the query fails.
func serviceInventoryOnce() []serviceRaw {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	// @(...) forces an array even when a single service is returned.
	const script = `@(Get-CimInstance Win32_Service | Select-Object Name,DisplayName,Description,State,StartMode,DelayedAutoStart,ProcessId) | ConvertTo-Json -Compress -Depth 3`
	out, err := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script).Output()
	if err != nil {
		return nil
	}
	rows, ok := parseWin32ServiceJSON(out)
	if !ok {
		return nil
	}
	stats := map[int32]pidStat{}
	result := make([]serviceRaw, 0, len(rows))
	for _, s := range rows {
		raw := serviceRaw{sample: s}
		if s.MainPid != nil {
			pid := int32(*s.MainPid)
			st, seen := stats[pid]
			if !seen {
				st = readPidStat(pid)
				stats[pid] = st
			}
			if st.name != "" {
				n := st.name
				s.MainProcess = &n
			}
			if st.hasRSS {
				m := st.rss
				s.MemBytes = &m
			}
			if st.hasCPU {
				raw.cpuSec, raw.cpuKey, raw.hasCPU = st.cpuSec, st.cpuKey, true
			}
		}
		result = append(result, raw)
	}
	return result
}

// parseWin32ServiceJSON maps the CIM query's JSON onto wire samples (no process
// figures — those need a live PID). Pure; false on undecodable output.
func parseWin32ServiceJSON(b []byte) ([]*transport.ServiceSample, bool) {
	var rows []struct {
		Name             string `json:"Name"`
		DisplayName      string `json:"DisplayName"`
		Description      string `json:"Description"`
		State            string `json:"State"`
		StartMode        string `json:"StartMode"`
		DelayedAutoStart *bool  `json:"DelayedAutoStart"`
		ProcessId        int    `json:"ProcessId"`
	}
	if err := json.Unmarshal(b, &rows); err != nil {
		return nil, false
	}
	out := make([]*transport.ServiceSample, 0, len(rows))
	for _, r := range rows {
		if r.Name == "" {
			continue
		}
		s := &transport.ServiceSample{Unit: r.Name, Platform: "windows"}
		if r.DisplayName != "" {
			d := r.DisplayName
			s.DisplayName = &d
		}
		if desc := strings.TrimSpace(r.Description); desc != "" {
			if rs := []rune(desc); len(rs) > maxServiceDescriptionRunes {
				desc = string(rs[:maxServiceDescriptionRunes])
			}
			s.Description = &desc
		}
		if r.State != "" {
			a := strings.ToLower(r.State)
			s.ActiveState = &a
		}
		if r.StartMode != "" {
			e := strings.ToLower(r.StartMode)
			if e == "auto" && r.DelayedAutoStart != nil && *r.DelayedAutoStart {
				e = "auto-delayed"
			}
			s.EnabledState = &e
		}
		if r.ProcessId > 0 {
			pid := r.ProcessId
			s.MainPid = &pid
		}
		out = append(out, s)
	}
	return out, true
}
