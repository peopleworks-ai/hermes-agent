'use strict'
/**
 * sara-state — the widget's single source of truth.
 *
 * These tests exist because the widget's UI used to LIE about whether it was recording the user's
 * screen. Two of them (marked BUG 1 / BUG 2) FAIL against the pre-refactor code. They are the point
 * of the whole exercise: a screen recorder whose indicator can be wrong is worse than no indicator.
 *
 * Everything here runs headlessly — sara-state.cjs imports no Electron, and every side effect is an
 * injected fake. That is deliberate: the GUI cannot be run on the Linux box this was written on, so
 * the privacy contract had to be provable without it.
 */
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  DEFAULT_STATE,
  WORKSPACES,
  LEARNINGS,
  reduceWorkspace,
  reduceLearning,
  hydrate,
  createSaraStore,
  recordingIsHonest,
} = require('./sara-state.cjs')

// ── fakes ───────────────────────────────────────────────────────────────────
function makeFakes({ config = {}, consent = { screen: true, voice: true }, confirmWhole = true } = {}) {
  const calls = { startWatch: [], stopWatch: 0, setPaused: [], chrome: [], toast: [], openExternal: 0, patch: [] }
  let store = { ...config }
  let watchListener = null
  const watchNow = { enabled: false, screen: false, voice: false, deviceId: null }

  const connector = {
    setPaused: (v) => calls.setPaused.push(v),
    startWatch: async (modes) => {
      calls.startWatch.push(modes)
      Object.assign(watchNow, { enabled: true, screen: !!modes.screen, voice: !!modes.voice, deviceId: 'dev1' })
      if (watchListener) watchListener({ ...watchNow })
    },
    stopWatch: async () => {
      calls.stopWatch += 1
      Object.assign(watchNow, { enabled: false })
      if (watchListener) watchListener({ ...watchNow })
    },
    getCurrentWork: async () => [],
    isPaired: () => true,
    readConfig: () => ({ ...store }),
    patchConfig: (patch) => {
      calls.patch.push(patch)
      store = { ...store, ...patch } // the real one MERGES — creds must survive
    },
    getWatch: () => ({ ...watchNow }),
    onWatchChange: (cb) => {
      watchListener = cb
      return () => {
        watchListener = null
      }
    },
    _watchNow: watchNow,
    _store: () => store,
  }
  const chrome = { launch: () => calls.chrome.push('launch'), quit: () => calls.chrome.push('quit') }
  const dialogs = {
    confirmWholeComputer: () => confirmWhole,
    chooseWatchModes: () => consent,
    toast: (m) => calls.toast.push(m),
    openExternal: () => (calls.openExternal += 1),
  }
  return { connector, chrome, dialogs, calls }
}

const types = (effects) => effects.map((e) => e.type)

// ── 1. defaults ─────────────────────────────────────────────────────────────
test('defaults: chrome workspace, learning off, not recording', () => {
  assert.equal(DEFAULT_STATE.workspace, 'chrome')
  assert.equal(DEFAULT_STATE.learning, 'off')
  assert.equal(DEFAULT_STATE.recording, false)
})

// ── 2. BUG 1 — the boot lie ─────────────────────────────────────────────────
test('BUG 1: hydrate with a persisted watch.enabled reports WATCHING, not Off', () => {
  // The connector's resumeWatchIfEnabled() acts on exactly this value at boot. The old tray
  // hardcoded learning:'off', so the menu said "Off" while the screen was being captured.
  const s = hydrate(DEFAULT_STATE, {
    config: { api_key: 'k', watch: { enabled: true, screen: true, voice: false } },
    watchNow: { enabled: false }, // async resume hasn't landed yet
    paired: true,
  })
  assert.equal(s.learning, 'watch', 'must not claim Off while a capture is being resumed')
  assert.deepEqual(s.watch, { screen: true, voice: false })
  assert.equal(s.workspace, 'whole', 'watching implies Whole Computer')
  assert.equal(s.recording, false, 'armed, but the capture has not actually started yet')
})

test('BUG 1b: once the connector reports the capture is live, recording flips true', () => {
  const s = hydrate(DEFAULT_STATE, {
    config: { watch: { enabled: true, screen: true, voice: true } },
    watchNow: { enabled: true, screen: true, voice: true },
    paired: true,
  })
  assert.equal(s.learning, 'watch')
  assert.equal(s.recording, true)
})

