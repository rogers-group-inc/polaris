//go:build !linux && !windows

package collectors

// No FC HBA interface is read on this platform: "cannot say".
func readPlatformFcPorts() *[]FcPort {
	return nil
}
