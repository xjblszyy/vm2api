import test from 'node:test'
import assert from 'node:assert/strict'
import {
  kvmContainerMemory,
  kvmExecArgs,
  kvmHardwareIdentity,
  kvmImageForKernel,
  kvmRunArgs,
  kvmRunError,
  probeKvmCapability,
  resetKvmCapabilityCache,
} from '../../src/lib/vm/kvm-runtime.mjs'
import { slotExecArgs, slotImageFor } from '../../src/lib/vm/vm-runtime.mjs'

const VSOCK = ['kin-guest', 'exec', '--vsock', '/run/kin-vmm/vsock.sock']

test('kvmExecArgs moves flags inside the guest and keeps -i on docker', () => {
  assert.deepEqual(
    kvmExecArgs([
      'exec',
      '-i',
      '-u',
      '10001:987',
      '-e',
      'A=1',
      '-w',
      '/tmp',
      'kin-01',
      'kin-worker',
      'oauth',
      'refresh',
    ]),
    [
      'exec',
      '-i',
      'kin-01',
      ...VSOCK,
      '-i',
      '-u',
      '10001:987',
      '-e',
      'A=1',
      '-w',
      '/tmp',
      '--',
      'kin-worker',
      'oauth',
      'refresh',
    ],
  )
  assert.deepEqual(kvmExecArgs(['exec', '-d', 'kin-01', 'sh', '-c', 'x']), [
    'exec',
    'kin-01',
    ...VSOCK,
    '-d',
    '--',
    'sh',
    '-c',
    'x',
  ])
  assert.deepEqual(kvmExecArgs(['exec', '--user', '0', 'kin-01', 'true']), [
    'exec',
    'kin-01',
    ...VSOCK,
    '-u',
    '0',
    '--',
    'true',
  ])
})

test('kvmExecArgs leaves non-exec docker commands alone', () => {
  const restart = ['restart', 'kin-01']
  assert.equal(kvmExecArgs(restart), restart)
})

test('kvmExecArgs keeps a terminal on both sides for -t / -it', () => {
  assert.deepEqual(kvmExecArgs(['exec', '-it', '-u', '1:2', 'kin-01', 'cli']), [
    'exec',
    '-i',
    '-t',
    'kin-01',
    ...VSOCK,
    '-i',
    '-t',
    '-u',
    '1:2',
    '--',
    'cli',
  ])
  assert.deepEqual(kvmExecArgs(['exec', '-t', 'kin-01', 'sh']), ['exec', '-t', 'kin-01', ...VSOCK, '-t', '--', 'sh'])
})

test('kvmExecArgs refuses flags it cannot honour instead of dropping them', () => {
  assert.throws(
    () => kvmExecArgs(['exec', '--privileged', 'kin-01', 'sh']),
    /unsupported docker exec flag --privileged/,
  )
  assert.throws(() => kvmExecArgs(['exec', 'kin-01']), /command required/)
})

test('slotExecArgs only rewrites KVM slots', () => {
  const args = ['exec', 'kin-01', 'true']
  assert.equal(slotExecArgs({ runtime: { type: 'docker' } }, args), args)
  assert.deepEqual(slotExecArgs({ runtime: { type: 'kvm' } }, args), ['exec', 'kin-01', ...VSOCK, '--', 'true'])
})

test('KVM slots use the kin-vmm image for their OS', () => {
  assert.match(kvmImageForKernel('debian-12'), /\/kin-vmm-debian:12$/)
  assert.match(kvmImageForKernel('nope'), /\/kin-vmm-ubuntu:24\.04$/)
  assert.match(slotImageFor({ runtime: { type: 'kvm' } }, 'fedora-41'), /\/kin-vmm-fedora:41$/)
  assert.match(slotImageFor({ runtime: { type: 'docker' } }, 'fedora-41'), /\/kin-os-fedora:41$/)
})

