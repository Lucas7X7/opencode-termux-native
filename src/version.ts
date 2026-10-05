import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'opencode-termux-native'

/**
 * The version lives in package.json and nowhere else. Hardcoding it here meant
 * a release could ship a binary that reports the wrong version, so it is read
 * from the manifest next to the code instead.
 *
 * The walk stops at the first package.json whose `name` is ours: without that
 * check it would happily report the version of whatever project installed us.
 */
function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string
        version?: string
      }
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === 'string') return pkg.version
    } catch {
      // Keep walking: dist/src/ has no manifest of its own.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return '0.0.0-unknown'
}

export const VERSION = readVersion()

export const CACHE_MARKER = '.opencode-termux-native-version'
