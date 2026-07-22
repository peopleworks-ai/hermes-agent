/**
 * Sarä widget — the state the tray and the widget window BOTH render.
 *
 * The main process (electron/sara-state.cjs) owns it; this is only the shape. Note what is not
 * here: any way for the renderer to set `recording`. It is mirrored from the connector, because a
 * UI that can assert "I am recording your screen" can also assert the opposite while it is.
 */

export type SaraWorkspace = 'pause' | 'chrome' | 'whole'
export type SaraLearning = 'off' | 'ask' | 'watch'

export interface SaraWidgetState {
  workspace: SaraWorkspace
  /** What the user ASKED for. Not proof that a capture is running — see `recording`. */
  learning: SaraLearning
  watch: { screen: boolean; voice: boolean }
  /** Connector truth: a capture is actually running right now. The badge renders THIS. */
  recording: boolean
  currentWork: { label: string }[]
  paired: boolean
  /** WHOSE account this app is paired to ("Connected as ..."); '' until known. */
  account: string
  /** Connector truth: the stored token exists but the server rejects it (401). */
  authBad: boolean
  /**
   * Is "Chrome restricts Sarä to her browser" a REAL boundary on this machine, or just a label?
   * True only when the boot probe confirmed the installed Hermes understands --toolsets. When
   * false, the Chrome-mode copy says so rather than pretending.
   */
  gated: boolean
}

/** Used until the first IPC round-trip lands — and when the surface is opened in a plain browser. */
export const SARA_DEFAULT_STATE: SaraWidgetState = {
  workspace: 'chrome',
  learning: 'off',
  watch: { screen: false, voice: false },
  recording: false,
  currentWork: [],
  paired: false,
  account: '',
  authBad: false,
  gated: false
}

// Mirrors electron/sara-copy.cjs. Kept short here — the long consent text lives in the dialogs the
// main process raises, so there is exactly one copy of the wording the user consents to.
export const SARA_WORKSPACE_LABEL: Record<SaraWorkspace, string> = {
  pause: 'Pause',
  chrome: "Sara's Google Chrome Browser",
  whole: 'Whole Computer'
}

export const SARA_WORKSPACE_HINT: Record<SaraWorkspace, string> = {
  pause: 'Sarä stops taking new work. Chrome closes.',
  chrome: 'Sarä works only inside her own browser. She cannot see anything outside it.',
  whole: 'Sarä can use all apps on this computer. Avoid personal use while this is on.'
}

export const SARA_LEARNING_LABEL: Record<SaraLearning, string> = {
  off: 'Off',
  ask: 'Ask Sarä to learn on her own',
  watch: 'Sarä learns by watching me'
}

export const SARA_LEARNING_HINT: Record<SaraLearning, string> = {
  off: 'Nothing is captured.',
  ask: 'She learns from what you give her in chat. Nothing is captured.',
  watch: 'Captures your screen and/or voice. Requires Whole Computer.'
}

export function watchLabel(watch: { screen: boolean; voice: boolean }): string {
  if (!watch.screen && !watch.voice) return ''

  return watch.screen && watch.voice ? 'Screen + Voice' : watch.voice ? 'Voice' : 'Screen'
}
