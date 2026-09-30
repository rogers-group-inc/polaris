//go:build !linux

package collectors

// readJournaldComm is a no-op off Linux — journald exists only on systemd
// hosts. Non-Linux pinned programs use the file-glob source instead.
func readJournaldComm(_ string, _ string, _ int, _ bool) ([]rawLogLine, string) {
	return nil, ""
}
