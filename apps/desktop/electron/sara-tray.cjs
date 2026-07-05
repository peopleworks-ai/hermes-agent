'use strict'
/**
 * Sarä menubar/tray — the widget UI from the brief (§5).
 *
 * Self-contained ADD module (part of the "subtraction on Hermes Desktop" fork).
 * Standard Electron Tray + Menu; wire it from main.cjs on app.whenReady():
 *
 *   const { initSaraTray } = require('./sara-tray.cjs')
 *   initSaraTray(app, {
 *     iconPath: path.join(__dirname, '..', 'assets', 'icon.png'),
 *     webAppUrl: 'https://hcos.peopleworks.ai/people/sarah',
 *     getCurrentWork: async () => [{ label: 'Posting job ad on JobStreet' }, ...],
 *     onWorkspaceChange: (mode) => {},  // mode: 'pause' | 'chrome' | 'whole'
 *     onLearningChange:  (mode) => {},  // mode: 'off' | 'ask' | 'watch'
 *     onOpenWebApp: () => {},           // open the web app window/browser
 *   })
 *
 * The callbacks are where the fork hooks Sarä's real behaviour (Chrome Sara
 * lifecycle, Omi capture, the connector's task bridge + no-key sidecar). This
 * module only owns the menu, the mode state, and the popup rules from §5.
 */
const { Tray, Menu, nativeImage, dialog, Notification, shell } = require('electron')

// Always return a VISIBLE tray image. If the icon file is missing/empty (a common
// cause of an invisible tray on Windows), fall back to a solid indigo square so
// the user can always find + click the menu.
function loadTrayIcon(iconPath) {
  let img = null
  try {
    if (iconPath) img = nativeImage.createFromPath(iconPath)
  } catch {
    img = null
  }
  const empty = !img || img.isEmpty()
  if (empty) {
    const size = 16
    const bmp = Buffer.alloc(size * size * 4)
    for (let i = 0; i < bmp.length; i += 4) {
      bmp[i] = 229 // B
      bmp[i + 1] = 70 // G
      bmp[i + 2] = 79 // R  (≈ indigo #4F46E5)
      bmp[i + 3] = 255 // A
    }
    img = nativeImage.createFromBitmap(bmp, { width: size, height: size })
  }
  console.log('[sara] tray icon: path=' + (iconPath || 'none') + ' loaded=' + !empty)
  return img
}

// Menu copy — exactly the brief's §5 labels.
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

function initSaraTray(app, opts = {}) {
  const {
    iconPath,
    webAppUrl = 'https://hcos.peopleworks.ai/people/sarah',
    getCurrentWork = async () => [],
    onWorkspaceChange = () => {},
    onLearningChange = () => {},
    onOpenWebApp = null,
    currentWorkIntervalMs = 8000,
  } = opts

  const state = {
    workspace: 'chrome', // default on startup (§5)
    learning: 'off',
    currentWork: [],
  }

  const img = loadTrayIcon(iconPath)
  // macOS menubar wants a small template image; Windows/Linux use the icon as-is.
  const trayImg = process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img
  const tray = new Tray(trayImg)
  tray.setToolTip('Sarä')
  console.log('[sara] tray created ✓ — look in the system tray (Windows: click ^ to show hidden icons)')

  function toast(body) {
    try {
      if (Notification.isSupported()) new Notification({ title: 'Sarä', body }).show()
    } catch {
      /* non-fatal */
    }
  }

  function confirmWholeComputer() {
    const res = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Turn on Whole Computer', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'Sarä — Whole Computer',
      message: WORKSPACE.whole,
      detail: POPUP.whole,
    })
    return res === 0
  }

  // ── Workspace transitions (with §5 rules) ──────────────────────────────
  function setWorkspace(mode) {
    if (mode === state.workspace) return rebuild()
    if (mode === 'whole') {
      if (!confirmWholeComputer()) return rebuild() // reverts the radio
      state.workspace = 'whole'
    } else if (mode === 'chrome') {
      // Leaving Whole Computer while Watching is on → Watching can't continue.
      if (state.learning === 'watch') {
        state.learning = 'off'
        toast('Watching paused — needs Whole Computer')
        onLearningChange('off')
      }
      state.workspace = 'chrome'
      toast(POPUP.chrome)
    } else if (mode === 'pause') {
      state.workspace = 'pause'
    }
    onWorkspaceChange(state.workspace)
    rebuild()
  }

  // ── Learning transitions (with §5 rules) ───────────────────────────────
  function setLearning(mode) {
    if (mode === state.learning) return rebuild()
    if (mode === 'ask') {
      state.learning = 'ask'
      onLearningChange('ask')
      openWebApp() // §5: opens the AI Personal Assistant chat
    } else if (mode === 'watch') {
      // Watch Me requires Whole Computer — auto-switch on confirm (§5).
      state.learning = 'watch'
      if (state.workspace !== 'whole') {
        state.workspace = 'whole'
        onWorkspaceChange('whole')
      }
      toast(POPUP.watch)
      onLearningChange('watch') // callback starts Omi capture
    } else {
      state.learning = 'off'
      onLearningChange('off')
    }
    rebuild()
  }

  function openWebApp() {
    if (onOpenWebApp) return onOpenWebApp()
    shell.openExternal(webAppUrl)
  }

  function radio(label, checked, click) {
    return { label, type: 'radio', checked, click }
  }

  function rebuild() {
    const cw = state.currentWork.length
      ? state.currentWork.map((w) => ({ label: `▸ ${w.label}`, enabled: false }))
      : [{ label: 'Nothing running', enabled: false }]

    const menu = Menu.buildFromTemplate([
      { label: '● Sarä', enabled: false },
      { type: 'separator' },
      { label: 'SARA WORKSPACE', enabled: false },
      radio(WORKSPACE.pause, state.workspace === 'pause', () => setWorkspace('pause')),
      radio(WORKSPACE.chrome + '  ⟵ default', state.workspace === 'chrome', () => setWorkspace('chrome')),
      radio(WORKSPACE.whole, state.workspace === 'whole', () => setWorkspace('whole')),
      { type: 'separator' },
      { label: 'LEARNING MODE', enabled: false },
      radio(LEARNING.off, state.learning === 'off', () => setLearning('off')),
      radio(LEARNING.ask, state.learning === 'ask', () => setLearning('ask')),
      radio(LEARNING.watch, state.learning === 'watch', () => setLearning('watch')),
      { type: 'separator' },
      { label: 'CURRENT WORK', enabled: false },
      ...cw,
      { type: 'separator' },
      { label: 'Open Sara Web App', click: openWebApp },
      { label: 'Quit Sarä', role: 'quit' },
    ])
    tray.setContextMenu(menu)
  }

  // Live Current Work feed (dummy-feed OK per §5 exit gate).
  async function refreshCurrentWork() {
    try {
      const items = await getCurrentWork()
      if (Array.isArray(items)) {
        state.currentWork = items
        rebuild()
      }
    } catch {
      /* keep last */
    }
  }

  rebuild()
  refreshCurrentWork()
  const timer = setInterval(refreshCurrentWork, currentWorkIntervalMs)
  app.on('before-quit', () => clearInterval(timer))

  return {
    tray,
    getState: () => ({ ...state }),
    setCurrentWork: (items) => {
      state.currentWork = items || []
      rebuild()
    },
  }
}

module.exports = { initSaraTray }
