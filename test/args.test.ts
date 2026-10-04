import { test } from 'node:test'
import assert from 'node:assert/strict'
import { options, parse } from '../src/args.ts'

test('treats an empty argv as the default command', () => {
  assert.deepEqual(parse([]), { command: '', flags: {}, rest: [] })
})

test('reads a flag value from the next argument', () => {
  const parsed = parse(['install', '--opencode', '1.18.31'])
  assert.equal(parsed.command, 'install')
  assert.equal(parsed.flags.opencode, '1.18.31')
})

test('reads a flag value from an inline equals sign', () => {
  assert.equal(parse(['install', '--opencode=1.18.31']).flags.opencode, '1.18.31')
})

test('treats a flag without a value as a boolean', () => {
  assert.equal(parse(['install', '--no-verify']).flags['no-verify'], true)
})

test('stops parsing flags after a bare separator', () => {
  const parsed = parse(['run', '--', '--version'])
  assert.equal(parsed.command, 'run')
  assert.deepEqual(parsed.rest, ['--version'])
  assert.deepEqual(parsed.flags, {})
})

test('forwards every argument after run verbatim, flags included', () => {
  const parsed = parse(['run', '--version'])
  assert.equal(parsed.command, 'run')
  assert.deepEqual(parsed.rest, ['--version'])
  assert.deepEqual(parsed.flags, {})
})

test('forwards a mixed argument list after run untouched', () => {
  const parsed = parse(['run', 'serve', '--port', '4096', '--json'])
  assert.deepEqual(parsed.rest, ['serve', '--port', '4096', '--json'])
  assert.deepEqual(parsed.flags, {})
})

test('defaults the release repository and keeps verification on', () => {
  assert.deepEqual(options({}), { repo: 'Lucas7X7/opencode-termux-native', verify: true })
})

test('accepts an alternate repository and skips verification on request', () => {
  assert.deepEqual(options({ repo: 'someone/else', 'no-verify': true }), {
    repo: 'someone/else',
    verify: false,
  })
})