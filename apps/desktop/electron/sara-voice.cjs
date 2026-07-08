'use strict'
/**
 * Sarä Learn-by-Watching — VOICE capture (main process).
 *
 * A hidden renderer window (sara-voice-capture.html) runs Omi's proven
 * hrosRecording logic (mic + optional system loopback → MediaRecorder webm/opus).
 * It finalizes a segment on a ~12-min timer (main sends 'sara-voice:rotate') and
 * ships the bytes here via IPC; main uploads each segment to the live endpoints
 * omi_desktop.{create_conversation, upload_audio_chunk, finalize_upload} — the
 * server then Bunny-stores, Gladia-transcribes, extracts memories + 'watched'
 * skills. Upload flow ported from Omi's credentials.ts::hrosUpload (MIT).
 */
const path = require('path')

let win = null
let cfg = null // { deviceId, base, key, secret, system }
let rotateTimer = null
let loopbackReady = false
// ~12-min meeting segments; override for testing (e.g. SARA_VOICE_SEGMENT_MS=60000).
const SEGMENT_MS = Number(process.env.SARA_VOICE_SEGMENT_MS) || 12 * 60 * 1000

function ensureLoopbackHandler() {
  if (loopbackReady) return
  try {
    const { session, desktopCapturer } = require('electron')
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] })
        if (!sources.length) throw new Error('no screen sources')
        callback({ video: sources[0], audio: 'loopback' }) // system-audio loopback (Windows)
      } catch (e) {
        console.error('[sara-voice] loopback grant failed:', (e && e.message) || e)
        callback({})
      }
    })
    loopbackReady = true
    console.log('[sara-voice] loopback handler registered')
  } catch (e) {
    console.error('[sara-voice] loopback handler:', (e && e.message) || e)
  }
}

function wireIpcOnce() {
  const { ipcMain } = require('electron')
  if (wireIpcOnce._done) return
  wireIpcOnce._done = true
  ipcMain.on('sara-voice:segment', (_e, meta, buf) => {
    if (!cfg) return
    upload(meta, Buffer.from(buf)).catch((e) => console.error('[sara-voice] upload failed:', (e && e.message) || e))
  })
  ipcMain.on('sara-voice:error', (_e, msg) => console.error('[sara-voice] renderer:', msg))
  ipcMain.on('sara-voice:stopped', () => {
    try {
      win && win.destroy()
    } catch {}
    win = null
  })
}

function start(opts) {
  cfg = opts || {}
  ensureLoopbackHandler()
  wireIpcOnce()
  if (win) return
  const { BrowserWindow } = require('electron')
  win = new BrowserWindow({
    width: 320,
    height: 180,
    show: false,
    skipTaskbar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, backgroundThrottling: false },
  })
  win.loadFile(path.join(__dirname, 'sara-voice-capture.html'))
  win.webContents.once('did-finish-load', () => {
    win.webContents.send('sara-voice:start', { system: !!cfg.system })
    rotateTimer = setInterval(() => {
      if (win) win.webContents.send('sara-voice:rotate')
    }, SEGMENT_MS)
  })
  console.log(`[sara-voice] voice capture started (segment ~${SEGMENT_MS / 60000}min, system=${!!cfg.system})`)
}

function stop() {
  if (rotateTimer) clearInterval(rotateTimer)
  rotateTimer = null
  if (win) {
    try {
      win.webContents.send('sara-voice:stop') // flush the final segment, then it emits 'stopped'
    } catch {}
    setTimeout(() => {
      try {
        win && win.destroy()
      } catch {}
      win = null
    }, 10000) // safety close if 'stopped' never arrives
  }
  cfg = null
}

function fmtDt(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function upload(meta, buf) {
  if (!buf || !buf.length) return
  const auth = `token ${cfg.key}:${cfg.secret}`
  const jsonCall = async (method, body) => {
    const r = await fetch(`${cfg.base}/api/method/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify(body || {}),
    })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`${method} → ${r.status}`)
    return j && j.message !== undefined ? j.message : j
  }
  const created = await jsonCall('hros.api.omi_desktop.create_conversation', {
    device_id: cfg.deviceId,
    started_at: fmtDt(meta.startedAt),
    ended_at: fmtDt(meta.endedAt),
    duration_seconds: meta.durationSeconds || 0,
    source: 'Mixed',
  })
  const conversation = created.conversation
  if (!conversation) throw new Error('create_conversation returned no conversation')
  const chunkSize = created.chunk_size || 8 * 1024 * 1024
  const total = Math.max(Math.ceil(buf.length / chunkSize), 1)
  for (let i = 0; i < total; i++) {
    const slice = buf.subarray(i * chunkSize, (i + 1) * chunkSize)
    const form = new FormData()
    form.append('conversation', conversation)
    form.append('chunk_index', String(i))
    form.append('file', new Blob([slice], { type: 'audio/webm' }), 'chunk.webm')
    const r = await fetch(`${cfg.base}/api/method/hros.api.omi_desktop.upload_audio_chunk`, {
      method: 'POST',
      headers: { Authorization: auth },
      body: form,
    })
    if (!r.ok) throw new Error(`chunk ${i} → ${r.status}`)
  }
  const { createHash } = require('node:crypto')
  const sha = createHash('sha256').update(buf).digest('hex')
  await jsonCall('hros.api.omi_desktop.finalize_upload', { conversation, total_chunks: total, sha256: sha })
  console.log(`[sara-voice] uploaded segment → ${conversation} (${buf.length} bytes, ${meta.durationSeconds || 0}s)`)
}

module.exports = { start, stop }
