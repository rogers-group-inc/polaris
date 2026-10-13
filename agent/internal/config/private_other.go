//go:build !windows

package config

// On Unix the 0o600 chmod in Save is the whole story; see private_windows.go.
func restrictConfigDir(string) {}

func restrictConfigFile(string) error { return nil }
