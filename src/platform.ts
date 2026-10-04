import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

export type Arch = 'aarch64' | 'armv7' | 'x86_64' | 'unknown'
export type TermuxFlavor = 'fdroid' | 'playstore' | 'github' | 'unknown'

export interface Platform {
  arch: Arch
  androidApi: number
  termux: boolean
  flavor: TermuxFlavor
  supported: boolean
  reason?: string
}

export const MIN_ANDROID_API = 28

export function mapArch(nodeArch: string): Arch {
  switch (nodeArch) {
    case 'arm64':
    case 'aarch64':
      return 'aarch64'
    case 'arm':
    case 'armv7l':
      return 'armv7'
    case 'x64':
    case 'x86_64':
      return 'x86_64'
    default:
      return 'unknown'
  }
}

function readProp(file: string, key: string): string {
  try {
    const content = readFileSync(file, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith(`${key}=`)) return trimmed.slice(key.length + 1).trim()
      if (trimmed.startsWith(`[${key}]:`)) {
        const match = trimmed.match(/\[[^\]]+\]:\s*\[(.*)\]/)
        if (match?.[1] !== undefined) return match[1]
      }
    }
  } catch {
    /* not readable on this device */
  }
  return ''
}

/**
 * Android's `getprop` is the reliable source, but it is not on `$PATH` in every
 * Termux build. Fall back to reading the build props directly, then to a safe
 * default so an unknown API level never blocks the install.
 */
export function detectAndroidApi(): number {
  try {
    const out = execFileSync('getprop', ['ro.build.version.sdk'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const api = Number.parseInt(out, 10)
    if (Number.isFinite(api) && api > 0) return api
  } catch {
    /* getprop unavailable */
  }

  for (const file of ['/system/build.prop', '/vendor/build.prop']) {
    const value = readProp(file, 'ro.build.version.sdk')
    const api = Number.parseInt(value, 10)
    if (Number.isFinite(api) && api > 0) return api
  }

  return 0
}

export function detectTermux(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TERMUX_VERSION || env.TERMUX_APP_PACKAGE) return true
  if (existsSync('/data/data/com.termux/files/usr/bin/login')) return true
  return (env.PREFIX ?? '').includes('com.termux')
}

/**
 * Both store builds share the `com.termux` package, so the version string is the
 * only honest signal. The Play Store build froze at 0.101 and ships an older
 * coreutils; the F-Droid and GitHub builds run 0.118+. This is cosmetic — it
 * only shapes the doctor report, never the install.
 */
export function detectFlavor(
  env: NodeJS.ProcessEnv = process.env,
  termuxInfoExists: boolean = existsSync('/data/data/com.termux/files/usr/bin/termux-info'),
): TermuxFlavor {
  const version = env.TERMUX_VERSION ?? ''
  if (/^(0\.10[01]|googleplay)/.test(version)) return 'playstore'
  if (env.TERMUX_VERSION && !/^(0\.10[01]|googleplay)/.test(version)) return 'fdroid'
  if (termuxInfoExists) return 'fdroid'
  return 'unknown'
}

export function detectPlatform(
  env: NodeJS.ProcessEnv = process.env,
  nodeArch: string = process.arch,
  androidApi: number = detectAndroidApi(),
): Platform {
  const arch = mapArch(nodeArch)
  const termux = detectTermux(env)

  let supported = true
  let reason: string | undefined

  if (arch !== 'aarch64') {
    supported = false
    reason = `unsupported architecture: ${nodeArch} (only aarch64/arm64 has native builds)`
  } else if (androidApi > 0 && androidApi < MIN_ANDROID_API) {
    supported = false
    reason = `Android API ${androidApi} is below the minimum (${MIN_ANDROID_API})`
  }

  return {
    arch,
    androidApi,
    termux,
    flavor: detectFlavor(env),
    supported,
    ...(reason ? { reason } : {}),
  }
}

export function describeFlavor(flavor: TermuxFlavor): string {
  switch (flavor) {
    case 'fdroid':
      return 'Termux (F-Droid/GitHub)'
    case 'playstore':
      return 'Termux (Play Store)'
    default:
      return 'Termux'
  }
}
