//go:build windows

package scriptexec

import (
	"os/exec"
	"syscall"
)

// useRawCommandLine hands CreateProcess a command line built by the caller
// instead of one Go assembles from Args.
//
// Go quotes each Args entry with the C-runtime convention (backslash-escaped
// quotes). cmd.exe does not implement that convention — it reads the backslash
// as an ordinary character and the quote as end-of-quote — so an argument
// containing a quote could close its own quoting and have the rest of itself
// executed as commands. SysProcAttr.CmdLine is the documented escape hatch:
// when set, Args is ignored and this string is passed through verbatim.
//
// The executable still comes from cmd.Path (lpApplicationName), but the
// command line conventionally repeats it as its first token, so we prepend it
// quoted.
func useRawCommandLine(cmd *exec.Cmd, cmdLine string) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CmdLine = `"` + cmd.Path + `" ` + cmdLine
}
