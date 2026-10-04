import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseChecksums, sha256, verifyChecksum } from '../src/sha256.ts'

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

test('parses sha256sum output', () => {
  const sums = parseChecksums(
    `${HASH_A}  opencode-termux-native-aarch64.tar.gz\n${HASH_B} *other.tgz\n`,
  )
  assert.equal(sums.size, 2)
  assert.equal(sums.get('opencode-termux-native-aarch64.tar.gz'), HASH_A)
  assert.equal(sums.get('other.tgz'), HASH_B)
})

test('ignores malformed lines', () => {
  const sums = parseChecksums('not a checksum\n\n# comment\n')
  assert.equal(sums.size, 0)
})

test('verifies a matching file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octn-sha-'))
  try {
    const file = join(dir, 'artifact.tar.gz')
    writeFileSync(file, 'payload')
    const sums = parseChecksums(`${sha256('payload')}  artifact.tar.gz\n`)
    const result = verifyChecksum(file, sums)
    assert.equal(result.ok, true)
    assert.equal(result.actual, result.expected)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rejects a mismatching file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octn-sha-'))
  try {
    const file = join(dir, 'artifact.tar.gz')
    writeFileSync(file, 'tampered')
    const sums = parseChecksums(`${sha256('original')}  artifact.tar.gz\n`)
    assert.equal(verifyChecksum(file, sums).ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
