import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assetUrl, nativeTagFor, parseRelease } from '../src/release.ts'

const SAMPLE = {
  tag_name: 'v1.18.31-native',
  assets: [
    { name: 'opencode-termux-native-aarch64.tar.gz', browser_download_url: 'https://example.test/a' },
    { name: 'SHA256SUMS', browser_download_url: 'https://example.test/b' },
  ],
}

test('parses a release and normalises the tag to a version', () => {
  const release = parseRelease(SAMPLE)
  assert.ok(release)
  assert.equal(release.tag, 'v1.18.31-native')
  assert.equal(release.version, '1.18.31-native')
  assert.equal(release.assets.length, 2)
})

test('finds an asset by name', () => {
  const release = parseRelease(SAMPLE)
  assert.ok(release)
  assert.equal(assetUrl(release, 'SHA256SUMS'), 'https://example.test/b')
  assert.equal(assetUrl(release, 'missing'), undefined)
})

test('rejects malformed payloads', () => {
  assert.equal(parseRelease(null), undefined)
  assert.equal(parseRelease({ assets: [] }), undefined)
  assert.equal(parseRelease('nope'), undefined)
})

test('builds the native tag from an upstream version', () => {
  assert.equal(nativeTagFor('1.18.31'), 'v1.18.31-native')
  assert.equal(nativeTagFor('v1.18.31'), 'v1.18.31-native')
})
