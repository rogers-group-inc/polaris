// fcports.go — the host's own fibre-channel HBA ports (Polaris business
// rule 159).
//
// Rides the system-info push. What a fibre-channel switch logs in is a
// port WWN; the host reporting the same WWN is the exact match between the
// switch's login table and this asset, needing no names.
//
//   - Linux: /sys/class/fc_host/host<N>/{port_name,node_name,port_state,
//     speed,fabric_name}, model and firmware from /sys/class/scsi_host/host<N>
//     (lpfc: modelname / fwrev; qla2xxx: model_name / fw_version), the driver
//     from proc_name and /sys/module/<driver>/version. World-readable, so the
//     unprivileged tier sees them.
//   - Windows: MSFT_InitiatorPort (root\Microsoft\Windows\Storage) for the
//     port and node WWNs, MSFC_FCAdapterHBAAttributes (root\WMI) for the
//     adapter's model / firmware / driver.
//   - Elsewhere: not reported (nil).
//
// The three answers are distinct on the wire: nil = this platform or host
// cannot say (the server keeps what it had), an empty list = read, and the
// host has no FC ports (the server clears them), a list = the ports.
package collectors

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/polaris/agent/internal/transport"
)

// FcPort is one HBA port as the host sees it — the wire shape itself.
type FcPort = transport.FcPort

// maxFcPorts bounds what one host can send; a host carries a handful.
const maxFcPorts = 64

// FcPortsOnce snapshots the host's FC ports. See the file comment for the
// nil / empty / list contract.
func FcPortsOnce() *[]FcPort {
	return readPlatformFcPorts()
}

func readAttr(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func firstAttr(dir string, names ...string) string {
	for _, n := range names {
		if v := readAttr(filepath.Join(dir, n)); v != "" {
			return v
		}
	}
	return ""
}

// readFcPortsFromSysfs reads the fc_host class under `root` (normally "/sys").
// A missing fc_host directory is a host with no FC transport loaded: an empty
// list. Any other failure to list it (a masked /sys) is "cannot say": nil.
func readFcPortsFromSysfs(root string) *[]FcPort {
	base := filepath.Join(root, "class", "fc_host")
	entries, err := os.ReadDir(base)
	if err != nil {
		if os.IsNotExist(err) {
			empty := []FcPort{}
			return &empty
		}
		return nil
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	out := []FcPort{}
	for _, name := range names {
		if len(out) >= maxFcPorts {
			break
		}
		dir := filepath.Join(base, name)
		wwn := readAttr(filepath.Join(dir, "port_name"))
		if wwn == "" {
			continue
		}
		host := filepath.Join(root, "class", "scsi_host", name)
		p := FcPort{
			Name:       name,
			PortWWN:    wwn,
			NodeWWN:    readAttr(filepath.Join(dir, "node_name")),
			PortState:  readAttr(filepath.Join(dir, "port_state")),
			Speed:      readAttr(filepath.Join(dir, "speed")),
			FabricName: readAttr(filepath.Join(dir, "fabric_name")),
			Model:      firstAttr(host, "modelname", "model_name"),
			Firmware:   firstAttr(host, "fwrev", "fw_version"),
		}
		if drv := readAttr(filepath.Join(host, "proc_name")); drv != "" {
			p.Driver = drv
			if v := readAttr(filepath.Join(root, "module", drv, "version")); v != "" {
				p.Driver = drv + " " + v
			}
		}
		out = append(out, p)
	}
	return &out
}
