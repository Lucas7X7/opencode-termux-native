import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'

export interface TarEntry {
  name: string
  mode: number
  size: number
  type: 'file' | 'directory' | 'other'
  data: Buffer
}

const BLOCK = 512

function readString(buffer: Buffer): string {
  const end = buffer.indexOf(0)
  return (end === -1 ? buffer : buffer.subarray(0, end)).toString('utf8')
}

function parseOctal(buffer: Buffer): number {
  const raw = buffer.toString('ascii').replace(/\0.*$/, '').trim()
  if (raw === '') return 0
  // GNU tar stores large sizes with the high bit set (base-256).
  if (buffer[0] !== undefined && (buffer[0] & 0x80) !== 0) {
    let value = buffer[0] & 0x7f
    for (let i = 1; i < buffer.length; i += 1) value = value * 256 + (buffer[i] ?? 0)
    return value
  }
  const parsed = Number.parseInt(raw, 8)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Minimal POSIX tar reader: enough for the release tarball, with no dependency
 * on the `tar` binary. That keeps the installer working on a bare Termux where
 * only Node is guaranteed. Long names (`L`) and pax headers are handled; pax
 * payloads are ignored because we only need names, modes and bytes.
 */
export function readTarGz(gz: Buffer): TarEntry[] {
  const data = gunzipSync(gz)
  const entries: TarEntry[] = []
  let offset = 0
  let longName: string | undefined

  while (offset + BLOCK <= data.length) {
    const header = data.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break

    const rawName = readString(header.subarray(0, 100))
    const prefix = readString(header.subarray(345, 500))
    const mode = parseOctal(header.subarray(100, 108))
    const size = parseOctal(header.subarray(124, 136))
    const typeflag = String.fromCharCode(header[156] ?? 0)

    offset += BLOCK
    const body = data.subarray(offset, offset + size)
    offset += Math.ceil(size / BLOCK) * BLOCK

    if (typeflag === 'L') {
      longName = readString(body)
      continue
    }
    if (typeflag === 'x' || typeflag === 'g' || typeflag === 'K') continue

    const name = longName ?? (prefix ? `${prefix}/${rawName}` : rawName)
    longName = undefined

    const type: TarEntry['type'] =
      typeflag === '5' ? 'directory' : typeflag === '0' || typeflag === '\u0000' ? 'file' : 'other'

    entries.push({
      name,
      mode,
      size,
      type,
      data: type === 'file' ? Buffer.from(body) : Buffer.alloc(0),
    })
  }

  return entries
}

export function safeJoin(root: string, name: string): string {
  const clean = normalize(name).replace(/^(\.\/)+/, '')
  if (clean.startsWith('..') || clean.startsWith('/') || clean.includes(`..${sep}`)) {
    throw new Error(`unsafe path in archive: ${name}`)
  }
  return join(root, clean)
}

export function extractTarGz(gz: Buffer, dest: string): string[] {
  const written: string[] = []
  for (const entry of readTarGz(gz)) {
    const target = safeJoin(dest, entry.name)
    if (entry.type === 'directory') {
      mkdirSync(target, { recursive: true })
      continue
    }
    if (entry.type !== 'file') continue
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, entry.data, { mode: entry.mode & 0o777 })
    written.push(target)
  }
  return written
}
