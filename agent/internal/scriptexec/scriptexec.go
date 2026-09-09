// Package scriptexec executes automation scripts pushed from the Polaris
// server via the AgentCommand queue (action="run_script").
//
// SECURITY MODEL — this executes server-supplied code as the agent's user
// (root / LocalSystem), so the package enforces every defense the wire can't:
//   - the payload's sha256 must match the body (a tampered/truncated payload
//     is refused before anything touches disk),
//   - the body is written to a 0700 temp file that is ALWAYS removed,
//   - the args string travels as ONE argv entry — never shell-interpolated —
//     EXCEPT for the "cmd" interpreter, which has no argv to travel in:
//     `cmd /c` re-parses the raw command line with its own grammar, so that
//     one path is escaped by cmdCommandLine() and handed to CreateProcess
//     verbatim (see the comment there),
//   - execution is bounded by the payload's timeout (process killed) and
//     stdout/stderr are capped at 64 KB each,
//   - unknown interpreters are refused (the list mirrors
//     notificationTypes.SCRIPT_INTERPRETERS on the server).
//
// Polaris-side counterpart: automationScriptRunner.ts (same caps + argv
// posture for server-side runs — keep the two in lockstep).
package scriptexec

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
	"unicode"
)

// Payload mirrors the server's AgentCommand.payload for action="run_script".
type Payload struct {
	RunID       string `json:"runId"`
	Interpreter string `json:"interpreter"` // bash | sh | powershell | cmd | python3
	Body        string `json:"body"`
	Sha256      string `json:"sha256"`
	Args        string `json:"args"`
	TimeoutSec  int    `json:"timeoutSec"`
}

// Result is what the agent reports back via /command-result.
type Result struct {
	Status   string // "succeeded" | "failed" | "timeout"
	ExitCode int    // -1 when unknown (refused / killed before exit)
	Stdout   string
	Stderr   string
}

const outputCapBytes = 64 * 1024
const defaultTimeoutSec = 60
const maxTimeoutSec = 600

// ParsePayload decodes and sanity-checks a run_script payload.
func ParsePayload(raw json.RawMessage) (*Payload, error) {
	if len(raw) == 0 {
		return nil, fmt.Errorf("run_script command carried no payload")
	}
	var p Payload
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, fmt.Errorf("run_script payload malformed: %w", err)
	}
	if p.RunID == "" || p.Body == "" || p.Sha256 == "" {
		return nil, fmt.Errorf("run_script payload missing runId/body/sha256")
	}
	return &p, nil
}

func extensionFor(interpreter string) string {
	switch interpreter {
	case "powershell":
		return ".ps1"
	case "cmd":
		return ".cmd"
	case "python3":
		return ".py"
	default:
		return ".sh"
	}
}

// cmdMetaRe are the cmd.exe metacharacters, all of which "^" neutralises.
var cmdMetaRe = regexp.MustCompile(`[()<>&|^]`)

