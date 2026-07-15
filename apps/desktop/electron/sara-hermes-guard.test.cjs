// Regression: a task must NEVER be reported "done" from the app's own boot banner.
//
// Bug (device "Jojo", 2026-07-16): the connector spawned bare `hermes`, which a Windows PATH shim
// redirected to THIS Electron app. The 2nd instance hit the single-instance lock, printed its boot
// banner ("[hermes] install stamp… [sara] connector started… tray created"), and exited 0 — so the
// connector captured the banner as the task result and the server marked the step Done. No file was
// written. `looksLikeAppBanner` catches that output so runHermes fails loudly instead.
const test = require('node:test')
const assert = require('node:assert')
const { looksLikeAppBanner } = require('./sara-connector.cjs')

test('the real Jojo boot banner is detected', () => {
  const banner =
    '[hermes] install stamp: 3ada4ac5cba6 (feature/sara-widget) from ci\n' +
    '[sara] connector started (paired=true, device=Jojo)\n' +
    '[sara] tray icon: path=C:\\Users\\mfahm\\...\\icon.ico loaded=true\n' +
    '[sara] tray created ✓ — look in the system tray'
  assert.equal(looksLikeAppBanner(banner), true)
})

test('a genuine Hermes answer is NOT flagged', () => {
  assert.equal(
    looksLikeAppBanner('Done. File is at:\nC:\\Users\\x\\Desktop\\candidates.xlsx\nwrote 453 rows.'),
    false
  )
})

test('a single incidental marker word does not trip it (needs >=2)', () => {
  assert.equal(looksLikeAppBanner('I added a tray icon to the mockup'), false)
})

test('empty / nullish output is safe', () => {
  assert.equal(looksLikeAppBanner(''), false)
  assert.equal(looksLikeAppBanner(null), false)
  assert.equal(looksLikeAppBanner(undefined), false)
})
