//go:build windows

package config

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// Business rule 117: on Windows os.Chmod(0o600) only clears the read-only
// bit, so agent.conf (it holds the bearer) inherited %ProgramData%'s
// "Users: read" entry. These descriptors are protected (no inheritance from
// above) and grant only SYSTEM and Administrators — plus OWNER RIGHTS on the
// file, so an agent run by hand as a plain user can still read the file it
// just wrote.
const (
	privateDirSDDL  = "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
	privateFileSDDL = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;OW)"
)

func setProtectedDACL(path, sddl string) error {
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	return windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil, nil, dacl, nil)
}

// restrictConfigDir protects the canonical %ProgramData%\Polaris\agent
// directory before a tempfile is created in it, so the file never exists
// readable. It leaves any other directory alone: an operator pointing -conf
// at their own folder must not be locked out of it. Best-effort — installs
// predating rule 117 may lack the right to rewrite a folder another account
// owns; the installer fixes ownership, and the file itself is still protected.
func restrictConfigDir(dir string) {
	base := os.Getenv("ProgramData")
	if base == "" {
		base = `C:\ProgramData`
	}
	want := filepath.Join(base, "Polaris", "agent")
	if !strings.EqualFold(filepath.Clean(dir), filepath.Clean(want)) {
		return
	}
	_ = setProtectedDACL(dir, privateDirSDDL)
}

// restrictConfigFile replaces the tempfile's inherited ACL before it is
// renamed over agent.conf. The process created the file, so it holds
// WRITE_DAC and this cannot fail for lack of rights.
func restrictConfigFile(path string) error {
	return setProtectedDACL(path, privateFileSDDL)
}
