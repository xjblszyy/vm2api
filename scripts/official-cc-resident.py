#!/usr/bin/env python3
"""Keep the slot cli-node attached after init hello.

Host PTY + `docker exec -it` so the CLI stays in an interactive session.
A KVM slot (KIN_SLOT_KVM=1) gets the same session on a guest PTY via kin-guest.
Does not print credentials. Exits when the guest CLI process exits.
"""
from __future__ import annotations

import os
import pty
import sys


def main() -> int:
    container = os.environ.get("KIN_CONTAINER", "").strip()
    uid = os.environ.get("KIN_UID", "").strip()
    gid = os.environ.get("KIN_GID", "").strip()
    if not container or not uid or not gid:
        return 2
    tz = os.environ.get("TZ", "UTC")
    lang = os.environ.get("LANG", "en_US.UTF-8")
    cli = os.environ["KIN_CLI_BIN"]
    argv = [
        "docker", "exec", "-it",
        "-u", f"{uid}:{gid}",
        "-e", "HOME=/home/kincli",
        "-e", "TMPDIR=/home/kincli/.cache/tmp",
        "-e", f"TZ={tz}",
        "-e", f"LANG={lang}",
        "-e", f"LC_ALL={lang}",
        "-e", "PATH=/home/kincli/.local/bin:/usr/bin:/bin",
        # The host Go Refresher is the only RT writer; the marker lets the host
        # find this process apart from the kernel's CLI on the same binary.
        "-e", "CLAUDE_CODE_HOST_REFRESH=1",
        "-e", f"CLAUDE_CODE_VERSION={os.environ.get('KIN_CLI_VERSION', '2.1.293')}",
        "-e", "USER_TYPE=external",
        "-e", "KIN_OFFICIAL_CC=1",
        "-e", "CLAUDE_CODE_USE_BEDROCK=0",
        "-e", "CLAUDE_CODE_USE_VERTEX=0",
        "-e", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=0",
        "-e", "DISABLE_TELEMETRY=1",
        "-e", "DO_NOT_TRACK=1",
        "-e", "ANTHROPIC_BASE_URL=",
        "-e", "ANTHROPIC_API_KEY=",
        "-e", "ANTHROPIC_AUTH_TOKEN=",
        "-w", "/home/kincli",
        container,
        cli,
    ]
    if os.environ.get("KIN_SLOT_KVM") == "1":
        argv = kvm_exec(argv)
    return pty.spawn(argv) or 0


def kvm_exec(argv: list[str]) -> list[str]:
    """Run inside a KVM slot's guest: same shape as kvmExecArgs in kvm-runtime.mjs."""
    i = argv.index("exec") + 1
    flags: list[str] = []
    while argv[i].startswith("-"):
        flag = argv[i]
        if flag in ("-u", "-e", "-w"):
            flags += [flag, argv[i + 1]]
            i += 2
        else:
            i += 1  # -it: docker keeps its tty, the guest gets -i -t below
    container, cmd = argv[i], argv[i + 1:]
    return [
        "docker", "exec", "-i", "-t", container,
        "kin-guest", "exec", "--vsock", "/run/kin-vmm/vsock.sock", "-i", "-t",
        *flags, "--", *cmd,
    ]


if __name__ == "__main__":
    sys.exit(main())
