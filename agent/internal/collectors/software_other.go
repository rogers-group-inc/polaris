//go:build !linux && !windows

package collectors

// softwareInventoryOnce is a no-op where no package database is mapped yet
// (macOS) — nil, which the server treats as "leave the inventory alone".
func softwareInventoryOnce() []softwareRaw { return nil }
