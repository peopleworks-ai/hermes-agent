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
 * MEMORY: a kept frame is written straight to a temp file and uploaded as soon
 * as it lands — the JPEG buffer is never retained. The previous version pushed
 * the encoded Buffer into `frames` and only flushed every 15 min, so up to
 * 50 full screenshots (tens of MB on a dense 1600px screen) sat in the
 * main process continuously. Only {ts, app, title, ocrText, file} is held now.
 *
 * A frame whose upload fails keeps its temp file and is retried on the next
 * tick, so a network blip costs latency rather than the screenshot.
 *
 * Everything is best-effort: a failing OCR / active-win / upload logs and
 * continues; it never throws into the widget. Ports the proven logic from
 * apps/hros/omi-desktop-client/patched-files/src/main/ipc/screenActivityUploader.ts.
 */
const { desktopCapturer, screen: elScreen } = require('electron')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
// Omi's native Windows OCR + window-info engine (extracted, MIT) — replaces
// tesseract.js + active-win. One long-running win-ocr-helper.exe subprocess.
const { helperProcess } = require('./ocr/helperProcess.cjs')

// CHANGE-DRIVEN capture: poll the screen cheaply and keep a frame only when it
// meaningfully changes (≈ one frame per action) — so the vision model gets the
// step granularity a step-by-step SOP needs, instead of 1 blurry frame/minute.
const POLL_MS = 2500 // sample the screen every 2.5s (cheap: just a hash)
const BATCH_MS = 15 * 60 * 1000
const MAX_GAP_MS = 120 * 1000 // cap a frame's attributed active-seconds (idle guard)
const CHANGE_THRESHOLD = 12 // aHash Hamming distance (of 256) that counts as a new step
const HEARTBEAT_MS = 3 * 60 * 1000 // keep ≥1 frame every 3 min even when nothing changes
// Server refuses past MAX_FRAMES_PER_SESSION = 60 (hros/api/omi_screen.py); roll
// to a fresh session before that rather than letting uploads start failing.
const MAX_FRAMES_PER_SESSION = 50
// Bound on UNUPLOADED frames on disk, for the case where the server is
// unreachable for a long stretch. ~0.5 MB each, so ~100 MB worst case.
const MAX_PENDING = 200
const TMP_DIR = path.join(os.tmpdir(), 'sara-capture')

let cfg = null // { deviceId, base, key, secret, screen, voice }
let snapTimer = null
let flushTimer = null
let firstFlushTimer = null
let pending = [] // [{ ts, app, windowTitle, ocrText, file }] — paths, never buffers
let session = null // { name, count, seen: [{ ts, app }] }
let draining = false
let seq = 0
let lastHash = null
let lastKeptTs = 0
let droppedPending = 0

function fmtDt(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 16×16 grayscale average-hash of a nativeImage → 256-bit fingerprint. */
function aHash(img) {
  const small = img.resize({ width: 16, height: 16, quality: 'good' })
  const bmp = small.toBitmap() // BGRA
  const n = 16 * 16
  const gray = new Float32Array(n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const b = bmp[i * 4] || 0,
      g = bmp[i * 4 + 1] || 0,
      r = bmp[i * 4 + 2] || 0
    const v = r * 0.3 + g * 0.59 + b * 0.11
    gray[i] = v
    sum += v
  }
  const mean = sum / n
  const bits = new Uint8Array(n)
  for (let i = 0; i < n; i++) bits[i] = gray[i] > mean ? 1 : 0
  return bits
}
function hamming(a, b) {
  if (!a || !b) return 9999
  let d = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++
  return d
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

    // Cheap change test — hash the downscaled frame; only KEEP (OCR + encode) on a
    // meaningful change or the idle heartbeat.
    const hash = aHash(img)
    const changed = hamming(hash, lastHash) > CHANGE_THRESHOLD
    const heartbeat = Date.now() - lastKeptTs > HEARTBEAT_MS
    lastHash = hash
    if (!changed && !heartbeat) return

    const jpeg = img.toJPEG(70) // encode only kept frames
    const win = await helperProcess.windowInfo() // { app, title } (native)
    const res = await helperProcess.ocr(jpeg) // { ok, fullText } | { ok:false, ... }
    const ocrText = res && res.ok ? (res.fullText || '').replace(/\s+/g, ' ').trim().slice(0, 4000) : ''
    // Straight to disk. `jpeg` goes out of scope at the end of this function —
    // nothing in this module retains an encoded screenshot.
    const ts = Date.now()
    const file = path.join(TMP_DIR, `${ts}-${seq++}.jpg`)
    await fsp.mkdir(TMP_DIR, { recursive: true })
    await fsp.writeFile(file, jpeg)
    pending.push({ ts, app: (win && win.app) || '', windowTitle: (win && win.title) || '', ocrText, file })
    lastKeptTs = ts

    // Disk backstop: only reachable when uploads have been failing for a while.
    // Say so — a silent drop reads as "we captured everything" when we did not.
    while (pending.length > MAX_PENDING) {
      const old = pending.shift()
      droppedPending++
      await fsp.unlink(old.file).catch(() => {})
    }
    if (droppedPending) {
      console.warn(`[sara] screen: dropped ${droppedPending} un-uploaded frame(s) — backlog over ${MAX_PENDING}`)
      droppedPending = 0
    }

    void drain() // upload now; do not make the caller wait on the network
  } catch (e) {
    console.error('[sara] snap failed:', (e && e.message) || e)
  }
}