// ── 3. the UI cannot invent a recording state ───────────────────────────────
test('a persisted UI preference can NEVER assert watching on its own', () => {
  // sara.learning is only a preference. If the connector has no watch to resume, we are Off.
  const s = hydrate(DEFAULT_STATE, {
    config: { sara: { workspace: 'whole', learning: 'watch' }, watch: { enabled: false } },
    watchNow: { enabled: false },
    paired: true,
  })
  assert.notEqual(s.learning, 'watch', 'a preference must not be able to claim a recording state')
  assert.equal(s.recording, false)
})

test('fail-closed: no watch key at all ⇒ Off', () => {
  const s = hydrate(DEFAULT_STATE, { config: { api_key: 'k' }, watchNow: null, paired: true })
  assert.equal(s.learning, 'off')
  assert.equal(s.recording, false)
})

// ── 4. BUG 2 — "Ask" left the recorder running ──────────────────────────────
test('BUG 2: watch → Ask STOPS the capture (it used to keep recording)', () => {
  const watching = { ...DEFAULT_STATE, workspace: 'whole', learning: 'watch', watch: { screen: true, voice: true } }
  const { next, effects } = reduceLearning(watching, 'ask')
  assert.equal(next.learning, 'ask')
  assert.ok(types(effects).includes('stopWatch'), 'Ask is not a capture mode — it must stop the recorder')
  assert.ok(types(effects).includes('openWebApp'))
  assert.deepEqual(next.watch, { screen: false, voice: false })
})

test('watch → Off stops the capture', () => {
  const watching = { ...DEFAULT_STATE, workspace: 'whole', learning: 'watch', watch: { screen: true, voice: false } }
  const { next, effects } = reduceLearning(watching, 'off')
  assert.equal(next.learning, 'off')
  assert.ok(types(effects).includes('stopWatch'))
})

// ── 5/6. consent gates the ONLY path that starts recording ──────────────────
test('Watch Me with consent starts the capture and forces Whole Computer', () => {
  const { next, effects } = reduceLearning(DEFAULT_STATE, 'watch', { consent: { screen: true, voice: false } })
  assert.equal(next.learning, 'watch')
  assert.equal(next.workspace, 'whole', 'the consent dialog promised this — honour it')
  const start = effects.find((e) => e.type === 'startWatch')
  assert.deepEqual(start.modes, { screen: true, voice: false })
})

test('Watch Me CANCELLED changes nothing and starts nothing', () => {
  const { next, effects } = reduceLearning(DEFAULT_STATE, 'watch', { consent: null })
  assert.equal(next, DEFAULT_STATE, 'no state change at all — the radio snaps back')
  assert.equal(effects.length, 0, 'nothing may start recording without consent')
})

test('Watch Me with an EMPTY consent (neither screen nor voice) starts nothing', () => {
  const { next, effects } = reduceLearning(DEFAULT_STATE, 'watch', { consent: { screen: false, voice: false } })
  assert.equal(next, DEFAULT_STATE)
  assert.equal(effects.length, 0)
})

// ── 7. Whole Computer confirm ───────────────────────────────────────────────
test('Whole Computer DECLINED changes nothing', () => {
  const { next, effects } = reduceWorkspace(DEFAULT_STATE, 'whole', { confirmed: false })
  assert.equal(next, DEFAULT_STATE)
  assert.equal(effects.length, 0)
})

test('Whole Computer confirmed switches and unpauses', () => {
  const { next, effects } = reduceWorkspace(DEFAULT_STATE, 'whole', { confirmed: true })
  assert.equal(next.workspace, 'whole')
  assert.deepEqual(
    effects.find((e) => e.type === 'setPaused'),
    { type: 'setPaused', value: false }
  )
})

// ── 8. leaving Whole Computer while watching ────────────────────────────────
test('chrome while watching ⇒ learning Off + stopWatch + toast', () => {
  const watching = { ...DEFAULT_STATE, workspace: 'whole', learning: 'watch', watch: { screen: true, voice: true } }
  const { next, effects } = reduceWorkspace(watching, 'chrome')
  assert.equal(next.learning, 'off', 'watching cannot survive outside Whole Computer')
  assert.ok(types(effects).includes('stopWatch'))
  assert.ok(types(effects).includes('toast'))
  assert.ok(types(effects).includes('chrome'))
})

test('pause while watching ⇒ also stops the capture', () => {
  const watching = { ...DEFAULT_STATE, workspace: 'whole', learning: 'watch', watch: { screen: true, voice: true } }
  const { next, effects } = reduceWorkspace(watching, 'pause')
  assert.equal(next.learning, 'off')
  assert.ok(types(effects).includes('stopWatch'))
})

