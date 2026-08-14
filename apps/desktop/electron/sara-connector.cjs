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
const { syncDesktopSkills } = require('./sara-skills-sync.cjs')

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
// Resolved LAZILY at each spawn: main.cjs injects a resolver that re-checks the venv CLI path on
// EVERY call, so a venv that appears after boot (bootstrap finishing late, a repair) is picked up
// without a restart. NEVER falls back to a bare 'hermes': on Windows, CreateProcess searches the
// calling app's own directory BEFORE PATH, and that directory contains Hermes.exe — a bare name is
// GUARANTEED to relaunch this app, boot-banner out, and "complete" a task that ran nothing. No
// resolvable CLI ⇒ null ⇒ the engine-broken latch below (an honest failure, not a fake success).
let binResolver = () => process.env.HERMES_BIN || null
function setBinResolver(fn) {
  if (typeof fn === 'function') binResolver = fn
}
function hermesBin() {
  try {
    return binResolver() || null
  } catch {
    return null
  }
}

// Same shape for HERMES_HOME. main.cjs already resolves it (env → Windows user
// registry → %LOCALAPPDATA%\hermes), and duplicating that logic here is how the
// two drift apart, so it injects the resolved value instead.
let homeResolver = () => process.env.HERMES_HOME || null
function setHomeResolver(fn) {
  if (typeof fn === 'function') homeResolver = fn
}
function hermesHome() {
  try {
    return homeResolver() || null
  } catch {
    return null
  }
}

// ── Per-conversation context bundle ──────────────────────────────────────────
// A step used to arrive with its instruction and nothing else: no transcript, no
// SOP. The server can now hand over both, but only a SKILL PACK is reachable —
// CHROME_TOOLSETS below deliberately withholds `file` and `terminal`, so
// skill_view (which reads under HERMES_HOME/skills) is the agent's only door to
// a file. Hence: write the bundle as a skill pack, and point the spawn's cwd at
// it so Hermes's own AGENTS.md injection picks up the small always-on tier.
const BUNDLE_ROOT = 'conversations'
const BUNDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000

function bundleDir(conversation) {
  const home = hermesHome()
  if (!home || !conversation) return null
  // Names come from the server (SARAH-CONV-2026-#####); keep only characters that
  // cannot climb out of the skills directory.
  const safe = String(conversation).replace(/[^A-Za-z0-9._-]/g, '')
  if (!safe) return null
  return path.join(home, 'skills', BUNDLE_ROOT, `conv-${safe}`)
}

/** Materialise a conversation's bundle; returns its directory, or null.
 *  Best-effort by contract — a bundle that will not download must never stop
 *  the task it was meant to help. */
async function syncConversationBundle(conversation) {
  const dir = bundleDir(conversation)
  if (!dir) return null
  try {
    const stamp = path.join(dir, '.bundle-hash')
    let have = ''
    try {
      have = fs.readFileSync(stamp, 'utf8').trim()
    } catch {
      /* first time */
    }
    const b = await hcos('hros.api.desktop_context.get_conversation_bundle', { conversation })
    if (!b || !Array.isArray(b.files) || !b.files.length) return null
    if (b.hash && b.hash === have) {
      fs.utimesSync(dir, new Date(), new Date()) // keep it out of the pruner
      return dir
    }
    for (const f of b.files) {
      // Server-authored relative paths (SKILL.md, references/…). Resolve and
      // confirm the result is still inside the bundle before writing.
      const dest = path.resolve(dir, String(f.path || ''))
      if (dest !== dir && !dest.startsWith(dir + path.sep)) continue
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, String(f.content ?? ''), 'utf8')
    }
    fs.writeFileSync(stamp, String(b.hash || ''), 'utf8')
    console.log(`[sara] context bundle ready: ${dir} (${b.files.length} files)`)
    return dir
  } catch (e) {
    console.error('[sara] context bundle failed (continuing without it):', (e && e.message) || e)
    return null
  }
}

/** Drop bundles nobody has touched in a week. */
function pruneConversationBundles() {
  const home = hermesHome()
  if (!home) return
  const root = path.join(home, 'skills', BUNDLE_ROOT)
  let names = []
  try {
    names = fs.readdirSync(root)
  } catch {
    return
  }
  const cutoff = Date.now() - BUNDLE_TTL_MS
  for (const n of names) {
    const p = path.join(root, n)
    try {
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true })
    } catch {
      /* leave it */
    }
  }
}

