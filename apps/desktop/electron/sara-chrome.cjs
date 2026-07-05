'use strict'
/**
 * Chrome Sara lifecycle (brief §5) — launches a dedicated, VISIBLE Chrome with a
 * persistent profile + CDP, so the user logs in ONCE and the session sticks.
 * Hermes then drives it via its own CDP tools (browser.cdp_url points here) —
 * no Stagehand needed for this path.
 *
 *   Widget → launch Chrome (--user-data-dir sara-chrome-profile --remote-debugging-port)
 *          → Hermes browser_cdp / browser_navigate/click drive it over CDP.
 */
const http = require('node:http')
const { spawn } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const CDP_PORT = Number(process.env.SARA_CDP_PORT || 39222)
const PROFILE =
  process.env.SARA_PROFILE ||
  path.join(process.env.LOCALAPPDATA || os.homedir(), 'sara-chrome-profile')

let child = null

function findChrome() {
  if (process.env.SARA_CHROME && existsSync(process.env.SARA_CHROME)) return process.env.SARA_CHROME
  const guesses =
    process.platform === 'win32'
      ? [
          path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
          path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
          path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']
  return guesses.find((g) => g && existsSync(g)) || null
}

function cdpUp() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${CDP_PORT}/json/version`, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(1500, () => {
      req.destroy()
      resolve(false)
    })
  })
}

function cdpUrl() {
  return `http://127.0.0.1:${CDP_PORT}`
}

async function launch() {
  if (await cdpUp()) return cdpUrl() // already running — reuse (logins persist)
  const chrome = findChrome()
  if (!chrome) throw new Error('Chrome not found — install Google Chrome or set SARA_CHROME')
  console.log('[sara] launching Chrome Sara:', chrome, 'profile:', PROFILE)
  child = spawn(
    chrome,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { detached: false, stdio: 'ignore', windowsHide: false }
  )
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    if (await cdpUp()) {
      console.log('[sara] Chrome Sara ready on CDP', cdpUrl(), '— log in once; the session persists.')
      return cdpUrl()
    }
  }
  throw new Error('Chrome Sara did not expose CDP in time')
}

function quit() {
  try {
    child && child.kill()
  } catch {
    /* ignore */
  }
  child = null
}

async function isRunning() {
  return cdpUp()
}

module.exports = { launch, quit, cdpUrl, isRunning, CDP_PORT }
