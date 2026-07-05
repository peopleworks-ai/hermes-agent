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
const HERMES = process.env.HERMES_BIN || 'hermes'
const HTIMEOUT_MS = 600000
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
function saveCreds(c) {
  try {
    fs.mkdirSync(path.dirname(cfgPath()), { recursive: true })
    fs.writeFileSync(cfgPath(), JSON.stringify(c))
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
      return res.end(JSON.stringify({ app: 'sara-desktop', paired: isPaired() }))
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
      spawn(HERMES, ['config', 'set', k, v], { stdio: 'ignore' })
    } catch {
      /* best-effort */
    }
  }
}

function runHermes(prompt) {
  return new Promise((resolve) => {
    let out = '',
      err = ''
    let child
    try {
      child = spawn(HERMES, ['-z', prompt], { windowsHide: true })
    } catch (e) {
      return resolve({ error: `hermes spawn failed: ${(e && e.message) || e}` })
    }
    const t = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      resolve({ error: `hermes timed out after ${HTIMEOUT_MS / 1000}s` })
    }, HTIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(t)
      resolve({ error: `hermes not found (${HERMES}): ${(e && e.message) || e}` })
    })
    child.on('close', (code) => {
      clearTimeout(t)
      if (code !== 0) resolve({ error: (err || out || `hermes exit ${code}`).slice(0, 2000) })
      else resolve({ result: (out || '').trim() })
    })
  })
}

// ── (1) task bridge ──────────────────────────────────────────────────────
async function pollOnce() {
  if (claiming || state.paused || !isPaired()) return
  claiming = true
  try {
    const task = await hcos(`${TASK_API}.claim_next_task`, { device: DEVICE })
    if (task && task.name) {
      const entry = { name: task.name, label: task.prompt || '(task)' }
      state.running.push(entry)
      console.log(`[sara] claimed ${task.name}: ${String(task.prompt).slice(0, 80)}`)
      const { result, error } = await runHermes(task.prompt || '')
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
function start(dir, onPaired) {
  userDataDir = dir
  loadCreds()
  startSidecar()
  startPairing(onPaired)
  ensureHermesConfig()
  if (!pollTimer) pollTimer = setInterval(pollOnce, POLL_MS)
  console.log(`[sara] connector started (paired=${isPaired()}, device=${DEVICE})`)
}
function stop() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
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

module.exports = { start, stop, getCurrentWork, isPaired, setPaused }
