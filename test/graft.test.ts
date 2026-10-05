import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildStandalone,
  buildStandaloneWithModules,
  buildTarGz,
  fakeElfAarch64,
} from './fixtures.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/graft.py', import.meta.url))
const TRAILER = Buffer.from('\n---- Bun! ----\n')
const OFFSETS_SIZE = 32

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' })
const hasPython = python.status === 0
const skip = hasPython ? false : 'python3 is not available'

function runGraft(base: Buffer, opencode: Buffer, opentui?: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'octn-graft-'))
  try {
    const basePath = join(dir, 'base')
    const tarPath = join(dir, 'opencode.tar.gz')
    const outPath = join(dir, 'out')
    writeFileSync(basePath, base)
    writeFileSync(tarPath, buildTarGz({ opencode }))
    const args = [SCRIPT, '--base', basePath, '--opencode-tar', tarPath, '--out', outPath]
    if (opentui) {
      const libPath = join(dir, 'libopentui.so')
      writeFileSync(libPath, opentui)
      args.push('--opentui', libPath)
    }
    const result = spawnSync('python3', args, { encoding: 'utf8' })
    let out: Buffer | undefined
    try {
      out = readFileSync(outPath)
    } catch {
      out = undefined
    }
    return { status: result.status, stderr: result.stderr, out }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('transplants the payload onto a Bionic base', { skip }, () => {
  const officialBase = fakeElfAarch64(400, 0xaa)
  const blob = Buffer.from('module graph bytes')
  const standalone = buildStandalone(officialBase, blob)

  const bionicBase = fakeElfAarch64(300, 0x11)
  const { status, stderr, out } = runGraft(bionicBase, standalone)

  assert.equal(status, 0, stderr)
  assert.ok(out, 'graft produced no output')

  const offsets = Buffer.alloc(OFFSETS_SIZE)
  offsets.writeBigUInt64LE(BigInt(blob.length), 0)
  const graphLength = blob.length + OFFSETS_SIZE + TRAILER.length
  const total = BigInt(bionicBase.length + graphLength + 8)
  const footer = Buffer.alloc(8)
  footer.writeBigUInt64LE(total, 0)
  const expected = Buffer.concat([bionicBase, blob, offsets, TRAILER, footer])

  assert.deepEqual(out, expected)
  assert.ok(out.subarray(-24, -8).equals(TRAILER), 'trailer is not 24 bytes from the end')
})

test('rejects a binary with no Bun trailer', { skip }, () => {
  const { status, stderr } = runGraft(fakeElfAarch64(300), Buffer.from('not a standalone'))
  assert.equal(status, 1)
  assert.match(stderr, /trailer not found/)
})

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])
const fakeLib = (size: number, fill: number): Buffer =>
  Buffer.concat([ELF_MAGIC, Buffer.alloc(size - ELF_MAGIC.length, fill)])

/** Read the module graph: recorded length per module, plus the blob size. */
function readGraph(binary: Buffer): { lengths: Map<string, number>; byteCount: number } {
  const trailerPos = binary.lastIndexOf(TRAILER)
  const offsetsPos = trailerPos - OFFSETS_SIZE
  const byteCount = Number(binary.readBigUInt64LE(offsetsPos))
  const modulesOff = binary.readUInt32LE(offsetsPos + 8)
  const modulesLen = binary.readUInt32LE(offsetsPos + 12)
  const graphStart = offsetsPos - byteCount
  const lengths = new Map<string, number>()

  for (const stride of [52, 36]) {
    if (modulesLen % stride !== 0) continue
    const attempt = new Map<string, number>()
    let valid = true
    for (let i = 0; i < modulesLen / stride; i += 1) {
      const rec = graphStart + modulesOff + i * stride
      const nameOff = binary.readUInt32LE(rec)
      const nameLen = binary.readUInt32LE(rec + 4)
      if (nameLen === 0 || nameLen > 4096) {
        valid = false
        break
      }
      const name = binary.subarray(graphStart + nameOff, graphStart + nameOff + nameLen).toString()
      if (!name.startsWith('/')) {
        valid = false
        break
      }
      attempt.set(name, binary.readUInt32LE(rec + 12))
    }
    if (valid) return { lengths: attempt, byteCount }
  }
  throw new Error('could not read the module graph')
}

