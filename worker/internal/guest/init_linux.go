//go:build linux

package guest

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Guest-side layout. /run/kin and /home/kincli come from the runner over virtiofs.
const (
	SharedRunDir    = "/run/kin"
	GuestRunDir     = "/run/kin-guest"
	SharedKernelCfg = "/run/kin/kernel.json"
	GuestKernelCfg  = "/run/kin-guest/kernel.json"
	GuestKernelSock = "/run/kin-guest/kernel.sock"
	GuestBootFile   = "/run/kin/guest.json"
	HostKinDir      = "/opt/kin"
	HostBinDir      = "/opt/kin/bin"
	wrapKernel      = "/home/kincli/.kin/kin-kernel"
	imageKernel     = "/opt/kin/kin-kernel"
	bakedKernel     = "/usr/local/bin/kin-kernel"
)

// Boot is written by the runner before the VM starts; the guest applies it once.
type Boot struct {
	Hostname  string   `json:"hostname"`
	MachineID string   `json:"machine_id"`
	IP        string   `json:"ip"`
	Gateway   string   `json:"gateway"`
	DNS       []string `json:"dns"`
	User      string   `json:"user"`
	Env       []string `json:"env"`
	Kernel    bool     `json:"kernel"`
	// Mounts are extra virtiofs shares (nested binds the runner exported separately).
	Mounts []Mount `json:"mounts"`
}

type Mount struct {
	Tag  string `json:"tag"`
	Path string `json:"path"`
}

type mountSpec struct {
	src, dst, fstype, data string
	flags                  uintptr
}

// RunInit is the guest PID1. It never returns on success.
func RunInit() error {
	log.SetFlags(0)
	log.SetPrefix("kin-guest: ")
	// The kernel starts init with an empty environment; exec.LookPath needs PATH.
	_ = os.Setenv("PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	for _, m := range []mountSpec{
		{"proc", "/proc", "proc", "", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC},
		{"sysfs", "/sys", "sysfs", "", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC},
		{"devtmpfs", "/dev", "devtmpfs", "mode=0755", unix.MS_NOSUID},
		{"devpts", "/dev/pts", "devpts", "gid=5,mode=620,ptmxmode=666", unix.MS_NOSUID | unix.MS_NOEXEC},
		{"tmpfs", "/dev/shm", "tmpfs", "mode=1777", unix.MS_NOSUID | unix.MS_NODEV},
		{"tmpfs", "/run", "tmpfs", "mode=0755", unix.MS_NOSUID | unix.MS_NODEV},
		{"tmpfs", "/tmp", "tmpfs", "mode=1777", unix.MS_NOSUID | unix.MS_NODEV},
		{"cgroup2", "/sys/fs/cgroup", "cgroup2", "", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_NOEXEC},
		{"kinrun", SharedRunDir, "virtiofs", "", unix.MS_NOSUID | unix.MS_NODEV},
		{"kinhome", "/home/kincli", "virtiofs", "", unix.MS_NOSUID | unix.MS_NODEV},
		{"kinbin", HostKinDir, "virtiofs", "", unix.MS_NOSUID | unix.MS_NODEV | unix.MS_RDONLY},
	} {
		if err := mountOne(m); err != nil {
			// /run/kin and the home are the slot: without them there is nothing to serve.
			if m.src == "kinrun" || m.src == "kinhome" {
				return err
			}
			log.Printf("mount %s: %v", m.dst, err)
		}
	}
	if err := os.MkdirAll(GuestRunDir, 0o755); err != nil {
		return err
	}
	linkHostBins()
	boot, err := readBoot(GuestBootFile)
	if err != nil {
		return err
	}
	for _, m := range boot.Mounts {
		if err = mountOne(mountSpec{m.Tag, m.Path, "virtiofs", "", unix.MS_NOSUID | unix.MS_NODEV}); err != nil {
			return err
		}
	}
	if err = applyIdentity(boot); err != nil {
		return err
	}
	if err = applyNetwork(boot); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go reapLoop(ctx)
	go serveVsock(ctx, PortExec, func(c net.Conn) { serveExec(c, boot) })
	go serveVsock(ctx, PortKernel, func(c net.Conn) { proxyUnix(c, GuestKernelSock) })
	if boot.Kernel {
		go superviseKernel(ctx, boot)
	}
	log.Printf("ready hostname=%s ip=%s", boot.Hostname, boot.IP)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT, syscall.SIGPWR)
	// No ACPI daemon runs in the guest; the runner asks for poweroff over vsock.
	stop := make(chan struct{}, 1)
	go serveVsock(ctx, PortPower, func(c net.Conn) {
		c.Close()
		select {
		case stop <- struct{}{}:
		default:
		}
	})
	select {
	case <-sig:
	case <-stop:
	}
	log.Printf("poweroff")
	cancel()
	_ = syscall.Kill(-1, syscall.SIGTERM)
	time.Sleep(2 * time.Second)
	_ = syscall.Kill(-1, syscall.SIGKILL)
	unix.Sync()
	return unix.Reboot(unix.LINUX_REBOOT_CMD_POWER_OFF)
}