function computeUsage(batch) {
  const topApps = {}
  let activeSeconds = 0
  const sorted = [...batch].sort((a, b) => a.ts - b.ts)
  for (let i = 0; i < sorted.length; i++) {
    const gap = i < sorted.length - 1 ? sorted[i + 1].ts - sorted[i].ts : POLL_MS
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

async function ensureSession(ts) {
  if (session) return session
  const res = await jsonCall('hros.api.omi_screen.create_session', {
    device_id: cfg.deviceId,
    period_start: fmtDt(ts),
    period_end: fmtDt(ts),
  })
  const name = res && res.session
  if (!name) throw new Error('create_session returned no session')
  session = { name, count: 0, seen: [] }
  return session
}

/** Close the open session, reporting usage from the frames that actually landed. */
async function closeSession() {
  if (!session) return
  const s = session
  session = null
  if (!s.count) return
  try {
    const { topApps, activeSeconds } = computeUsage(s.seen)
    await jsonCall('hros.api.omi_screen.finalize_session', {
      session: s.name,
      top_apps_json: JSON.stringify(topApps),
      active_seconds: activeSeconds,
    })
    console.log(`[sara] screen: finalized ${s.name} (${s.count} frames)`)
  } catch (e) {
    console.error('[sara] screen finalize failed:', (e && e.message) || e)
  }
}

/**
 * Upload whatever is waiting on disk, oldest first, one at a time.
 *
 * Serialised on `draining` so the snap timer firing mid-upload cannot start a
 * second pass over the same files. A frame is unlinked only after the server
 * has taken it; on failure we stop and keep the file for the next tick, which
 * is why a dropped connection costs latency instead of the screenshot.
 */
async function drain() {
  if (!cfg || draining) return
  draining = true
  try {
    while (pending.length) {
      const f = pending[0]
      let bytes
      try {
        bytes = await fsp.readFile(f.file)
      } catch {
        pending.shift() // file vanished (temp cleaner, disk full) — nothing to send
        continue
      }
      try {
        const s = await ensureSession(f.ts)
        const form = new FormData()
        form.append('session', s.name)
        form.append('captured_at', fmtDt(f.ts))
        form.append('app', f.app || '')
        form.append('window_title', f.windowTitle || '')
        form.append('ocr_text', f.ocrText || '')
        form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'frame.jpg')
        await multipartCall('hros.api.omi_screen.upload_frame', form)
        s.count++
        s.seen.push({ ts: f.ts, app: f.app })
        pending.shift()
        await fsp.unlink(f.file).catch(() => {})
        // Roll before the server's own per-session ceiling rejects us.
        if (s.count >= MAX_FRAMES_PER_SESSION) await closeSession()
      } catch (e) {
        console.error('[sara] frame upload failed, will retry:', (e && e.message) || e)
        break // keep the file; try again on the next tick
      }
    }
  } finally {
    draining = false
  }
}

/** Batch boundary: push anything still waiting, then close the window. */
async function flush() {
  if (!cfg) return
  await drain()
  await closeSession()
}

/** Orphaned temp files from a previous run have no metadata left, so they can
 *  never be uploaded — clearing them on start keeps the folder from growing. */
async function cleanTmp() {
  try {
    const files = await fsp.readdir(TMP_DIR)
    await Promise.all(files.map((n) => fsp.unlink(path.join(TMP_DIR, n)).catch(() => {})))
  } catch {
    /* no temp dir yet */
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
  pending = []
  session = null
  seq = 0
  droppedPending = 0
  lastHash = null
  lastKeptTs = 0
  cfg = opts || {}
  if (cfg.screen) {
    void cleanTmp()
    snapOnce()
    // drain() on every poll, not only when a frame is kept: an upload backlog
    // built up while the server was unreachable would otherwise sit untouched
    // until the next batch boundary if the screen went idle. It is a no-op when
    // there is nothing pending.
    snapTimer = setInterval(() => {
      void snapOnce()
      void drain()
    }, POLL_MS)
    // First batch fires early so a session appears within ~2 min (testing);
    // thereafter every 15 min. Overridable via SARA_SCREEN_BATCH_MS.
    const batchMs = Number(process.env.SARA_SCREEN_BATCH_MS) || BATCH_MS
    firstFlushTimer = setTimeout(() => {
      flush()
      flushTimer = setInterval(flush, batchMs)
    }, 90 * 1000)
    console.log('[sara] screen capture started (change-driven: poll 2.5s, keep on change; upload immediately, session closes every batch)')
  }
  // cfg.voice → Slice 4 (hidden renderer getUserMedia → MediaRecorder). Not yet wired.
}

async function stop() {
  clearTimers()
  try {
    await flush() // upload what is still on disk, then close the session (cfg still set)
  } catch {
    /* best-effort */
  }
  await cleanTmp()
  pending = []
  session = null
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
