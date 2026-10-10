package guest

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strconv"
	"sync"
	"time"
)

// Bridge serves listenPath (the slot's run/kernel.sock) and forwards each
// connection to the guest kernel over hybrid vsock. The control plane keeps
// dialing the same unix socket it uses for Docker slots.
func Bridge(ctx context.Context, listenPath, vsockPath string, port uint32) error {
	_ = os.Remove(listenPath)
	ln, err := net.Listen("unix", listenPath)
	if err != nil {
		return err
	}
	_ = os.Chmod(listenPath, 0o666)
	go func() {
		<-ctx.Done()
		ln.Close()
	}()
	for {
		c, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		go func() {
			defer c.Close()
			g, err := DialHybrid(vsockPath, port, 3*time.Second)
			if err != nil {
				log.Printf("bridge: %v", err)
				return
			}
			defer g.Close()
			pipeConns(c, g)
		}()
	}
}

func pipeConns(a, b net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)
	cp := func(dst, src net.Conn) {
		defer wg.Done()
		_, _ = io.Copy(dst, src)
		if cw, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = cw.CloseWrite()
		} else {
			_ = dst.Close()
		}
	}
	go cp(a, b)
	go cp(b, a)
	wg.Wait()
}

// ExitError carries the guest command's exit status.
type ExitError struct{ Code int }

func (e ExitError) Error() string { return "exit status " + strconv.Itoa(e.Code) }

// Exec runs req in the guest. stdin is streamed only when req.Stdin is set.
func Exec(vsockPath string, req ExecRequest, stdin io.Reader, stdout, stderr io.Writer) error {
	conn, err := DialHybrid(vsockPath, PortExec, 5*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err = WriteRequest(conn, req); err != nil {
		return err
	}
	if req.Stdin && stdin != nil {
		go func() {
			buf := make([]byte, 32*1024)
			for {
				n, rerr := stdin.Read(buf)
				if n > 0 {
					if WriteFrame(conn, FrameStdin, buf[:n]) != nil {
						return
					}
				}
				if rerr != nil {
					_ = WriteFrame(conn, FrameEOF, nil)
					return
				}
			}
		}()
	}
	for {
		kind, payload, err := ReadFrame(conn)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return errors.New("guest closed exec stream without exit status")
			}
			return err
		}
		switch kind {
		case FrameStdout:
			_, _ = stdout.Write(payload)
		case FrameStderr:
			_, _ = stderr.Write(payload)
		case FrameExit:
			code, perr := strconv.Atoi(string(payload))
			if perr != nil {
				return fmt.Errorf("bad exit frame %q", payload)
			}
			if code != 0 {
				return ExitError{Code: code}
			}
			return nil
		}
	}
}
