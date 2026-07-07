'use strict'
// One supervised, long-running win-ocr-helper subprocess shared by OCR +
// window-info. Ported verbatim-in-spirit from Omi (MIT). Lazy start;
// capped-backoff restart on crash; single-flight FIFO queue (the helper does one
// frame at a time); per-request timeout recycles a wedged pipe; ENOENT → mark
// unavailable and fail fast (so a missing exe degrades to titles-only, not a loop).
const { spawn } = require('child_process')
const { resolveHelperPath } = require('./resolveHelperPath.cjs')
const { encodeRequest, FrameDecoder, OP_OCR, OP_WINDOW } = require('./helperProtocol.cjs')

const REQUEST_TIMEOUT_MS = 5000
const MAX_BACKOFF_MS = 10000

class HelperProcess {
  constructor() {
    this.child = null
    this.queue = []
    this.backoff = 500
    this.starting = false
    this.unavailable = false
  }

  ensureStarted() {
    if (this.child || this.starting || this.unavailable) return
    this.starting = true
    const exe = resolveHelperPath()
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    this.child = child
    this.starting = false

    const decoder = new FrameDecoder((json) => {
      const pending = this.queue.shift()
      if (!pending) return
      clearTimeout(pending.timer)
      pending.resolve(json)
    })
    child.stdout.on('data', (chunk) => decoder.push(chunk))
    child.stderr.on('data', (c) => console.log('[win-ocr-helper]', c.toString().trim()))
    child.on('exit', (code) => {
      console.warn(`[win-ocr-helper] exited code=${code}`)
      this.handleExit()
    })
    child.on('error', (e) => {
      if (e && e.code === 'ENOENT') {
        if (!this.unavailable) {
          console.error(
            '[win-ocr-helper] binary not found — screen OCR + window-info DISABLED (titles/OCR empty). ' +
              'Build it once on Windows: dotnet publish native/win-ocr-helper -c Release -o resources/win-ocr-helper ' +
              `(needs the .NET 8 SDK). (${e.message})`,
          )
        }
        this.unavailable = true
      } else {
        console.error('[win-ocr-helper] spawn error:', e && e.message)
      }
      this.handleExit()
    })
    setTimeout(() => {
      if (this.child === child) this.backoff = 500
    }, 2000)
  }

  handleExit() {
    this.child = null
    while (this.queue.length) {
      const p = this.queue.shift()
      clearTimeout(p.timer)
      p.reject(new Error('helper exited'))
    }
    this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
  }

  recycle() {
    if (this.child) {
      try {
        this.child.kill()
      } catch {
        /* already dead */
      }
    }
    this.handleExit()
  }

  request(opcode, payload) {
    if (this.unavailable) return Promise.reject(new Error('helper unavailable (binary missing)'))
    this.ensureStarted()
    const child = this.child
    if (!child) return Promise.reject(new Error('helper not available'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.queue.findIndex((p) => p.timer === timer)
        if (idx >= 0) this.queue.splice(idx, 1)
        reject(new Error('helper request timed out'))
        this.recycle()
      }, REQUEST_TIMEOUT_MS)
      this.queue.push({ resolve, reject, timer })
      child.stdin.write(encodeRequest(opcode, payload))
    })
  }

  async ocr(jpeg) {
    try {
      return JSON.parse(await this.request(OP_OCR, jpeg)) // {ok, fullText, lines} | {ok:false, code, message}
    } catch (e) {
      return { ok: false, code: 'HELPER_ERROR', message: (e && e.message) || String(e) }
    }
  }

  async windowInfo() {
    try {
      return JSON.parse(await this.request(OP_WINDOW, Buffer.alloc(0))) // {app, title, pid, processName}
    } catch {
      return { app: '', title: '' }
    }
  }

  dispose() {
    this.recycle()
  }
}

module.exports = { helperProcess: new HelperProcess() }
