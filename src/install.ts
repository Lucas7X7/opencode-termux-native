import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { download } from './download.ts'
import { writeLauncher } from './launcher.ts'
import { BINARY_NAME, type Paths, RUNTIME_NAME, resolvePaths } from './paths.ts'
import { type Platform, detectPlatform } from './platform.ts'
import {
  CHECKSUM_ASSET,
  DEFAULT_REPO,
  NATIVE_ASSET,
  assetUrl,
  fetchLatestRelease,
  fetchReleaseByTag,
  nativeTagFor,
  type Release,
} from './release.ts'
import { parseChecksums, verifyChecksum } from './sha256.ts'
import { extractTarGz } from './tar.ts'
import { CACHE_MARKER } from './version.ts'

export interface InstallOptions {
  repo?: string
  opencodeVersion?: string
  verify?: boolean
  token?: string
  env?: NodeJS.ProcessEnv
  /** Override the detected architecture (used by tests and cross-installs). */
  nodeArch?: string
  onLog?: (message: string) => void
}

export interface InstallResult {
  version: string
  tag: string
  binary: string
  launcher: string
  runtime: string
  nativeLib?: string
  paths: Paths
}

async function resolveRelease(options: InstallOptions): Promise<Release> {
  const repo = options.repo ?? DEFAULT_REPO
  if (options.opencodeVersion) {
    return fetchReleaseByTag(nativeTagFor(options.opencodeVersion), repo, options.token)
  }
  return fetchLatestRelease(repo, options.token, NATIVE_ASSET)
}

function findFile(root: string, name: string): string | undefined {
  const direct = join(root, name)
  if (existsSync(direct)) return direct
  return undefined
}

/**
 * Installs the native release. Only Node is required on the device: downloads
 * use `fetch`, extraction uses the bundled tar reader and hashing uses
 * `node:crypto`, so a bare F-Droid or Play Store Termux with `nodejs` is enough.
 */
export async function install(options: InstallOptions = {}): Promise<InstallResult> {
  const log = options.onLog ?? (() => {})
  const env = options.env ?? process.env
  const paths = resolvePaths(env)
  const platform: Platform = detectPlatform(env, options.nodeArch ?? process.arch)

  if (!platform.supported) {
    throw new Error(platform.reason ?? 'unsupported device')
  }

  const release = await resolveRelease(options)
  const tarball = assetUrl(release, NATIVE_ASSET)
  if (!tarball) throw new Error(`release ${release.tag} has no ${NATIVE_ASSET} asset`)

  mkdirSync(paths.cacheDir, { recursive: true })
  const work = mkdtempSync(join(paths.cacheDir, 'install-'))
  const archivePath = join(work, NATIVE_ASSET)

  try {
    log(`downloading ${NATIVE_ASSET} (${release.tag})`)
    await download(tarball, archivePath, { token: options.token })

    const checksumUrl = assetUrl(release, CHECKSUM_ASSET)
    if (checksumUrl) {
      const sumsPath = join(work, CHECKSUM_ASSET)
      await download(checksumUrl, sumsPath, { token: options.token })
      const checksums = parseChecksums(readFileSync(sumsPath, 'utf8'))
      const result = verifyChecksum(archivePath, checksums)
      if (!result.ok && options.verify !== false) {
        throw new Error(
          `checksum mismatch for ${basename(archivePath)} (expected ${result.expected ?? 'none'}, got ${result.actual ?? 'none'})`,
        )
      }
      if (result.ok) log('checksum verified')
    } else if (options.verify !== false) {
      log(`no ${CHECKSUM_ASSET} asset; continuing without verification`)
    }

    log('extracting')
    const extractDir = join(work, 'extract')
    mkdirSync(extractDir, { recursive: true })
    extractTarGz(readFileSync(archivePath), extractDir)

    const sourceBinary = findFile(extractDir, 'opencode')
    if (!sourceBinary) throw new Error('archive does not contain an "opencode" binary')

    mkdirSync(paths.libexecDir, { recursive: true })
    const runtime = join(paths.libexecDir, RUNTIME_NAME)
    copyFileSync(sourceBinary, runtime)
    chmodSync(runtime, 0o755)

    let nativeLib: string | undefined
    const sourceLib = findFile(extractDir, 'libopentui.so')
    if (sourceLib) {
      mkdirSync(paths.libDir, { recursive: true })
      nativeLib = join(paths.libDir, 'libopentui.so')
      copyFileSync(sourceLib, nativeLib)
      chmodSync(nativeLib, 0o644)
    }

    log('writing launcher')
    const launcher = writeLauncher(paths)
    writeFileSync(join(paths.libexecDir, CACHE_MARKER), `${release.version}\n`)

    return {
      version: release.version,
      tag: release.tag,
      binary: runtime,
      launcher,
      runtime,
      ...(nativeLib ? { nativeLib } : {}),
      paths,
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

export function uninstall(paths: Paths = resolvePaths()): string[] {
  const runtimeDir = paths.libexecDir
  const launcher = join(paths.binDir, BINARY_NAME)
  const nativeLib = join(paths.libDir, 'libopentui.so')
  const removed: string[] = []

  for (const target of [launcher, nativeLib]) {
    if (existsSync(target)) {
      rmSync(target, { force: true })
      removed.push(target)
    }
  }
  if (existsSync(runtimeDir)) {
    rmSync(runtimeDir, { recursive: true, force: true })
    removed.push(runtimeDir)
  }
  return removed
}
