import { gzipSync } from 'node:zlib'

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

export function buildTar(files: Record<string, string | Buffer>): Buffer {
  const parts: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content)
    parts.push(header(name, body.length))
    parts.push(body)
    const pad = (512 - (body.length % 512)) % 512
    if (pad > 0) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

export function buildTarGz(files: Record<string, string | Buffer>): Buffer {
  return gzipSync(buildTar(files))
}

const BUN_TRAILER = '\n---- Bun! ----\n'
const OFFSETS_SIZE = 32

/** A minimal aarch64 ELF header good enough for `elftype` to accept. */
export function fakeElfAarch64(size = 256, fill = 0): Buffer {
  const base = Buffer.alloc(size, fill)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(base, 0)
  base.writeUInt16LE(0xb7, 18)
  return base
}

/**
 * Build a synthetic Bun standalone binary using the real payload layout:
 *
 *   [base][blob (byte_count)][Offsets 32B][trailer 16B][u64 total]
 */
export function buildStandalone(base: Buffer, blob: Buffer): Buffer {
  const offsets = Buffer.alloc(OFFSETS_SIZE)
  offsets.writeBigUInt64LE(BigInt(blob.length), 0)
  const trailer = Buffer.from(BUN_TRAILER)
  const total = BigInt(base.length + blob.length + OFFSETS_SIZE + trailer.length + 8)
  const footer = Buffer.alloc(8)
  footer.writeBigUInt64LE(total, 0)
  return Buffer.concat([base, blob, offsets, trailer, footer])
}

export interface FakeModule {
  name: string
  contents: Buffer
}

/**
 * Build a standalone whose payload contains a real (52-byte) module table, so
 * the graft script can find and patch an embedded shared object by name.
 */
export function buildStandaloneWithModules(base: Buffer, modules: FakeModule[]): Buffer {
  const chunks: Buffer[] = []
  let cursor = 0
  const add = (buf: Buffer): { off: number; len: number } => {
    const ref = { off: cursor, len: buf.length }
    chunks.push(buf)
    cursor += buf.length
    return ref
  }

  const records = modules.map((mod) => {
    const name = add(Buffer.from(mod.name))
    const contents = add(mod.contents)
    const rec = Buffer.alloc(52)
    rec.writeUInt32LE(name.off, 0)
    rec.writeUInt32LE(name.len, 4)
    rec.writeUInt32LE(contents.off, 8)
    rec.writeUInt32LE(contents.len, 12)
    return rec
  })

  const table = Buffer.concat(records)
  const modulesOff = cursor
  cursor += table.length

  const offsets = Buffer.alloc(OFFSETS_SIZE)
  offsets.writeBigUInt64LE(BigInt(cursor), 0)
  offsets.writeUInt32LE(modulesOff, 8)
  offsets.writeUInt32LE(table.length, 12)

  const trailer = Buffer.from(BUN_TRAILER)
  const graph = Buffer.concat([...chunks, table, offsets, trailer])
  const total = BigInt(base.length + graph.length + 8)
  const footer = Buffer.alloc(8)
  footer.writeBigUInt64LE(total, 0)
  return Buffer.concat([base, graph, footer])
}
