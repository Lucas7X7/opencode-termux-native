#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type Flags, options, parse } from './args.ts'
import { diagnose } from './doctor.ts'
import { install, uninstall } from './install.ts'
import { detectLinkerExec, linkerExec } from './linker.ts'
import { bail, bold, cyan, dim, info, ok, warn } from './log.ts'
import { BINARY_NAME, resolvePaths } from './paths.ts'
import { DEFAULT_REPO } from './release.ts'
import { VERSION } from './version.ts'

function helpText(): string {
  return `${bold('opencode-termux-native')} ${dim(`v${VERSION}`)}

${bold('Usage')}
  opencode-termux <command> [options]

${bold('Commands')}
  install      Install or update the native OpenCode binary ${dim('(default)')}
  update       Alias for install
  uninstall    Remove the installed binary, launcher and native libs
  doctor       Check whether this device can run the native build
  run          Run the installed OpenCode, passing through arguments
  version      Print the installer version
  help         Show this help

${bold('Options')}
  --repo <owner/name>       Release repository ${dim(`(default: ${DEFAULT_REPO})`)}
  --opencode <version>      Pin an OpenCode version instead of latest
  --no-verify               Skip the SHA256 check (not recommended)
  --json                    Machine-readable output for \`doctor\``
}

async function commandInstall(flags: Flags): Promise<void> {
  const opts = options(flags)
  try {
    const result = await install({
      repo: opts.repo,
      verify: opts.verify,
      ...(opts.opencodeVersion ? { opencodeVersion: opts.opencodeVersion } : {}),
      onLog: (message) => info(message),
    })

    console.log('')
    ok(`installed OpenCode v${bold(result.version)}`)
    info(`launcher ${dim(result.launcher)}`)
    info(`runtime  ${dim(result.runtime)}`)
    if (result.nativeLib) info(`native   ${dim(result.nativeLib)}`)
    console.log('')
    info(`run ${cyan('opencode')} to start`)
  } catch (error) {
    bail(error instanceof Error ? error.message : String(error))
  }
}

function commandDoctor(flags: Flags): void {
  const report = diagnose()

  if (flags.json === true) {
    console.log(JSON.stringify(report, null, 2))
    if (!report.ok) process.exit(1)
    return
  }

  console.log(bold('opencode-termux-native doctor'))
  console.log('')
  for (const check of report.checks) {
    const marker = check.level === 'ok' ? cyan('·') : check.level === 'warn' ? cyan('!') : cyan('✗')
    console.log(`  ${marker} ${check.label.padEnd(14)} ${check.value}`)
  }
  console.log('')

  if (report.ok) ok('this device can run the native build')
  else {
    warn('this device cannot run the native build')
    process.exit(1)
  }
}

function commandUninstall(): void {
  const removed = uninstall()
  if (removed.length === 0) {
    warn('nothing to remove')
    return
  }
  for (const target of removed) info(`removed ${dim(target)}`)
  ok('uninstalled (your OpenCode config was left untouched)')
}

function commandRun(rest: string[]): void {
  const paths = resolvePaths()
  const launcher = join(paths.binDir, BINARY_NAME)
  if (!existsSync(launcher)) bail('OpenCode is not installed. Run: opencode-termux install')

  // On the Play Store Termux this process cannot `execve` the app-data launcher
  // either, so fall back to the same system-linker relaunch the launcher uses.
  const status = detectLinkerExec(paths)
  const spec = status.available && status.needed ? linkerExec(paths, rest) : null
  const result = spec
    ? spawnSync(spec.file, spec.args, { stdio: 'inherit', env: spec.env })
    : spawnSync(launcher, rest, { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}

async function main(): Promise<void> {
  const { command, flags, rest } = parse(process.argv.slice(2))

  switch (command) {
    case '':
    case 'install':
    case 'update':
    case 'upgrade':
      await commandInstall(flags)
      break
    case 'doctor':
      commandDoctor(flags)
      break
    case 'uninstall':
    case 'remove':
      commandUninstall()
      break
    case 'run':
      commandRun(rest)
      break
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION)
      break
    case 'help':
    case '--help':
    case '-h':
      console.log(helpText())
      break
    default:
      bail(`unknown command: ${command}\n\n${helpText()}`)
  }
}

await main()
