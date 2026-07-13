'use strict'
/**
 * Sarä widget state — the ONE owner of {workspace, learning, watch, recording, currentWork, paired}.
 *
 * WHY THIS EXISTS
 * ---------------
 * This state used to live in a closure inside `initSaraTray` (sara-tray.cjs): unpersisted,
 * unreachable, and duplicated nowhere else because nothing else could reach it. That was fine while
 * the tray was the only surface. It stopped being fine the moment the state started LYING:
 *
 *   • `sara-connector.resumeWatchIfEnabled()` restarts screen+voice capture at boot from the
 *     persisted `watch.enabled` — but the tray hardcoded `learning: 'off'`. The menu said
 *     "LEARNING MODE: Off" while the screen was being captured and uploaded.
 *   • Picking "Ask" while watching only console.logged. Capture kept running behind an inert radio.
 *
 * A second surface (the widget window) rendering that same state would just have told the lie more
 * convincingly. So: one owner, and the lies are made UNREPRESENTABLE rather than merely fixed —
 * see `hydrate()` and `reduceLearning()` below.
 *
 * SHAPE
 * -----
 * Two layers, deliberately:
 *   • PURE REDUCERS — `(state, input) => { next, effects }`. Effects are DATA (`{type:'stopWatch'}`),
 *     never side effects. No Electron, no fs, no network. That is what lets the whole privacy
 *     contract be proven by `node --test` on a headless Linux box, where the GUI cannot run at all.
 *   • THE STORE — holds state, runs effects through INJECTED adapters (connector/chrome/dialogs),
 *     emits change. main.cjs injects the real modules; the tests inject fakes.
 *
 * `recording` is mirrored from the connector's `watch` and is NEVER set by a UI action. The tray and
 * the window both render it; neither may assert it.
 */
const { POPUP, WATCH_PAUSED_TOAST } = require('./sara-copy.cjs')

const WORKSPACES = ['pause', 'chrome', 'whole']
const LEARNINGS = ['off', 'ask', 'watch']

const DEFAULT_STATE = Object.freeze({
  workspace: 'chrome', // §5 default
  learning: 'off',
  watch: { screen: false, voice: false }, // meaningful only while learning === 'watch'
  recording: false, // connector truth — the UI mirrors it, never sets it
  currentWork: [],
  paired: false,
})

const NO_WATCH = { screen: false, voice: false }

/**
 * The safety property, stated precisely: **the UI may never claim not-recording while the recorder
 * is running.** It is enforced in `syncRecording()` below, which is SELF-CORRECTING — if the
 * connector says a capture is live, the indicator moves to match it, not the other way round.
 *
 * Note what is deliberately NOT an invariant:
 *   • "watch ⇒ recording" is false, and should be. Arming happens instantly; the capture starts
 *     asynchronously and can fail. Claiming a red dot for a capture that never started is its own
 *     lie. That state renders as "Watch armed — not recording".
 *   • "learning='off' ⇒ !recording" is momentarily false while a stop is in flight. That is not a
 *     lie either — the badge is driven by `recording`, so it correctly still shows red until the
 *     recorder has actually stopped.
 * A hard `throw` here would only have crashed the tray over a transient. The guarantee lives in
 * `syncRecording`; the reducers just have to always ORDER the stop, which the test sweep proves.
 */
function recordingIsHonest(state) {
  return !state.recording || state.learning === 'watch'
}

// ── pure reducers ───────────────────────────────────────────────────────────

/**
 * @param {object} state
 * @param {'pause'|'chrome'|'whole'} mode
 * @param {{confirmed?: boolean, gated?: boolean}} ctx  confirmed = the Whole-Computer dialog said yes.
 */
