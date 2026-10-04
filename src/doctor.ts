import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectLinkerExec } from './linker.ts'
import { type Paths, RUNTIME_NAME, resolvePaths } from './paths.ts'
import { type Platform, MIN_ANDROID_API, describeFlavor, detectPlatform } from './platform.ts'
import { detectRipgrep } from './ripgrep.ts'
import { CACHE_MARKER } from './version.ts'

export interface DoctorCheck {
  label: string
  value: string
  level: 'ok' | 'warn' | 'fail'
}

export interface DoctorReport {
  ok: boolean
  platform: Platform
  paths: Paths
  checks: DoctorCheck[]
}

export function diagnose(
  env: NodeJS.ProcessEnv = process.env,
  platform: Platform = detectPlatform(env),
  paths: Paths = resolvePaths(env),
): DoctorReport {
  const checks: DoctorCheck[] = []

  checks.push({
    label: 'architecture',
    value: platform.arch,
    level: platform.arch === 'aarch64' ? 'ok' : 'fail',
  })

  checks.push({
    label: 'android api',
    value: platform.androidApi > 0 ? String(platform.androidApi) : 'unknown',
    level:
      platform.androidApi === 0
        ? 'warn'
        : platform.androidApi >= MIN_ANDROID_API
          ? 'ok'
          : 'fail',
  })

  checks.push({
    label: 'termux',
    value: platform.termux ? describeFlavor(platform.flavor) : 'not detected',
    level: platform.termux ? 'ok' : 'warn',
  })

  if (platform.flavor === 'playstore') {
    checks.push({
      label: 'store build',
      value: 'Play Store Termux is deprecated; native build runs, but F-Droid/GitHub is recommended',
      level: 'warn',
    })
  }

  const linkerExec = detectLinkerExec(paths)
  checks.push({
    label: 'linker exec',
    value: !linkerExec.available
      ? 'not available'
      : linkerExec.needed
        ? 'enabled (app-data exec is restricted on this build)'
        : 'not needed',
    level: linkerExec.available ? 'ok' : 'warn',
  })

  const ripgrep = detectRipgrep(paths)
  checks.push({
    label: 'ripgrep',
    value: ripgrep.sourceAvailable
      ? 'available (seeded into the OpenCode cache)'
      : ripgrep.cached
        ? 'cached only; run: pkg install ripgrep'
        : 'missing; run: pkg install ripgrep (glob/grep need it)',
    level: ripgrep.sourceAvailable ? 'ok' : 'warn',
  })

  const runtime = join(paths.libexecDir, RUNTIME_NAME)
  checks.push({
    label: 'runtime',
    value: existsSync(runtime) ? runtime : 'not installed',
    level: existsSync(runtime) ? 'ok' : 'warn',
  })

  const marker = join(paths.libexecDir, CACHE_MARKER)
  let installed = 'unknown'
  if (existsSync(marker)) {
    try {
      installed = readFileSync(marker, 'utf8').trim() || 'unknown'
    } catch {
      /* keep the default */
    }
  }
  checks.push({
    label: 'version',
    value: installed === 'unknown' ? 'not installed' : `v${installed}`,
    level: installed === 'unknown' ? 'warn' : 'ok',
  })

  const launcher = join(paths.binDir, 'opencode')
  checks.push({
    label: 'launcher',
    value: existsSync(launcher) ? launcher : 'not installed',
    level: existsSync(launcher) ? 'ok' : 'warn',
  })

  const ok = !checks.some((check) => check.level === 'fail')
  return { ok, platform, paths, checks }
}
