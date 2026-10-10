/**
 * Self-contained slot image for cluster nodes: the kin-os guest image plus every
 * slot service baked in (kin-kernel + glibc shim, cli-node, cc-node, kin-worker
 * for oauth/telemetry, kin-egress, kin-codex-kernel). A remote node never
 * bind-mounts binaries from the control plane; it only receives per-slot config.
 *
 * The tag carries a content hash of the payload: a rebuilt cli-node with the
 * same VERSION is a different image (version strings do not prove bytes).
 * Built on the node itself via POST /build with a gzip tar context streamed
 * over SSH, so neither a registry nor node → ghcr credentials for our payload are needed.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { OS_CATALOG, imageForKernel } from '../vm/os-catalog.mjs'
import { kvmImageForKernel } from '../vm/kvm-runtime.mjs'
import { EGRESS_BIN } from '../vm/egress.mjs'
import {
  describeKernelPayload,
  inspectLinuxAmd64Elf,
  wrapCliTemplateDir,
  wrapKernelWrapperScript,
  WRAP_GLIBC_DIR,
} from '../vm/wrap-cli-runtime.mjs'
import { codexKernelBinPath } from '../transport/codex-kernel-supervisor.mjs'
import { ClusterError } from './ssh-link.mjs'
import { tarStream } from './tar.mjs'

export const REMOTE_WORKER_BIN = '/usr/local/bin/kin-worker'

function binOr(envKey, fallback) {
  const env = String(process.env[envKey] || '').trim()
  return env && fs.existsSync(env) ? env : fallback
}

function requireElf(file, label) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(64)
    fs.readSync(fd, head, 0, 64, 0)
    const check = inspectLinuxAmd64Elf(head)
    if (!check.ok) throw new ClusterError(500, 'slot_payload_invalid', `${label} 不是 linux amd64 ELF：${file}`)
  } catch (err) {
    if (err instanceof ClusterError) throw err
    throw new ClusterError(500, 'slot_payload_missing', `${label} 缺失：${file}`)
  } finally {
    if (fd != null) fs.closeSync(fd)
  }
}

/**
 * Files that go into the image, as tar entries `{ name, src?, body?, mode }`.
 * Throws slot_payload_missing / slot_payload_invalid with the offending path.
 */
export function slotPayload(projectRoot) {
  const wrapDir = wrapCliTemplateDir(projectRoot)
  const kernel = describeKernelPayload(projectRoot)
  if (kernel.source === 'missing') throw new ClusterError(500, 'slot_payload_missing', 'kin-kernel 缺失')
  requireElf(kernel.path, 'kin-kernel')
  const files = [
    { name: 'opt/kin/kin-kernel', body: Buffer.from(wrapKernelWrapperScript()), mode: 0o755 },
    { name: 'opt/kin/kin-kernel.bin', src: kernel.path, mode: 0o755 },
  ]
  for (const bin of ['cli-node', 'cc-node']) {
    const src = path.join(wrapDir, bin)
    requireElf(src, bin)
    files.push({ name: `opt/kin/${bin}`, src, mode: 0o755 })
  }
  const glibc = path.join(wrapDir, WRAP_GLIBC_DIR)
  if (fs.existsSync(glibc)) {
    for (const name of fs.readdirSync(glibc).sort()) {
      const src = path.join(glibc, name)
      if (fs.statSync(src).isFile()) files.push({ name: `opt/kin/${WRAP_GLIBC_DIR}/${name}`, src, mode: 0o755 })
    }
  }
  // Remote nodes require amd64 payloads, even when this control plane runs ARM64.
  const worker = binOr('KIN_CLUSTER_WORKER_BIN', binOr('KIN_WORKER_BIN', path.join(projectRoot, 'bin', 'kin-worker')))
  requireElf(worker, 'kin-worker')
  files.push({ name: 'usr/local/bin/kin-worker', src: worker, mode: 0o755 })
  const egress = binOr(
    'KIN_CLUSTER_EGRESS_BIN',
    fs.existsSync(EGRESS_BIN) ? EGRESS_BIN : path.join(projectRoot, 'bin', 'kin-egress'),
  )
  requireElf(egress, 'kin-egress')
  files.push({ name: 'usr/local/bin/kin-egress', src: egress, mode: 0o755 })
  const codex = codexKernelBinPath() || path.join(projectRoot, 'bin', 'kin-codex-kernel')
  requireElf(codex, 'kin-codex-kernel')
  files.push({ name: 'usr/local/bin/kin-codex-kernel', src: codex, mode: 0o755 })
  return files
}

const digestCache = new Map()

/** Content digest, cached by path + size + mtime so preflight does not rehash 100 MB each call. */
function fileDigest(file) {
  const st = fs.statSync(file)
  const key = `${file}\0${st.size}\0${st.mtimeMs}`
  const hit = digestCache.get(file)
  if (hit?.key === key) return hit.digest
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  digestCache.set(file, { key, digest })
  return digest
}

/**
 * A container slot gets the binaries in place. A KVM runner keeps them under
 * /opt/kin, which it shares into the guest; the guest links /opt/kin/bin into
 * /usr/local/bin, so exec callers see the same paths either way.
 */
export function slotDockerfile(baseImage, { kvm = false } = {}) {
  return [
    `FROM ${baseImage}`,
    'COPY opt/kin/ /opt/kin/',
    kvm ? 'COPY usr/local/bin/ /opt/kin/bin/' : 'COPY usr/local/bin/ /usr/local/bin/',
    'LABEL kin.slot.full=1',
    '',
  ].join('\n')
}

/**
 * `{ ref, base, hash, files }`. The tag is local to each node (never pushed):
 * vm2api/kin-slot-<kernel>:<hash12>. Content only — a release that leaves the
 * slot binaries alone must not orphan every node's image and stop its slots.
 */
export function slotImageSpec(projectRoot, kernel, { kvm = false } = {}) {
  if (!OS_CATALOG[kernel]) throw new ClusterError(400, 'invalid_kernel', `未知系统：${kernel}`)
  const base = kvm ? kvmImageForKernel(kernel) : imageForKernel(kernel)
  const files = slotPayload(projectRoot)
  const hash = crypto.createHash('sha256')
  hash.update(slotDockerfile(base, { kvm }))
  for (const f of files) {
    hash.update(`${f.name}\0${f.mode}\0`)
    hash.update(f.body ? crypto.createHash('sha256').update(f.body).digest('hex') : fileDigest(f.src))
  }
  const digest = hash.digest('hex').slice(0, 12)
  const name = kvm ? `kin-slot-vmm-${kernel}` : `kin-slot-${kernel}`
  return { ref: `vm2api/${name}:${digest}`, base, hash: digest, files, kvm }
}

export function slotBuildContext(spec) {
  const entries = [
    { name: 'Dockerfile', body: Buffer.from(slotDockerfile(spec.base, { kvm: spec.kvm })), mode: 0o644 },
    ...spec.files,
  ]
  return tarStream(entries).pipe(zlib.createGzip({ level: 6 }))
}