// linkHostBins exposes the host's kin-worker / kin-kernel (virtiofs "kinbin")
// at the paths a Docker slot bind-mounts them to, so exec callers need no branch.
func linkHostBins() {
	entries, err := os.ReadDir(HostBinDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		dst := "/usr/local/bin/" + e.Name()
		_ = os.Remove(dst)
		if err := os.Symlink(HostBinDir+"/"+e.Name(), dst); err != nil {
			log.Printf("link %s: %v", dst, err)
		}
	}
}

func mountOne(m mountSpec) error {
	if err := os.MkdirAll(m.dst, 0o755); err != nil {
		return err
	}
	if err := unix.Mount(m.src, m.dst, m.fstype, m.flags, m.data); err != nil && !errors.Is(err, unix.EBUSY) {
		return fmt.Errorf("mount %s (%s): %w", m.dst, m.fstype, err)
	}
	return nil
}

func readBoot(path string) (Boot, error) {
	var boot Boot
	raw, err := os.ReadFile(path)
	if err != nil {
		return boot, fmt.Errorf("read %s: %w", path, err)
	}
	if err = json.Unmarshal(raw, &boot); err != nil {
		return boot, fmt.Errorf("decode %s: %w", path, err)
	}
	if boot.IP == "" || boot.Gateway == "" {
		return boot, errors.New("guest.json: ip and gateway are required")
	}
	return boot, nil
}

func applyIdentity(boot Boot) error {
	if boot.Hostname != "" {
		if err := unix.Sethostname([]byte(boot.Hostname)); err != nil {
			return fmt.Errorf("sethostname: %w", err)
		}
		_ = writeRootFile("/etc/hostname", boot.Hostname+"\n")
		_ = writeRootFile("/etc/hosts", "127.0.0.1 localhost\n127.0.1.1 "+boot.Hostname+"\n::1 localhost ip6-localhost ip6-loopback\n")
	}
	if boot.MachineID != "" {
		_ = writeRootFile("/etc/machine-id", boot.MachineID+"\n")
		_ = os.MkdirAll("/var/lib/dbus", 0o755)
		_ = writeRootFile("/var/lib/dbus/machine-id", boot.MachineID+"\n")
	}
	if len(boot.DNS) > 0 {
		var b strings.Builder
		for _, ns := range boot.DNS {
			b.WriteString("nameserver " + ns + "\n")
		}
		// Same as the Docker slot's --dns-opt use-vc: TCP DNS survives SOCKS egress.
		b.WriteString("options use-vc\n")
		_ = writeRootFile("/etc/resolv.conf", b.String())
	}
	return nil
}

// writeRootFile replaces a file on the root disk; a symlink (resolv.conf) is replaced, not followed.
func writeRootFile(path, body string) error {
	_ = os.Remove(path)
	return os.WriteFile(path, []byte(body), 0o644)
}

