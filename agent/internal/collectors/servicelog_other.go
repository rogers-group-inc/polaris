//go:build !linux && !windows

package collectors

// readServiceUnitLog is a no-op where the agent maps no service manager.
func readServiceUnitLog(_ string, _ map[string]string, _ int) ([]rawLogLine, string) {
	return nil, ""
}
