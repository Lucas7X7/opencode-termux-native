import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Where the native binary, its launcher and its optional `.so` live. These are
 * the F-Droid defaults; the Play Store Termux uses the same `$PREFIX`, so a
 * single layout covers both builds.
 */
export interface Paths {
  prefix: string
  binDir: string
  libexecDir: string
  libDir: string
  cacheDir: string
  configDir: string
  /** OpenCode's own binary cache, where it keeps the ripgrep it downloads. */
  opencodeBinDir: string
}

export const DEFAULT_PREFIX = '/data/data/com.termux/files/usr'
export const BINARY_NAME = 'opencode'
export const RUNTIME_NAME = 'opencode.bin'

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const prefix = env.PREFIX ?? DEFAULT_PREFIX
  const home = env.HOME ?? homedir()
  const cacheHome = env.XDG_CACHE_HOME ?? join(home, '.cache')
  const configHome = env.XDG_CONFIG_HOME ?? join(home, '.config')

  return {
    prefix,
    binDir: join(prefix, 'bin'),
    libexecDir: join(prefix, 'libexec', 'opencode-termux-native'),
    libDir: join(prefix, 'lib'),
    cacheDir: join(cacheHome, 'opencode-termux-native'),
    configDir: join(configHome, 'opencode'),
    opencodeBinDir: join(cacheHome, 'opencode', 'bin'),
  }
}
