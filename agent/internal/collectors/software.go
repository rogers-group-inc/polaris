package collectors

import (
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/polaris/agent/internal/transport"
)

// Installed-software inventory — the programs a host has INSTALLED, as opposed
// to the processes it is running (processes.go) or the units it has registered
// (services.go). Current state: the server diffs each push against what it
// holds and writes only the change, so the full list is sent every time.
//
// Platform readers (software_windows.go / software_linux.go) return []softwareRaw;
// everything below is untagged and pure so the parsing and the normalization
// are unit-tested on every platform the tests run on.
//
//   - Windows: the Uninstall registry keys under HKLM, both the 64-bit and the
//     32-bit (WOW6432Node) views — the list "Apps & features" draws from. Never
//     Win32_Product: enumerating it makes Windows Installer consistency-check
//     (and sometimes repair) every MSI package on the box.
//   - Linux: dpkg-query when the host has dpkg, else rpm.
//
// Per-user installs (HKU\<sid>\...\Uninstall) are not read: the agent runs as a
// service and would have to load every profile's hive to see them.

type softwareRaw struct {
	Name         string
	Version      string
	Publisher    string
	Architecture string
	// InstallDate as YYYY-MM-DD, "" when the platform does not record one.
	InstallDate string
	SizeBytes   uint64
	// "windows" | "dpkg" | "rpm" — which package database the row came from.
	Platform string
}

// SoftwareInventoryOnce returns the host's installed software, sorted by name
// then version so the push is stable across scrapes. nil means the platform has
// no supported package database or the read failed — the server treats a nil
// push as "leave the inventory alone", never as "everything was uninstalled".
func SoftwareInventoryOnce() []*transport.SoftwareSample {
	raws := softwareInventoryOnce()
	if raws == nil {
		return nil
	}
	return softwareSamples(raws)
}

// softwareSamples trims, drops nameless rows, de-duplicates on the server's
// key (name + version + architecture, case-insensitive — a 32-bit OS answers
// both registry views with the same key) and sorts. Pure.
func softwareSamples(raws []softwareRaw) []*transport.SoftwareSample {
	seen := make(map[string]bool, len(raws))
	out := make([]*transport.SoftwareSample, 0, len(raws))
	for _, r := range raws {
		name := strings.TrimSpace(r.Name)
		if name == "" {
			continue
		}
		version := strings.TrimSpace(r.Version)
		arch := strings.TrimSpace(r.Architecture)
		k := strings.ToLower(name + "\x00" + version + "\x00" + arch)
		if seen[k] {
			continue
		}
		seen[k] = true
		s := &transport.SoftwareSample{Name: name, Platform: r.Platform}
		s.Version = optString(version)
		s.Publisher = optString(strings.TrimSpace(r.Publisher))
		s.Architecture = optString(arch)
		s.InstallDate = optString(r.InstallDate)
		if r.SizeBytes > 0 {
			v := r.SizeBytes
			s.SizeBytes = &v
		}
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if a != b {
			return a < b
		}
		return derefString(out[i].Version) < derefString(out[j].Version)
	})
	return out
}

