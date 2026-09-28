//go:build windows

package collectors

import (
	"context"
	"os/exec"
	"strconv"
	"time"
)

// winServiceLogChannels are the Event Log channels a service's entries land in.
var winServiceLogChannels = []string{"System", "Application"}

// readServiceUnitLog (Windows) reads the Event Log entries about one service
// (see winServiceLogQuery) newer than its per-channel cursor — the highest
// EventRecordID already emitted, like the Event Log stream's. The first read of
// a channel backfills the newest winServiceLogBackfill entries instead of
// seeding at the tail. Rendered XML, so the message is the publisher's own text
// ("The Print Spooler service entered the stopped state."), not the raw data.
// Advances cursors in place; returns oldest-first lines and the source label.
func readServiceUnitLog(unit string, cursors map[string]string, maxLines int) ([]rawLogLine, string) {
	names := []string{unit}
	if d := serviceDisplayName(unit); d != "" && d != unit {
		names = append(names, d)
	}
	var out []rawLogLine
	for _, ch := range winServiceLogChannels {
		key := "wevt-unit:" + unit + "|" + ch
		saved, _ := strconv.ParseInt(cursors[key], 10, 64) // 0 when absent/garbage
		n := maxLines
		if saved == 0 && n > winServiceLogBackfill {
			n = winServiceLogBackfill
		}
		q := winServiceLogQuery(ch, names, saved)
		if q == "" {
			continue
		}
		parsed := parseWevtutilXML(winQueryRendered(ch, q, n), ch)
		maxSeen := saved
		// /rd:true returns newest-first; the stream is oldest-first.
		for i := len(parsed) - 1; i >= 0; i-- {
			e := parsed[i]
			if e.recordID <= saved {
				continue
			}
			out = append(out, rawLogLine{Timestamp: e.ev.Timestamp, Level: normalizeLevel(e.ev.Level), Message: e.ev.Message})
			if e.recordID > maxSeen {
				maxSeen = e.recordID
			}
		}
		if maxSeen > 0 {
			cursors[key] = strconv.FormatInt(maxSeen, 10)
		}
	}
	return out, "eventlog:" + unit
}

// winQueryRendered runs one Event Log XPath query newest-first with the
// publisher messages rendered. nil on any failure (a missing channel, a
// timeout, a query wevtutil rejects).
func winQueryRendered(channel, xpath string, maxN int) []byte {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "wevtutil", "qe", channel,
		"/q:"+xpath, "/c:"+strconv.Itoa(maxN), "/rd:true", "/f:RenderedXml").Output()
	if err != nil {
		return nil
	}
	return out
}