func applyNetwork(boot Boot) error {
	for _, argv := range [][]string{
		{"ip", "link", "set", "lo", "up"},
		{"ip", "link", "set", "eth0", "up"},
		{"ip", "addr", "add", boot.IP, "dev", "eth0"},
		{"ip", "route", "add", "default", "via", boot.Gateway},
	} {
		if out, err := exec.Command(argv[0], argv[1:]...).CombinedOutput(); err != nil {
			return fmt.Errorf("%s: %v: %s", strings.Join(argv, " "), err, strings.TrimSpace(string(out)))
		}
	}
	return nil
}

// reapLoop collects orphans: PID1 inherits every daemonized child.
func reapLoop(ctx context.Context) {
	sig := make(chan os.Signal, 8)
	signal.Notify(sig, syscall.SIGCHLD)
	for {
		select {
		case <-ctx.Done():
			return
		case <-sig:
		}
		for {
			var ws unix.WaitStatus
			pid, err := unix.Wait4(-1, &ws, unix.WNOHANG, nil)
			if pid <= 0 || err != nil {
				break
			}
		}
	}
}

// --- kernel supervision ------------------------------------------------------

// kernelBinary: the slot home's wrap kernel, else one baked into the runner image
// (cluster nodes), else a host-mounted binary.
func kernelBinary() string {
	for _, p := range []string{wrapKernel, imageKernel} {
		if st, err := os.Stat(p); err == nil && st.Mode()&0o111 != 0 {
			return p
		}
	}
	return bakedKernel
}

// syncKernelConfig mirrors the shared kernel.json with a guest-local socket path.
// kin-kernel binds socket_path; a socket on virtiofs is not reachable from the host,
// so the host side is the runner's bridge and the guest kernel binds tmpfs.
func syncKernelConfig() (bool, error) {
	raw, err := os.ReadFile(SharedKernelCfg)
	if err != nil {
		return false, err
	}
	var doc map[string]any
	if err = json.Unmarshal(raw, &doc); err != nil {
		return false, err
	}
	doc["socket_path"] = GuestKernelSock
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return false, err
	}
	out = append(out, '\n')
	if prev, err := os.ReadFile(GuestKernelCfg); err == nil && string(prev) == string(out) {
		return false, nil
	}
	tmp := GuestKernelCfg + ".tmp"
	if err = os.WriteFile(tmp, out, 0o600); err != nil {
		return false, err
	}
	return true, os.Rename(tmp, GuestKernelCfg)
}

func superviseKernel(ctx context.Context, boot Boot) {
	uid, gid := parseUser(boot.User)
	go func() {
		// kin-kernel hot-reloads its config file; keep the local copy current.
		t := time.NewTicker(time.Second)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				if _, err := syncKernelConfig(); err != nil && !errors.Is(err, os.ErrNotExist) {
					log.Printf("kernel.json sync: %v", err)
				}
			}
		}
	}()
	backoff := time.Second
	for ctx.Err() == nil {
		if _, err := syncKernelConfig(); err != nil {
			log.Printf("waiting for kernel.json: %v", err)
			sleepCtx(ctx, 2*time.Second)
			continue
		}
		_ = os.Chown(GuestKernelCfg, uid, gid)
		_ = os.Chown(GuestRunDir, uid, gid)
		_ = os.Remove(GuestKernelSock)
		cmd := exec.CommandContext(ctx, kernelBinary(), "--gateway-worker", "--config", GuestKernelCfg)
		cmd.Dir = "/home/kincli"
		cmd.Env = append(baseEnv(), boot.Env...)
		cmd.Env = append(cmd.Env, "KIN_SUBMIT_WAIT_MS=30000", "KIN_SLOT_MAX_LIFETIME_SECS=604800")
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}, Setpgid: true}
		started := time.Now()
		err := cmd.Run()
		if ctx.Err() != nil {
			return
		}
		log.Printf("kin-kernel exited: %v", err)
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		sleepCtx(ctx, backoff)
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func sleepCtx(ctx context.Context, d time.Duration) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func baseEnv() []string {
	return []string{
		"HOME=/home/kincli",
		"PATH=/home/kincli/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		"CLAUDE_CONFIG_DIR=/home/kincli/.claude",
	}
}

