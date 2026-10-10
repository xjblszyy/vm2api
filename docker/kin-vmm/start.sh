#!/bin/sh
# KVM slot runner (container PID1). The slot container keeps its Docker contract:
# same name, same kin-eg-* network, same /run/kin and /home/kincli mounts. This
# script moves the workload one level down into a cloud-hypervisor guest.
#
#   /run/kin      -> guest /run/kin (virtiofs "kinrun")
#   /home/kincli  -> guest /home/kincli (virtiofs "kinhome")
#   /opt/kin      -> guest /opt/kin (virtiofs "kinbin", ro): host-mounted or baked slot
#                    binaries; /opt/kin/bin/* is linked into the guest's /usr/local/bin
#   /home/kincli/.claude -> same path in the guest (virtiofs "kinclaude") when it is
#                    its own bind mount here (cluster nodes nest it under the home)
#   $DISK         -> guest root (per-slot copy, kept on the host across restarts)
#   /run/kin/kernel.sock  served here by `kin-guest bridge` over vsock
#   guest eth0 -> tap0 -> MASQUERADE -> container eth0 -> host kin-eg-* REDIRECT
set -eu

VMM=/opt/kin-vmm
STATE=/run/kin-vmm
TAP=tap0
HOST_IP=172.31.255.1
GUEST_IP=172.31.255.2
CPUS="${KIN_VMM_CPUS:-2}"
MEM="${KIN_VMM_MEMORY_MB:-1024}"
GUEST_USER="${KIN_VMM_USER:-999:987}"

log() { echo "kin-vmm: $*" >&2; }

[ -c /dev/kvm ] || { log "/dev/kvm missing (run with --device /dev/kvm)"; exit 1; }
mkdir -p "$STATE"
rm -f "$STATE"/*.sock /run/kin/kernel.sock

# Each slot owns its root disk copy: guest writes (apt, /etc) must not leak between slots.
# It lives on the host volume, not the container tmpfs, so it never counts as slot memory.
DISK_DIR="${KIN_VMM_DISK_DIR:-/var/lib/kin-vmm}"
DISK="$DISK_DIR/rootfs.ext4"
mkdir -p "$DISK_DIR"
if [ ! -f "$DISK" ] || ! cmp -s "$VMM/rootfs.id" "$DISK_DIR/rootfs.id"; then
  cp --sparse=always "$VMM/rootfs.ext4" "$DISK.new"
  mv -f "$DISK.new" "$DISK"
  cp "$VMM/rootfs.id" "$DISK_DIR/rootfs.id"
fi

SHARES="kinrun:/run/kin kinhome:/home/kincli kinbin:/opt/kin"
# A nested bind is invisible through the parent's virtiofs share; export it on its own.
EXTRA_MOUNTS=""
if mountpoint -q /home/kincli/.claude 2>/dev/null; then
  SHARES="$SHARES kinclaude:/home/kincli/.claude"
  EXTRA_MOUNTS='{"tag": "kinclaude", "path": "/home/kincli/.claude"}'
fi
FS_PIDS=""
FS_ARGS=""
for share in $SHARES; do
  tag=${share%%:*}
  dir=${share#*:}
  # The slot container has no CAP_SETFCAP; virtiofsd must not ask to keep it.
  /usr/libexec/virtiofsd --socket-path="$STATE/$tag.sock" --shared-dir="$dir" \
    --sandbox=none --modcaps=-setfcap --cache=auto --inode-file-handles=never --xattr --log-level=error &
  FS_PIDS="$FS_PIDS $tag:$!"
  FS_ARGS="$FS_ARGS tag=$tag,socket=$STATE/$tag.sock"
done

# docker restart keeps the netns: tap0 and the nat rules may already exist.
ip link show "$TAP" >/dev/null 2>&1 || ip tuntap add dev "$TAP" mode tap
ip addr replace "$HOST_IP/30" dev "$TAP"
ip link set "$TAP" up
nat_rule() { iptables -t nat -C "$@" 2>/dev/null || iptables -t nat -A "$@"; }
nat_rule POSTROUTING -s "$GUEST_IP/32" -o eth0 -j MASQUERADE

# guest.json is read once by the guest PID1; vm2api owns every value in it.
cat > /run/kin/guest.json <<EOF
{
  "hostname": "${KIN_VMM_HOSTNAME:-$(hostname)}",
  "machine_id": "${KIN_VMM_MACHINE_ID:-}",
  "ip": "$GUEST_IP/30",
  "gateway": "$HOST_IP",
  "dns": ["${KIN_VMM_DNS:-8.8.8.8}"],
  "user": "$GUEST_USER",
  "env": ["TZ=${TZ:-UTC}", "LANG=${LANG:-en_US.UTF-8}", "KIN_VM_ID=${KIN_VM_ID:-}", "KIN_VM_OS=${KIN_VM_OS:-}"],
  "kernel": ${KIN_VMM_KERNEL:-true},
  "mounts": [${EXTRA_MOUNTS}]
}
EOF

# Guest DNS is plain :53 to a public resolver, masqueraded like any other packet:
# on a SOCKS network the host bridge's kin-egress REDIRECT catches it, exactly as
# for a Docker slot. Docker's 127.0.0.11 is loopback and unreachable from tap0.

for entry in $FS_PIDS; do
  tag=${entry%%:*}
  pid=${entry#*:}
  i=0
  while [ ! -S "$STATE/$tag.sock" ]; do
    kill -0 "$pid" 2>/dev/null || { log "virtiofsd $tag exited"; exit 1; }
    i=$((i + 1))
    [ "$i" -lt 100 ] || { log "virtiofsd $tag did not start"; exit 1; }
    sleep 0.05
  done
done

kin-guest bridge --listen /run/kin/kernel.sock --vsock "$STATE/vsock.sock" &

# DMI is per slot (vm.fingerprint); unset fields keep cloud-hypervisor defaults.
PLATFORM=""
add_platform() { [ -n "$2" ] && PLATFORM="${PLATFORM:+$PLATFORM,}$1=$2"; return 0; }
add_platform system_manufacturer "${KIN_VMM_SYS_VENDOR:-}"
add_platform system_product_name "${KIN_VMM_PRODUCT:-}"
add_platform system_version "${KIN_VMM_PRODUCT_VERSION:-}"
add_platform system_family "${KIN_VMM_FAMILY:-}"
add_platform system_serial_number "${KIN_VMM_SERIAL:-}"
add_platform system_uuid "${KIN_VMM_UUID:-}"

# docker stop: ask the guest PID1 to sync and power off; cloud-hypervisor then exits.
trap 'log "stopping guest"; kin-guest poweroff --vsock "$STATE/vsock.sock" || kill "$CH" 2>/dev/null' TERM INT

"$VMM/cloud-hypervisor" \
  --api-socket "$STATE/api.sock" \
  --kernel "$VMM/vmlinux" \
  --cmdline "console=ttyS0 root=/dev/vda rw init=/sbin/kin-guest quiet" \
  --disk "path=$DISK,image_type=raw" \
  --cpus "boot=$CPUS" \
  --memory "size=${MEM}M,shared=on" \
  --fs $FS_ARGS \
  --net "tap=$TAP,mac=${KIN_VMM_MAC:-52:54:00:12:34:56}" \
  --vsock "cid=3,socket=$STATE/vsock.sock" \
  ${PLATFORM:+--platform "$PLATFORM"} \
  --serial tty --console off &
CH=$!
wait "$CH" || true
# A trapped signal interrupts the first wait; let the guest finish its poweroff.
wait "$CH" 2>/dev/null || true