// ── 9. pause ────────────────────────────────────────────────────────────────
test('pause pauses the task bridge and quits Chrome', () => {
  const { next, effects } = reduceWorkspace(DEFAULT_STATE, 'pause')
  assert.equal(next.workspace, 'pause')
  assert.deepEqual(
    effects.find((e) => e.type === 'setPaused'),
    { type: 'setPaused', value: true }
  )
  assert.deepEqual(
    effects.find((e) => e.type === 'chrome'),
    { type: 'chrome', action: 'quit' }
  )
})

// ── 10. THE INVARIANT, swept over every reachable transition ────────────────
// The reducer's guarantee is not "recording is false" — it doesn't own `recording`, the connector
// does, and a stop takes a tick to land. Its guarantee is the one that MATTERS: you can never leave
// the watching state without ORDERING the recorder to stop. Combined with syncRecording() being
// self-correcting, that is what makes "UI says Off while capturing" unrepresentable.
test('INVARIANT: every path out of watching orders a stopWatch', () => {
  const seeds = []
  for (const workspace of WORKSPACES) {
    for (const learning of LEARNINGS) {
      const on = learning === 'watch'
      seeds.push({
        ...DEFAULT_STATE,
        workspace,
        learning,
        recording: on,
        watch: on ? { screen: true, voice: true } : { screen: false, voice: false },
      })
    }
  }
  let leaves = 0
  for (const seed of seeds) {
    for (const mode of WORKSPACES) {
      const { next, effects } = reduceWorkspace(seed, mode, { confirmed: true })
      if (seed.learning === 'watch' && next.learning !== 'watch') {
        leaves += 1
        assert.ok(
          types(effects).includes('stopWatch'),
          `left watch via setWorkspace(${mode}) from ${seed.workspace} without stopping the recorder`
        )
      }
    }
    for (const mode of LEARNINGS) {
      const { next, effects } = reduceLearning(seed, mode, { consent: { screen: true, voice: true } })
      if (seed.learning === 'watch' && next.learning !== 'watch') {
        leaves += 1
        assert.ok(
          types(effects).includes('stopWatch'),
          `left watch via setLearning(${mode}) from ${seed.workspace} without stopping the recorder`
        )
      }
    }
  }
  assert.ok(leaves > 0, 'the sweep must actually exercise leaving the watching state')
})

test('syncRecording is SELF-CORRECTING: a live capture drags the indicator to Watching', async () => {
  // The runtime backstop. If a capture is running for ANY reason — a resumed one landing after boot,
  // a path we never wrote — the UI is not allowed to keep saying Off.
  const { connector, chrome, dialogs } = makeFakes({ config: {} })
  const store = createSaraStore({ connector, chrome, dialogs })
  store.hydrateFromConnector()
  assert.equal(store.getState().learning, 'off')

  await connector.startWatch({ screen: true, voice: false }) // nothing in the UI asked for this
  const s = store.getState()
  assert.equal(s.recording, true)
  assert.equal(s.learning, 'watch', 'the recorder wins — the indicator must follow it')
  assert.equal(s.workspace, 'whole')
  assert.ok(recordingIsHonest(s))
})

// ── toolset gating: the workspace must reach the connector, or Chrome is a label ─────
test('changing workspace emits a toolset effect carrying the new mode', () => {
  const a = reduceWorkspace(DEFAULT_STATE, 'whole', { confirmed: true })
  assert.deepEqual(
    a.effects.find(e => e.type === 'toolset'),
    { type: 'toolset', mode: 'whole' }
  )
  const b = reduceWorkspace({ ...DEFAULT_STATE, workspace: 'whole' }, 'chrome')
  assert.deepEqual(
    b.effects.find(e => e.type === 'toolset'),
    { type: 'toolset', mode: 'chrome' }
  )
})

test('the store pushes the workspace to the connector on change AND on hydrate', async () => {
  const { connector, chrome, dialogs } = makeFakes({ config: { sara: { workspace: 'whole' } } })
  const pushed = []
  connector.setToolsetMode = m => pushed.push(m)
  connector.isToolsetGatingAvailable = () => true

  const store = createSaraStore({ connector, chrome, dialogs })
  store.hydrateFromConnector()
  assert.equal(pushed.at(-1), 'whole', 'hydrate must push the restored mode so the first task is gated right')
  assert.equal(store.getState().gated, true, 'gated is read live from the connector probe')

  await store.setWorkspace('pause')
  assert.equal(pushed.at(-1), 'pause')
})

