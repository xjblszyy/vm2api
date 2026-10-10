//go:build linux

package guest

import (
	"bufio"
	"bytes"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

// Drives the real guest exec server over an in-memory conn.
func runServeExec(t *testing.T, req ExecRequest, input []byte) (stdout string, code string) {
	t.Helper()
	if _, err := os.Stat("/dev/ptmx"); err != nil && req.TTY {
		t.Skip("no /dev/ptmx")
	}
	server, client := net.Pipe()
	go serveExec(server, Boot{})
	if err := WriteRequest(client, req); err != nil {
		t.Fatal(err)
	}
	sink := &frameSink{w: client}
	if len(input) > 0 {
		go func() { _ = sink.frame(FrameStdin, input) }()
	}
	_ = client.SetDeadline(time.Now().Add(10 * time.Second))
	r := bufio.NewReader(client)
	var out bytes.Buffer
	for {
		kind, payload, err := ReadFrame(r)
		if err != nil {
			t.Fatalf("read frame: %v (out=%q)", err, out.String())
		}
		switch kind {
		case FrameStdout, FrameStderr:
			out.Write(payload)
		case FrameExit:
			client.Close()
			return out.String(), string(payload)
		}
	}
}

func TestServeExecTTYAllocatesTerminalWithSize(t *testing.T) {
	out, code := runServeExec(t, ExecRequest{
		Argv: []string{"sh", "-c", "tty; stty size; [ -t 0 ] && echo stdin-is-tty"},
		Dir:  "/",
		TTY:  true, Stdin: true, Rows: 33, Cols: 101,
	}, nil)
	if code != "0" {
		t.Fatalf("exit %s: %q", code, out)
	}
	for _, want := range []string{"/dev/pts/", "33 101", "stdin-is-tty"} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in %q", want, out)
		}
	}
}

func TestServeExecTTYForwardsInputAndExitCode(t *testing.T) {
	out, code := runServeExec(t, ExecRequest{
		Argv: []string{"sh", "-c", "read line; echo got:$line; exit 4"},
		Dir:  "/",
		TTY:  true, Stdin: true,
	}, []byte("hello\n"))
	if code != "4" || !strings.Contains(out, "got:hello") {
		t.Fatalf("exit %s out %q", code, out)
	}
}

func TestServeExecPlainKeepsStreamsSeparate(t *testing.T) {
	out, code := runServeExec(t, ExecRequest{Argv: []string{"sh", "-c", "[ -t 1 ] || echo no-tty; exit 2"}, Dir: "/"}, nil)
	if code != "2" || !strings.Contains(out, "no-tty") {
		t.Fatalf("exit %s out %q", code, out)
	}
}
