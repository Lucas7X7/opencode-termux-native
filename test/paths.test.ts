import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PREFIX, resolvePaths } from '../src/paths.ts'

test('resolves the Termux prefix and its subdirectories', () => {
  const paths = resolvePaths({ PREFIX: '/x/usr', HOME: '/x/home' })
  assert.equal(paths.prefix, '/x/usr')
  assert.equal(paths.binDir, '/x/usr/bin')
  assert.equal(paths.libexecDir, '/x/usr/libexec/opencode-termux-native')
  assert.equal(paths.libDir, '/x/usr/lib')
  assert.equal(paths.cacheDir, '/x/home/.cache/opencode-termux-native')
  assert.equal(paths.configDir, '/x/home/.config/opencode')
  assert.equal(paths.opencodeBinDir, '/x/home/.cache/opencode/bin')
})

test('falls back to the F-Droid default prefix when PREFIX is unset', () => {
  assert.equal(resolvePaths({}).prefix, DEFAULT_PREFIX)
})

test('honours XDG overrides', () => {
  const paths = resolvePaths({ PREFIX: '/x/usr', XDG_CACHE_HOME: '/cache', XDG_CONFIG_HOME: '/cfg' })
  assert.equal(paths.cacheDir, '/cache/opencode-termux-native')
  assert.equal(paths.configDir, '/cfg/opencode')
  assert.equal(paths.opencodeBinDir, '/cache/opencode/bin')
})
