import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { SYSTEM_LINKER, launchEnv } from './launcher.ts'
import { RUNTIME_NAME, type Paths, resolvePaths } from './paths.ts'

export interface LinkerExecStatus {
  /** The system linker and the Termux shim are both present. */
  available: boolean
  /** Raw `execve()` of an app-data ELF is denied here (Play Store build). */
  needed: boolean
}

/**
 * Android denies `execve()` of files under app data to apps that target API 29+
 * (the Play Store Termux), and `libtermux-exec.so` is what lifts that. The
 * launcher handles it on its own: it checks `/proc/self/maps` and re-executes
 * itself through the system linker with the shim when it is missing.
 *
 * This mirrors the same restriction for JS callers that spawn the runtime
 * directly (`opencode-termux run`): if this process cannot `execve` an app-data
 * ELF, it has no shim of its own and must go through the linker, which is
 * exactly when the fallback is required.
 */
export function detectLinkerExec(
  paths: Paths = resolvePaths(),
  linker: string = SYSTEM_LINKER,
  probeExists: boolean = existsSync(join(paths.binDir, 'true')),
): LinkerExecStatus {
  const available = existsSync(linker) && existsSync(join(paths.libDir, 'libtermux-exec.so'))
  if (!available || !probeExists) return { available, needed: false }

  try {
    execFileSync(join(paths.binDir, 'true'), { stdio: 'ignore' })
    return { available, needed: false }
  } catch {
    return { available, needed: true }
  }
}

export interface SpawnSpec {
  file: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * Builds the command that relaunches the runtime through the system linker with
 * the Termux shim preloaded. Used when a JS caller cannot execute the app-data
 * launcher itself (Play Store Termux denies `execve` to this process too).
 */
export function linkerExec(paths: Paths, args: string[] = [], env: NodeJS.ProcessEnv = process.env): SpawnSpec {
  return {
    file: SYSTEM_LINKER,
    args: [join(paths.libexecDir, RUNTIME_NAME), ...args],
    env: { ...launchEnv(paths, env), LD_PRELOAD: join(paths.libDir, 'libtermux-exec.so') },
  }
}