test('hardware identity is stable per slot and rotates with the guest machine-id', () => {
  const vm = { id: 'vm-07', fingerprint: { guest_machine_id: 'a'.repeat(32) } }
  const a = kvmHardwareIdentity(vm)
  assert.deepEqual(kvmHardwareIdentity(structuredClone(vm)), a)
  assert.match(a.product_uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.match(a.mac, /^02(:[0-9a-f]{2}){5}$/)
  assert.ok(a.sys_vendor && a.product_name && a.product_serial)
  const reset = kvmHardwareIdentity({ ...vm, fingerprint: { guest_machine_id: 'b'.repeat(32) } })
  assert.notEqual(reset.product_uuid, a.product_uuid)
  assert.notEqual(reset.mac, a.mac)
  assert.notEqual(kvmHardwareIdentity({ ...vm, id: 'vm-08' }).product_uuid, a.product_uuid)
})

test('kvmRunArgs grants KVM and tun devices and passes identity', () => {
  const vm = { id: 'vm-07', fingerprint: { guest_machine_id: 'c'.repeat(32) } }
  const args = kvmRunArgs(vm, { hostname: 'arch-1a2b', machineId: 'c'.repeat(32), uid: 10007, gid: 987 })
  const env = Object.fromEntries(args.flatMap((v, i) => (args[i - 1] === '-e' ? [v.split(/=(.*)/s).slice(0, 2)] : [])))
  assert.ok(args.includes('/dev/kvm') && args.includes('/dev/net/tun'))
  assert.equal(env.KIN_VMM_USER, '10007:987')
  assert.equal(env.KIN_VMM_HOSTNAME, 'arch-1a2b')
  assert.equal(env.KIN_VMM_MACHINE_ID, 'c'.repeat(32))
  assert.equal(env.KIN_VMM_UUID, kvmHardwareIdentity(vm).product_uuid)
  assert.match(kvmContainerMemory(), /^\d+m$/)
})

test('kvmRunError maps the daemon refusing /dev/kvm and ignores other failures', () => {
  const err = kvmRunError(
    'docker: Error response from daemon: error gathering device information while adding custom device "/dev/kvm": no such file or directory',
  )
  assert.equal(err.code, 'kvm_unavailable')
  assert.match(err.error, /\/dev\/kvm/)
  assert.equal(kvmRunError('docker: Error response from daemon: Conflict. The container name is already in use'), null)
})

test('node KVM slot body: root runner with devices, guest identity, no machine-id bind', async () => {
  const { slotContainerBody } = await import('../../src/lib/cluster/remote-slot.mjs')
  const vm = {
    id: 'vm-12',
    kernel: 'debian-12',
    timezone: 'UTC',
    locale: 'en_US.UTF-8',
    fingerprint: { hostname: 'debian-1a2b', guest_machine_id: 'd'.repeat(32) },
    runtime: { type: 'kvm' },
  }
  const opts = {
    image: 'vm2api/kin-slot-vmm-debian-12:abc',
    network: 'kin-eg-x',
    remoteDir: '/srv/vms/vm-12',
    user: '1012:987',
  }
  const body = slotContainerBody(vm, opts)
  assert.equal(body.User, undefined)
  assert.equal(body.Cmd, undefined)
  assert.equal(body.Labels['kin.vm.runtime'], 'kvm')
  assert.deepEqual(
    body.HostConfig.Devices.map((d) => d.PathOnHost),
    ['/dev/kvm', '/dev/net/tun'],
  )
  assert.ok(body.HostConfig.CapAdd.includes('NET_ADMIN') && body.HostConfig.CapAdd.includes('SETPCAP'))
  assert.ok(body.Env.includes('KIN_VMM_USER=1012:987'))
  assert.ok(body.Env.includes(`KIN_VMM_MACHINE_ID=${'d'.repeat(32)}`))
  assert.ok(body.HostConfig.Binds.includes('/srv/vms/vm-12/vmm:/var/lib/kin-vmm'))
  assert.ok(body.HostConfig.Binds.includes('/srv/vms/vm-12/claude:/home/kincli/.claude'))
  assert.ok(!body.HostConfig.Binds.some((b) => b.includes('machine-id')))
  // A container slot keeps its original shape.
  const plain = slotContainerBody({ ...vm, runtime: { type: 'docker' } }, opts)
  assert.equal(plain.User, '1012:987')
  assert.ok(plain.Cmd.length > 0)
  assert.equal(plain.HostConfig.Devices, undefined)
})

test('node KVM image builds on kin-vmm and keeps bins under /opt/kin', async () => {
  const { slotDockerfile } = await import('../../src/lib/cluster/slot-image.mjs')
  assert.match(slotDockerfile('ghcr.io/x/kin-vmm-debian:12', { kvm: true }), /COPY usr\/local\/bin\/ \/opt\/kin\/bin\//)
  assert.match(slotDockerfile('ghcr.io/x/kin-os-debian:12'), /COPY usr\/local\/bin\/ \/usr\/local\/bin\//)
})

test('probeKvmCapability asks the daemon, caches success, and reports a missing image', async () => {
  resetKvmCapabilityCache()
  const calls = []
  const run = async (argv) => {
    calls.push(argv[1])
    return { ok: true }
  }
  assert.equal((await probeKvmCapability({ kernel: 'debian-12', run, now: 0 })).ok, true)
  assert.equal((await probeKvmCapability({ kernel: 'debian-12', run, now: 1000 })).ok, true)
  assert.equal(calls.filter((c) => c === 'run').length, 1)
  assert.equal(calls.filter((c) => c === 'info').length, 1)

  resetKvmCapabilityCache()
  const noDev = async (argv) =>
    argv[1] === 'image'
      ? { ok: true }
      : { ok: false, stderr: 'error gathering device information while adding custom device "/dev/kvm": no such file' }
  assert.equal((await probeKvmCapability({ kernel: 'debian-12', run: noDev, now: 0 })).code, 'kvm_unavailable')

  resetKvmCapabilityCache()
  const arm = async (argv) => (argv[1] === 'info' ? { ok: true, stdout: 'aarch64' } : { ok: true })
  assert.equal((await probeKvmCapability({ kernel: 'debian-12', run: arm, now: 0 })).code, 'kvm_arch_unsupported')

  resetKvmCapabilityCache()
  const noImage = async (argv) => (argv[1] === 'info' ? { ok: true, stdout: 'x86_64' } : { ok: false })
  assert.equal((await probeKvmCapability({ kernel: 'debian-12', run: noImage, now: 0 })).code, 'kvm_image_missing')
})
