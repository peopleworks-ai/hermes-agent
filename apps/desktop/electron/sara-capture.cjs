'use strict'
/**
 * Sarä Learn-by-Watching capture (MAIN process).
 *
 * SCREEN (this slice): a desktopCapturer thumbnail every ~60s + the active
 * window app/title (active-win, optional) + on-screen text (tesseract.js OCR,
 * optional) → batched every 15 min to the already-live HROS ingest endpoints
 * omi_screen.{create_session, upload_frame, finalize_session}. Server relays the
 * JPEG to Bunny, summarises the batch, and (Slice 1) distils Staged skills.
 *
 * VOICE is Slice 4 (a hidden renderer running getUserMedia → MediaRecorder).
 *
 * Everything is best-effort: a failing OCR / active-win / upload logs and
 * continues; it never throws into the widget. Ports the proven logic from
 * apps/hros/omi-desktop-client/patched-files/src/main/ipc/screenActivityUploader.ts.
 */
const { desktopCapturer, screen: elScreen } = require('electron')
// Omi's native Windows OCR + window-info engine (extracted, MIT) — replaces
// tesseract.js + active-win. One long-running win-ocr-helper.exe subprocess.
const { helperProcess } = require('./ocr/helperProcess.cjs')

const SNAP_MS = 60 * 1000
const BATCH_MS = 15 * 60 * 1000
const MAX_FRAMES = 30
const MAX_GAP_MS = 120 * 1000 // cap a frame's attributed active-seconds (idle guard)

let cfg = null // { deviceId, base, key, secret, screen, voice }
let snapTimer = null
let flushTimer = null
let firstFlushTimer = null
let frames = []
let flushing = false

function fmtDt(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function snapOnce() {
  try {
    const disp = elScreen.getPrimaryDisplay()
    const scale = Math.min(1, 1600 / (disp.size.width || 1600))
    const width = Math.max(320, Math.round((disp.size.width || 1280) * scale))
    const height = Math.max(240, Math.round((disp.size.height || 720) * scale))
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
    if (!sources.length) return
    const img = sources[0].thumbnail
    if (!img || img.isEmpty()) return
    const jpeg = img.toJPEG(70)
    // Native Windows engine: foreground window + OCR (no tesseract / active-win).
    const win = await helperProcess.windowInfo() // { app, title } | { '', '' }
    const res = await helperProcess.ocr(jpeg) // { ok, fullText } | { ok:false, ... }
    const ocrText = res && res.ok ? (res.fullText || '').replace(/\s+/g, ' ').trim().slice(0, 4000) : ''
    frames.push({ ts: Date.now(), app: (win && win.app) || '', windowTitle: (win && win.title) || '', ocrText, jpeg })
    if (frames.length > MAX_FRAMES) frames = frames.slice(-MAX_FRAMES)
  } catch (e) {
    console.error('[sara] snap failed:', (e && e.message) || e)
  }
}

function computeUsage(batch) {
  const topApps = {}
  let activeSeconds = 0
  const sorted = [...batch].sort((a, b) => a.ts - b.ts)
  for (let i = 0; i < sorted.length; i++) {
    const gap = i < sorted.length - 1 ? sorted[i + 1].ts - sorted[i].ts : SNAP_MS
    const secs = Math.round(Math.min(gap, MAX_GAP_MS) / 1000)
    const a = sorted[i].app || 'Unknown'
    topApps[a] = (topApps[a] || 0) + secs
    activeSeconds += secs
  }
  return { topApps, activeSeconds }
}

async function jsonCall(method, body) {
  const r = await fetch(`${cfg.base}/api/method/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `token ${cfg.key}:${cfg.secret}` },
    body: JSON.stringify(body || {}),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${method} → ${r.status}`)
  return j && j.message !== undefined ? j.message : j
}

async function multipartCall(method, form) {
  const r = await fetch(`${cfg.base}/api/method/${method}`, {
    method: 'POST',
    headers: { Authorization: `token ${cfg.key}:${cfg.secret}` }, // let fetch set the multipart boundary
    body: form,
  })
  if (!r.ok) throw new Error(`${method} → ${r.status}`)
  const j = await r.json().catch(() => ({}))
  return j && j.message !== undefined ? j.message : j
}

async function flush() {
  if (!cfg || flushing) return
  const batch = frames.splice(0, MAX_FRAMES)
  if (!batch.length) return
  flushing = true
  try {
    const session = await jsonCall('hros.api.omi_screen.create_session', {
      device_id: cfg.deviceId,
      period_start: fmtDt(batch[0].ts),
      period_end: fmtDt(batch[batch.length - 1].ts),
    })
    const sessionName = session && session.session
    if (!sessionName) throw new Error('create_session returned no session')
    for (const f of batch) {
      try {
        const form = new FormData()
        form.append('session', sessionName)
        form.append('captured_at', fmtDt(f.ts))
        form.append('app', f.app || '')
        form.append('window_title', f.windowTitle || '')
        form.append('ocr_text', f.ocrText || '')
        form.append('file', new Blob([f.jpeg], { type: 'image/jpeg' }), 'frame.jpg')
        await multipartCall('hros.api.omi_screen.upload_frame', form)
      } catch (e) {
        console.error('[sara] frame upload failed:', (e && e.message) || e)
      }
    }
    const { topApps, activeSeconds } = computeUsage(batch)
    await jsonCall('hros.api.omi_screen.finalize_session', {
      session: sessionName,
      top_apps_json: JSON.stringify(topApps),
      active_seconds: activeSeconds,
    })
    console.log(`[sara] screen: uploaded ${batch.length} frames → ${sessionName}`)
  } catch (e) {
    console.error('[sara] screen flush failed:', (e && e.message) || e)
  } finally {
    flushing = false
  }
}

function clearTimers() {
  if (snapTimer) clearInterval(snapTimer)
  if (flushTimer) clearInterval(flushTimer)
  if (firstFlushTimer) clearTimeout(firstFlushTimer)
  snapTimer = flushTimer = firstFlushTimer = null
}

function start(opts) {
  clearTimers() // SYNC reset — never call the async stop() here (it would null the new cfg)
  frames = []
  cfg = opts || {}
  if (cfg.screen) {
    snapOnce()
    snapTimer = setInterval(snapOnce, SNAP_MS)
    // First batch fires early so a session appears within ~2 min (testing);
    // thereafter every 15 min. Overridable via SARA_SCREEN_BATCH_MS.
    const batchMs = Number(process.env.SARA_SCREEN_BATCH_MS) || BATCH_MS
    firstFlushTimer = setTimeout(() => {
      flush()
      flushTimer = setInterval(flush, batchMs)
    }, 90 * 1000)
    console.log('[sara] screen capture started (snap 60s, first batch ~90s)')
  }
  // cfg.voice → Slice 4 (hidden renderer getUserMedia → MediaRecorder). Not yet wired.
}

async function stop() {
  clearTimers()
  try {
    await flush() // upload whatever's buffered before we stop (cfg still set)
  } catch {
    /* best-effort */
  }
  frames = []
  try {
    helperProcess.dispose() // stop the win-ocr-helper subprocess
  } catch {}
  cfg = null
}

/** For testing: force an immediate batch flush. */
async function flushNow() {
  await flush()
}

module.exports = { start, stop, flushNow }