// Engine-health latch (same shape as authBad): set when the Hermes CLI is missing or a spawn
// resolved to the app itself; cleared by any successful probe/run. main.cjs subscribes via
// onEngineBroken to trigger auto-repair; the widget + tray render it via getIdentity(). Without
// this, a laptop failing 100% of its tasks looks identical to a healthy idle one.
let engineBrokenCb = null
function onEngineBroken(cb) {
  engineBrokenCb = typeof cb === 'function' ? cb : null
}
function noteEngineBroken(detail) {
  const first = !state.engineBroken
  state.engineBroken = true
  state.engineDetail = String(detail || '')
  if (first && engineBrokenCb) {
    try {
      engineBrokenCb(state.engineDetail)
    } catch {}
  }
}
function clearEngineBroken() {
  state.engineBroken = false
  state.engineDetail = ''
}
// While the installer runs we stop claiming tasks — they wait Queued on the server instead of
// failing mid-repair. main.cjs flips this around its repair flow.
function setRepairing(v) {
  state.repairing = !!v
}
// Boot-banner phrases this app prints (main.cjs install-stamp, connector-started, tray-created). If a
// spawned "hermes" emits ≥2 of these, HERMES resolved to the app itself: the 2nd instance hits the
// single-instance lock, prints its banner, and exits 0 having run NOTHING. Never call that a result.
const APP_BANNER_MARKERS = ['install stamp', 'connector started', 'tray created', 'tray icon']
function looksLikeAppBanner(s) {
  const t = String(s || '').toLowerCase()
  return APP_BANNER_MARKERS.filter((m) => t.includes(m)).length >= 2
}
// A zero-work "success" (2026-07-28 field incident): a freshly bootstrapped hermes ran
// with NO inference provider — boot-time ensureHermesConfig() was skipped while the venv
// didn't exist yet — echoed the prompt, printed this refusal, and exited 0. The task
// showed a green ✓ having done NOTHING. Never report that output as a result.
function looksLikeNoProvider(s) {
  return /no inference provider configured/i.test(String(s || ''))
}
// Zombie safety-net only — Hermes itself has no timeout. Heavy multi-app tasks
// (build a spreadsheet, drive Gmail in the browser, write+run a script) legit run
// well past 10 min, so kill only after 30. Keep in sync with the server's
// STALE_MINUTES (a task can't run longer than this ceiling anyway).
const HTIMEOUT_MS = 1800000
// Idle ceiling: TOTAL silence (no stdout/stderr bytes at all) for this long =
// a wedged engine, not a long task — long tasks stream tool markers and LLM
// retries constantly. Distinct from HTIMEOUT_MS: that caps a NOISY run's total
// time; this frees the single-lane queue from a silent hang in minutes.
const IDLE_MS = 600000
const LLM_METHOD = 'hros.api.llm_proxy.anthropic_messages'
const TASK_API = 'hros.api.sarah_desktop'

const state = {
  base: process.env.HROS_BASE_URL || 'https://hcos.peopleworks.ai',
  key: process.env.HROS_API_KEY || '',
  secret: process.env.HROS_API_SECRET || '',
  running: [], // [{ name, label }] — the tray's "Current Work"
  paused: false,
  // WHOSE account this app records into ("Connected as …"). From the pairing payload, or
  // backfilled by whoami() for installs paired before the field existed.
  userEmail: '',
  // Token-validity truth. "paired" only means creds EXIST; when the account's secret is
  // re-generated elsewhere, every call 401s while both surfaces still say Connected — that
  // exact incident is why this flag exists. Set on any 401, cleared on any authed success.
  authBad: false,
  // Engine-health truth (see noteEngineBroken): the Hermes CLI is missing/mis-resolved,
  // so tasks CANNOT run on this machine until a repair. detail: 'missing' | 'app-shim'.
  engineBroken: false,
  engineDetail: '',
  repairing: false,
}
let userDataDir = null
let pollTimer = null
let skillsTimer = null
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
      if (typeof c.user === 'string') state.userEmail = c.user
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

