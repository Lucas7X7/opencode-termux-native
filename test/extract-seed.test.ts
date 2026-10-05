import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStandalone, buildStandaloneWithModules, fakeElfAarch64 } from './fixtures.ts'

const SCRIPT = fileURLToPath(new URL('../scripts/extract-seed.py', import.meta.url))

const python = spawnSync('python3', ['--version'], { encoding: 'utf8' })
const skip = python.status === 0 ? false : 'python3 is not available'

/**
 * An ELF whose section header table ends before the buffer does, so the script
 * has to work out the real object length instead of trusting the slot size.
 */
function fakeLib(totalSize: number, sectionTableAt: number, fill = 0x33): Buffer {
  const buf = Buffer.alloc(totalSize, fill)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(buf, 0)
  buf.writeUInt16LE(0xb7, 18)
  buf.writeBigUInt64LE(BigInt(sectionTableAt), 0x28) // e_shoff
  buf.writeUInt16LE(64, 0x3a) // e_shentsize
  buf.writeUInt16LE(2, 0x3c) // e_shnum -> 128 bytes of table
  return buf
}

function runExtract(binary: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'octn-seed-'))
  try {
    const binPath = join(dir, 'opencode.bin')
    const outDir = join(dir, 'out')
    writeFileSync(binPath, binary)
    const result = spawnSync('python3', [SCRIPT, binPath, outDir], { encoding: 'utf8' })
    // Snapshot before the temp dir goes away; a lazy reader would see nothing.
    const files = new Map<string, Buffer>()
    if (existsSync(outDir)) {
      for (const name of readdirSync(outDir).sort()) {
        files.set(name, readFileSync(join(outDir, name)))
      }
    }
    return { status: result.status, stderr: result.stderr, stdout: result.stdout, files }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('recovers the base and the embedded libraries from a grafted binary', { skip }, () => {
  const base = fakeElfAarch64(300, 0xaa)
  const lib = fakeLib(120, 40)
  const standalone = buildStandaloneWithModules(base, [
    { name: '/$bunfs/root/index.js', contents: Buffer.from('module') },
    { name: '/$bunfs/root/libopentui-abc.so', contents: lib },
  ])

  const { status, stderr, stdout, files } = runExtract(standalone)

  assert.equal(status, 0, stderr)
  assert.deepEqual([...files.keys()], ['bun-base.bin', 'libopentui-abc.so'])
  // The base is everything before the module graph: ELF header and all.
  assert.equal(files.get('bun-base.bin')?.length, base.length)
  assert.equal(files.get('bun-base.bin')?.readUInt16LE(18), 0xb7)
  assert.match(stdout, /bun-base\.bin\s+300 bytes\s+aarch64/)
})

test('trims the padding an in-place swap left behind', { skip }, () => {
  // Slot is 300 bytes; the section table ends at 100 + 64 * 2 = 228.
  const lib = fakeLib(300, 100)
  const standalone = buildStandaloneWithModules(fakeElfAarch64(200), [
    { name: '/$bunfs/root/libopentui-abc.so', contents: lib },
  ])

  const { status, stderr, stdout, files } = runExtract(standalone)

  assert.equal(status, 0, stderr)
  const recovered = files.get('libopentui-abc.so')
  assert.equal(recovered?.length, 228)
  assert.deepEqual(recovered, lib.subarray(0, 228))
  assert.match(stdout, /padding=72/)
})

test('handles a graft whose libraries were never resized', { skip }, () => {
  const lib = fakeLib(96, 96) // section table runs to the very end
  const standalone = buildStandaloneWithModules(fakeElfAarch64(200), [
    { name: '/$bunfs/root/libopentui-abc.so', contents: lib },
  ])

  const { status, stderr, files } = runExtract(standalone)

  assert.equal(status, 0, stderr)
  assert.equal(files.get('libopentui-abc.so')?.length, 96)
})

test('lists every embedded shared object', { skip }, () => {
  const standalone = buildStandaloneWithModules(fakeElfAarch64(200), [
    { name: '/$bunfs/root/libopentui-abc.so', contents: fakeLib(80, 80) },
    { name: '/$bunfs/root/librust_pty_arm64-xyz.so', contents: fakeLib(64, 64) },
    { name: '/$bunfs/root/index.js', contents: Buffer.from('not a library') },
  ])

  const { status, stderr, files } = runExtract(standalone)

  assert.equal(status, 0, stderr)
  assert.deepEqual(
    [...files.keys()],
    ['bun-base.bin', 'libopentui-abc.so', 'librust_pty_arm64-xyz.so'],
  )
})

test('fails on a binary with no Bun trailer', { skip }, () => {
  const { status, stderr } = runExtract(fakeElfAarch64(256))

  assert.equal(status, 1)
  assert.match(stderr, /Bun trailer not found/)
})

test('fails when the graph carries no shared object', { skip }, () => {
  const standalone = buildStandaloneWithModules(fakeElfAarch64(200), [
    { name: '/$bunfs/root/index.js', contents: Buffer.from('module') },
  ])

  const { status, stderr } = runExtract(standalone)

  assert.equal(status, 1)
  assert.match(stderr, /no embedded shared objects/)
})
