//go:build linux

package guest

import (
	"fmt"
	"os"
	"strconv"
	"unsafe"

	"golang.org/x/sys/unix"
)

// openPTY allocates a pseudo-terminal pair from /dev/ptmx.
func openPTY() (master, slave *os.File, err error) {
	m, err := os.OpenFile("/dev/ptmx", os.O_RDWR|unix.O_NOCTTY|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, nil, err
	}
	unlock := 0
	if err = unix.IoctlSetPointerInt(int(m.Fd()), unix.TIOCSPTLCK, unlock); err != nil {
		m.Close()
		return nil, nil, fmt.Errorf("unlockpt: %w", err)
	}
	n, err := unix.IoctlGetInt(int(m.Fd()), unix.TIOCGPTN)
	if err != nil {
		m.Close()
		return nil, nil, fmt.Errorf("ptsname: %w", err)
	}
	s, err := os.OpenFile("/dev/pts/"+strconv.Itoa(n), os.O_RDWR|unix.O_NOCTTY, 0)
	if err != nil {
		m.Close()
		return nil, nil, err
	}
	return m, s, nil
}

func setWinsize(f *os.File, rows, cols uint16) {
	if rows == 0 || cols == 0 {
		return
	}
	ws := unix.Winsize{Row: rows, Col: cols}
	_, _, _ = unix.Syscall(unix.SYS_IOCTL, f.Fd(), unix.TIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
}