// Who does this token belong to? Backfills `userEmail` for installs paired before the pairing
// payload carried `user`, and doubles as a token-validity probe at boot. Best-effort: a network
// blip must not flag a working pairing as bad, so ONLY a 401 sets authBad here.
async function whoami() {
  if (!isPaired()) return
  try {
    const u = await hcos('frappe.auth.get_logged_user', {})
    if (u && typeof u === 'string') {
      if (u !== state.userEmail) {
        state.userEmail = u
        saveCreds({ user: u })
      }
    }
    state.authBad = false
  } catch (e) {
    if (e && e.status === 401) state.authBad = true
  }
}

// The UI's line "Connected as …" / "Connection expired". `user` may be '' on pre-field pairings
// until whoami() lands; authBad flips live from the poll (401 ⇒ true, any success ⇒ false).
// engineBroken/repairing ride along so the store needs no second mirror channel.
function getIdentity() {
  return {
    user: state.userEmail || '',
    authBad: !!state.authBad,
    engineBroken: !!state.engineBroken,
    engineDetail: state.engineDetail || '',
    repairing: !!state.repairing,
  }
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
      // Chrome's Private Network Access: a public https page calling 127.0.0.1 sends a
      // preflight demanding this header; without it, newer/policy-managed Chromes block the
      // pairing call outright — the exact "Connect does nothing, app looks fine" failure.
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
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
          if (typeof c.user === 'string' && c.user) state.userEmail = c.user
          state.authBad = false // fresh creds — assume good until a call says otherwise
          saveCreds({
            base_url: state.base,
            api_key: c.api_key,
            api_secret: c.api_secret,
            ...(state.userEmail ? { user: state.userEmail } : {}),
          })
          console.log(`[sara] paired ✓${state.userEmail ? ' as ' + state.userEmail : ''}`)
          whoami() // verify + backfill the account for payloads without `user`
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
// `hermes config set` is read-modify-write on ~/.hermes/config.yaml guarded only by an
// IN-PROCESS lock, so concurrent setter processes all read the same snapshot and the last
// writer wins — the other keys are silently dropped. On a fresh venv that left
// model.provider=minimax but LOST model.base_url + model.api_key, and hermes then called
// api.minimax.io directly with the placeholder key: every task 401'd while the widget
// looked healthy (2026-08-14). One queue, one setter at a time — and overlapping
// invocations (boot + post-bootstrap + repair) join the same queue instead of racing.
let hermesConfigQueue = Promise.resolve()
function queueHermesConfigWrites(settings, runOne) {
  hermesConfigQueue = hermesConfigQueue.then(async () => {
    for (const [k, v] of settings) {
      try {
        await runOne(k, v)
      } catch {
        /* best-effort — a failed key must not block the rest */
      }
    }
  })
  return hermesConfigQueue
}

function runHermesConfigSet(bin, key, value) {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }
    // A wedged CLI must not jam the queue forever (config set is normally <2s).
    const timer = setTimeout(finish, 15_000)
    try {
      const child = spawn(bin, ['config', 'set', key, value], { stdio: 'ignore' })
      child.on('error', finish)
      child.on('close', finish)
    } catch {
      finish()
    }
  })
}

