import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BINARY_NAME, RUNTIME_NAME, type Paths } from './paths.ts'
import { RIPGREP_NAME } from './ripgrep.ts'

export const LAUNCHER_MARKER = '# opencode-termux-native launcher'

/** The system linker lets Android execute app-data ELFs when `execve` is denied. */
export const SYSTEM_LINKER = '/system/bin/linker64'

/**
 * The launcher is what makes the binary behave on Android regardless of which
 * Termux build started it:
 *
 * - point `OPENTUI_LIB_PATH` at a real filesystem `.so`, because Bun's virtual
 *   `$bunfs` paths are not resolvable by the Android loader;
 * - keep a sane `TERM` so the TUI does not fall back to a dumb terminal;
 * - make sure the runtime is loaded with `libtermux-exec.so`, which is what
 *   bypasses the SELinux `execve` restriction on Play Store Termux, and that the
 *   shim is present in the runtime and everything it spawns.
 *
 * The last point is subtle. The shim only helps the process that has it loaded,
 * so the launcher inspects `/proc/self/maps` instead of trusting an env guard
 * (which can leak into the launching shell) or a probe (which passes whenever the
 * launcher already inherited the shim, while the runtime would still lose it). If
 * the shim is missing, the launcher relaunches itself through the system linker
 * with the shim preloaded and `TERMUX_EXEC_OPTOUT=1`, so an inherited shim does
 * not strip `LD_PRELOAD` on the way. From then on it `exec`s the runtime
 * normally: the runtime is an app-data target, so the loaded shim rewrites that
 * exec and hands the child its own `LD_PRELOAD`. Calling the linker by hand for
 * the runtime would lose the shim, because the linker is not an app-data target
 * and the shim does not put `LD_PRELOAD` back for it.
 */
export function renderLauncher(paths: Paths): string {
  const lib = join(paths.libDir, 'libopentui.so')
  const runtime = join(paths.libexecDir, RUNTIME_NAME)
  const sh = join(paths.binDir, 'sh')
  const interposer = join(paths.libDir, 'libtermux-exec.so')
  const rgSource = join(paths.binDir, RIPGREP_NAME)
  const rgTarget = join(paths.opencodeBinDir, RIPGREP_NAME)

  return `#!${sh}
${LAUNCHER_MARKER}
set -e

# Is the termux-exec shim already loaded into this shell? Read it straight from
# /proc/self/maps so no external command (which would itself need the shim) is
# required.
shimmed=0
if [ -r /proc/self/maps ]; then
  while IFS= read -r line; do
    case "$line" in
      *libtermux-exec*) shimmed=1; break ;;
    esac
  done < /proc/self/maps
fi

# Android 10+ runs Termux builds that target API 29 or newer (the Play Store
# one) in the "untrusted_app" SELinux domain, which forbids execve() of files
# under app data. libtermux-exec.so rewrites those execs through the system
# linker, but only for the process that has it loaded. If this shell does not
# have it yet, relaunch through the linker with the shim preloaded. The opt-out
# stops an already-loaded shim from stripping LD_PRELOAD here, since the linker
# is not an app-data target and the shim would not put it back.
if [ "$shimmed" -eq 0 ] && [ -x "${SYSTEM_LINKER}" ] && [ -f "${interposer}" ]; then
  export TERMUX_EXEC_OPTOUT=1
  export LD_PRELOAD="${interposer}"
  exec "${SYSTEM_LINKER}" "${sh}" "$0" "$@"
fi

# The shim is loaded now. Drop the opt-out so the runtime is not started
# deaf to it, and let the shim rewrite the runtime's exec below.
unset TERMUX_EXEC_OPTOUT

export OPENCODE_TERMUX_NATIVE=1
export TERM="\${TERM:-xterm-256color}"
export COLORTERM="\${COLORTERM:-truecolor}"
if [ -f "${lib}" ]; then
  export OPENTUI_LIB_PATH="${lib}"
fi

# OpenCode downloads a glibc ripgrep that cannot run on Bionic, which breaks the
# glob and grep tools. Seed the Termux rg into OpenCode's cache, and repair a
# cached copy that no longer runs.
if [ -x "${rgSource}" ]; then
  if [ ! -e "${rgTarget}" ] || ! "${rgTarget}" --version >/dev/null 2>&1; then
    mkdir -p "${paths.opencodeBinDir}" && cp "${rgSource}" "${rgTarget}" && chmod +x "${rgTarget}" || true
  fi
fi

exec "${runtime}" "$@"
`
}

/**
 * The environment the launcher prepares for the runtime. Shared with JS callers
 * (e.g. `opencode-termux run`) that must spawn the runtime directly when the
 * system linker fallback is required and the launcher itself cannot be executed.
 */
export function launchEnv(paths: Paths, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const lib = join(paths.libDir, 'libopentui.so')
  const next: NodeJS.ProcessEnv = {
    ...env,
    OPENCODE_TERMUX_NATIVE: '1',
    TERM: env.TERM ?? 'xterm-256color',
    COLORTERM: env.COLORTERM ?? 'truecolor',
  }
  if (existsSync(lib)) next.OPENTUI_LIB_PATH = lib
  return next
}

export function writeLauncher(paths: Paths): string {
  const target = join(paths.binDir, BINARY_NAME)
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.tmp.${process.pid}`
  writeFileSync(temp, renderLauncher(paths), { mode: 0o755 })
  chmodSync(temp, 0o755)
  renameSync(temp, target)
  return target
}
