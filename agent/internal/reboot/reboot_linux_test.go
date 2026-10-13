//go:build linux

package reboot

import "testing"

func TestParseCanReboot(t *testing.T) {
	cases := map[string]string{
		`s "yes"`:       "yes",
		`s "challenge"`: "challenge",
		` s "no" `:      "no",
		`garbage`:       "",
		``:              "",
	}
	for in, want := range cases {
		if got := parseCanReboot(in); got != want {
			t.Errorf("parseCanReboot(%q) = %q, want %q", in, got, want)
		}
	}
}