function reduceWorkspace(state, mode, ctx = {}) {
  const effects = []
  if (!WORKSPACES.includes(mode) || mode === state.workspace) return { next: state, effects }
  // Cancelled the warning ⇒ nothing happens at all. The radio/segment snaps back because the state
  // never moved — no optimistic UI to unwind.
  if (mode === 'whole' && !ctx.confirmed) return { next: state, effects }

  let next = { ...state, workspace: mode }

  // Watching REQUIRES Whole Computer, so leaving it must stop the capture — not just relabel it.
  if (state.learning === 'watch' && mode !== 'whole') {
    next = { ...next, learning: 'off', watch: { ...NO_WATCH } }
    effects.push({ type: 'stopWatch' })
    effects.push({ type: 'toast', message: WATCH_PAUSED_TOAST })
  }

  if (mode === 'pause') {
    effects.push({ type: 'setPaused', value: true })
    effects.push({ type: 'chrome', action: 'quit' })
  } else {
    effects.push({ type: 'setPaused', value: false })
    if (mode === 'chrome') {
      effects.push({ type: 'chrome', action: 'launch' })
      effects.push({ type: 'toast', message: ctx.gated === false ? POPUP.chrome : POPUP.chrome })
    }
  }
  effects.push({ type: 'persist', patch: { workspace: next.workspace, learning: next.learning } })
  return { next, effects }
}

/**
 * @param {object} state
 * @param {'off'|'ask'|'watch'} mode
 * @param {{consent?: {screen:boolean,voice:boolean}|null}} ctx  consent = what the user allowed.
 */
function reduceLearning(state, mode, ctx = {}) {
  const effects = []
  if (!LEARNINGS.includes(mode) || mode === state.learning) return { next: state, effects }

  if (mode === 'watch') {
    // No consent (cancelled) ⇒ NOTHING starts. Not the state, not the capture, not the device
    // registration. This is the only path that may ever begin recording.
    if (!ctx.consent || (!ctx.consent.screen && !ctx.consent.voice)) return { next: state, effects }
    const watch = { screen: !!ctx.consent.screen, voice: !!ctx.consent.voice }
    let next = { ...state, learning: 'watch', watch }
    if (next.workspace !== 'whole') {
      // The consent dialog already told them this ("This requires Whole Computer access — turning
      // it on now"), so honour it rather than silently watching from a mode that forbids it.
      next = { ...next, workspace: 'whole' }
      effects.push({ type: 'setPaused', value: false })
    }
    effects.push({ type: 'startWatch', modes: watch })
    effects.push({ type: 'persist', patch: { workspace: next.workspace, learning: next.learning } })
    return { next, effects }
  }

  // 'off' AND 'ask' are both NOT-RECORDING states. "Ask Sarä to learn on her own" is a chat
  // behaviour, not a capture mode — the old code only stopped on 'off', so choosing Ask while
  // watching left the screen recorder running behind a radio that said otherwise. Emitting
  // stopWatch unconditionally here is what makes `recording ⇒ learning==='watch'` hold by
  // construction rather than by remembering to.
  const next = { ...state, learning: mode, watch: { ...NO_WATCH } }
  effects.push({ type: 'stopWatch' })
  if (mode === 'ask') effects.push({ type: 'openWebApp' }) // §5: opens the AI Personal Assistant chat
  effects.push({ type: 'persist', patch: { workspace: next.workspace, learning: next.learning } })
  return { next, effects }
}

/**
 * Boot state. `config` is the connector's persisted sara-config.json; `watchNow` is the connector's
 * LIVE watch (getWatch()).
 *
 * The load-bearing line is the `persistedWatch.enabled` branch: `learning` is derived from the very
 * value `resumeWatchIfEnabled()` acts on, so the UI is structurally incapable of saying "Off" while
 * a resumed capture is running — and equally incapable of claiming "Watching" when the connector has
 * no watch to resume. We deliberately DON'T trust our own persisted `sara.learning` for this: it is
 * a UI preference, and a UI preference must never be able to assert a recording state.
 *
 * Note the fail-closed consequence: if `startWatch` failed last session (offline), `watch.enabled`
 * was never written, so we come back as Off. For a screen recorder, forgetting is the safe default.
 */
