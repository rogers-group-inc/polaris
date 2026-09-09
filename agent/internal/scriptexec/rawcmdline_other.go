//go:build !windows

package scriptexec

import "os/exec"

// useRawCommandLine is Windows-only: SysProcAttr.CmdLine does not exist
// elsewhere, and nothing off Windows produces a cmdLine — the "cmd"
// interpreter is refused on non-Windows agents in argvFor.
func useRawCommandLine(_ *exec.Cmd, _ string) {}
