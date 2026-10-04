import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MIN_ANDROID_API, detectFlavor, detectPlatform, mapArch } from '../src/platform.ts'

test('maps node arch to device arch', () => {
  assert.equal(mapArch('arm64'), 'aarch64')
  assert.equal(mapArch('aarch64'), 'aarch64')
  assert.equal(mapArch('x64'), 'x86_64')
  assert.equal(mapArch('arm'), 'armv7')
  assert.equal(mapArch('mips'), 'unknown')
})

test('detects the Play Store build from the frozen version', () => {
  assert.equal(detectFlavor({ TERMUX_VERSION: '0.101.0' }, false), 'playstore')
  assert.equal(detectFlavor({ TERMUX_VERSION: 'googleplay.2026.06.21' }, false), 'playstore')
  assert.equal(detectFlavor({ TERMUX_VERSION: '0.118.3' }, false), 'fdroid')
  assert.equal(detectFlavor({}, false), 'unknown')
})

test('marks an aarch64 device on a modern API as supported', () => {
  const platform = detectPlatform({ TERMUX_VERSION: '0.118.3' }, 'arm64', 34)
  assert.equal(platform.supported, true)
  assert.equal(platform.arch, 'aarch64')
  assert.equal(platform.flavor, 'fdroid')
  assert.equal(platform.termux, true)
})

test('rejects non-arm64 architectures', () => {
  const platform = detectPlatform({}, 'x64', 34)
  assert.equal(platform.supported, false)
  assert.match(platform.reason ?? '', /unsupported architecture/)
})

test('rejects an Android API below the minimum', () => {
  const platform = detectPlatform({}, 'arm64', MIN_ANDROID_API - 1)
  assert.equal(platform.supported, false)
  assert.match(platform.reason ?? '', /below the minimum/)
})

test('does not block when the API level is unknown', () => {
  const platform = detectPlatform({}, 'arm64', 0)
  assert.equal(platform.supported, true)
})
