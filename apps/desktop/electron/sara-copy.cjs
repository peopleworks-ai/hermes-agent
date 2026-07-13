'use strict'
/**
 * Sarä widget copy — the §5 labels and consent text, in ONE place.
 *
 * Pure: no Electron, no Node APIs. That matters three ways —
 *   1. `sara-state.cjs` can import it and still run under `node --test` on a headless box;
 *   2. `sara-dialogs.cjs` (Electron) shows exactly these strings, so the tray and the widget
 *      window can never drift into showing different consent wording for the same action;
 *   3. it ships to the renderer over IPC, so the window never re-types the privacy copy.
 *
 * Consent text is not decoration. If you change what a mode DOES, change these strings in the
 * same commit — the whole point of the state refactor was that the UI stopped telling the truth.
 */

const WORKSPACE = {
  pause: 'Pause',
  chrome: "Sara's Google Chrome Browser",
  whole: 'Whole Computer',
}

const LEARNING = {
  off: 'Off',
  ask: 'Ask Sara To Learn On Its Own or From References',
  watch: 'Sara Learn By Watching Me',
}

const POPUP = {
  chrome: 'Sara will work only inside her own browser. She cannot see or access anything outside it.',
  whole:
    'Sara can now use all apps on this computer, with security guardrails active. We advise avoiding personal usage while this mode is on.',
  watch:
    'Sara will watch how you work and build work memory from it. This requires Whole Computer access — turning it on now.',
}

// Shown when the toolset probe fails, i.e. we could NOT actually restrict Sarä to the browser.
// An unverifiable claim must degrade to honesty, never to a comfortable lie.
const POPUP_UNGATED = {
  chrome:
    "Sara will prefer her own browser. Note: tool restrictions could not be enforced on this machine, so treat this as a preference, not a boundary.",
}

const WATCH_PAUSED_TOAST = 'Watching paused — needs Whole Computer'

function watchLabel(m) {
  if (!m || (!m.screen && !m.voice)) return ''
  return m.screen && m.voice ? 'Screen + Voice' : m.voice ? 'Voice' : 'Screen'
}

module.exports = { WORKSPACE, LEARNING, POPUP, POPUP_UNGATED, WATCH_PAUSED_TOAST, watchLabel }
