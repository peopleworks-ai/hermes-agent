/**
 * Tests for the per-conversation context bundle in electron/sara-connector.cjs.
 *
 * Run with: node --test electron/sara-bundle.test.cjs
 *
 * Why this matters: the bundle is server-authored content written to a path the
 * agent then reads, so two properties are load-bearing and neither is visible by
 * reading the happy path.
 *
 * 1. A file path in the bundle is chosen by the SERVER. If a `../../..` ever got
 *    through, the connector would write outside HERMES_HOME as whatever user the
 *    app runs as. The write must stay inside the bundle directory.
 * 2. Fetching the bundle must never be able to stop a task. A step whose context
 *    fails to download has to run exactly as it did before the bundle existed —
 *    degraded, not blocked.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sara-bundle-test-'))
process.env.HERMES_HOME = HOME

const { syncConversationBundle, bundleDir, pruneConversationBundles } = require('./sara-connector.cjs')

const CONV = 'SARAH-CONV-2026-000001'

function serve(payload) {
  global.fetch = async () => ({ ok: true, json: async () => ({ message: payload }) })
}

test('writes the pack and keeps every file inside the bundle directory', async () => {
  const escaped = path.join(os.tmpdir(), 'sara-bundle-escape-probe.md')
  fs.rmSync(escaped, { force: true })
  serve({
    hash: 'h1',
    files: [
      { path: 'SKILL.md', content: '---\nname: conv\n---\n' },
      { path: 'AGENTS.md', content: 'step 1 already done' },
      { path: 'references/transcript.md', content: 'transcript body' },
      // The escape attempt. Written by the server; must not land.
      { path: '../../../../sara-bundle-escape-probe.md', content: 'escaped' },
    ],
  })

  const dir = await syncConversationBundle(CONV)
  assert.equal(dir, bundleDir(CONV))
  assert.ok(fs.existsSync(path.join(dir, 'SKILL.md')))
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), 'step 1 already done')
  assert.ok(fs.existsSync(path.join(dir, 'references', 'transcript.md')))
  assert.equal(fs.existsSync(escaped), false, 'a ../ path escaped the bundle directory')
})

test('an unchanged hash leaves the files alone', async () => {
  const dir = bundleDir(CONV)
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'LOCAL EDIT', 'utf8')
  serve({ hash: 'h1', files: [{ path: 'AGENTS.md', content: 'rewritten' }] })

  await syncConversationBundle(CONV)
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), 'LOCAL EDIT')
})

test('a changed hash rewrites', async () => {
  const dir = bundleDir(CONV)
  serve({ hash: 'h2', files: [{ path: 'AGENTS.md', content: 'step 2 also done' }] })

  await syncConversationBundle(CONV)
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), 'step 2 also done')
})

test('a failing fetch yields null instead of throwing', async () => {
  global.fetch = async () => {
    throw new Error('network down')
  }
  assert.equal(await syncConversationBundle(CONV), null)

  global.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) })
  assert.equal(await syncConversationBundle(CONV), null)

  serve({ hash: 'h3', files: [] }) // server answered, nothing to write
  assert.equal(await syncConversationBundle(CONV), null)
})

test('no conversation id yields null without touching disk', async () => {
  assert.equal(await syncConversationBundle(''), null)
  assert.equal(bundleDir(''), null)
})

test('pruning removes stale bundles and keeps fresh ones', async () => {
  serve({ hash: 'h4', files: [{ path: 'SKILL.md', content: 'x' }] })
  const fresh = await syncConversationBundle('SARAH-CONV-2026-000002')
  const stale = await syncConversationBundle('SARAH-CONV-2026-000003')

  const old = Date.now() - 8 * 24 * 60 * 60 * 1000
  fs.utimesSync(stale, new Date(old), new Date(old))

  pruneConversationBundles()
  assert.equal(fs.existsSync(fresh), true, 'a fresh bundle was pruned')
  assert.equal(fs.existsSync(stale), false, 'a week-old bundle survived pruning')
})

test.after(() => fs.rmSync(HOME, { recursive: true, force: true }))
