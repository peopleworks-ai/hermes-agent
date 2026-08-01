'use strict'
/**
 * Sarä menubar/tray — a VIEW over sara-state, nothing more.
 *
 * It used to own the widget's state in a closure, which is how the menu ended up able to say
 * "LEARNING MODE: Off" while the screen was being captured (see sara-state.cjs). It now renders
 * `store.getState()` and forwards clicks to `store.setWorkspace/setLearning`. The transition rules,
 * the dialogs, the toasts and the Current Work poll all moved to the store, so the tray and the
 * widget window are two views of ONE truth instead of two copies of it.
 *
 *   const store = createSaraStore({ connector, chrome, dialogs, webAppUrl })
 *   store.hydrateFromConnector(); store.startCurrentWorkPoll()
 *   initSaraTray(app, { store, iconPath, onOpenWidget, onOpenWebApp })
 *
 * Cancel semantics are preserved exactly: a declined dialog produces no state change, and the store
 * still emits, so the radio Electron had already visually toggled snaps back.
 */
const { Tray, Menu, nativeImage } = require('electron')
const { WORKSPACE, LEARNING, watchLabel } = require('./sara-copy.cjs')

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

function initSaraTray(app, opts = {}) {
  const {
    store,
    iconPath,
    onOpenWidget = null,
    onOpenWebApp = null,
    onOpenSetup = null,
    onRepairEngine = null,
    onApplyUpdate = null,
  } = opts
  if (!store) throw new Error('initSaraTray: a sara-state store is required')

  const img = loadTrayIcon(iconPath)
  // macOS menubar wants a small template image; Windows/Linux use the icon as-is.
  const trayImg = process.platform === 'darwin' ? img.resize({ width: 18, height: 18 }) : img
  const tray = new Tray(trayImg)
  console.log('[sara] tray created ✓ — look in the system tray (Windows: click ^ to show hidden icons)')

  function radio(label, checked, click) {
    return { label, type: 'radio', checked, click }
  }

  function rebuild() {
    const s = store.getState()

    const cw = s.currentWork.length
      ? s.currentWork.map((w) => ({ label: `▸ ${w.label}`, enabled: false }))
      : [{ label: 'Nothing running', enabled: false }]

    // The watching line is driven by `recording` (connector truth), NOT by the radio. Armed but not
    // yet capturing is a real state (the async resume, or a failed one) and it must not show as a
    // live capture — nor may a live capture hide behind an "Off" radio.
    const watchLine = []
    if (s.recording) {
      watchLine.push({ label: `   👁️ Watching: ${watchLabel(s.watch)}`, enabled: false })
    } else if (s.learning === 'watch') {
      watchLine.push({ label: '   ⏳ Watch armed — not recording', enabled: false })
    }

    const template = []
    if (onOpenWidget) {
      template.push({ label: 'Open Sarä Widget', click: () => onOpenWidget() })
      template.push({ type: 'separator' })
    }
    // Identity + token truth. "Connected as" says WHOSE account work and recordings land in
    // (load-bearing on shared computers); the expired line is clickable and opens the setup page,
    // because a silently-401ing app otherwise looks identical to a healthy one.
    const identityLine = []
    if (s.authBad) {
      identityLine.push({ label: '⚠ Connection expired — Re-connect', click: () => onOpenSetup && onOpenSetup() })
    } else if (s.account) {
      identityLine.push({ label: `   Connected as ${s.account}`, enabled: false })
    }
    // Engine truth, same contract as the expired line: a machine where every task
    // would fail must not look identical to a healthy idle one.
    if (s.repairing) {
      identityLine.push({ label: '⏳ Memasang enjin Sarä…', enabled: false })
    } else if (s.engineBroken) {
      identityLine.push({ label: '⚠ Baiki enjin Sarä', click: () => onRepairEngine && onRepairEngine() })
    }
    // Same honesty contract again: an app with a pending update must not look identical to a
    // current one. The line appears only when main.cjs's periodic checkUpdates() says we're
    // behind the release branch; clicking hands off to the EXISTING applyUpdates flow.
    if (s.updateBehind > 0 && onApplyUpdate) {
      identityLine.push({ label: '⬆ Update tersedia — klik untuk pasang', click: () => onApplyUpdate() })
    }

    template.push(
      { label: '● Sarä', enabled: false },
      ...identityLine,
      { type: 'separator' },
      { label: 'SARA WORKSPACE', enabled: false },
      radio(WORKSPACE.pause, s.workspace === 'pause', () => store.setWorkspace('pause')),
      radio(WORKSPACE.chrome + '  ⟵ default', s.workspace === 'chrome', () => store.setWorkspace('chrome')),
      radio(WORKSPACE.whole, s.workspace === 'whole', () => store.setWorkspace('whole')),
      { type: 'separator' },
      { label: 'LEARNING MODE', enabled: false },
      radio(LEARNING.off, s.learning === 'off', () => store.setLearning('off')),
      radio(LEARNING.ask, s.learning === 'ask', () => store.setLearning('ask')),
      radio(LEARNING.watch, s.learning === 'watch', () => store.setLearning('watch')),
      ...watchLine,
      { type: 'separator' },
      { label: 'CURRENT WORK', enabled: false },
      ...cw,
      { type: 'separator' },
      { label: 'Open Sara Web App', click: () => onOpenWebApp && onOpenWebApp() },
      { label: 'Quit Sarä', role: 'quit' }
    )

    tray.setContextMenu(Menu.buildFromTemplate(template))
    // An honest tooltip: hovering the tray must tell you whether you are being recorded.
    tray.setToolTip(s.recording ? `Sarä — Watching (${watchLabel(s.watch)})` : 'Sarä')
  }

  rebuild()
  const unsubscribe = store.subscribe(rebuild)

  // Left-click opens the widget window (the Windows/Linux "Apploye feel"); right-click still gets
  // the menu. macOS swallows the left-click when a context menu is set, which is exactly why
  // "Open Sarä Widget" also exists as a menu item — a click handler alone would be a mac dead end.
  if (onOpenWidget) {
    tray.on('click', () => onOpenWidget())
    tray.on('double-click', () => onOpenWidget())
  }

  app.on('before-quit', () => {
    try {
      unsubscribe()
      tray.destroy()
    } catch {
      /* shutting down anyway */
    }
  })

  return { tray, rebuild, unsubscribe }
}

module.exports = { initSaraTray, loadTrayIcon }
