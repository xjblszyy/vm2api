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

// virtiofsd serves the slot uid's files and narrows its own caps (SETPCAP);
// NET_ADMIN builds tap0 + MASQUERADE inside the slot's own netns only.
export const KVM_RUNNER_CAPS = [
  'NET_ADMIN',
  'CHOWN',
  'DAC_OVERRIDE',
  'DAC_READ_SEARCH',
  'FOWNER',
  'FSETID',
  'SETUID',
  'SETGID',
  'MKNOD',
  'SETPCAP',
]

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
  {
    vendor: 'Dell Inc.',
    product: 'OptiPlex 7090',
    family: 'OptiPlex',
    serial: ['', 7],
    bios: { vendor: 'Dell Inc.', version: '1.21.0', date: '05/14/2024' },
  },
  {
    vendor: 'Dell Inc.',
    product: 'Precision 3660',
    family: 'Precision',
    serial: ['', 7],
    bios: { vendor: 'Dell Inc.', version: '2.16.0', date: '08/06/2024' },
  },
  {
    vendor: 'LENOVO',
    product: '11T3S0A400',
    version: 'ThinkCentre M70q Gen 3',
    family: 'ThinkCentre M70q',
    serial: ['MJ0', 5],
    bios: { vendor: 'LENOVO', version: 'M47KT3AA', date: '03/21/2024' },
  },
  {
    vendor: 'HP',
    product: 'HP EliteDesk 800 G6 Desktop Mini PC',
    family: '103C_53307F HP EliteDesk',
    serial: ['8CC', 7],
    bios: { vendor: 'HP', version: 'S21 Ver. 02.19.00', date: '01/10/2024' },
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
    bios_vendor: profile.bios.vendor,
    bios_version: profile.bios.version,
    bios_date: profile.bios.date,
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
    // Read by the patched cloud-hypervisor (docker/kin-vmm/patches); upstream ignores them.
    KIN_SMBIOS_BIOS_VENDOR: hw.bios_vendor,
    KIN_SMBIOS_BIOS_VERSION: hw.bios_version,
    KIN_SMBIOS_BIOS_DATE: hw.bios_date,
  }
  return [
    '--device',
    '/dev/kvm',
    '--device',
    '/dev/net/tun',
    '--sysctl',
    'net.ipv4.ip_forward=1',
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
  ]
}

/**
 * Rewrite `docker exec` argv for a KVM slot so the command runs in the guest.
 * Input/output are docker CLI args without the leading 'docker':
 *   ['exec', '-d', '-i', '-t', '-u', U, '-e', K=V, '-w', D, <container>, cmd...]
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
    } else if (a === '-t' || a === '--tty') {
      // docker hands its pty to kin-guest, which opens a guest pty for the command.
      outer.push('-t')
      inner.push('-t')
    } else if (a === '-it' || a === '-ti') {
      outer.push('-i', '-t')
      inner.push('-i', '-t')
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

const capabilityCache = new Map()
const CAPABILITY_TTL_MS = 10 * 60 * 1000

/**
 * Can the daemon that would run the slot give it /dev/kvm? Asked of the daemon
 * itself (local or a node via its DOCKER_HOST), since the control plane's own
 * container never has the device. `run` must be async: a node's DOCKER_HOST is
 * a bridge served by this process, so a blocking docker CLI call deadlocks it.
 * Cached: KVM availability does not flap.
 *   { ok, code?: 'kvm_unavailable' | 'kvm_arch_unsupported' | 'kvm_image_missing' | 'docker_unavailable', image }
 */
export async function probeKvmCapability({ kernel = 'ubuntu-24.04', env, key = 'local', run, now = Date.now() } = {}) {
  const image = kvmImageForKernel(kernel)
  const cacheKey = `${key}|${image}`
  const hit = capabilityCache.get(cacheKey)
  if (hit && now - hit.at < CAPABILITY_TTL_MS) return hit.result
  const docker = (args, timeout) => run(['docker', ...args], { timeout, ...(env ? { env } : {}) })
  let result
  const arch = String((await docker(['info', '--format', '{{.Architecture}}'], 10_000)).stdout || '').trim()
  if (arch && arch !== 'x86_64' && arch !== 'amd64') {
    // Slot binaries are amd64 only; an arm64 guest would need qemu-user inside the VM.
    result = {
      ok: false,
      code: 'kvm_arch_unsupported',
      image,
      error: `KVM slots need an x86_64 host (this one is ${arch})`,
    }
  } else if (!(await docker(['image', 'inspect', image], 10_000)).ok) {
    result = { ok: false, code: 'kvm_image_missing', image, error: `KVM slot image ${image} is not pulled` }
  } else {
    const r = await docker(
      ['run', '--rm', '--network', 'none', '--device', '/dev/kvm', '--entrypoint', 'test', image, '-c', '/dev/kvm'],
      30_000,
    )
    result = r.ok
      ? { ok: true, image }
      : kvmRunError(r.stderr) || {
          ok: false,
          code: 'docker_unavailable',
          image,
          error: r.stderr || 'docker run failed',
        }
  }
  // An image pull or a node reboot changes the answer; only stable results are cached.
  if (result.ok || result.code === 'kvm_unavailable' || result.code === 'kvm_arch_unsupported') {
    capabilityCache.set(cacheKey, { at: now, result })
  }
  return result
}

export function resetKvmCapabilityCache() {
  capabilityCache.clear()
}

/** Engine-API form of kvmExecArgs: the Cmd for an exec that should run in the guest. */
export function kvmExecCmd(cmd, { user, detach = false } = {}) {
  return [
    KVM_GUEST_BIN,
    'exec',
    '--vsock',
    KVM_VSOCK,
    ...(detach ? ['-d'] : []),
    ...(user ? ['-u', user] : []),
    '--',
    ...cmd,
  ]
}

/** Engine-API HostConfig / Env additions that turn a slot container into a KVM runner. */
export function kvmContainerSpec(vm, { hostname, machineId, uid, gid }) {
  const args = kvmRunArgs(vm, { hostname, machineId, uid, gid })
  const env = args.flatMap((v, i) => (args[i - 1] === '-e' ? [v] : []))
  const mem = (KVM_GUEST_MEMORY_MB + KVM_OVERHEAD_MB) * 1024 * 1024
  return {
    Env: env,
    HostConfig: {
      Devices: ['/dev/kvm', '/dev/net/tun'].map((d) => ({
        PathOnHost: d,
        PathInContainer: d,
        CgroupPermissions: 'rwm',
      })),
      CapDrop: ['ALL'],
      CapAdd: KVM_RUNNER_CAPS,
      Sysctls: { 'net.ipv4.ip_forward': '1' },
      Memory: mem,
      MemorySwap: mem,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=32m', '/run': 'rw,nosuid,size=16m' },
    },
  }
}
