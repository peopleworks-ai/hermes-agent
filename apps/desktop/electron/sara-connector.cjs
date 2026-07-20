'use strict'
/**
 * Sarä connector (Electron/Node port of apps/hros/desktop/connector/sara_connector.py).
 *
 * Runs inside the widget's main process. Three jobs, no key typed by the user:
 *   1. TASK BRIDGE  — polls hcos for THIS user's queued desktop tasks, runs each
 *                     with `hermes -z`, posts the result back.
 *   2. LLM SIDECAR  — a local Anthropic endpoint Hermes points at; forwards to
 *                     hcos llm_proxy (server holds the MiniMax key) → no key here.
 *   3. PAIRING      — a loopback server the hcos "Connect my desktop app" button
 *                     POSTs credentials to (127.0.0.1:8761). Creds persist in
 *                     userData/sara-config.json.
 *
 * Exposes getCurrentWork() (the tasks it's running right now) for the tray.
 */
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

const LLM_PORT = Number(process.env.SARA_LLM_PORT || 8760)
const PAIR_PORT = Number(process.env.SARA_PAIR_PORT || 8761)
const DEVICE = os.hostname()
const POLL_MS = 3000

// The build we're running, reported to hcos so it can tell the user when a newer one is out.
// Without this the server only knows the version it PUBLISHED, so a stale install is
// indistinguishable from a current one. Resolved lazily and defensively: `app` isn't ready at
// module load, and this file is also require()d by plain-node unit tests where 'electron' throws.
function appVersion() {
  try {
    return require('electron').app.getVersion() || ''
  } catch {
    return ''
  }
}
// Resolved LAZILY at each spawn: main.cjs pins HERMES_BIN to the venv CLI, and it may do so after
// this module is required — capturing it once at load time would freeze the wrong value ('hermes' on
// PATH). On a packaged client, bare `hermes` can be a PATH shim that relaunches THIS Electron app.
function hermesBin() {
  return process.env.HERMES_BIN || 'hermes'
}
// Boot-banner phrases this app prints (main.cjs install-stamp, connector-started, tray-created). If a
// spawned "hermes" emits ≥2 of these, HERMES resolved to the app itself: the 2nd instance hits the
// single-instance lock, prints its banner, and exits 0 having run NOTHING. Never call that a result.
const APP_BANNER_MARKERS = ['install stamp', 'connector started', 'tray created', 'tray icon']
function looksLikeAppBanner(s) {
  const t = String(s || '').toLowerCase()
  return APP_BANNER_MARKERS.filter((m) => t.includes(m)).length >= 2
}
// Zombie safety-net only — Hermes itself has no timeout. Heavy multi-app tasks
// (build a spreadsheet, drive Gmail in the browser, write+run a script) legit run
// well past 10 min, so kill only after 30. Keep in sync with the server's
// STALE_MINUTES (a task can't run longer than this ceiling anyway).
const HTIMEOUT_MS = 1800000
const LLM_METHOD = 'hros.api.llm_proxy.anthropic_messages'
const TASK_API = 'hros.api.sarah_desktop'

const state = {
  base: process.env.HROS_BASE_URL || 'https://hcos.peopleworks.ai',
  key: process.env.HROS_API_KEY || '',
  secret: process.env.HROS_API_SECRET || '',
  running: [], // [{ name, label }] — the tray's "Current Work"
  paused: false,
}
let userDataDir = null
let pollTimer = null
let sidecarSrv = null
let pairSrv = null
let claiming = false

// ── credentials ────────────────────────────────────────────────────────
function cfgPath() {
  return path.join(userDataDir || os.homedir(), 'sara-config.json')
}
function loadCreds() {
  try {
    const c = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'))
    if (c && c.api_key && c.api_secret) {
      state.base = (c.base_url || state.base).replace(/\/+$/, '')
      state.key = c.api_key
      state.secret = c.api_secret
      return true
    }
  } catch {
    /* not paired yet */
  }
  return !!(state.key && state.secret)
}
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) || {}
  } catch {
    return {}
  }
}
// MERGES into sara-config.json so persisting watch state doesn't drop the creds
// (and re-pairing doesn't drop the watch state).
function saveCreds(c) {
  try {
    fs.mkdirSync(path.dirname(cfgPath()), { recursive: true })
    fs.writeFileSync(cfgPath(), JSON.stringify({ ...readConfig(), ...c }))
  } catch (e) {
    console.error('[sara] saveCreds failed:', e && e.message)
  }
}
function isPaired() {
  return !!(state.key && state.secret)
}

