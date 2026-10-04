import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePaths } from '../src/paths.ts'
import { detectRipgrep } from '../src/ripgrep.ts'

test('reports the Termux rg as the seeding source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octn-rg-'))
  const paths = resolvePaths({ PREFIX: join(dir, 'usr'), HOME: dir })
  mkdirSync(paths.binDir, { recursive: true })
  writeFileSync(join(paths.binDir, 'rg'), '')

  const status = detectRipgrep(paths)
  assert.equal(status.sourceAvailable, true)
  assert.equal(status.cached, false)
  assert.equal(status.target, join(dir, '.cache', 'opencode', 'bin', 'rg'))
})

test('reports a missing ripgrep when the Termux package is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'octn-rg-'))
  const paths = resolvePaths({ PREFIX: join(dir, 'usr'), HOME: dir })

  const status = detectRipgrep(paths)
  assert.equal(status.sourceAvailable, false)
  assert.equal(status.cached, false)
})