function hydrate(state, { config = {}, watchNow = null, paired = false } = {}) {
  const persistedWatch = config.watch || null
  const saved = config.sara || {}

  let workspace = WORKSPACES.includes(saved.workspace) ? saved.workspace : DEFAULT_STATE.workspace
  let learning = 'off'
  let watch = { ...NO_WATCH }

  if (persistedWatch && persistedWatch.enabled) {
    learning = 'watch'
    watch = { screen: !!persistedWatch.screen, voice: !!persistedWatch.voice }
    workspace = 'whole' // watching implies Whole Computer
  } else if (saved.learning === 'ask') {
    learning = 'ask' // 'ask' records nothing, so it is safe to restore from a preference
  }

  // Not `saved.recording` — there is no such thing. Recording is whatever the connector is ACTUALLY
  // doing right now, which at boot is "nothing yet" (the resume is async and may still fail).
  const recording = !!(watchNow && watchNow.enabled)

  return { ...state, workspace, learning, watch, recording, paired: !!paired }
}

// ── the store ───────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {object} deps.connector  sara-connector.cjs (or a fake): setPaused, startWatch, stopWatch,
 *                                 getCurrentWork, isPaired, readConfig, patchConfig, getWatch, onWatchChange
 * @param {object} deps.chrome     sara-chrome.cjs (or a fake): launch, quit
 * @param {object} deps.dialogs    sara-dialogs.cjs (or a fake): confirmWholeComputer, chooseWatchModes,
 *                                 toast, openExternal
 * @param {string} deps.webAppUrl
 */
