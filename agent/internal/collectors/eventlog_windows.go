//go:build windows

package collectors

import (
	"bytes"
	"context"
	"encoding/xml"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// readPlatformEvents (Windows) shells out to wevtutil. This is the thin-first
// implementation per the plan — robust under a Service account and far lighter
// than spawning PowerShell, which is frequently locked down (Constrained
// Language Mode / AppLocker) on hardened endpoints. The native wevtapi +
// bookmark implementation is a later, localized swap behind this same function
// signature.
//
// Cursor model: highest EventRecordID seen per channel (monotonic until the log
// is cleared). First run captures the current max without emitting history.
func readPlatformEvents(cursors map[string]string, filter EventLogFilter) ([]rawEvent, map[string]string, error) {
	channels := filter.Channels
	if len(channels) == 0 {
		channels = []string{"System", "Application"}
	}
	maxN := filter.MaxPerPush
	if maxN <= 0 {
		maxN = defaultMaxPerPush
	}
	pred := winLevelPredicate(filter.MinLevel)

	out := map[string]string{}
	for k, v := range cursors {
		out[k] = v
	}
	var events []rawEvent

	for _, ch := range channels {
		saved, _ := strconv.ParseInt(cursors[ch], 10, 64) // 0 when absent/garbage
		if cursors[ch] == "" {
			// First run for this channel — seed at the current tail, emit nothing.
			if maxID := winChannelMaxRecordID(ch); maxID > 0 {
				out[ch] = strconv.FormatInt(maxID, 10)
			} else {
				out[ch] = "0"
			}
			continue
		}
		raw := winQuery(ch, pred, maxN)
		parsed := parseWevtutilXML(raw, ch)
		maxSeen := saved
		for _, e := range parsed {
			if e.recordID > saved {
				events = append(events, e.ev)
			}
			if e.recordID > maxSeen {
				maxSeen = e.recordID
			}
		}
		out[ch] = strconv.FormatInt(maxSeen, 10)
	}
	return events, out, nil
}

// winLevelPredicate builds the XPath System-level predicate for a min severity.
// Empty string = no level filter (info and up). Windows levels: 1 Critical,
// 2 Error, 3 Warning, 4 Information.
func winLevelPredicate(minLevel string) string {
	switch minLevel {
	case "critical":
		return "Level=1"
	case "warning":
		return "Level=1 or Level=2 or Level=3"
	case "info":
		return ""
	default: // "error"
		return "Level=1 or Level=2"
	}
}

func winQuery(channel, pred string, maxN int) []byte {
	q := "*"
	if pred != "" {
		q = "*[System[(" + pred + ")]]"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "wevtutil", "qe", channel,
		"/q:"+q, "/c:"+strconv.Itoa(maxN), "/rd:true", "/f:XML")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}
	return out
}

// winChannelMaxRecordID returns the newest EventRecordID in a channel (for the
// first-run cursor seed) without emitting it. 0 on any failure or empty log.
func winChannelMaxRecordID(channel string) int64 {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "wevtutil", "qe", channel, "/c:1", "/rd:true", "/f:XML")
	out, err := cmd.Output()
	if err != nil {
		return 0
	}
	parsed := parseWevtutilXML(out, channel)
	var max int64
	for _, e := range parsed {
		if e.recordID > max {
			max = e.recordID
		}
	}
	return max
}

type winParsedEvent struct {
	recordID int64
	ev       rawEvent
}

// wevtutil /f:XML emits a sequence of <Event> elements (no single root).
// xml.Decoder.Decode in a loop handles the concatenation cleanly.
type wevtSystem struct {
	Provider      struct{ Name string `xml:"Name,attr"` } `xml:"Provider"`
	EventID       string                                  `xml:"EventID"`
	Level         string                                  `xml:"Level"`
	TimeCreated   struct{ SystemTime string `xml:"SystemTime,attr"` } `xml:"TimeCreated"`
	EventRecordID string                                  `xml:"EventRecordID"`
}
type wevtEvent struct {
	System    wevtSystem `xml:"System"`
	EventData struct {
		Data []string `xml:"Data"`
	} `xml:"EventData"`
}

// parseWevtutilXML decodes the event stream into parsed events. Pure given its
// bytes. wevtutil doesn't render the publisher message, so the message is built
// from the EventData Data values (the native wevtapi upgrade adds EvtFormatMessage).
func parseWevtutilXML(b []byte, channel string) []winParsedEvent {
	if len(b) == 0 {
		return nil
	}
	dec := xml.NewDecoder(bytes.NewReader(b))
	var out []winParsedEvent
	for {
		var e wevtEvent
		if err := dec.Decode(&e); err != nil {
			break
		}
		recordID, _ := strconv.ParseInt(strings.TrimSpace(e.System.EventRecordID), 10, 64)
		var idPtr *int64
		if id, err := strconv.ParseInt(strings.TrimSpace(e.System.EventID), 10, 64); err == nil {
			idPtr = &id
		}
		msg := strings.TrimSpace(strings.Join(e.EventData.Data, " "))
		if msg == "" {
			msg = e.System.Provider.Name + " event " + strings.TrimSpace(e.System.EventID)
		}
		out = append(out, winParsedEvent{
			recordID: recordID,
			ev: rawEvent{
				Timestamp: normalizeWinTime(e.System.TimeCreated.SystemTime),
				Channel:   channel,
				Provider:  e.System.Provider.Name,
				EventID:   idPtr,
				Level:     winLevelName(e.System.Level),
				Message:   msg,
			},
		})
	}
	return out
}

// normalizeWinTime passes through the ISO8601 SystemTime wevtutil emits
// (already UTC, e.g. 2024-01-02T03:04:05.1234567Z). Returns "" if blank so the
// server stamps receipt time.
func normalizeWinTime(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC().Format(time.RFC3339Nano)
	}
	return s
}