// parseUser accepts "uid:gid" (docker exec -u form). Empty means the slot user.
func parseUser(spec string) (int, int) {
	if spec == "" {
		return 999, 987
	}
	u, g, _ := strings.Cut(spec, ":")
	uid, err := strconv.Atoi(u)
	if err != nil {
		uid = 999
	}
	gid, err := strconv.Atoi(g)
	if err != nil {
		gid = 987
	}
	return uid, gid
}

// --- vsock services ----------------------------------------------------------

func serveVsock(ctx context.Context, port uint32, handle func(net.Conn)) {
	for ctx.Err() == nil {
		ln, err := listenVsock(port)
		if err != nil {
			log.Printf("vsock listen %d: %v", port, err)
			sleepCtx(ctx, time.Second)
			continue
		}
		go func() {
			<-ctx.Done()
			ln.Close()
		}()
		for {
			c, err := ln.Accept()
			if err != nil {
				break
			}
			go handle(c)
		}
		ln.Close()
	}
}

type vsockListener struct {
	f *os.File
}

func listenVsock(port uint32) (*vsockListener, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	if err = unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: port}); err != nil {
		unix.Close(fd)
		return nil, err
	}
	if err = unix.Listen(fd, 64); err != nil {
		unix.Close(fd)
		return nil, err
	}
	return &vsockListener{f: os.NewFile(uintptr(fd), fmt.Sprintf("vsock:%d", port))}, nil
}

func (l *vsockListener) Accept() (net.Conn, error) {
	nfd, _, err := unix.Accept4(int(l.f.Fd()), unix.SOCK_CLOEXEC)
	if err != nil {
		return nil, err
	}
	return &vsockConn{File: os.NewFile(uintptr(nfd), "vsock-conn")}, nil
}

func (l *vsockListener) Close() error { return l.f.Close() }

// vsockConn is enough of net.Conn for io.Copy and the exec frames.
type vsockConn struct {
	*os.File
}

func (c *vsockConn) LocalAddr() net.Addr  { return vsockAddr{} }
func (c *vsockConn) RemoteAddr() net.Addr { return vsockAddr{} }
func (c *vsockConn) CloseWrite() error    { return unix.Shutdown(int(c.Fd()), unix.SHUT_WR) }

type vsockAddr struct{}

func (vsockAddr) Network() string { return "vsock" }
func (vsockAddr) String() string  { return "vsock" }

func proxyUnix(c net.Conn, path string) {
	defer c.Close()
	u, err := net.DialTimeout("unix", path, 3*time.Second)
	if err != nil {
		return
	}
	defer u.Close()
	pipe(c, u)
}

