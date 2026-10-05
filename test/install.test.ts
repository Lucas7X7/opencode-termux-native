import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install, uninstall } from '../src/install.ts'
import { resolvePaths } from '../src/paths.ts'
import { sha256 } from '../src/sha256.ts'
import { buildTarGz } from './fixtures.ts'

function stubFetch(routes: (url: string) => Response | undefined): () => void {
  const original = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return routes(url) ?? new Response('not found', { status: 404 })
  }) as typeof fetch
  return () => {
    globalThis.fetch = original
  }
}

function releaseJson(assets: Array<{ name: string; url: string }>): string {
  return JSON.stringify({
    tag_name: 'v9.9.9-native',
    assets: assets.map((asset) => ({ name: asset.name, browser_download_url: asset.url })),
  })
}

test('installs a release using only fetch and node', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'octn-prefix-'))
  const home = mkdtempSync(join(tmpdir(), 'octn-home-'))
  const tarball = buildTarGz({ opencode: 'native-binary', 'libopentui.so': 'so-bytes' })
  const sums = `${sha256(tarball)}  opencode-termux-native-aarch64.tar.gz\n`

  const restore = stubFetch((url) => {
    if (url.includes('/releases/latest')) {
      return new Response(
        releaseJson([
          { name: 'opencode-termux-native-aarch64.tar.gz', url: 'https://fake.test/pkg.tar.gz' },
          { name: 'SHA256SUMS', url: 'https://fake.test/SHA256SUMS' },
        ]),
        { status: 200 },
      )
    }
    if (url.endsWith('pkg.tar.gz')) return new Response(tarball, { status: 200 })
    if (url.endsWith('SHA256SUMS')) return new Response(sums, { status: 200 })
    return undefined
  })

  try {
    const result = await install({
      repo: 'fake/repo',
      env: { PREFIX: prefix, HOME: home },
      nodeArch: 'arm64',
    })

    assert.equal(result.version, '9.9.9-native')
    assert.equal(result.launcher, join(prefix, 'bin', 'opencode'))
    assert.ok(existsSync(result.runtime))
    assert.equal(readFileSync(result.runtime, 'utf8'), 'native-binary')
    assert.equal(readFileSync(join(prefix, 'lib', 'libopentui.so'), 'utf8'), 'so-bytes')

    const launcher = readFileSync(result.launcher, 'utf8')
    assert.match(launcher, /OPENTUI_LIB_PATH/)

    const removed = uninstall(resolvePaths({ PREFIX: prefix, HOME: home }))
    assert.equal(removed.length, 3)
    assert.ok(!existsSync(result.launcher))
  } finally {
    restore()
    rmSync(prefix, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('refuses a tampered package', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'octn-prefix-'))
  const home = mkdtempSync(join(tmpdir(), 'octn-home-'))
  const tarball = buildTarGz({ opencode: 'native-binary' })
  const sums = `${sha256('something-else')}  opencode-termux-native-aarch64.tar.gz\n`

  const restore = stubFetch((url) => {
    if (url.includes('/releases/latest')) {
      return new Response(
        releaseJson([
          { name: 'opencode-termux-native-aarch64.tar.gz', url: 'https://fake.test/pkg.tar.gz' },
          { name: 'SHA256SUMS', url: 'https://fake.test/SHA256SUMS' },
        ]),
        { status: 200 },
      )
    }
    if (url.endsWith('pkg.tar.gz')) return new Response(tarball, { status: 200 })
    if (url.endsWith('SHA256SUMS')) return new Response(sums, { status: 200 })
    return undefined
  })

  try {
    await assert.rejects(
      () => install({ repo: 'fake/repo', env: { PREFIX: prefix, HOME: home }, nodeArch: 'arm64' }),
      /checksum mismatch/,
    )
  } finally {
    restore()
    rmSync(prefix, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('rejects an unsupported architecture before downloading', async () => {
  await assert.rejects(
    () => install({ repo: 'fake/repo', env: {}, nodeArch: 'x64' }),
    /unsupported architecture/,
  )
})

function taggedReleaseJson(tag: string, assets: Array<{ name: string; url: string }>): string {
  return JSON.stringify({
    tag_name: tag,
    assets: assets.map((asset) => ({ name: asset.name, browser_download_url: asset.url })),
  })
}

// `/releases/latest` is ordered by creation date and this repo also publishes
// pinned seed releases. If one of those shadows the native build, a plain
// `install` must still find the real release instead of erroring out.
test('skips a release that carries no native build', async () => {
  const prefix = mkdtempSync(join(tmpdir(), 'octn-prefix-'))
  const home = mkdtempSync(join(tmpdir(), 'octn-home-'))
  const tarball = buildTarGz({ opencode: 'native-binary' })
  const sums = `${sha256(tarball)}  opencode-termux-native-aarch64.tar.gz\n`
  const nativeAssets = [
    { name: 'opencode-termux-native-aarch64.tar.gz', url: 'https://fake.test/pkg.tar.gz' },
    { name: 'SHA256SUMS', url: 'https://fake.test/SHA256SUMS' },
  ]

  const restore = stubFetch((url) => {
    if (url.includes('/releases/latest')) {
      // A seed release, freshly created, so GitHub would call it "latest".
      return new Response(
        taggedReleaseJson('opentui-bionic-ndk29-aarch64', [
          { name: 'libopentui.so', url: 'https://fake.test/libopentui.so' },
        ]),
        { status: 200 },
      )
    }
    if (url.includes('/releases?')) {
      return new Response(
        JSON.stringify([
          JSON.parse(taggedReleaseJson('opentui-bionic-ndk29-aarch64', [
            { name: 'libopentui.so', url: 'https://fake.test/libopentui.so' },
          ])),
          JSON.parse(taggedReleaseJson('v9.9.9-native', nativeAssets)),
        ]),
        { status: 200 },
      )
    }
    if (url.endsWith('pkg.tar.gz')) return new Response(tarball, { status: 200 })
    if (url.endsWith('SHA256SUMS')) return new Response(sums, { status: 200 })
    return undefined
  })

  try {
    const result = await install({ repo: 'fake/repo', env: { PREFIX: prefix, HOME: home }, nodeArch: 'arm64' })
    assert.equal(result.tag, 'v9.9.9-native')
    assert.equal(readFileSync(result.runtime, 'utf8'), 'native-binary')
  } finally {
    restore()
    rmSync(prefix, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('reports clearly when no release carries a native build', async () => {
  const restore = stubFetch((url) => {
    if (url.includes('/releases/latest')) {
      return new Response(
        taggedReleaseJson('opentui-bionic-ndk29-aarch64', [
          { name: 'libopentui.so', url: 'https://fake.test/libopentui.so' },
        ]),
        { status: 200 },
      )
    }
    if (url.includes('/releases?')) {
      return new Response(JSON.stringify([JSON.parse(taggedReleaseJson('opentui-bionic-ndk29-aarch64', [
        { name: 'libopentui.so', url: 'https://fake.test/libopentui.so' },
      ]))]), { status: 200 })
    }
    return undefined
  })

  try {
    await assert.rejects(
      () =>
        install({
          repo: 'fake/repo',
          env: { PREFIX: mkdtempSync(join(tmpdir(), 'octn-prefix-')), HOME: mkdtempSync(join(tmpdir(), 'octn-home-')) },
          nodeArch: 'arm64',
        }),
      /no release for fake\/repo carries opencode-termux-native-aarch64\.tar\.gz/,
    )
  } finally {
    restore()
  }
})