// cmdArgRepresentable reports whether args can be handed to cmd.exe literally.
// A quote ends the quoted token (cmd has no in-quote escape for one) and % / !
// are expanded by the parser before the script sees them; control characters
// end the command line (CR, LF), truncate it (NUL) or are still end-of-file to
// cmd (0x1A). "^" helps with none of these.
func cmdArgRepresentable(args string) bool {
	if strings.ContainsAny(args, "\"%!") {
		return false
	}
	for _, r := range args {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// cmdCommandLine builds the whole command line for cmd.exe, which is the one
// interpreter here with no argv: `cmd /c` re-parses the raw command line, so
// passing it a Go-quoted argument vector executed whatever an argument chose
// to inject. Args reach the agent from the server's rendered argsTemplate,
// which interpolates alert context — a device's own hostname can land here.
//
// Three things have to hold at once, each verified against a real cmd.exe:
//  1. every metacharacter is "^"-escaped — quoting ALONE does not stop a pipe,
//  2. the whole command is wrapped in one further quote pair, because /s strips
//     the first and last character of the remainder when both are quotes,
//  3. the caller passes this to CreateProcess VERBATIM (SysProcAttr.CmdLine on
//     Windows). Letting Go re-quote it with the C-runtime rules that cmd.exe
//     does not implement is the original bug.
//
// Keep in lockstep with buildCmdCommandLine() in automationScriptRunner.ts.
func cmdCommandLine(scriptPath, args string) (string, error) {
	if args != "" && !cmdArgRepresentable(args) {
		return "", fmt.Errorf(`arguments for the cmd interpreter cannot contain " %% ! or a control character — cmd.exe expands or re-parses those before the script sees them`)
	}
	inner := `"` + scriptPath + `"`
	if args != "" {
		esc := cmdMetaRe.ReplaceAllStringFunc(args, func(s string) string { return "^" + s })
		inner += ` "` + esc + `"`
	}
	return `/d /s /c "` + inner + `"`, nil
}

// argvFor resolves the interpreter invocation for this OS. The script path and
// the args string are appended as discrete argv entries — except for "cmd",
// which returns a non-empty cmdLine instead, to be passed through verbatim.
func argvFor(interpreter, scriptPath, args string) (bin string, argv []string, cmdLine string, err error) {
	tail := []string{}
	if args != "" {
		tail = append(tail, args)
	}
	switch interpreter {
	case "bash", "sh", "python3":
		if runtime.GOOS == "windows" {
			return "", nil, "", fmt.Errorf("interpreter %q is not supported on Windows agents", interpreter)
		}
		return interpreter, append([]string{scriptPath}, tail...), "", nil
	case "powershell":
		bin = "pwsh"
		if runtime.GOOS == "windows" {
			bin = "powershell.exe"
		}
		return bin, append([]string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath}, tail...), "", nil
	case "cmd":
		if runtime.GOOS != "windows" {
			return "", nil, "", fmt.Errorf("interpreter \"cmd\" is only supported on Windows agents")
		}
		line, cerr := cmdCommandLine(scriptPath, args)
		if cerr != nil {
			return "", nil, "", cerr
		}
		return "cmd.exe", append([]string{"/d", "/s", "/c", scriptPath}, tail...), line, nil
	default:
		return "", nil, "", fmt.Errorf("unknown interpreter %q — refusing to execute", interpreter)
	}
}

func cap64k(b []byte) string {
	if len(b) > outputCapBytes {
		return string(b[:outputCapBytes])
	}
	return string(b)
}

// Run verifies and executes one script payload. Never panics; every refusal
// or failure comes back as a Result with Status "failed"/"timeout".
func Run(p *Payload) Result {
	// Integrity gate first — refuse anything whose hash doesn't match.
	sum := sha256.Sum256([]byte(p.Body))
	if !strings.EqualFold(hex.EncodeToString(sum[:]), p.Sha256) {
		return Result{Status: "failed", ExitCode: -1, Stderr: "payload sha256 mismatch — refusing to execute"}
	}

	timeout := p.TimeoutSec
	if timeout <= 0 {
		timeout = defaultTimeoutSec
	}
	if timeout > maxTimeoutSec {
		timeout = maxTimeoutSec
	}

	dir, err := os.MkdirTemp("", "polaris-script-")
	if err != nil {
		return Result{Status: "failed", ExitCode: -1, Stderr: fmt.Sprintf("temp dir: %v", err)}
	}
	defer os.RemoveAll(dir)
	scriptPath := filepath.Join(dir, "run"+extensionFor(p.Interpreter))
	if err := os.WriteFile(scriptPath, []byte(p.Body), 0o700); err != nil {
		return Result{Status: "failed", ExitCode: -1, Stderr: fmt.Sprintf("write script: %v", err)}
	}

	bin, argv, cmdLine, err := argvFor(p.Interpreter, scriptPath, p.Args)
	if err != nil {
		return Result{Status: "failed", ExitCode: -1, Stderr: err.Error()}
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, argv...)
	// cmd.exe only: hand CreateProcess the line cmdCommandLine already escaped,
	// instead of letting Go re-quote argv with C-runtime rules cmd.exe does not
	// implement. No-op off Windows, where nothing reaches this with a cmdLine.
	if cmdLine != "" {
		useRawCommandLine(cmd, cmdLine)
	}
	cmd.Env = append(os.Environ(), "POLARIS_RUN_ID="+p.RunID)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limitedWriter{buf: &stdout}
	cmd.Stderr = &limitedWriter{buf: &stderr}

	runErr := cmd.Run()
	out := cap64k(stdout.Bytes())
	errOut := cap64k(stderr.Bytes())

	if ctx.Err() == context.DeadlineExceeded {
		return Result{Status: "timeout", ExitCode: -1, Stdout: out, Stderr: errOut}
	}
	if runErr != nil {
		exitCode := -1
		if ee, ok := runErr.(*exec.ExitError); ok {
			exitCode = ee.ExitCode()
		}
		if errOut == "" {
			errOut = runErr.Error()
		}
		return Result{Status: "failed", ExitCode: exitCode, Stdout: out, Stderr: errOut}
	}
	return Result{Status: "succeeded", ExitCode: 0, Stdout: out, Stderr: errOut}
}

// limitedWriter stops accepting bytes past the cap but never errors — a
// chatty script keeps running; only its captured output is truncated.
type limitedWriter struct {
	buf *bytes.Buffer
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if w.buf.Len() < outputCapBytes {
		remain := outputCapBytes - w.buf.Len()
		if len(p) > remain {
			w.buf.Write(p[:remain])
		} else {
			w.buf.Write(p)
		}
	}
	return len(p), nil
}
