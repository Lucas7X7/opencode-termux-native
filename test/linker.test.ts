import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchEnv } from '../src/launcher.ts'
import { detectLinkerExec, linkerExec } from '../src/linker.ts'
import { resolvePaths } from '../src/paths.ts'

const paths = resolvePaths({ PREFIX: '/x/usr', HOME: '/x/home' })

test('linker fallback is unavailable without the system linker and shim', () => {
  const status = detectLinkerExec(paths, '/nonexistent/linker64', false)
  assert.equal(status.available, false)
  assert.equal(status.needed, false)
})

test('linker fallback is needed when the probe cannot execute', () => {
  const dir = mkdtempSync(join(tmpdir(), 'opencode-termux-'))
  const appPaths = resolvePaths({ PREFIX: join(dir, 'usr'), HOME: dir })
  mkdirSync(appPaths.libDir, { recursive: true })
  const linker = join(dir, 'linker')
  writeFileSync(linker, '')
  writeFileSync(join(appPaths.libDir, 'libtermux-exec.so'), '')

  const status = detectLinkerExec(appPaths, linker, true)
  assert.equal(status.available, true)
  assert.equal(status.needed, true)
})

test('linkerExec relaunches the runtime through the system linker', () => {
  const spec = linkerExec(paths, ['--help'], {})
  assert.equal(spec.file, '/system/bin/linker64')
  assert.deepEqual(spec.args, ['/x/usr/libexec/opencode-termux-native/opencode.bin', '--help'])
})

test('linkerExec preloads the termux-exec shim from the prefix', () => {
  const spec = linkerExec(paths, [], {})
  assert.equal(spec.env.LD_PRELOAD, '/x/usr/lib/libtermux-exec.so')
  assert.equal(spec.env.OPENCODE_TERMUX_NATIVE, '1')
})

test('launchEnv keeps a caller-provided TERM and COLORTERM', () => {
  const env = launchEnv(paths, { TERM: 'screen', COLORTERM: '24bit' })
  assert.equal(env.TERM, 'screen')
  assert.equal(env.COLORTERM, '24bit')
})

test('launchEnv supplies sane terminal defaults', () => {
  const env = launchEnv(paths, {})
  assert.equal(env.TERM, 'xterm-256color')
  assert.equal(env.COLORTERM, 'truecolor')
})