// ── 11. persistence must MERGE, never clobber the creds ─────────────────────
test('the store persists only {sara:{…}} and never drops the pairing creds', async () => {
  const { connector, chrome, dialogs, calls } = makeFakes({
    config: { api_key: 'KEY', api_secret: 'SEC', watch: { enabled: false } },
  })
  const store = createSaraStore({ connector, chrome, dialogs, webAppUrl: 'https://x' })
  store.hydrateFromConnector()
  await store.setWorkspace('pause')

  assert.deepEqual(Object.keys(calls.patch[0]), ['sara'], 'the store must only ever write its own block')
  const after = connector._store()
  assert.equal(after.api_key, 'KEY', 'the merging write must not drop the creds')
  assert.equal(after.api_secret, 'SEC')
  assert.equal(after.sara.workspace, 'pause')
})

// ── 12. the resume-failed path is reported honestly ─────────────────────────
test('a connector watch=false while armed ⇒ recording false, and it emits', async () => {
  const { connector, chrome, dialogs } = makeFakes({
    config: { api_key: 'k', watch: { enabled: true, screen: true, voice: false } },
  })
  const store = createSaraStore({ connector, chrome, dialogs })
  store.hydrateFromConnector()
  let seen = null
  store.subscribe((s) => (seen = s))

  assert.equal(store.getState().learning, 'watch', 'armed from the persisted config')
  assert.equal(store.getState().recording, false, 'but the capture has not started')

  // the connector's async resume succeeds
  await connector.startWatch({ screen: true, voice: false })
  assert.equal(store.getState().recording, true)
  assert.equal(seen.recording, true, 'subscribers were told')

  // …and now it dies / is stopped
  await connector.stopWatch()
  assert.equal(store.getState().recording, false)
  assert.equal(seen.recording, false)
})

// ── the store end-to-end: cancel really does nothing ────────────────────────
test('store: a declined Whole-Computer dialog runs no effects and still notifies (so the radio snaps back)', async () => {
  const { connector, chrome, dialogs, calls } = makeFakes({ confirmWhole: false })
  const store = createSaraStore({ connector, chrome, dialogs })
  store.hydrateFromConnector()
  let notified = 0
  store.subscribe(() => (notified += 1))

  const after = await store.setWorkspace('whole')
  assert.equal(after.workspace, 'chrome', 'declining must leave the state exactly where it was')
  assert.equal(calls.setPaused.length, 0, 'no effects ran')
  assert.equal(notified, 1, 'but the views were still told, so an optimistic radio snaps back')
})

test('store: Ask while watching actually stops the recorder (end-to-end)', async () => {
  const { connector, chrome, dialogs, calls } = makeFakes({ consent: { screen: true, voice: true } })
  const store = createSaraStore({ connector, chrome, dialogs })
  store.hydrateFromConnector()

  await store.setLearning('watch')
  assert.equal(store.getState().recording, true, 'the fake connector started capturing')

  await store.setLearning('ask')
  assert.equal(calls.stopWatch, 1, 'Ask must stop the recorder')
  assert.equal(store.getState().recording, false, 'and the UI must say so')
  assert.equal(store.getState().learning, 'ask')
})

// ── identity: "Connected as …" + the expired-token truth ────────────────────
test('hydrate adopts the persisted pairing identity (config.user) as account', () => {
  const s = hydrate(DEFAULT_STATE, { config: { user: 'a@b.com' }, paired: true })
  assert.equal(s.account, 'a@b.com')
  assert.equal(s.authBad, false, 'authBad is live connector truth — never restored from disk')
})

test('store: setIdentity mirrors the connector and notifies views; no-op when unchanged', () => {
  const { connector, chrome, dialogs } = makeFakes({})
  const store = createSaraStore({ connector, chrome, dialogs })
  let notified = 0
  store.subscribe(() => (notified += 1))

  store.setIdentity({ user: 'a@b.com', authBad: false })
  assert.equal(store.getState().account, 'a@b.com')
  assert.equal(notified, 1)

  store.setIdentity({ user: 'a@b.com', authBad: false })
  assert.equal(notified, 1, 'identical identity must not re-emit')

  store.setIdentity({ user: 'a@b.com', authBad: true })
  assert.equal(store.getState().authBad, true, 'a 401 must surface, not hide behind "Connected"')
  assert.equal(notified, 2)
})