function ensureHermesConfig() {
  const bin = hermesBin()
  if (!bin) return Promise.resolve() // no CLI yet (pre-bootstrap / mid-repair) — main.cjs re-invokes after repair
  const settings = [
    ['model.default', 'MiniMax-M3'],
    ['model.provider', 'minimax'],
    ['model.base_url', `http://127.0.0.1:${LLM_PORT}/anthropic`],
    ['model.api_key', 'sara-local'],
    // Point Hermes's browser tools (browser_cdp / browser_navigate / …) at the
    // visible, persistent Chrome Sara the widget launches (brief §5).
    ['browser.cdp_url', `http://127.0.0.1:${process.env.SARA_CDP_PORT || 39222}`],
  ]
  return queueHermesConfigWrites(settings, (k, v) => runHermesConfigSet(bin, k, v))
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
// What "Whole Computer" means for a Sarä TASK when an admin policy forces us to
// enumerate (you cannot subtract from "everything" without naming it first).
// Without a policy, whole mode keeps today's behaviour: no --toolsets at all.
const WHOLE_TOOLSETS = 'browser,web,vision,skills,todo,terminal,file,computer_use'
let toolsetMode = 'chrome' // §5 default; the store pushes the real one via setToolsetMode
let toolsetGating = false // flipped true only if the probe succeeds
// Admin ceiling from Super Admin → Desktop Tools, refreshed on every claim poll:
// {disabled_toolsets: [], disabled_tools: []}. The user's workspace mode can only
// NARROW further — it never re-enables what the policy disabled.
let toolPolicy = { disabled_toolsets: [], disabled_tools: [] }
function setToolPolicy(p) {
  toolPolicy = {
    disabled_toolsets: Array.isArray(p && p.disabled_toolsets) ? p.disabled_toolsets : [],
    disabled_tools: Array.isArray(p && p.disabled_tools) ? p.disabled_tools : [],
  }
}
function getToolPolicy() {
  return { ...toolPolicy, disabled_toolsets: [...toolPolicy.disabled_toolsets], disabled_tools: [...toolPolicy.disabled_tools] }
}
// Pure — exported for tests. The effective --toolsets list for a spawn, or null
// for "pass no flag" (ungated / nothing to subtract in whole mode).
function effectiveToolsets(mode, gating, policy) {
  if (!gating) return null // unknown flag on this hermes — degrade to ungated, never crash
  const denied = new Set((policy && policy.disabled_toolsets) || [])
  if (mode === 'chrome') {
    const kept = CHROME_TOOLSETS.split(',').filter((t) => !denied.has(t))
    return kept.join(',') || 'skills' // never an empty list — a tool-less spawn can do nothing, not even report why
  }
  if (denied.size === 0) return null // whole mode, no policy → today's behaviour
  const kept = WHOLE_TOOLSETS.split(',').filter((t) => !denied.has(t))
  return kept.join(',') || 'skills'
}

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
    const bin = hermesBin()
    if (!bin) {
      // The CLI doesn't exist on this machine at all — that's an ENGINE alarm, not
      // merely "gating unavailable". Latching here makes the boot probe double as
      // the engine-health check that triggers auto-repair.
      noteEngineBroken('missing')
      return finish(false)
    }
    let child
    try {
      child = spawn(bin, ['chat', '--list-toolsets'], { windowsHide: true })
    } catch {
      noteEngineBroken('missing')
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
      noteEngineBroken('missing') // ENOENT: the resolved path vanished
      finish(false)
    })
    child.on('close', (code) => {
      clearTimeout(t)
      const ok = code === 0 && /\bbrowser\b/i.test(out)
      if (ok || code === 0) clearEngineBroken() // the CLI ran — engine is real (gating may still be off)
      finish(ok)
    })
  })
}

// Pure (exported for tests): the args for a task spawn given a gating flag + workspace mode. Whole
// Computer (or an un-probed Hermes) → no flag → Hermes's full default toolset. Chrome → the
// browser-only set, but ONLY when the probe confirmed --toolsets is understood.
function buildChatArgs(prompt, gating, mode, policy) {
  const ts = effectiveToolsets(mode, gating, policy || toolPolicy)
  if (ts) {
    return ['chat', '--toolsets', ts, '-q', prompt]
  }
  return ['chat', '-q', prompt]
}
function hermesChatArgs(prompt) {
  return buildChatArgs(prompt, toolsetGating, toolsetMode)
}

// Run via `hermes chat -q` (shows tool activity, unlike the silent `-z`) and
// stream the tool lines out via onProgress so the Sarä chat shows live steps.
// The one in-flight hermes run, exposed so the widget's Cancel button can kill
// it. The child handle used to live only inside runHermes's closure — nothing
// outside could stop a run short of its own timeouts.
let currentChild = null
let currentTaskName = null
let cancelRequested = false

