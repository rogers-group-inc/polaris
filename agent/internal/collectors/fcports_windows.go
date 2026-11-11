//go:build windows

package collectors

import (
	"strings"

	"github.com/yusufpapurcu/wmi"
)

// MSFT_InitiatorPort (Windows Storage module): one row per initiator port,
// FC ones being ConnectionType 1. Its addresses are flat hex strings, unlike
// MSFC_FibrePortHBAAttributes, whose WWNs sit inside an embedded object.
type msftInitiatorPort struct {
	InstanceName   string
	NodeAddress    string
	PortAddress    string
	ConnectionType uint16
}

// MSFC_FCAdapterHBAAttributes (root\WMI), published by the HBA driver.
type msfcAdapterAttrs struct {
	Model           string
	FirmwareVersion string
	DriverVersion   string
}

const initiatorPortFibreChannel = 1

func readPlatformFcPorts() *[]FcPort {
	var ports []msftInitiatorPort
	q := "SELECT InstanceName, NodeAddress, PortAddress, ConnectionType FROM MSFT_InitiatorPort"
	if err := wmi.QueryNamespace(q, &ports, `root\Microsoft\Windows\Storage`); err != nil {
		// No Storage module (older Windows) or the query refused: cannot say.
		return nil
	}

	// The adapter attributes cannot be joined to a port reliably (the two
	// classes do not share a key), so they are applied only when every FC
	// adapter on the host is the same model — the usual dual-port card.
	var model, firmware, driver string
	var adapters []msfcAdapterAttrs
	if err := wmi.QueryNamespace("SELECT Model, FirmwareVersion, DriverVersion FROM MSFC_FCAdapterHBAAttributes", &adapters, `root\WMI`); err == nil && len(adapters) > 0 {
		same := true
		for _, a := range adapters[1:] {
			if a.Model != adapters[0].Model || a.FirmwareVersion != adapters[0].FirmwareVersion || a.DriverVersion != adapters[0].DriverVersion {
				same = false
				break
			}
		}
		if same {
			model = strings.TrimSpace(adapters[0].Model)
			firmware = strings.TrimSpace(adapters[0].FirmwareVersion)
			driver = strings.TrimSpace(adapters[0].DriverVersion)
		}
	}

	out := []FcPort{}
	for _, p := range ports {
		if p.ConnectionType != initiatorPortFibreChannel || strings.TrimSpace(p.PortAddress) == "" {
			continue
		}
		if len(out) >= maxFcPorts {
			break
		}
		out = append(out, FcPort{
			Name:     strings.TrimSpace(p.InstanceName),
			PortWWN:  strings.TrimSpace(p.PortAddress),
			NodeWWN:  strings.TrimSpace(p.NodeAddress),
			Model:    model,
			Firmware: firmware,
			Driver:   driver,
		})
	}
	return &out
}