// ── hcos calls ─────────────────────────────────────────────────────────
async function hcos(method, payload) {
  const r = await fetch(`${state.base}/api/method/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `token ${state.key}:${state.secret}` },
    body: JSON.stringify(payload || {}),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status, body: j })
  return j && j.message !== undefined ? j.message : j
}

// ── (2) LLM sidecar: Hermes → here → hcos llm_proxy → MiniMax ────────────
function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}
function* synthSSE(resp) {
  const shell = { ...resp }
  delete shell.content
  shell.content = []
  if (shell.stop_reason === undefined) shell.stop_reason = null
  yield sse('message_start', { type: 'message_start', message: shell })
  const blocks = resp.content || []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type === 'text') {
      yield sse('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } })
      yield sse('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text || '' } })
    } else if (b.type === 'tool_use') {
      yield sse('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } })
      yield sse('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input || {}) } })
    } else {
      yield sse('content_block_start', { type: 'content_block_start', index: i, content_block: b })
    }
    yield sse('content_block_stop', { type: 'content_block_stop', index: i })
  }
  const usage = resp.usage || {}
  yield sse('message_delta', { type: 'message_delta', delta: { stop_reason: resp.stop_reason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens || 0 } })
  yield sse('message_stop', { type: 'message_stop' })
}
function startSidecar() {
  if (sidecarSrv) return
  sidecarSrv = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end('{"ok":true,"service":"sara-llm-sidecar"}')
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      let parsed
      try {
        parsed = JSON.parse(body || '{}')
      } catch {
        res.writeHead(400)
        return res.end('bad body')
      }
      const wantsStream = !!parsed.stream
      parsed.stream = false
      try {
        const resp = await hcos(LLM_METHOD, { payload: JSON.stringify(parsed) })
        // Lazy Chrome Sara: the moment the model decides to use a browser tool,
        // launch the visible Chrome now (just-in-time) so Hermes's browser_cdp
        // has a CDP endpoint when it runs. Best-effort, non-blocking.
        try {
          const blocks = (resp && resp.content) || []
          if (blocks.some((b) => b && b.type === 'tool_use' && /^browser/i.test(b.name || ''))) {
            require('./sara-chrome.cjs').launch().catch(() => {})
          }
        } catch {
          /* ignore */
        }
        if (wantsStream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
          for (const chunk of synthSSE(resp)) res.write(chunk)
          res.end()
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(resp))
        }
      } catch (e) {
        res.writeHead(e.status || 502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { message: String((e && e.message) || e).slice(0, 300) } }))
      }
    })
  })
  // A listen() error MUST be handled: without this, EADDRINUSE is an UNCAUGHT exception in
  // the main process → Electron pops "A JavaScript error occurred in the main process" and the
  // app dies. That fires whenever the port is already held — a user double-clicking the icon
  // while the app is running in the tray, or a leftover dev/unpacked instance. Degrade
  // gracefully instead: skip the sidecar, keep the app alive.
  sidecarSrv.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.warn(`[sara] LLM sidecar port ${LLM_PORT} already in use — another Sarä instance owns it; skipping sidecar.`)
    } else {
      console.error('[sara] LLM sidecar server error:', (e && e.message) || e)
    }
    sidecarSrv = null
  })
  sidecarSrv.listen(LLM_PORT, '127.0.0.1', () =>
    console.log(`[sara] LLM sidecar on http://127.0.0.1:${LLM_PORT} (no key on this laptop)`)
  )
}

