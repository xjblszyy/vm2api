import test from 'node:test'
import assert from 'node:assert/strict'
import {
  kvmContainerMemory,
  kvmExecArgs,
  kvmHardwareIdentity,
  kvmImageForKernel,
  kvmRunArgs,
  kvmRunError,
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

test('kvmExecArgs refuses flags it cannot honour instead of dropping them', () => {
  assert.throws(() => kvmExecArgs(['exec', '-t', 'kin-01', 'sh']), /unsupported docker exec flag -t/)
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

test('kvmRunArgs grants KVM, tun and netns-only NET_ADMIN and passes identity', () => {
  const vm = { id: 'vm-07', fingerprint: { guest_machine_id: 'c'.repeat(32) } }
  const args = kvmRunArgs(vm, { hostname: 'arch-1a2b', machineId: 'c'.repeat(32), uid: 10007, gid: 987 })
  const env = Object.fromEntries(args.flatMap((v, i) => (args[i - 1] === '-e' ? [v.split(/=(.*)/s).slice(0, 2)] : [])))
  assert.ok(args.includes('/dev/kvm') && args.includes('/dev/net/tun'))
  assert.deepEqual(args.slice(args.indexOf('--cap-add'), args.indexOf('--cap-add') + 2), ['--cap-add', 'NET_ADMIN'])
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
