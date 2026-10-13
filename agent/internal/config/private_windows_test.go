//go:build windows

package config

import (
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// Rule 117: a saved agent.conf carries a protected DACL — SYSTEM,
// Administrators and the owner only — never the Users read entry a file in
// %ProgramData% would otherwise inherit.
func TestSave_WindowsProtectedDACL(t *testing.T) {
	p := writeAgentConf(t, "server_url       = https://polaris.example.com\n"+
		"cert_fingerprint = "+canonPin+"\n"+
		"bearer_token     = polaris_xyz\n")
	cfg, err := Load(p)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if err := cfg.Save(); err != nil {
		t.Fatalf("save: %v", err)
	}
	sd, err := windows.GetNamedSecurityInfo(p, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatalf("get security: %v", err)
	}
	sddl := sd.String()
	if !strings.HasPrefix(sddl, "D:P") {
		t.Errorf("DACL not protected: %s", sddl)
	}
	for _, bad := range []string{";;;BU)", ";;;WD)", ";;;AU)", "ID;"} {
		if strings.Contains(sddl, bad) {
			t.Errorf("DACL grants %q: %s", bad, sddl)
		}
	}
	if !strings.Contains(sddl, ";;;SY)") || !strings.Contains(sddl, ";;;BA)") {
		t.Errorf("DACL missing SYSTEM/Administrators: %s", sddl)
	}
}
