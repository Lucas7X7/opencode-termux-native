import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { extractTarGz, readTarGz, safeJoin } from '../src/tar.ts'

function header(name: string, size: number, type = '0'): Buffer {
  const block = Buffer.alloc(512)
  block.write(name, 0, 100, 'utf8')
  block.write('0000644\0', 100, 8, 'ascii')
  block.write('0000000\0', 108, 8, 'ascii')
  block.write('0000000\0', 116, 8, 'ascii')
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
  block.write('00000000000\0', 136, 12, 'ascii')
  block.write('        ', 148, 8, 'ascii')
  block.write(type, 156, 1, 'ascii')
  block.write('ustar\0', 257, 6, 'ascii')
  block.write('00', 263, 2, 'ascii')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
  return block
}

function makeTar(files: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content)
    parts.push(header(name, body.length))
    parts.push(body)
    const pad = (512 - (body.length % 512)) % 512
    if (pad > 0) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

test('reads a plain file entry', () => {
  const entries = readTarGz(gzipSync(makeTar({ 'opencode': 'binary-bytes' })))
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.name, 'opencode')
  assert.equal(entries[0]?.data.toString(), 'binary-bytes')
  assert.equal(entries[0]?.type, 'file')
})

test('strips a leading ./ like npm tarballs use', () => {
  const entries = readTarGz(gzipSync(makeTar({ './package/opencode': 'x' })))
  assert.equal(entries[0]?.name, './package/opencode')
})

test('extracts files to disk with their mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octn-tar-'))
  try {
    const written = extractTarGz(
      gzipSync(makeTar({ 'opencode': 'hello', 'libopentui.so': 'so' })),
      dir,
    )
    assert.equal(written.length, 2)
    assert.equal(readFileSync(join(dir, 'opencode'), 'utf8'), 'hello')
    assert.equal(readFileSync(join(dir, 'libopentui.so'), 'utf8'), 'so')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refuses path traversal', () => {
  assert.throws(() => safeJoin('/tmp/root', '../evil'), /unsafe path/)
  assert.throws(() => safeJoin('/tmp/root', '/etc/passwd'), /unsafe path/)
})
