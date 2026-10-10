// kin-guest is the KVM slot glue.
//
//	kin-guest init                      guest PID1 (kernel cmdline init=)
//	kin-guest bridge --listen P --vsock S   runner: run/kernel.sock -> guest kernel
//	kin-guest exec --vsock S [-u U] [-e K=V] [-w DIR] [-d] [-i] -- argv...
//	                                     runner: `docker exec` into the guest
//	kin-guest poweroff --vsock S         runner: clean guest shutdown on docker stop
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/dofastted/kin-gateway/worker/internal/guest"
)

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func main() {
	// As the kernel's init= the guest gets no reliable argv; PID1 is always init.
	if os.Getpid() == 1 {
		os.Args = []string{os.Args[0], "init"}
	}
	if len(os.Args) < 2 {
		usage()
	}
	switch os.Args[1] {
	case "init":
		if err := guest.RunInit(); err != nil {
			fmt.Fprintf(os.Stderr, "kin-guest init: %v\n", err)
			// PID1 must not exit: a dead init panics the guest kernel and loses the log.
			// `select {}` would trip the runtime deadlock detector, so sleep instead.
			for {
				time.Sleep(time.Hour)
			}
		}
	case "bridge":
		fs := flag.NewFlagSet("bridge", flag.ExitOnError)
		listen := fs.String("listen", "/run/kin/kernel.sock", "unix socket to serve")
		vsock := fs.String("vsock", "/run/kin-vmm/vsock.sock", "cloud-hypervisor vsock socket")
		port := fs.Uint("port", guest.PortKernel, "guest vsock port")
		_ = fs.Parse(os.Args[2:])
		ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer stop()
		if err := guest.Bridge(ctx, *listen, *vsock, uint32(*port)); err != nil {
			fmt.Fprintf(os.Stderr, "kin-guest bridge: %v\n", err)
			os.Exit(1)
		}
	case "exec":
		os.Exit(runExec(os.Args[2:]))
	case "poweroff":
		fs := flag.NewFlagSet("poweroff", flag.ExitOnError)
		vsock := fs.String("vsock", "/run/kin-vmm/vsock.sock", "cloud-hypervisor vsock socket")
		_ = fs.Parse(os.Args[2:])
		conn, err := guest.DialHybrid(*vsock, guest.PortPower, 3*time.Second)
		if err != nil {
			fmt.Fprintf(os.Stderr, "kin-guest poweroff: %v\n", err)
			os.Exit(1)
		}
		conn.Close()
	default:
		usage()
	}
}

func runExec(args []string) int {
	fs := flag.NewFlagSet("exec", flag.ExitOnError)
	vsock := fs.String("vsock", "/run/kin-vmm/vsock.sock", "cloud-hypervisor vsock socket")
	user := fs.String("u", "", "uid:gid")
	dir := fs.String("w", "", "working directory")
	detach := fs.Bool("d", false, "detach")
	interactive := fs.Bool("i", false, "forward stdin")
	var env multiFlag
	fs.Var(&env, "e", "KEY=VALUE (repeatable)")
	_ = fs.Parse(args)
	argv := fs.Args()
	if len(argv) == 0 {
		fmt.Fprintln(os.Stderr, "kin-guest exec: command required")
		return 125
	}
	req := guest.ExecRequest{Argv: argv, Env: env, User: *user, Dir: *dir, Detach: *detach, Stdin: *interactive}
	err := guest.Exec(*vsock, req, os.Stdin, os.Stdout, os.Stderr)
	var exit guest.ExitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &exit):
		return exit.Code
	default:
		fmt.Fprintf(os.Stderr, "kin-guest exec: %v\n", err)
		return 125
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: kin-guest init | bridge | exec | poweroff")
	os.Exit(2)
}
