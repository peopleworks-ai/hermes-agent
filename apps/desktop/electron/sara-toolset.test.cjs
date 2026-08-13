'use strict'
/**
 * "Whole Computer" is a real boundary, not a label — the pure arg-builder proves the gating.
 *
 * The connector has no Electron imports, so it loads under plain `node --test`. We test the pure
 * buildChatArgs() rather than spawning `hermes` (which does not exist on the box this runs on — and
 * that unavailability is exactly why the gating is probe-guarded).
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const { buildChatArgs, CHROME_TOOLSETS } = require('./sara-connector.cjs')

test('ungated (probe failed / never ran) → NO --toolsets, full default toolset', () => {
  // The safe fallback: if we could not confirm the flag, we must not pass it — an unknown flag
  // would fail every task. Ungated behaves exactly like today.
  assert.deepEqual(buildChatArgs('do it', false, 'chrome'), ['chat', '-q', 'do it'])
  assert.deepEqual(buildChatArgs('do it', false, 'whole'), ['chat', '-q', 'do it'])
})

test('gated + Chrome → restricted to the browser set (no terminal, no file)', () => {
  assert.deepEqual(buildChatArgs('do it', true, 'chrome'), ['chat', '--toolsets', CHROME_TOOLSETS, '-q', 'do it'])
})

test('gated + Whole Computer → still NO flag, so Hermes gets everything', () => {
  assert.deepEqual(buildChatArgs('do it', true, 'whole'), ['chat', '-q', 'do it'])
})

test('the Chrome toolset genuinely withholds the dangerous capabilities', () => {
  const sets = CHROME_TOOLSETS.split(',')
  assert.ok(sets.includes('browser'), 'Chrome mode still needs the browser')
  assert.ok(!sets.includes('terminal'), 'Chrome mode must NOT get a shell')
  assert.ok(!sets.includes('file'), 'Chrome mode must NOT get the filesystem')
})

// ── Admin tool ceiling (Super Admin → Desktop Tools) ─────────────────────────
const { effectiveToolsets, setToolPolicy, getToolPolicy } = require('./sara-connector.cjs')

test('effectiveToolsets: no gating → null (never pass an unknown flag)', () => {
  assert.equal(effectiveToolsets('chrome', false, { disabled_toolsets: ['terminal'] }), null)
})

test('effectiveToolsets: chrome mode subtracts denied toolsets', () => {
  const out = effectiveToolsets('chrome', true, { disabled_toolsets: ['vision', 'todo'] })
  assert.equal(out, 'browser,web,skills')
})

test('effectiveToolsets: whole mode without policy keeps today\'s ungated behaviour', () => {
  assert.equal(effectiveToolsets('whole', true, { disabled_toolsets: [] }), null)
})

test('effectiveToolsets: whole mode WITH policy enumerates and subtracts', () => {
  const out = effectiveToolsets('whole', true, { disabled_toolsets: ['terminal', 'computer_use'] })
  assert.equal(out, 'browser,web,vision,skills,todo,file')
})

test('effectiveToolsets: never returns an empty list', () => {
  const all = 'browser,web,vision,skills,todo,terminal,file,computer_use'.split(',')
  const out = effectiveToolsets('chrome', true, { disabled_toolsets: all })
  assert.equal(out, 'skills', 'a tool-less spawn cannot even report why it failed')
})

test('setToolPolicy: junk shapes normalise to empty lists', () => {
  setToolPolicy(null)
  assert.deepEqual(getToolPolicy().disabled_toolsets, [])
  setToolPolicy({ disabled_toolsets: 'terminal' }) // string, not array
  assert.deepEqual(getToolPolicy().disabled_toolsets, [])
  setToolPolicy({ disabled_toolsets: ['terminal'], disabled_tools: ['browser_console'] })
  assert.deepEqual(getToolPolicy().disabled_tools, ['browser_console'])
  setToolPolicy(null) // leave clean for other tests
})