test('swaps the embedded libopentui for a Bionic build', { skip }, () => {
  const glibc = fakeLib(64, 0x11)
  const bionic = fakeLib(64, 0x22)
  const opencodeFile = buildStandaloneWithModules(fakeElfAarch64(400), [
    { name: '/$bunfs/root/libopentui-abc.so', contents: glibc },
    { name: '/$bunfs/root/index.js', contents: Buffer.from('module') },
  ])

  const { status, stderr, out } = runGraft(fakeElfAarch64(300), opencodeFile, bionic)

  assert.equal(status, 0, stderr)
  assert.ok(out, 'graft produced no output')
  assert.ok(out.includes(bionic), 'Bionic libopentui is missing from the output')
  assert.ok(!out.includes(glibc), 'the glibc libopentui was not replaced')
})

test('pads a shorter libopentui replacement', { skip }, () => {
  const glibc = fakeLib(64, 0x11)
  const bionic = fakeLib(60, 0x22)
  const opencodeFile = buildStandaloneWithModules(fakeElfAarch64(400), [
    { name: '/$bunfs/root/libopentui-abc.so', contents: glibc },
  ])

  const { status, stderr, out } = runGraft(fakeElfAarch64(300), opencodeFile, bionic)

  assert.equal(status, 0, stderr)
  assert.ok(out?.includes(bionic), 'Bionic libopentui is missing from the output')
})

// Bun materialises an embedded library into a temp file before dlopen and writes
// exactly the recorded length, so leaving the padded length in place left a 13 MB
// copy of a 5.6 MB library in /tmp on every run. The recorded length has to follow
// the replacement, and because offsets are absolute nothing else may move.
test('records the real library length instead of the padded slot', { skip }, () => {
  const glibc = fakeLib(64, 0x11)
  const bionic = fakeLib(60, 0x22)
  const opencodeFile = buildStandaloneWithModules(fakeElfAarch64(400), [
    { name: '/$bunfs/root/libopentui-abc.so', contents: glibc },
  ])

  const upstream = readGraph(opencodeFile)
  assert.equal(upstream.lengths.get('/$bunfs/root/libopentui-abc.so'), 64)

  const { status, stderr, out } = runGraft(fakeElfAarch64(300), opencodeFile, bionic)

  assert.equal(status, 0, stderr)
  assert.ok(out, 'graft produced no output')

  const grafted = readGraph(out)
  assert.equal(grafted.lengths.get('/$bunfs/root/libopentui-abc.so'), 60)
  // The blob keeps its size, so every other offset in the graph stays valid.
  assert.equal(grafted.byteCount, upstream.byteCount)
})

test('rejects a libopentui replacement that is too large', { skip }, () => {
  const glibc = fakeLib(64, 0x11)
  const bionic = fakeLib(80, 0x22)
  const opencodeFile = buildStandaloneWithModules(fakeElfAarch64(400), [
    { name: '/$bunfs/root/libopentui-abc.so', contents: glibc },
  ])

  const { status, stderr } = runGraft(fakeElfAarch64(300), opencodeFile, bionic)

  assert.equal(status, 1)
  assert.match(stderr, /would need\s+reserializing/)
})

test('rejects --opentui when no lib is embedded', { skip }, () => {
  const bionic = fakeLib(64, 0x22)
  const opencodeFile = buildStandaloneWithModules(fakeElfAarch64(400), [
    { name: '/$bunfs/root/index.js', contents: Buffer.from('module') },
  ])

  const { status, stderr } = runGraft(fakeElfAarch64(300), opencodeFile, bionic)

  assert.equal(status, 1)
  assert.match(stderr, /no embedded library/)
})

test('rejects an implausible byte_count', { skip }, () => {
  const procedural = Buffer.concat([
    Buffer.alloc(OFFSETS_SIZE),
    Buffer.from('\n---- Bun! ----\n'),
    Buffer.alloc(8),
  ])
  procedural.writeBigUInt64LE(BigInt(0xffffffff), 0)
  const { status, stderr } = runGraft(fakeElfAarch64(300), procedural)
  assert.equal(status, 1)
  assert.match(stderr, /implausible module graph/)
})
