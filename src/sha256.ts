import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

export interface ChecksumMatch {
  ok: boolean
  expected?: string
  actual?: string
}

export function sha256(buffer: Buffer | string): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * `sha256sum` emits `<hash>  <name>` and BSD tooling emits `<hash> *<name>`; a
 * release may also carry a trailing comment. Match on basename so a checksum
 * file written with `./` prefixes still resolves.
 */
export function parseChecksums(content: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of content.split('\n')) {
    const match = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/)
    if (!match || match[1] === undefined || match[2] === undefined) continue
    map.set(basename(match[2]), match[1].toLowerCase())
  }
  return map
}

export function verifyChecksum(
  file: string,
  checksums: Map<string, string>,
): ChecksumMatch {
  const expected = checksums.get(basename(file))
  if (expected === undefined) return { ok: false }
  const actual = sha256File(file)
  return { ok: actual === expected, expected, actual }
}