// ── (3) pairing server: hcos page → here ─────────────────────────────────
function startPairing(onPaired) {
  if (pairSrv) return
  pairSrv = http.createServer((req, res) => {
    const cors = () => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    }
    if (req.method === 'OPTIONS') {
      cors()
      res.writeHead(204)
      return res.end()
    }
    if (req.method === 'GET') {
      cors()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      // `version` lets the hcos page compare against the published build and offer an update.
      return res.end(JSON.stringify({ app: 'sara-desktop', paired: isPaired(), version: appVersion() }))
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      cors()
      try {
        const c = JSON.parse(body || '{}')
        if (c.api_key && c.api_secret) {
          state.base = (c.base_url || state.base).replace(/\/+$/, '')
          state.key = c.api_key
          state.secret = c.api_secret
          saveCreds({ base_url: state.base, api_key: c.api_key, api_secret: c.api_secret })
          console.log('[sara] paired ✓')
          if (onPaired) onPaired()
        }
      } catch {
        /* ignore */
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  // Same guard as the sidecar above — an unhandled EADDRINUSE here kills the whole app.
  pairSrv.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      console.warn(`[sara] pairing port ${PAIR_PORT} already in use — another Sarä instance owns it; skipping pairing server.`)
    } else {
      console.error('[sara] pairing server error:', (e && e.message) || e)
    }
    pairSrv = null
  })
  pairSrv.listen(PAIR_PORT, '127.0.0.1', () =>
    console.log(`[sara] pairing server on http://127.0.0.1:${PAIR_PORT}`)
  )
}

// ── Hermes: point it at the sidecar (auto-config) ────────────────────────
function ensureHermesConfig() {
  const settings = [
    ['model.default', 'MiniMax-M3'],
    ['model.provider', 'minimax'],
    ['model.base_url', `http://127.0.0.1:${LLM_PORT}/anthropic`],
    ['model.api_key', 'sara-local'],
    // Point Hermes's browser tools (browser_cdp / browser_navigate / …) at the
    // visible, persistent Chrome Sara the widget launches (brief §5).
    ['browser.cdp_url', `http://127.0.0.1:${process.env.SARA_CDP_PORT || 39222}`],
  ]
  for (const [k, v] of settings) {
    try {
      spawn(hermesBin(), ['config', 'set', k, v], { stdio: 'ignore' })
    } catch {
      /* best-effort */
    }
  }
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

// Pull the final answer out of `hermes chat -q` output — prefer the boxed
// "Hermes" panel; else strip tool lines, the box borders, and the footer.
function extractAnswer(raw) {
  const lines = raw.replace(ANSI, '').split(/\r?\n/)
  let inBox = false
  const box = []
  for (const ln of lines) {
    if (/[╭┌].*Hermes/.test(ln)) {
      inBox = true
      continue
    }
    if (inBox && /[╰└]/.test(ln)) {
      inBox = false
      continue
    }
    if (inBox) box.push(ln.replace(/^[│|]?\s*/, '').replace(/\s+$/, ''))
  }
  const boxed = box.join('\n').trim()
  if (boxed) return boxed
  const junk = /^(Query:|Initializing agent|Resume this session|Session:|Duration:|Messages:)|┊|^\s*hermes --resume|^[\s┊│|╭╮╰╯└┌┐┘─═•]+$/
  return lines.filter((l) => l.trim() && !junk.test(l)).map((l) => l.replace(/^[│|]?\s*/, '').trim()).join('\n').trim()
}

// ── Workspace → toolset gating ───────────────────────────────────────────────
// "Whole Computer" used to be a LABEL: every mode ran Hermes with its full default toolset, so a
// dialog promising "Sara can now use all apps" was equally true in Chrome mode. Now the workspace
// actually restricts what Hermes can touch — Chrome gets browser/web only (no terminal, no file
// system), Whole Computer gets everything.
//
// DEFENSIVE, because this box can't run `hermes`: we do NOT pass --toolsets unless a boot probe has
// CONFIRMED the installed Hermes understands it. Passing an unknown flag would fail every task; an
// unverifiable restriction must degrade to today's behaviour (ungated) AND to honest copy, never to
// a crash. `isToolsetGatingAvailable()` reports the probe result so the UI can tell the truth about
// whether the boundary is real.
const CHROME_TOOLSETS = 'browser,web,vision,skills,todo' // deliberately NO terminal, NO file
let toolsetMode = 'chrome' // §5 default; the store pushes the real one via setToolsetMode
let toolsetGating = false // flipped true only if the probe succeeds

function setToolsetMode(mode) {
  toolsetMode = mode === 'whole' ? 'whole' : mode === 'pause' ? 'pause' : 'chrome'
}
function isToolsetGatingAvailable() {
  return toolsetGating
}

// One-shot: does `hermes chat --list-toolsets` work AND mention the browser toolset? If so the CLI
// speaks --toolsets and we can trust the gating. Anything else (unknown flag, missing binary, a
// timeout) leaves gating OFF.
function probeToolsets() {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (ok) => {
      if (done) return
      done = true
      toolsetGating = ok
      console.log(`[sara] toolset gating ${ok ? 'AVAILABLE — Chrome mode restricts Sarä to the browser' : 'unavailable — Whole Computer / Chrome are labels only on this Hermes'}`)
      resolve(ok)
    }
    let child
    try {
      child = spawn(hermesBin(), ['chat', '--list-toolsets'], { windowsHide: true })
    } catch {
      return finish(false)
    }
    const t = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      finish(false)
    }, 12000)
    child.stdout && child.stdout.on('data', (d) => (out += d))
    child.on('error', () => {
      clearTimeout(t)
      finish(false)
    })
    child.on('close', (code) => {
      clearTimeout(t)
      finish(code === 0 && /\bbrowser\b/i.test(out))
    })
  })
}

