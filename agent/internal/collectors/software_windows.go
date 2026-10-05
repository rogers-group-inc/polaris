//go:build windows

package collectors

import (
	"log"
	"runtime"

	"golang.org/x/sys/windows/registry"
)

const uninstallKeyPath = `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall`

// softwareInventoryOnce reads HKLM's Uninstall keys through both registry
// views. WOW64_64KEY / WOW64_32KEY select the view explicitly, so the result
// does not depend on whether this binary is 32- or 64-bit; on a 32-bit OS both
// views are the same key and softwareSamples de-duplicates them.
//
// Read-only (ENUMERATE_SUB_KEYS | QUERY_VALUE); HKLM\SOFTWARE is readable by
// the agent's service account without elevation. Returns nil only when
// neither view could be opened.
func softwareInventoryOnce() []softwareRaw {
	nativeArch := "x64"
	if runtime.GOARCH == "arm64" {
		nativeArch = "arm64"
	}
	var rows []softwareRaw
	opened := false
	for _, view := range []struct {
		flag uint32
		arch string
	}{
		{registry.WOW64_64KEY, nativeArch},
		{registry.WOW64_32KEY, "x86"},
	} {
		got, ok := readUninstallView(view.flag, view.arch)
		if ok {
			opened = true
			rows = append(rows, got...)
		}
	}
	if !opened {
		log.Printf("softwareInventory: could not open HKLM\\%s in either registry view", uninstallKeyPath)
		return nil
	}
	if rows == nil {
		rows = []softwareRaw{}
	}
	return rows
}

func readUninstallView(viewFlag uint32, arch string) ([]softwareRaw, bool) {
	root, err := registry.OpenKey(registry.LOCAL_MACHINE, uninstallKeyPath,
		registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE|viewFlag)
	if err != nil {
		return nil, false
	}
	defer root.Close()
	names, err := root.ReadSubKeyNames(-1)
	if err != nil {
		return nil, false
	}
	rows := make([]softwareRaw, 0, len(names))
	for _, name := range names {
		k, err := registry.OpenKey(root, name, registry.QUERY_VALUE|viewFlag)
		if err != nil {
			continue
		}
		displayName := stringFromReg(k, "DisplayName")
		systemComponent, _, _ := k.GetIntegerValue("SystemComponent")
		if !registryEntryVisible(displayName, systemComponent,
			stringFromReg(k, "ParentKeyName"), stringFromReg(k, "ReleaseType")) {
			k.Close()
			continue
		}
		r := softwareRaw{
			Name:         displayName,
			Version:      stringFromReg(k, "DisplayVersion"),
			Publisher:    stringFromReg(k, "Publisher"),
			Architecture: arch,
			InstallDate:  normalizeRegistryInstallDate(stringFromReg(k, "InstallDate")),
			Platform:     "windows",
		}
		// EstimatedSize is a DWORD in KiB.
		if kib, _, err := k.GetIntegerValue("EstimatedSize"); err == nil && kib > 0 {
			r.SizeBytes = kib * 1024
		}
		k.Close()
		rows = append(rows, r)
	}
	return rows, true
}
