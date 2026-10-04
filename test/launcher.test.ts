import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LAUNCHER_MARKER, renderLauncher } from '../src/launcher.ts'
import { resolvePaths } from '../src/paths.ts'

const paths = resolvePaths({ PREFIX: '/x/usr', HOME: '/x/home' })

test('launcher detects the termux-exec shim from /proc/self/maps', () => {
  assert.match(renderLauncher(paths), /\/proc\/self\/maps/)
  assert.match(renderLauncher(paths), /libtermux-exec/)
})

test('launcher does not rely on a leaking env guard', () => {
  assert.doesNotMatch(renderLauncher(paths), /OPENCODE_TERMUX_REEXEC/)
})

test('launcher execs the runtime with the given arguments', () => {
  assert.match(renderLauncher(paths), /exec "\/x\/usr\/libexec\/opencode-termux-native\/opencode\.bin" "\$@"/)
})

test('launcher exports the native opentui library path', () => {
  assert.match(renderLauncher(paths), /OPENTUI_LIB_PATH="\/x\/usr\/lib\/libopentui\.so"/)
})

test('launcher carries a marker the installer can recognise', () => {
  assert.ok(renderLauncher(paths).includes(LAUNCHER_MARKER))
})

test('launcher lets the shim rewrite the runtime exec instead of calling the linker', () => {
  assert.doesNotMatch(renderLauncher(paths), /exec "\/system\/bin\/linker64" "\/x\/usr\/libexec/)
})

test('launcher preloads the termux-exec shim for the linker fallback', () => {
  assert.match(renderLauncher(paths), /LD_PRELOAD="\/x\/usr\/lib\/libtermux-exec\.so"/)
})

test('launcher re-execs itself through the linker before relaunching the runtime', () => {
  assert.match(renderLauncher(paths), /exec "\/system\/bin\/linker64" "\/x\/usr\/bin\/sh" "\$0" "\$@"/)
})

test('launcher uses the termux-exec opt-out only for its own re-exec', () => {
  assert.match(renderLauncher(paths), /export TERMUX_EXEC_OPTOUT=1/)
  assert.match(renderLauncher(paths), /unset TERMUX_EXEC_OPTOUT/)
})

test('launcher seeds the Termux ripgrep into the OpenCode cache', () => {
  assert.match(renderLauncher(paths), /cp "\/x\/usr\/bin\/rg" "\/x\/home\/\.cache\/opencode\/bin\/rg"/)
})
