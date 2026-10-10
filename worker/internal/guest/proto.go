// Package guest is the KVM slot plumbing: a guest PID1, a host-side
// kernel.sock bridge, and an exec channel. Host and guest talk over
// Cloud Hypervisor hybrid vsock: the host dials a unix socket and sends
// "CONNECT <port>\n"; the guest listens on AF_VSOCK.
package guest

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

const (
	// PortKernel carries raw kernel.sock bytes (HTTP over the stream).
	PortKernel = 1024
	// PortExec runs one command per connection.
	PortExec = 1025
	// PortPower: any connection asks the guest PID1 to power off.
	PortPower = 1026
)

// ExecRequest is the first frame on PortExec.
type ExecRequest struct {
	Argv   []string `json:"argv"`
	Env    []string `json:"env,omitempty"`
	User   string   `json:"user,omitempty"`
	Dir    string   `json:"dir,omitempty"`
	Detach bool     `json:"detach,omitempty"`
	Stdin  bool     `json:"stdin,omitempty"`
	// TTY runs the command on a guest pseudo-terminal (docker exec -t).
	// Output then arrives as FrameStdout only, and FrameResize carries the size.
	TTY  bool   `json:"tty,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
}

// Exec stream frames. Each frame is 1 type byte + 4 byte big-endian length + payload.
const (
	FrameStdin  byte = 0
	FrameStdout byte = 1
	FrameStderr byte = 2
	FrameExit   byte = 3
	FrameEOF    byte = 4
	// FrameResize payload: rows and cols as two big-endian uint16.
	FrameResize byte = 5
)

func ResizePayload(rows, cols uint16) []byte {
	var b [4]byte
	binary.BigEndian.PutUint16(b[0:], rows)
	binary.BigEndian.PutUint16(b[2:], cols)
	return b[:]
}

func ParseResize(p []byte) (rows, cols uint16, ok bool) {
	if len(p) != 4 {
		return 0, 0, false
	}
	return binary.BigEndian.Uint16(p[0:]), binary.BigEndian.Uint16(p[2:]), true
}

const maxFrame = 1 << 20

func WriteFrame(w io.Writer, kind byte, payload []byte) error {
	var hdr [5]byte
	hdr[0] = kind
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if len(payload) == 0 {
		return nil
	}
	_, err := w.Write(payload)
	return err
}

func ReadFrame(r io.Reader) (byte, []byte, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	if n > maxFrame {
		return 0, nil, fmt.Errorf("frame too large: %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	return hdr[0], buf, nil
}

func WriteRequest(w io.Writer, req ExecRequest) error {
	raw, err := json.Marshal(req)
	if err != nil {
		return err
	}
	return WriteFrame(w, FrameStdin, raw)
}

func ReadRequest(r io.Reader) (ExecRequest, error) {
	var req ExecRequest
	_, raw, err := ReadFrame(r)
	if err != nil {
		return req, err
	}
	if err = json.Unmarshal(raw, &req); err != nil {
		return req, err
	}
	if len(req.Argv) == 0 {
		return req, errors.New("empty argv")
	}
	return req, nil
}

// DialHybrid opens a guest port through the Cloud Hypervisor vsock unix socket.
func DialHybrid(socketPath string, port uint32, timeout time.Duration) (net.Conn, error) {
	conn, err := net.DialTimeout("unix", socketPath, timeout)
	if err != nil {
		return nil, err
	}
	_ = conn.SetDeadline(time.Now().Add(timeout))
	if _, err = fmt.Fprintf(conn, "CONNECT %d\n", port); err != nil {
		conn.Close()
		return nil, err
	}
	// The reply is exactly one line; read byte-wise so no payload is buffered away.
	line, err := readLine(conn)
	if err != nil {
		conn.Close()
		return nil, fmt.Errorf("vsock handshake: %w", err)
	}
	if !strings.HasPrefix(line, "OK ") {
		conn.Close()
		return nil, fmt.Errorf("vsock handshake: %q", line)
	}
	_ = conn.SetDeadline(time.Time{})
	return conn, nil
}

func readLine(r io.Reader) (string, error) {
	var b strings.Builder
	one := make([]byte, 1)
	for b.Len() < 128 {
		if _, err := io.ReadFull(r, one); err != nil {
			return "", err
		}
		if one[0] == '\n' {
			return b.String(), nil
		}
		b.WriteByte(one[0])
	}
	return "", errors.New("handshake line too long")
}