// pipe copies both ways and half-closes so HTTP request/response framing survives.
func pipe(a, b net.Conn) {
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

// --- exec --------------------------------------------------------------------

type frameWriter struct {
	sink *frameSink
	kind byte
}

func (f frameWriter) Write(p []byte) (int, error) {
	if err := f.sink.frame(f.kind, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

func serveExec(c net.Conn, boot Boot) {
	defer c.Close()
	r := bufio.NewReader(c)
	req, err := ReadRequest(r)
	if err != nil {
		_ = WriteFrame(c, FrameStderr, []byte(err.Error()+"\n"))
		_ = WriteFrame(c, FrameExit, []byte("126"))
		return
	}
	cmd := exec.Command(req.Argv[0], req.Argv[1:]...)
	cmd.Env = append(append(baseEnv(), boot.Env...), req.Env...)
	cmd.Dir = req.Dir
	if cmd.Dir == "" {
		cmd.Dir = "/home/kincli"
	}
	attr := &syscall.SysProcAttr{Setpgid: true}
	if req.User != "" {
		uid, gid := parseUser(req.User)
		if uid != 0 {
			attr.Credential = &syscall.Credential{Uid: uint32(uid), Gid: uint32(gid)}
		}
	}
	cmd.SysProcAttr = attr
	sink := &frameSink{w: c}
	errw := frameWriter{sink: sink, kind: FrameStderr}
	if req.Detach {
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err = cmd.Start(); err != nil {
			_ = WriteFrame(c, FrameStderr, []byte(err.Error()+"\n"))
			_ = WriteFrame(c, FrameExit, []byte("127"))
			return
		}
		go func() { _ = cmd.Wait() }()
		_ = WriteFrame(c, FrameExit, []byte("0"))
		return
	}
	cmd.Stdout, cmd.Stderr = frameWriter{sink: sink, kind: FrameStdout}, errw
	if req.TTY {
		code := runTTY(cmd, r, sink, req)
		_ = sink.frame(FrameExit, []byte(strconv.Itoa(code)))
		return
	}
	if req.Stdin {
		stdin, perr := cmd.StdinPipe()
		if perr == nil {
			go func() {
				defer stdin.Close()
				for {
					kind, buf, ferr := ReadFrame(r)
					if ferr != nil || kind == FrameEOF {
						return
					}
					if kind == FrameStdin {
						if _, werr := stdin.Write(buf); werr != nil {
							return
						}
					}
				}
			}()
		}
	}
	code := 0
	if err = cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			code = ee.ExitCode()
		} else {
			_, _ = errw.Write([]byte(err.Error() + "\n"))
			code = 127
		}
	}
	_ = sink.frame(FrameExit, []byte(strconv.Itoa(code)))
}

// runTTY runs cmd as a session leader on a fresh guest PTY. The master side is
// the whole stream: stdout frames out, stdin and resize frames in.
func runTTY(cmd *exec.Cmd, r io.Reader, sink *frameSink, req ExecRequest) int {
	master, slave, err := openPTY()
	if err != nil {
		_ = sink.frame(FrameStderr, []byte("pty: "+err.Error()+"\n"))
		return 126
	}
	defer master.Close()
	setWinsize(master, req.Rows, req.Cols)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = slave, slave, slave
	attr := cmd.SysProcAttr
	attr.Setpgid = false
	attr.Setsid = true
	attr.Setctty = true
	attr.Ctty = 0 // index into the child's fds: stdin is the slave
	if cmd.Env != nil && !hasEnv(cmd.Env, "TERM") {
		cmd.Env = append(cmd.Env, "TERM=xterm-256color")
	}
	if err = cmd.Start(); err != nil {
		slave.Close()
		_ = sink.frame(FrameStderr, []byte(err.Error()+"\n"))
		return 127
	}
	slave.Close()
	go func() {
		for {
			kind, buf, ferr := ReadFrame(r)
			if ferr != nil {
				return
			}
			switch kind {
			case FrameStdin:
				if _, werr := master.Write(buf); werr != nil {
					return
				}
			case FrameResize:
				if rows, cols, ok := ParseResize(buf); ok {
					setWinsize(master, rows, cols)
				}
			case FrameEOF:
				// ^D on the terminal is the in-band EOF; nothing to close here.
			}
		}
	}()
	out := make(chan struct{})
	go func() {
		defer close(out)
		buf := make([]byte, 32*1024)
		for {
			n, rerr := master.Read(buf)
			if n > 0 {
				if sink.frame(FrameStdout, buf[:n]) != nil {
					return
				}
			}
			if rerr != nil {
				return // EIO once the last slave fd closes
			}
		}
	}()
	err = cmd.Wait()
	<-out
	var ee *exec.ExitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &ee):
		return ee.ExitCode()
	default:
		return 127
	}
}

func hasEnv(env []string, key string) bool {
	for _, kv := range env {
		if strings.HasPrefix(kv, key+"=") {
			return true
		}
	}
	return false
}
