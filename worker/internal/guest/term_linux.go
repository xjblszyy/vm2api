//go:build linux

package guest

import (
	"os"
	"os/signal"
	"syscall"

	"golang.org/x/sys/unix"
)

// TermSize reports the size of a terminal fd; ok is false when it is not a tty.
func TermSize(f *os.File) (rows, cols uint16, ok bool) {
	ws, err := unix.IoctlGetWinsize(int(f.Fd()), unix.TIOCGWINSZ)
	if err != nil {
		return 0, 0, false
	}
	return ws.Row, ws.Col, true
}

// MakeRaw puts a terminal into raw mode and returns a restore func.
func MakeRaw(f *os.File) (func(), error) {
	fd := int(f.Fd())
	old, err := unix.IoctlGetTermios(fd, unix.TCGETS)
	if err != nil {
		return nil, err
	}
	raw := *old
	raw.Iflag &^= unix.IGNBRK | unix.BRKINT | unix.PARMRK | unix.ISTRIP | unix.INLCR | unix.IGNCR | unix.ICRNL | unix.IXON
	raw.Oflag &^= unix.OPOST
	raw.Lflag &^= unix.ECHO | unix.ECHONL | unix.ICANON | unix.ISIG | unix.IEXTEN
	raw.Cflag &^= unix.CSIZE | unix.PARENB
	raw.Cflag |= unix.CS8
	raw.Cc[unix.VMIN] = 1
	raw.Cc[unix.VTIME] = 0
	if err = unix.IoctlSetTermios(fd, unix.TCSETS, &raw); err != nil {
		return nil, err
	}
	return func() { _ = unix.IoctlSetTermios(fd, unix.TCSETS, old) }, nil
}

// NotifyResize delivers SIGWINCH.
func NotifyResize(ch chan<- os.Signal) { signal.Notify(ch, syscall.SIGWINCH) }