function runHermes(prompt, onProgress, cwd, taskName) {
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
    if (!bin) {
      // Keep the SARA_ENGINE_MISSING token in lockstep with the server's
      // _humanize_desktop_error (hros.api.sarah_desktop) — it maps this to the
      // user-facing Malay "engine not installed" message in the chat.
      noteEngineBroken('missing')
      return resolve({
        error:
          'SARA_ENGINE_MISSING: the Hermes CLI venv is not installed on this machine — ' +
          'Sarä Desktop needs its engine repaired before tasks can run.',
      })
    }
    try {
      // cwd = the conversation's bundle folder when there is one. Hermes reads
      // AGENTS.md from its working directory; the connector never set a cwd, so
      // that injection has never once fired.
      // Per-tool deny-list rides the environment (see agent_init's
      // HERMES_DISABLED_TOOLS filter) — toolset-level denies ride --toolsets.
      const _deniedTools = (toolPolicy.disabled_tools || []).join(',')
      child = spawn(bin, hermesChatArgs(prompt), {
        windowsHide: true,
        ...(cwd ? { cwd } : {}),
        env: { ...process.env, ...(_deniedTools ? { HERMES_DISABLED_TOOLS: _deniedTools } : {}) },
      })
    } catch (e) {
      noteEngineBroken('missing')
      return resolve({ error: `hermes spawn failed: ${(e && e.message) || e}` })
    }
    currentChild = child
    currentTaskName = taskName || null
    cancelRequested = false
    const t = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      resolve({ error: `hermes timed out after ${HTIMEOUT_MS / 1000}s` })
    }, HTIMEOUT_MS)
    // Idle watchdog: a HEALTHY run prints something (tool markers, retries,
    // stream chunks) well within minutes; total silence means the engine is
    // wedged. Killing at IDLE_MS instead of waiting out HTIMEOUT_MS matters
    // because the connector is single-lane — a silent hang used to block every
    // queued checkpoint behind it for the full 30 minutes (2026-08-12 jam).
    // The timer resets on ANY byte from stdout or stderr.
    let idleTimer = null
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        try {
          child.kill()
        } catch {}
        resolve({
          error:
            `hermes timed out after ${IDLE_MS / 1000}s of silence — the run produced no ` +
            `output at all in that window, so it was stopped to keep the task queue moving`,
        })
      }, IDLE_MS)
    }
    armIdle()
    child.stdout.on('data', (d) => {
      out += d
      armIdle()
      scanOut(d.toString('utf8'))
    })
    child.stderr.on('data', (d) => {
      err += d
      armIdle()
      scanErr(d.toString('utf8'))
    })
    child.on('error', (e) => {
      clearTimeout(t)
      currentChild = null
      currentTaskName = null
      noteEngineBroken('missing') // ENOENT: the resolved path vanished mid-flight
      resolve({ error: `hermes not found (${bin}): ${(e && e.message) || e}` })
    })
    child.on('close', (code) => {
      clearTimeout(t)
      currentChild = null
      currentTaskName = null
      // User pressed Batal on the widget: the kill is deliberate, so it MUST
      // resolve with the cancel token — falling through would report the kill
      // signal's non-zero exit as a generic engine failure. Token in lockstep
      // with the server's _humanize_desktop_error ("Dibatalkan oleh anda…").
      if (cancelRequested) {
        cancelRequested = false
        return resolve({
          error: 'SARA_CANCELLED_BY_USER: user pressed Cancel on the Sarä Desktop widget',
        })
      }
      // HERMES mis-resolved to THIS app (a PATH shim relaunched us): the 2nd instance printed its
      // boot banner and single-instance-exited 0 without running anything. Fail loudly — a fake
      // "success" here is exactly what let an empty task show a green ✓. With the per-spawn
      // resolver this should be unreachable; if it fires anyway, it's an engine alarm too.
      if (looksLikeAppBanner(out)) {
        noteEngineBroken('app-shim')
        return resolve({
          error:
            `SARA_ENGINE_MISSING: hermes resolved to the desktop app, not the CLI (bin=${bin}). ` +
            `No task ran — Sarä Desktop needs its engine repaired.`,
        })
      }
      if (looksLikeNoProvider(out + err)) {
        // Self-heal for the NEXT attempt (the CLI exists — it just was never pointed at
        // the sidecar), and fail THIS one honestly. Token in lockstep with the server's
        // _humanize_desktop_error, which tells the user to restart + Retry in Malay.
        try {
          ensureHermesConfig()
        } catch {}
        return resolve({
          error:
            'SARA_ENGINE_UNCONFIGURED: hermes ran with no inference provider — no work ' +
            'was performed. Configuration re-applied; retry the task.',
        })
      }
      if (code !== 0) {
        // The TAIL, not the head. Hermes opens with its banner and an echo of the
        // prompt (which now carries the platform-ethics prefix), and prints WHY it
        // stopped at the very end. Slicing from the front shipped 2000 characters
        // of preamble and cut the actual reason off — so the server's error
        // humaniser saw nothing it could recognise and the user got a wall of
        // unrelated text instead of "the model refused, press Retry".
        const raw = err || out || `hermes exit ${code}`
        resolve({ error: raw.length > 2000 ? '…' + raw.slice(-2000) : raw })
      }
      else {
        clearEngineBroken() // a real run completed — the engine works
        resolve({ result: extractAnswer(out) || '(no output)' })
      }
    })
  })
}

