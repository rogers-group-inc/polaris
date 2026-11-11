package collectors

import (
	"os"
	"path/filepath"
	"testing"
)

func writeAttr(t *testing.T, path, value string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(value+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestReadFcPortsFromSysfs(t *testing.T) {
	root := t.TempDir()
	fc := filepath.Join(root, "class", "fc_host", "host3")
	writeAttr(t, filepath.Join(fc, "port_name"), "0x10000090fa1b2c3d")
	writeAttr(t, filepath.Join(fc, "node_name"), "0x20000090fa1b2c3d")
	writeAttr(t, filepath.Join(fc, "port_state"), "Online")
	writeAttr(t, filepath.Join(fc, "speed"), "16 Gbit")
	writeAttr(t, filepath.Join(fc, "fabric_name"), "0x2065001dd8b0c001")
	sh := filepath.Join(root, "class", "scsi_host", "host3")
	writeAttr(t, filepath.Join(sh, "modelname"), "SN1200E2P")
	writeAttr(t, filepath.Join(sh, "fwrev"), "14.2.589.5")
	writeAttr(t, filepath.Join(sh, "proc_name"), "lpfc")
	writeAttr(t, filepath.Join(root, "module", "lpfc", "version"), "0:14.0.0.21")
	// A port with no WWN (a torn-down vport) is skipped.
	if err := os.MkdirAll(filepath.Join(root, "class", "fc_host", "host9"), 0o755); err != nil {
		t.Fatal(err)
	}

	got := readFcPortsFromSysfs(root)
	if got == nil || len(*got) != 1 {
		t.Fatalf("want one port, got %#v", got)
	}
	p := (*got)[0]
	want := FcPort{
		Name: "host3", PortWWN: "0x10000090fa1b2c3d", NodeWWN: "0x20000090fa1b2c3d",
		PortState: "Online", Speed: "16 Gbit", FabricName: "0x2065001dd8b0c001",
		Model: "SN1200E2P", Firmware: "14.2.589.5", Driver: "lpfc 0:14.0.0.21",
	}
	if p != want {
		t.Fatalf("got %#v\nwant %#v", p, want)
	}
}

func TestReadFcPortsFromSysfsNoTransport(t *testing.T) {
	// No fc_host class at all: read, and no FC ports (not "cannot say").
	got := readFcPortsFromSysfs(t.TempDir())
	if got == nil || len(*got) != 0 {
		t.Fatalf("want an empty list, got %#v", got)
	}
}