// Pure (exported for tests): the args for a task spawn given a gating flag + workspace mode. Whole
// Computer (or an un-probed Hermes) → no flag → Hermes's full default toolset. Chrome → the
// browser-only set, but ONLY when the probe confirmed --toolsets is understood.
function buildChatArgs(prompt, gating, mode) {
  if (gating && mode === 'chrome') {
    return ['chat', '--toolsets', CHROME_TOOLSETS, '-q', prompt]
  }
  return ['chat', '-q', prompt]
}
function hermesChatArgs(prompt) {
  return buildChatArgs(prompt, toolsetGating, toolsetMode)
}

// Run via `hermes chat -q` (shows tool activity, unlike the silent `-z`) and
// stream the tool lines out via onProgress so the Sarä chat shows live steps.
function runHermes(prompt, onProgress) {
  return new Promise((resolve) => {
    let out = '',
      err = ''
    // Scan a stream line-by-line for tool markers (┊). Hermes may print the tool
    // activity to stderr while the answer goes to stdout, so we scan BOTH.
    const scanFactory = () => {
      let b = ''
      return (chunk) => {
        b += chunk
        let idx
        while ((idx = b.indexOf('\n')) >= 0) {
          const line = b.slice(0, idx).replace(ANSI, '').trim()
          b = b.slice(idx + 1)
          if (line.includes('┊') && onProgress) {
            const step = line.replace(/^[┊\s]+/, '').replace(/\s{2,}/g, ' ').trim()
            if (step) onProgress(step)
          }
        }
      }
    }
    const scanOut = scanFactory()
    const scanErr = scanFactory()
    let child
    const bin = hermesBin()
    try {
      child = spawn(bin, hermesChatArgs(prompt), { windowsHide: true })
    } catch (e) {
      return resolve({ error: `hermes spawn failed: ${(e && e.message) || e}` })
    }
    const t = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      resolve({ error: `hermes timed out after ${HTIMEOUT_MS / 1000}s` })
    }, HTIMEOUT_MS)
    child.stdout.on('data', (d) => {
      out += d
      scanOut(d.toString('utf8'))
    })
    child.stderr.on('data', (d) => {
      err += d
      scanErr(d.toString('utf8'))
    })
    child.on('error', (e) => {
      clearTimeout(t)
      resolve({ error: `hermes not found (${bin}): ${(e && e.message) || e}` })
    })
    child.on('close', (code) => {
      clearTimeout(t)
      // HERMES mis-resolved to THIS app (a PATH shim relaunched us): the 2nd instance printed its
      // boot banner and single-instance-exited 0 without running anything. Fail loudly — a fake
      // "success" here is exactly what let an empty task show a green ✓.
      if (looksLikeAppBanner(out)) {
        return resolve({
          error:
            `hermes resolved to the desktop app, not the CLI (bin=${bin}). No task ran — set ` +
            `HERMES_BIN to the venv hermes and restart Sarä.`,
        })
      }
      if (code !== 0) resolve({ error: (err || out || `hermes exit ${code}`).slice(0, 2000) })
      else resolve({ result: extractAnswer(out) || '(no output)' })
    })
  })
}

