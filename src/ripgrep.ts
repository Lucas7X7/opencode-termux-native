import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type Paths } from './paths.ts'

export const RIPGREP_NAME = 'rg'

export interface RipgrepStatus {
  /** The Termux (Bionic) `rg` that can be seeded into OpenCode's cache. */
  source: string
  sourceAvailable: boolean
  /** Where OpenCode looks for its ripgrep (`~/.cache/opencode/bin/rg`). */
  target: string
  cached: boolean
}

/**
 * OpenCode downloads `ripgrep-<ver>-aarch64-unknown-linux-gnu`, a glibc build
 * that cannot run on Bionic Android, which makes the `glob` and `grep` tools
 * fail. The launcher seeds the Termux `rg` into OpenCode's cache instead; this
 * mirrors that lookup so the doctor can report whether glob/grep will work.
 */
export function detectRipgrep(paths: Paths): RipgrepStatus {
  const source = join(paths.binDir, RIPGREP_NAME)
  const target = join(paths.opencodeBinDir, RIPGREP_NAME)
  return {
    source,
    sourceAvailable: existsSync(source),
    target,
    cached: existsSync(target),
  }
}
