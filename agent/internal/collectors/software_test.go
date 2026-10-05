package collectors

import "testing"

func TestParseDpkgQuery(t *testing.T) {
	out := "openssl\t3.0.13-0ubuntu3.4\tamd64\t2112\tii \tUbuntu Developers <ubuntu-devel-discuss@lists.ubuntu.com>\n" +
		"libfoo\t1.0\tamd64\t10\trc \tSomeone <x@y>\n" +
		"held-pkg\t2.1\tall\t\thi \tHeld Maint\n" +
		"short\tline\n" +
		"\n"
	rows := parseDpkgQuery(out)
	if len(rows) != 2 {
		t.Fatalf("want 2 installed rows, got %d: %+v", len(rows), rows)
	}
	r := rows[0]
	if r.Name != "openssl" || r.Version != "3.0.13-0ubuntu3.4" || r.Architecture != "amd64" ||
		r.SizeBytes != 2112*1024 || r.Publisher != "Ubuntu Developers" || r.Platform != "dpkg" {
		t.Fatalf("openssl row wrong: %+v", r)
	}
	if rows[1].Name != "held-pkg" || rows[1].SizeBytes != 0 || rows[1].Publisher != "Held Maint" {
		t.Fatalf("held row wrong: %+v", rows[1])
	}
}

func TestParseDpkgQueryCRLF(t *testing.T) {
	rows := parseDpkgQuery("bash\t5.2\tamd64\t7000\tii \tMaint\r\n")
	if len(rows) != 1 || rows[0].Publisher != "Maint" {
		t.Fatalf("CRLF line not parsed: %+v", rows)
	}
}

func TestParseRpmQuery(t *testing.T) {
	out := "openssl-libs\t1\t3.0.7-27.el9\tx86_64\t6094000\t1720000000\tRed Hat, Inc.\n" +
		"bash\t(none)\t5.1.8-9.el9\tx86_64\t7738000\t1710000000\tRed Hat, Inc.\n" +
		"gpg-pubkey\t(none)\tfd431d51-4ae0493b\t(none)\t0\t1700000000\t(none)\n" +
		"tzdata\t0\t2024a-1.el9\tnoarch\t1700000\t0\t(none)\n"
	rows := parseRpmQuery(out)
	if len(rows) != 3 {
		t.Fatalf("want 3 rows (gpg-pubkey skipped), got %d: %+v", len(rows), rows)
	}
	if rows[0].Version != "1:3.0.7-27.el9" || rows[0].InstallDate != "2024-07-03" || rows[0].SizeBytes != 6094000 {
		t.Fatalf("epoch row wrong: %+v", rows[0])
	}
	if rows[1].Version != "5.1.8-9.el9" || rows[1].Publisher != "Red Hat, Inc." {
		t.Fatalf("no-epoch row wrong: %+v", rows[1])
	}
	if rows[2].Version != "2024a-1.el9" || rows[2].InstallDate != "" || rows[2].Publisher != "" {
		t.Fatalf("zero epoch / no install time / (none) vendor wrong: %+v", rows[2])
	}
}

func TestNormalizeRegistryInstallDate(t *testing.T) {
	cases := map[string]string{
		"20240115":   "2024-01-15",
		" 20240115 ": "2024-01-15",
		"2024-01-15": "",
		"00000000":   "",
		"20241399":   "",
		"19700101":   "",
		"":           "",
	}
	for in, want := range cases {
		if got := normalizeRegistryInstallDate(in); got != want {
			t.Errorf("normalizeRegistryInstallDate(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRegistryEntryVisible(t *testing.T) {
	if !registryEntryVisible("7-Zip 24.08 (x64)", 0, "", "") {
		t.Error("plain program should be visible")
	}
	if registryEntryVisible("", 0, "", "") {
		t.Error("no DisplayName should be hidden")
	}
	if registryEntryVisible("Microsoft Visual C++ 2022 X64 Minimum Runtime", 1, "", "") {
		t.Error("SystemComponent=1 should be hidden")
	}
	if registryEntryVisible("Update for Office", 0, "Office16.PROPLUS", "") {
		t.Error("child of a ParentKeyName should be hidden")
	}
	if registryEntryVisible("KB123", 0, "", "Security Update") {
		t.Error("security update should be hidden")
	}
}

func TestSoftwareSamplesDedupeAndSort(t *testing.T) {
	got := softwareSamples([]softwareRaw{
		{Name: "zlib", Version: "1.3", Architecture: "x64", Platform: "windows"},
		{Name: "  Git  ", Version: "2.46.0", Architecture: "x64", Publisher: " The Git Development Community ", InstallDate: "2024-08-01", SizeBytes: 300, Platform: "windows"},
		{Name: "git", Version: "2.46.0", Architecture: "x64", Platform: "windows"}, // same key, different case
		{Name: "Git", Version: "2.46.0", Architecture: "x86", Platform: "windows"}, // different arch is a different row
		{Name: "", Version: "1", Platform: "windows"},
	})
	if len(got) != 3 {
		t.Fatalf("want 3 rows, got %d", len(got))
	}
	if got[0].Name != "Git" || got[2].Name != "zlib" {
		t.Fatalf("not sorted by name: %s, %s, %s", got[0].Name, got[1].Name, got[2].Name)
	}
	if *got[0].Publisher != "The Git Development Community" || *got[0].SizeBytes != 300 || *got[0].InstallDate != "2024-08-01" {
		t.Fatalf("first row fields wrong: %+v", got[0])
	}
	if got[2].Publisher != nil || got[2].SizeBytes != nil || got[2].InstallDate != nil {
		t.Fatalf("empty fields should be omitted: %+v", got[2])
	}
}

func TestSoftwareSamplesEmptyIsNonNil(t *testing.T) {
	if got := softwareSamples([]softwareRaw{}); got == nil || len(got) != 0 {
		t.Fatalf("an empty read must stay a non-nil empty push, got %#v", got)
	}
}