func optString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func derefString(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// normalizeRegistryInstallDate turns the Uninstall key's InstallDate
// (YYYYMMDD, as Windows Installer writes it) into YYYY-MM-DD. Anything else —
// a locale-formatted date some installers write, a zero date — returns "":
// a wrong date is worse than none. Pure.
func normalizeRegistryInstallDate(s string) string {
	s = strings.TrimSpace(s)
	if len(s) != 8 {
		return ""
	}
	t, err := time.Parse("20060102", s)
	if err != nil || t.Year() < 1980 {
		return ""
	}
	return t.Format("2006-01-02")
}

// registryEntryVisible applies the rules "Apps & features" uses to decide
// whether an Uninstall subkey is a program a person installed: it has a
// DisplayName, is not a SystemComponent (the MSI halves behind a bundle such
// as a Visual C++ redistributable), and is not an update hanging off a parent
// (ParentKeyName / an update ReleaseType). Pure.
func registryEntryVisible(displayName string, systemComponent uint64, parentKeyName, releaseType string) bool {
	if strings.TrimSpace(displayName) == "" || systemComponent == 1 {
		return false
	}
	if strings.TrimSpace(parentKeyName) != "" {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(releaseType)) {
	case "security update", "update rollup", "hotfix", "update":
		return false
	}
	return true
}

// dpkgQueryFormat is the -f argument parseDpkgQuery reads: one tab-separated
// line per package. Installed-Size is KiB; Status-Abbrev's first two letters
// say whether the package is actually installed ("ii", or "hi" when held).
const dpkgQueryFormat = "${Package}\\t${Version}\\t${Architecture}\\t${Installed-Size}\\t${db:Status-Abbrev}\\t${Maintainer}\\n"

// parseDpkgQuery parses dpkg-query output in dpkgQueryFormat. Packages that
// are removed-but-configured ("rc") or half-installed are skipped: only the
// installed state is software on the box. Pure.
func parseDpkgQuery(out string) []softwareRaw {
	rows := []softwareRaw{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) < 5 {
			continue
		}
		status := strings.TrimSpace(f[4])
		if !strings.HasPrefix(status, "ii") && !strings.HasPrefix(status, "hi") {
			continue
		}
		r := softwareRaw{Name: f[0], Version: f[1], Architecture: f[2], Platform: "dpkg"}
		if kib, err := strconv.ParseUint(strings.TrimSpace(f[3]), 10, 64); err == nil {
			r.SizeBytes = kib * 1024
		}
		if len(f) > 5 {
			r.Publisher = maintainerName(f[5])
		}
		rows = append(rows, r)
	}
	return rows
}

// maintainerName keeps the name half of "Ubuntu Developers <ubuntu-devel@…>" —
// the address is noise in a Publisher column. Pure.
func maintainerName(m string) string {
	if i := strings.Index(m, "<"); i >= 0 {
		m = m[:i]
	}
	return strings.TrimSpace(m)
}

// rpmQueryFormat is the --queryformat parseRpmQuery reads. %{EPOCH} prints
// "(none)" when unset; INSTALLTIME is unix seconds; SIZE is bytes.
const rpmQueryFormat = "%{NAME}\\t%{EPOCH}\\t%{VERSION}-%{RELEASE}\\t%{ARCH}\\t%{SIZE}\\t%{INSTALLTIME}\\t%{VENDOR}\\n"

// parseRpmQuery parses rpm -qa output in rpmQueryFormat. The gpg-pubkey
// pseudo-packages (imported signing keys, one per repository) are skipped. A
// non-zero epoch is kept in the version as "E:V-R", the form dnf prints. Pure.
func parseRpmQuery(out string) []softwareRaw {
	rows := []softwareRaw{}
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		f := strings.Split(line, "\t")
		if len(f) < 6 || f[0] == "gpg-pubkey" {
			continue
		}
		version := f[2]
		if e := strings.TrimSpace(f[1]); e != "" && e != "(none)" && e != "0" {
			version = e + ":" + version
		}
		r := softwareRaw{Name: f[0], Version: version, Architecture: noneToEmpty(f[3]), Platform: "rpm"}
		if b, err := strconv.ParseUint(strings.TrimSpace(f[4]), 10, 64); err == nil {
			r.SizeBytes = b
		}
		if sec, err := strconv.ParseInt(strings.TrimSpace(f[5]), 10, 64); err == nil && sec > 0 {
			r.InstallDate = time.Unix(sec, 0).UTC().Format("2006-01-02")
		}
		if len(f) > 6 {
			r.Publisher = noneToEmpty(f[6])
		}
		rows = append(rows, r)
	}
	return rows
}

func noneToEmpty(s string) string {
	s = strings.TrimSpace(s)
	if s == "(none)" {
		return ""
	}
	return s
}
