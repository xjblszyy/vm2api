package guest

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestFrameRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	for _, f := range []struct {
		kind byte
		body string
	}{{FrameStdout, "hello"}, {FrameStderr, ""}, {FrameExit, "3"}} {
		if err := WriteFrame(&buf, f.kind, []byte(f.body)); err != nil {
			t.Fatal(err)
		}
	}
	for _, want := range []string{"hello", "", "3"} {
		_, got, err := ReadFrame(&buf)
		if err != nil || string(got) != want {
			t.Fatalf("frame = %q, %v; want %q", got, err, want)
		}
	}
	if _, _, err := ReadFrame(&buf); !errors.Is(err, io.EOF) {
		t.Fatalf("want EOF, got %v", err)
	}
}

func TestReadFrameRejectsOversize(t *testing.T) {
	hdr := []byte{FrameStdout, 0xff, 0xff, 0xff, 0xff}
	if _, _, err := ReadFrame(bytes.NewReader(hdr)); err == nil {
		t.Fatal("oversize frame accepted")
	}
}

func TestReadRequestRequiresArgv(t *testing.T) {
	var buf bytes.Buffer
	_ = WriteRequest(&buf, ExecRequest{})
	if _, err := ReadRequest(&buf); err == nil {
		t.Fatal("empty argv accepted")
	}
}

// fakeHybrid mimics Cloud Hypervisor's vsock unix socket: "CONNECT <port>\n" -> "OK <n>\n".
func fakeHybrid(t *testing.T, handlers map[uint32]func(net.Conn)) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "kg")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	path := filepath.Join(dir, "v.sock")
	ln, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				line, err := readLine(c)
				if err != nil {
					c.Close()
					return
				}
				var port uint32
				if _, err = fmt.Sscanf(line, "CONNECT %d", &port); err != nil || handlers[port] == nil {
					c.Close()
					return
				}
				fmt.Fprintf(c, "OK 1073741824\n")
				handlers[port](c)
			}()
		}
	}()
	return path
}

func TestDialHybridRejectsBadHandshake(t *testing.T) {
	path := fakeHybrid(t, map[uint32]func(net.Conn){})
	if _, err := DialHybrid(path, 9, time.Second); err == nil {
		t.Fatal("handshake to a closed port succeeded")
	}
}

func TestExecStreamsOutputAndExitCode(t *testing.T) {
	path := fakeHybrid(t, map[uint32]func(net.Conn){
		PortExec: func(c net.Conn) {
			defer c.Close()
			r := bufio.NewReader(c)
			req, err := ReadRequest(r)
			if err != nil {
				return
			}
			var in strings.Builder
			for {
				kind, buf, err := ReadFrame(r)
				if err != nil || kind == FrameEOF {
					break
				}
				in.Write(buf)
			}
			_ = WriteFrame(c, FrameStdout, []byte(strings.Join(req.Argv, " ")+"|"+req.User+"|"+in.String()))
			_ = WriteFrame(c, FrameStderr, []byte("warn"))
			_ = WriteFrame(c, FrameExit, []byte("7"))
		},
	})
	var out, errb bytes.Buffer
	err := Exec(path, ExecRequest{Argv: []string{"echo", "hi"}, User: "10001:987", Stdin: true}, strings.NewReader("payload"), &out, &errb)
	var exit ExitError
	if !errors.As(err, &exit) || exit.Code != 7 {
		t.Fatalf("err = %v, want exit 7", err)
	}
	if out.String() != "echo hi|10001:987|payload" || errb.String() != "warn" {
		t.Fatalf("stdout=%q stderr=%q", out.String(), errb.String())
	}
}

func TestExecWithoutExitFrameFails(t *testing.T) {
	path := fakeHybrid(t, map[uint32]func(net.Conn){
		PortExec: func(c net.Conn) {
			_, _ = ReadRequest(c)
			c.Close()
		},
	})
	err := Exec(path, ExecRequest{Argv: []string{"true"}}, nil, io.Discard, io.Discard)
	if err == nil || errors.As(err, new(ExitError)) {
		t.Fatalf("err = %v, want stream error", err)
	}
}

func TestBridgeForwardsKernelSocket(t *testing.T) {
	path := fakeHybrid(t, map[uint32]func(net.Conn){
		PortKernel: func(c net.Conn) {
			defer c.Close()
			req, _ := io.ReadAll(c) // client half-closes after the request
			_, _ = c.Write(append([]byte("echo:"), req...))
		},
	})
	listen := filepath.Join(filepath.Dir(path), "k.sock")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Bridge(ctx, listen, path, PortKernel) }()
	var conn net.Conn
	var err error
	for i := 0; i < 50; i++ {
		if conn, err = net.Dial("unix", listen); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err != nil {
		t.Fatal(err)
	}
	_, _ = conn.Write([]byte("GET /health"))
	_ = conn.(*net.UnixConn).CloseWrite()
	got, _ := io.ReadAll(conn)
	conn.Close()
	if string(got) != "echo:GET /health" {
		t.Fatalf("bridge reply %q", got)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("bridge did not stop")
	}
}