// ── (1) task bridge ──────────────────────────────────────────────────────
async function pollOnce() {
  if (claiming || state.paused || !isPaired()) return
  claiming = true
  try {
    // This poll doubles as the server-side heartbeat, so it's also where we report our version.
    const task = await hcos(`${TASK_API}.claim_next_task`, { device: DEVICE, version: appVersion() })
    if (task && task.name) {
      const entry = { name: task.name, label: task.prompt || '(task)' }
      state.running.push(entry)
      console.log(`[sara] claimed ${task.name}: ${String(task.prompt).slice(0, 80)}`)
      const { result, error } = await runHermes(task.prompt || '', (step) => {
        // Stream each tool step as an event → the Sarä chat renders live cards.
        console.log('[sara] step:', step)
        hcos(`${TASK_API}.append_task_event`, {
          name: task.name,
          event: JSON.stringify({ type: 'tool', text: step }),
        }).catch(() => {})
      })
      await hcos(`${TASK_API}.complete_task`, { name: task.name, result, error })
      state.running = state.running.filter((r) => r.name !== task.name)
      console.log(`[sara] done ${task.name}: ${error ? 'ERROR ' + error : String(result).slice(0, 100)}`)
    }
  } catch (e) {
    if (e.status === 401) console.error('[sara] 401 — re-pair at /people/desktop')
    else console.error('[sara] poll error:', (e && e.message) || e)
  } finally {
    claiming = false
  }
}

// ── public API ───────────────────────────────────────────────────────────
// ── (3) Learn-by-Watching: register an Omi device + consent, then capture ──
let hbTimer = null
const watch = { enabled: false, screen: false, voice: false, deviceId: null }

// `watch` is the ONLY truth about whether we are recording. The UI must mirror it, never guess:
// resumeWatchIfEnabled() below can turn recording ON at boot with nobody clicking anything, and it
// can also FAIL after we've already decided to resume. Anyone rendering a "watching" indicator
// subscribes here instead of keeping their own copy — that is what stopped the tray from claiming
// "Learning Mode: Off" while the screen was being captured and uploaded.
const watchListeners = []
function onWatchChange(cb) {
  if (typeof cb !== 'function') return () => {}
  watchListeners.push(cb)
  return () => {
    const i = watchListeners.indexOf(cb)
    if (i >= 0) watchListeners.splice(i, 1)
  }
}
function emitWatch() {
  const snap = getWatch()
  for (const cb of watchListeners.slice()) {
    try {
      cb(snap)
    } catch {
      /* a bad listener must never take the capture pipeline down */
    }
  }
}
function getWatch() {
  return { enabled: watch.enabled, screen: watch.screen, voice: watch.voice, deviceId: watch.deviceId }
}

function startHeartbeat() {
  stopHeartbeat()
  const beat = () => {
    if (watch.deviceId) hcos('hros.api.omi_desktop.heartbeat', { device_id: watch.deviceId }).catch(() => {})
  }
  beat()
  hbTimer = setInterval(beat, 60000)
}
function stopHeartbeat() {
  if (hbTimer) clearInterval(hbTimer)
  hbTimer = null
}

