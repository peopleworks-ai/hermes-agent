'use strict'
/**
 * Sarä dialogs + toasts — the Electron half of the widget's consent surface.
 *
 * Lifted VERBATIM out of the sara-tray.cjs closure so the tray and the widget window raise the
 * SAME dialog with the SAME words. They used to live inside `initSaraTray`, which meant a second
 * surface could only get them by copy-pasting the consent copy — and copy-pasted consent copy
 * drifts. Now there is one implementation and one place to change it.
 *
 * `parent` is the only addition: a dialog raised from the widget window is modal to that window
 * instead of appearing behind it. Omit it and you get the old app-modal behaviour.
 */
const { dialog, Notification, shell } = require('electron')
const { WORKSPACE, POPUP } = require('./sara-copy.cjs')

function toast(body) {
  try {
    if (Notification.isSupported()) new Notification({ title: 'Sarä', body }).show()
  } catch {
    /* non-fatal */
  }
}

/** Returns true when the user really chose Whole Computer. Cancel ⇒ false ⇒ NO state change. */
function confirmWholeComputer(parent) {
  const opts = {
    type: 'warning',
    buttons: ['Turn on Whole Computer', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Sarä — Whole Computer',
    message: WORKSPACE.whole,
    detail: POPUP.whole,
  }
  const res = parent ? dialog.showMessageBoxSync(parent, opts) : dialog.showMessageBoxSync(opts)
  return res === 0
}

/**
 * §5 Learn-by-Watching consent: the user chooses what Sarä may capture.
 * Returns { screen, voice } or null (cancelled → NO state change, nothing starts recording).
 */
function chooseWatchModes(parent) {
  const opts = {
    type: 'question',
    buttons: ['Screen + Voice', 'Voice only', 'Screen only', 'Cancel'],
    defaultId: 0,
    cancelId: 3,
    title: 'Sarä — Learn by Watching',
    message: 'Let Sarä learn how you work',
    detail:
      'Sarä will build private work memory + skills from what you allow below. ' +
      'It stays yours — you can stop anytime from this menu.\n\n' +
      '• Screen — periodic snapshots of your activity (active window + on-screen text)\n' +
      '• Voice — your meetings (microphone)\n\n' +
      'Your operating system may ask for Screen Recording / Microphone permission next.',
  }
  const res = parent ? dialog.showMessageBoxSync(parent, opts) : dialog.showMessageBoxSync(opts)
  if (res === 0) return { screen: true, voice: true }
  if (res === 1) return { screen: false, voice: true }
  if (res === 2) return { screen: true, voice: false }
  return null // Cancel
}

function openExternal(url) {
  try {
    shell.openExternal(url)
  } catch (e) {
    console.error('[sara] openExternal failed:', (e && e.message) || e)
  }
}

module.exports = { toast, confirmWholeComputer, chooseWatchModes, openExternal }
