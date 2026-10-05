import { DEFAULT_REPO } from './release.ts'

export interface Flags {
  [key: string]: string | boolean
}

export interface Parsed {
  command: string
  flags: Flags
  rest: string[]
}

export interface CommandOptions {
  repo: string
  opencodeVersion?: string
  verify: boolean
}

/**
 * Everything after the `run` command belongs to OpenCode, flags included, so it
 * is forwarded verbatim. Without this, `run --version` would be read as the
 * installer's own `--version` and OpenCode would start its TUI instead.
 */
export function parse(argv: string[]): Parsed {
  const flags: Flags = {}
  const rest: string[] = []
  let command = ''

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) break

    if (command === 'run') {
      if (arg === '--') {
        rest.push(...argv.slice(i + 1))
        break
      }
      rest.push(arg)
      continue
    }

    if (arg === '--') {
      rest.push(...argv.slice(i + 1))
      break
    }

    // The long spellings are commands, not flags: `-h` and `-v` already reach
    // the CLI this way. Without this they would be parsed as `--help=true`,
    // leaving the command empty, and an empty command runs an install.
    if (!command && (arg === '--help' || arg === '--version')) {
      command = arg
      continue
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1)
        continue
      }
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next
        i += 1
      } else {
        flags[key] = true
      }
      continue
    }

    if (!command) command = arg
    else rest.push(arg)
  }

  return { command, flags, rest }
}

export function options(flags: Flags): CommandOptions {
  const repo = typeof flags.repo === 'string' ? flags.repo : DEFAULT_REPO
  const opencodeVersion =
    typeof flags.opencode === 'string' ? flags.opencode : typeof flags.version === 'string' ? flags.version : undefined
  return {
    repo,
    verify: flags['no-verify'] !== true,
    ...(opencodeVersion ? { opencodeVersion } : {}),
  }
}