// ── (1) task bridge ──────────────────────────────────────────────────────
async function pollOnce() {
  // While the engine installer runs, DON'T claim — tasks wait Queued on the server
  // instead of failing mid-repair. (engineBroken alone does NOT stop claiming: each
  // claimed task then fails fast with SARA_ENGINE_MISSING, which the server turns
  // into an actionable chat message — far better than sitting Queued in silence.)
  if (claiming || state.paused || state.repairing || !isPaired()) return
  claiming = true
  try {
    // This poll doubles as the server-side heartbeat, so it's also where we report our version.
    const task = await hcos(`${TASK_API}.claim_next_task`, { device: DEVICE, version: appVersion() })
    state.authBad = false // an authed round-trip is live proof the token still works
    // Admin tool ceiling rides every claim poll — applied to the very spawn
    // that runs this task, so a Super Admin check/uncheck is live in seconds.
    if (task && task.tool_policy) setToolPolicy(task.tool_policy)
    if (task && task.name) {
      const entry = { name: task.name, label: task.prompt || '(task)' }
      state.running.push(entry)
      console.log(`[sara] claimed ${task.name}: ${String(task.prompt).slice(0, 80)}`)
      // Pull this conversation's transcript + SOPs before executing. Best-effort:
      // a missing bundle degrades to exactly today's behaviour.
      const ctxDir = task.conversation ? await syncConversationBundle(task.conversation) : null
      const { result, error } = await runHermes(task.prompt || '', (step) => {
        // Stream each tool step as an event → the Sarä chat renders live cards.
        console.log('[sara] step:', step)
        hcos(`${TASK_API}.append_task_event`, {
          name: task.name,
          event: JSON.stringify({ type: 'tool', text: step }),
        }).catch(() => {})
      }, ctxDir, task.name)
      await hcos(`${TASK_API}.complete_task`, { name: task.name, result, error })
      state.running = state.running.filter((r) => r.name !== task.name)
      console.log(`[sara] done ${task.name}: ${error ? 'ERROR ' + error : String(result).slice(0, 100)}`)
    }
  } catch (e) {
    if (e.status === 401) {
      state.authBad = true // surfaces as "Connection expired" in the widget + tray
      console.error('[sara] 401 — re-pair at /people/desktop')
    } else console.error('[sara] poll error:', (e && e.message) || e)
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

function syncSkills() {
  if (!isPaired()) return
  syncDesktopSkills({ base: state.base, key: state.key, secret: state.secret, userDataDir })
    .then((r) => r.changed && console.log(`[sara] desktop skills: ${r.changed}/${r.total} updated`))
    .catch((e) => console.log('[sara] skills sync error:', (e && e.message) || e))
}

function start(dir, onPaired) {
  userDataDir = dir
  loadCreds()
  whoami() // async: backfill "Connected as …" + boot-time token check; never blocks start
  startSidecar()
  startPairing(onPaired)
  ensureHermesConfig()
  // Desktop Skills registry → HERMES_HOME/skills: on boot, a one-minute retry
  // (covers pairing-just-completed on first launch), then daily.
  syncSkills()
  setTimeout(syncSkills, 60_000)
  if (!skillsTimer) skillsTimer = setInterval(syncSkills, 24 * 3600 * 1000)
  if (!pollTimer) pollTimer = setInterval(pollOnce, POLL_MS)
  resumeWatchIfEnabled()
  try {
    pruneConversationBundles()
  } catch {
    /* best-effort */
  }
  // Async — tasks spawning before it resolves run ungated (safe: full toolset), and Chrome mode
  // starts restricting once it lands. Never blocks boot.
  probeToolsets().catch(() => {})
  console.log(`[sara] connector started (paired=${isPaired()}, device=${DEVICE})`)
}
function stop() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  if (skillsTimer) clearInterval(skillsTimer)
  skillsTimer = null
  stopHeartbeat()
  try {
    sidecarSrv && sidecarSrv.close()
  } catch {}
  try {
    pairSrv && pairSrv.close()
  } catch {}
}
function getCurrentWork() {
  // `name` rides along so the widget's Cancel button can say WHICH task —
  // label-only items made the running list unactionable.
  return state.running.map((r) => ({ name: r.name, label: r.label }))
}
async function getQueuedWork() {
  // The server-side queue (Queued rows waiting for this laptop's single lane),
  // dispatch order. Best-effort: an offline moment renders as an empty queue,
  // never an error state.
  if (!isPaired()) return []
  try {
    const rows = await hcos(`${TASK_API}.list_my_queue`, {})
    state.authBad = false
    return (Array.isArray(rows) ? rows : [])
      .filter((r) => r && r.status === 'Queued')
      .map((r) => ({ name: r.name, label: r.label || '(task)', creation: r.creation || '' }))
  } catch (e) {
    if (e.status === 401) state.authBad = true
    return []
  }
}
async function cancelWork(name) {
  if (!name) return { ok: false, reason: 'no task name' }
  // The running task's hermes child lives HERE — kill it locally. pollOnce's
  // normal completion path then reports the SARA_CANCELLED_BY_USER token to
  // complete_task, which paints the amber "Dibatalkan oleh anda" + Retry card.
  if (currentTaskName === name && currentChild) {
    cancelRequested = true
    try {
      currentChild.kill()
    } catch {}
    console.log(`[sara] cancel (running): ${name}`)
    return { ok: true, where: 'laptop' }
  }
  // Not running here → a Queued row on the server; cancel it before it starts.
  try {
    const r = await hcos(`${TASK_API}.cancel_task`, { name })
    state.authBad = false
    console.log(`[sara] cancel (queued): ${name} →`, r && r.ok)
    return r || { ok: false }
  } catch (e) {
    if (e.status === 401) state.authBad = true
    return { ok: false, reason: (e && e.message) || String(e) }
  }
}
function setPaused(p) {
  state.paused = !!p
}

module.exports = {
  start,
  stop,
  setHomeResolver,
  syncSkills, // Desktop Skills registry → HERMES_HOME/skills (manual trigger)
  // Exported for apps/desktop/electron/sara-bundle.test.cjs — the path-escape
  // guard and the hash short-circuit are the parts worth a regression test.
  syncConversationBundle,
  bundleDir,
  pruneConversationBundles,
  getCurrentWork,
  getQueuedWork, // server-side Queued rows → the widget's "Work in Queue" card
  cancelWork, // widget Batal: kill the running child, or cancel a Queued row server-side
  isPaired,
  setPaused,
  startWatch,
  stopWatch,
  // Additive — so sara-state.cjs can be the ONE owner of widget state without a second store:
  readConfig, // the persisted sara-config.json (creds + watch + our own {sara:{…}} block)
  patchConfig: saveCreds, // MERGING write — never clobbers creds or watch
  getIdentity, // {user, authBad, engineBroken, engineDetail, repairing} — for the UI
  getWatch, // the truth about recording
  onWatchChange, // …and a subscription to it
  // Engine health + repair plumbing (main.cjs wires these):
  setBinResolver, // main injects the per-spawn venv-CLI resolver — never a bare 'hermes'
  onEngineBroken, // main subscribes to trigger auto-repair on first detection
  clearEngineBroken, // main clears after a successful repair
  setRepairing, // pause task-claiming while the installer runs
  probeToolsets, // re-probe after a repair (also re-latches gating)
  ensureHermesConfig, // re-point the freshly installed CLI at the sidecar
  queueHermesConfigWrites, // exported for tests — the one-at-a-time write queue contract
  // Workspace → toolset gating (Whole Computer made real):
  setToolsetMode, // the store pushes 'chrome'|'whole'|'pause' on a workspace change
  isToolsetGatingAvailable, // did the boot probe confirm --toolsets works? (drives honest copy)
  buildChatArgs, // pure — exported for tests
  effectiveToolsets, // pure — exported for tests (admin policy × workspace mode)
  setToolPolicy, // admin ceiling from claim_next_task's tool_policy
  getToolPolicy,
  looksLikeAppBanner, // pure — guards against reporting the app's own boot banner as a task result
  looksLikeNoProvider, // pure — guards against the "no inference provider" zero-work success
  CHROME_TOOLSETS,
}
