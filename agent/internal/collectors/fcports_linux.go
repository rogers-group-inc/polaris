//go:build linux

package collectors

func readPlatformFcPorts() *[]FcPort {
	return readFcPortsFromSysfs("/sys")
}