// Called from the tray when the user picks "Learn By Watching Me" + a mode.
async function startWatch(modes) {
  if (!isPaired()) throw new Error('not paired — connect the desktop app first')
  const scr = !!(modes && modes.screen)
  const voi = !!(modes && modes.voice)
  // Ensure an Active Omi device using our EXISTING token (register_device does
  // NOT rotate the api_secret, unlike pair_device — so our connector stays valid).
  const reg = await hcos('hros.api.omi_desktop.register_device', {
    device_label: `Sarä Desktop (${DEVICE})`,
    platform: process.platform,
  })
  watch.deviceId = reg && reg.device_id
  if (!watch.deviceId) throw new Error('register_device returned no device_id')
  await hcos('hros.api.omi_desktop.set_recording_consent', {
    device_id: watch.deviceId,
    allowed: 1,
    consent_version: 'sara-widget-v1',
  })
  watch.enabled = true
  watch.screen = scr
  watch.voice = voi
  saveCreds({ omi_device_id: watch.deviceId, watch: { enabled: true, screen: scr, voice: voi } })
  startHeartbeat()
  const capCfg = { deviceId: watch.deviceId, base: state.base, key: state.key, secret: state.secret }
  if (scr) {
    try {
      require('./sara-capture.cjs').start({ ...capCfg, screen: true })
    } catch (e) {
      console.error('[sara] screen capture start failed:', (e && e.message) || e)
    }
  }
  if (voi) {
    try {
      require('./sara-voice.cjs').start({ ...capCfg, system: true })
    } catch (e) {
      console.error('[sara] voice capture start failed:', (e && e.message) || e)
    }
  }
  console.log(`[sara] watching ON (screen=${scr} voice=${voi}) device=${watch.deviceId}`)
  emitWatch()
  return { deviceId: watch.deviceId, screen: scr, voice: voi }
}

async function stopWatch() {
  stopHeartbeat()
  try {
    require('./sara-capture.cjs').stop()
  } catch {}
  try {
    require('./sara-voice.cjs').stop()
  } catch {}
  const wasOn = watch.enabled
  watch.enabled = false
  saveCreds({ watch: { enabled: false, screen: watch.screen, voice: watch.voice } })
  if (wasOn && watch.deviceId) {
    try {
      await hcos('hros.api.omi_desktop.set_recording_consent', { device_id: watch.deviceId, allowed: 0 })
    } catch {}
  }
  console.log('[sara] watching OFF')
  emitWatch()
}

// On launch, resume watching if the user had it on (consent already given).
function resumeWatchIfEnabled() {
  const w = readConfig().watch
  if (w && w.enabled && isPaired()) {
    startWatch({ screen: w.screen, voice: w.voice }).catch((e) => {
      console.error('[sara] resume watch failed:', (e && e.message) || e)
      // startWatch throws BEFORE setting watch.enabled, so we are not recording. Say so — a UI
      // that had already armed itself from the persisted config must drop back to "armed, not
      // recording" rather than show a red dot for a capture that never started.
      emitWatch()
    })
  }
}

function start(dir, onPaired) {
  userDataDir = dir
  loadCreds()
  startSidecar()
  startPairing(onPaired)
  ensureHermesConfig()
  if (!pollTimer) pollTimer = setInterval(pollOnce, POLL_MS)
  resumeWatchIfEnabled()
  // Async — tasks spawning before it resolves run ungated (safe: full toolset), and Chrome mode
  // starts restricting once it lands. Never blocks boot.
  probeToolsets().catch(() => {})
  console.log(`[sara] connector started (paired=${isPaired()}, device=${DEVICE})`)
}
function stop() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  stopHeartbeat()
  try {
    sidecarSrv && sidecarSrv.close()
  } catch {}
  try {
    pairSrv && pairSrv.close()
  } catch {}
}
function getCurrentWork() {
  return state.running.map((r) => ({ label: r.label }))
}
function setPaused(p) {
  state.paused = !!p
}

module.exports = {
  start,
  stop,
  getCurrentWork,
  isPaired,
  setPaused,
  startWatch,
  stopWatch,
  // Additive — so sara-state.cjs can be the ONE owner of widget state without a second store:
  readConfig, // the persisted sara-config.json (creds + watch + our own {sara:{…}} block)
  patchConfig: saveCreds, // MERGING write — never clobbers creds or watch
  getWatch, // the truth about recording
  onWatchChange, // …and a subscription to it
  // Workspace → toolset gating (Whole Computer made real):
  setToolsetMode, // the store pushes 'chrome'|'whole'|'pause' on a workspace change
  isToolsetGatingAvailable, // did the boot probe confirm --toolsets works? (drives honest copy)
  buildChatArgs, // pure — exported for tests
  looksLikeAppBanner, // pure — guards against reporting the app's own boot banner as a task result
  CHROME_TOOLSETS,
}
