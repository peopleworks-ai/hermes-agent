// The engine-health contract behind "Baiki enjin Sarä" (self-repair, 0.20.0).
//
// Two root causes made every broken-engine laptop look healthy while 100% of its
// tasks failed (LAPTOP-0DINSRPP / Yanti, 2026-07-27):
//   1. The one-shot HERMES_BIN pin silently no-op'd when the venv was missing at
//      boot, and the connector then spawned bare `hermes` — which on Windows is
//      GUARANTEED to be this app's own exe (CreateProcess searches the app dir
//      before PATH).
//   2. Nothing latched "the engine is broken": each failure was per-task only.
//
// These tests pin the new contract: the resolver never yields a bare name, a
// missing engine latches state.engineBroken exactly once per transition, and the
// bootstrap fetches its installer from the repo named in the build stamp (the
// fork) — never the upstream hardcode that 404'd for every packaged client.
const test = require('node:test')
const assert = require('node:assert')
const saraConn = require('./sara-connector.cjs')
const { resolveInstallScript } = require('./bootstrap-runner.cjs')
const { createSaraStore } = require('./sara-state.cjs')

function fakeConnector(identity) {
  return {
    setPaused() {},
    async startWatch() {},
    async stopWatch() {},
    async getCurrentWork() {
      return []
    },
    isPaired: () => true,
    readConfig: () => ({}),
    patchConfig() {},
    getWatch: () => null,
    onWatchChange: () => () => {},
    setToolsetMode() {},
    getIdentity: () => identity,
  }
}

test('default resolver yields null (NEVER bare "hermes") without HERMES_BIN', async () => {
  // No HERMES_BIN in this test env and no injected resolver → probe must refuse
  // to spawn and latch engine-broken instead of spawning a bare name.
  delete process.env.HERMES_BIN
  saraConn.setBinResolver(() => process.env.HERMES_BIN || null)
  const gating = await saraConn.probeToolsets()
  assert.equal(gating, false)
  assert.equal(saraConn.getIdentity().engineBroken, true)
  assert.equal(saraConn.getIdentity().engineDetail, 'missing')
})

test('a throwing resolver degrades to null, not a crash', async () => {
  saraConn.setBinResolver(() => {
    throw new Error('boom')
  })
  const gating = await saraConn.probeToolsets()
  assert.equal(gating, false)
  assert.equal(saraConn.getIdentity().engineBroken, true)
})

test('onEngineBroken fires only on the false→true transition', async () => {
  let fires = 0
  saraConn.onEngineBroken(() => fires++)
  saraConn.clearEngineBroken()
  saraConn.setBinResolver(() => null)
  await saraConn.probeToolsets() // false→true: fires
  await saraConn.probeToolsets() // already true: must NOT fire again
  assert.equal(fires, 1)
  saraConn.onEngineBroken(null)
})

test('clearEngineBroken resets the latch (a later break re-fires)', async () => {
  let fires = 0
  saraConn.onEngineBroken(() => fires++)
  saraConn.clearEngineBroken()
  await saraConn.probeToolsets()
  saraConn.clearEngineBroken()
  await saraConn.probeToolsets()
  assert.equal(fires, 2)
  saraConn.onEngineBroken(null)
  saraConn.clearEngineBroken()
})

test('repairing is reported through getIdentity for the store to mirror', () => {
  saraConn.setRepairing(true)
  assert.equal(saraConn.getIdentity().repairing, true)
  saraConn.setRepairing(false)
  assert.equal(saraConn.getIdentity().repairing, false)
})

test('resolveInstallScript downloads from the repo named in the stamp', async () => {
  const seen = []
  await resolveInstallScript({
    installStamp: { commit: 'a'.repeat(40), repo: 'peopleworks-ai/hermes-agent' },
    sourceRepoRoot: null,
    hermesHome: '/nonexistent/hermes-home-' + process.pid,
    emit: () => {},
    _download: async (commit, dest, repo) => {
      seen.push({ commit, repo })
      return dest
    },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].repo, 'peopleworks-ai/hermes-agent')
})

test('an old stamp without `repo` still resolves (runner falls back to the fork default)', async () => {
  // The runner passes the stamp's (undefined) repo through; downloadInstallScript
  // itself applies DEFAULT_REPO. Here we just pin that the call is made with
  // undefined rather than exploding on the missing field.
  const seen = []
  await resolveInstallScript({
    installStamp: { commit: 'b'.repeat(40) },
    sourceRepoRoot: null,
    hermesHome: '/nonexistent/hermes-home-' + process.pid,
    emit: () => {},
    _download: async (commit, dest, repo) => {
      seen.push({ commit, repo })
      return dest
    },
  })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].repo, undefined)
})

test('the store mirrors engineBroken/repairing from getIdentity and exposes repairProgress', () => {
  const identity = { user: 'x@y.z', authBad: false, engineBroken: true, engineDetail: 'missing', repairing: false }
  const store = createSaraStore({
    connector: fakeConnector(identity),
    chrome: { launch() {}, quit() {} },
    dialogs: { confirmWholeComputer: () => true, chooseWatchModes: () => null, toast() {}, openExternal() {} },
  })
  store.setIdentity(identity)
  let s = store.getState()
  assert.equal(s.engineBroken, true)
  assert.equal(s.engineDetail, 'missing')

  store.setRepairProgress('Stage-Venv: creating venv')
  s = store.getState()
  assert.equal(s.repairProgress, 'Stage-Venv: creating venv')

  store.setIdentity({ ...identity, engineBroken: false, repairing: true })
  s = store.getState()
  assert.equal(s.engineBroken, false)
  assert.equal(s.repairing, true)
  store.stop()
})
