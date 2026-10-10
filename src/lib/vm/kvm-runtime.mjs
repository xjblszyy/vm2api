/**
 * KVM slot runtime. The slot is still one Docker container (`kin-<id>`) on the
 * same kin-eg-* network with the same /run/kin and /home/kincli mounts; its
 * image is kin-vmm, whose PID1 boots a cloud-hypervisor guest and bridges
 * run/kernel.sock over vsock. Docker lifecycle (start/stop/rm/inspect) is
 * unchanged; only `docker exec` must be routed into the guest (kvmExecArgs).
 */
import crypto from 'node:crypto'
import { OS_REGISTRY } from './os-catalog.mjs'

export const KVM_STATE_DIR = '/run/kin-vmm'
export const KVM_VSOCK = `${KVM_STATE_DIR}/vsock.sock`
export const KVM_GUEST_BIN = 'kin-guest'
// Guest RAM; the container limit adds VMM + virtiofsd headroom on top.
export const KVM_GUEST_MEMORY_MB = Number(process.env.KIN_KVM_MEMORY_MB || 1024)
export const KVM_GUEST_CPUS = Number(process.env.KIN_KVM_CPUS || 2)
const KVM_OVERHEAD_MB = 384

const VMM_IMAGES = {
  'ubuntu-24.04': `${OS_REGISTRY}/kin-vmm-ubuntu:24.04`,
  'debian-12': `${OS_REGISTRY}/kin-vmm-debian:12`,
  archlinux: `${OS_REGISTRY}/kin-vmm-arch:latest`,
  'fedora-41': `${OS_REGISTRY}/kin-vmm-fedora:41`,
}

export function kvmImageForKernel(kernel) {
  return VMM_IMAGES[kernel] || VMM_IMAGES['ubuntu-24.04']
}

export function kvmContainerMemory() {
  return `${KVM_GUEST_MEMORY_MB + KVM_OVERHEAD_MB}m`
}

/**
 * The host daemon, not this process, opens /dev/kvm: the control plane usually
 * runs in a container without the device. Map the daemon's refusal to a code.
 */
export function kvmRunError(stderr) {
  const text = String(stderr || '')
  if (!/\/dev\/(kvm|net\/tun)/.test(text)) return null
  return {
    ok: false,
    code: 'kvm_unavailable',
    error: `host cannot provide KVM devices: ${text.trim().slice(0, 300)}. Nested virtualization or a PVM host kernel is required.`,
  }
}

// Desktop SMBIOS profiles. One is picked per slot and kept for its lifetime.
const DMI_PROFILES = [
  { vendor: 'Dell Inc.', product: 'OptiPlex 7090', family: 'OptiPlex', serial: ['', 7] },
  { vendor: 'Dell Inc.', product: 'Precision 3660', family: 'Precision', serial: ['', 7] },
  {
    vendor: 'LENOVO',
    product: '11T3S0A400',
    version: 'ThinkCentre M70q Gen 3',
    family: 'ThinkCentre M70q',
    serial: ['MJ0', 5],
  },
  {
    vendor: 'HP',
    product: 'HP EliteDesk 800 G6 Desktop Mini PC',
    family: '103C_53307F HP EliteDesk',
    serial: ['8CC', 7],
  },
]
const SERIAL_CHARS = '0123456789BCDFGHJKLMNPQRSTVWXYZ'

/**
 * Stable hardware identity for a KVM slot, derived from the slot id and its
 * guest machine-id. A fingerprint reset rotates guest_machine_id and with it
 * the DMI serial, UUID and MAC; nothing extra is persisted in vm.json.
 */
export function kvmHardwareIdentity(vm = {}) {
  const seed = `${vm.id || ''}|${vm.fingerprint?.guest_machine_id || ''}`
  const d = crypto.createHash('sha256').update(`kin-kvm-dmi|${seed}`).digest()
  const profile = DMI_PROFILES[d[0] % DMI_PROFILES.length]
  const [prefix, len] = profile.serial
  let serial = prefix
  for (let i = 0; i < len; i++) serial += SERIAL_CHARS[d[1 + i] % SERIAL_CHARS.length]
  const u = Buffer.from(d.subarray(8, 24))
  u[6] = (u[6] & 0x0f) | 0x40
  u[8] = (u[8] & 0x3f) | 0x80
  const h = u.toString('hex')
  const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  // Locally administered unicast, so it never collides with a real OUI.
  const mac = [0x02, ...d.subarray(24, 29)].map((b) => b.toString(16).padStart(2, '0')).join(':')
  return {
    sys_vendor: profile.vendor,
    product_name: profile.product,
    product_version: profile.version || '',
    product_family: profile.family,
    product_serial: serial,
    product_uuid: uuid,
    mac,
  }
}

/** `docker run` flags that turn a slot container into a KVM runner. */
export function kvmRunArgs(vm, { hostname, machineId, uid, gid }) {
  const hw = kvmHardwareIdentity(vm)
  const env = {
    KIN_VMM_MEMORY_MB: String(KVM_GUEST_MEMORY_MB),
    KIN_VMM_CPUS: String(KVM_GUEST_CPUS),
    KIN_VMM_USER: `${uid}:${gid}`,
    KIN_VMM_HOSTNAME: hostname,
    KIN_VMM_MACHINE_ID: machineId || '',
    KIN_VMM_MAC: hw.mac,
    KIN_VMM_SYS_VENDOR: hw.sys_vendor,
    KIN_VMM_PRODUCT: hw.product_name,
    KIN_VMM_PRODUCT_VERSION: hw.product_version,
    KIN_VMM_FAMILY: hw.product_family,
    KIN_VMM_SERIAL: hw.product_serial,
    KIN_VMM_UUID: hw.product_uuid,
  }
  return [
    '--device',
    '/dev/kvm',
    '--device',
    '/dev/net/tun',
    // tap + MASQUERADE live in the slot's own netns; nothing touches the host's tables.
    '--cap-add',
    'NET_ADMIN',
    '--sysctl',
    'net.ipv4.ip_forward=1',
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
  ]
}

/**
 * Rewrite `docker exec` argv for a KVM slot so the command runs in the guest.
 * Input/output are docker CLI args without the leading 'docker':
 *   ['exec', '-d', '-i', '-u', U, '-e', K=V, '-w', D, <container>, cmd...]
 * Unknown flags are refused rather than silently dropped.
 */
export function kvmExecArgs(args) {
  if (!Array.isArray(args) || args[0] !== 'exec') return args
  const outer = ['exec']
  const inner = []
  let i = 1
  for (; i < args.length; i++) {
    const a = args[i]
    if (!a.startsWith('-')) break
    if (a === '-d' || a === '--detach') {
      inner.push('-d')
    } else if (a === '-i' || a === '--interactive') {
      outer.push('-i')
      inner.push('-i')
    } else if (a === '-u' || a === '--user' || a === '-e' || a === '--env' || a === '-w' || a === '--workdir') {
      const short = a === '--user' ? '-u' : a === '--env' ? '-e' : a === '--workdir' ? '-w' : a
      inner.push(short, args[++i])
    } else {
      throw new Error(`kvm exec: unsupported docker exec flag ${a}`)
    }
  }
  const container = args[i]
  const cmd = args.slice(i + 1)
  if (!container || cmd.length === 0) throw new Error('kvm exec: container and command required')
  return [...outer, container, KVM_GUEST_BIN, 'exec', '--vsock', KVM_VSOCK, ...inner, '--', ...cmd]
}