function createSaraStore({ connector, chrome, dialogs, webAppUrl = '' } = {}) {
  let state = { ...DEFAULT_STATE, watch: { ...NO_WATCH }, currentWork: [] }
  const listeners = []
  let pollTimer = null
  let unsubWatch = null

  const getState = () => ({ ...state, watch: { ...state.watch }, currentWork: state.currentWork.slice() })

  function emit() {
    const snap = getState()
    for (const cb of listeners.slice()) {
      try {
        cb(snap)
      } catch (e) {
        // A broken view must never take down the state that owns the recorder.
        console.error('[sara] state listener failed:', (e && e.message) || e)
      }
    }
  }

  function subscribe(cb) {
    if (typeof cb !== 'function') return () => {}
    listeners.push(cb)
    return () => {
      const i = listeners.indexOf(cb)
      if (i >= 0) listeners.splice(i, 1)
    }
  }

  async function runEffects(effects) {
    for (const e of effects) {
      try {
        if (e.type === 'setPaused') connector.setPaused(e.value)
        else if (e.type === 'chrome') e.action === 'launch' ? chrome.launch() : chrome.quit()
        else if (e.type === 'startWatch') await connector.startWatch(e.modes)
        else if (e.type === 'stopWatch') await connector.stopWatch()
        else if (e.type === 'openWebApp') dialogs.openExternal(webAppUrl)
        else if (e.type === 'toast') dialogs.toast(e.message)
        else if (e.type === 'persist') connector.patchConfig({ sara: e.patch })
      } catch (err) {
        // A failed startWatch leaves us ARMED but NOT RECORDING — which the connector reports over
        // onWatchChange, and which the UI shows honestly. Do not fake success by carrying on.
        console.error('[sara] effect failed:', e.type, (err && err.message) || err)
      }
    }
  }

  async function setWorkspace(mode, { parent } = {}) {
    const needsConfirm = mode === 'whole' && mode !== state.workspace
    const confirmed = needsConfirm ? dialogs.confirmWholeComputer(parent) : true
    const { next, effects } = reduceWorkspace(state, mode, { confirmed })
    state = next
    await runEffects(effects)
    emit() // ALWAYS — a cancelled dialog must still make the radio/segment snap back to the truth.
    return getState()
  }

  async function setLearning(mode, { parent } = {}) {
    const needsConsent = mode === 'watch' && mode !== state.learning
    const consent = needsConsent ? dialogs.chooseWatchModes(parent) : null
    const { next, effects } = reduceLearning(state, mode, { consent })
    state = next
    await runEffects(effects)
    emit()
    return getState()
  }

  /**
   * Connector truth about the recorder. The ONLY way `recording` ever changes — and the place the
   * safety property is actually enforced.
   *
   * SELF-CORRECTING: if the connector says a capture is live, the indicator moves to match it. The
   * recorder wins; the UI follows. That is what makes "the menu says Off while the screen is being
   * captured" unrepresentable at runtime, not merely fixed in the one code path we remembered — it
   * would take a resumed capture landing after boot, or capture starting by some route we didn't
   * write, and either way the badge goes red.
   *
   * Turning recording OFF does NOT touch `learning`: the user may still be armed (a failed resume →
   * "Watch armed — not recording"), or may have just asked us to stop. Both are honest.
   */
  function syncRecording(w) {
    const recording = !!(w && w.enabled)
    if (recording === state.recording) return
    let next = { ...state, recording }
    if (recording) {
      next.watch = { screen: !!w.screen, voice: !!w.voice }
      next.learning = 'watch'
      if (next.workspace !== 'whole') next.workspace = 'whole' // watching implies Whole Computer
    }
    state = next
    if (!recordingIsHonest(state)) {
      // Unreachable by construction (we just forced learning='watch' above). If it ever fires, the
      // indicator is wrong and that is a privacy incident, not a cosmetic bug — say so loudly.
      console.error('[sara] STATE INCONSISTENT: recording while learning=' + state.learning)
    }
    emit()
  }

  function setCurrentWork(items) {
    const next = Array.isArray(items) ? items : []
    const same =
      next.length === state.currentWork.length &&
      next.every((it, i) => it && state.currentWork[i] && it.label === state.currentWork[i].label)
    if (same) return
    state = { ...state, currentWork: next }
    emit()
  }

  function setPaired(p) {
    if (!!p === state.paired) return
    state = { ...state, paired: !!p }
    emit()
  }

  /** Read the connector's persisted config + live watch, and adopt them as the truth. */
  function hydrateFromConnector() {
    const config = typeof connector.readConfig === 'function' ? connector.readConfig() : {}
    const watchNow = typeof connector.getWatch === 'function' ? connector.getWatch() : null
    const paired = typeof connector.isPaired === 'function' ? connector.isPaired() : false
    state = hydrate(state, { config, watchNow, paired })
    if (typeof connector.onWatchChange === 'function') {
      unsubWatch = connector.onWatchChange(syncRecording)
    }
    emit()
    return getState()
  }

  /** One poll now feeds BOTH surfaces — the tray used to run its own. */
  function startCurrentWorkPoll(intervalMs = 8000) {
    stopCurrentWorkPoll()
    const tick = async () => {
      try {
        const items = await connector.getCurrentWork()
        setCurrentWork(items)
        setPaired(connector.isPaired())
      } catch {
        /* keep the last known list rather than blanking it on a transient error */
      }
    }
    tick()
    pollTimer = setInterval(tick, intervalMs)
    return pollTimer
  }

  function stopCurrentWorkPoll() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  function stop() {
    stopCurrentWorkPoll()
    if (unsubWatch) unsubWatch()
    unsubWatch = null
    listeners.length = 0
  }

  return {
    getState,
    subscribe,
    setWorkspace,
    setLearning,
    setCurrentWork,
    setPaired,
    syncRecording,
    hydrateFromConnector,
    startCurrentWorkPoll,
    stopCurrentWorkPoll,
    stop,
  }
}

module.exports = {
  DEFAULT_STATE,
  WORKSPACES,
  LEARNINGS,
  reduceWorkspace,
  reduceLearning,
  hydrate,
  recordingIsHonest,
  createSaraStore,
}
