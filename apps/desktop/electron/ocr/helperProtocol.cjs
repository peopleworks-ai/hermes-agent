'use strict'
// Framing for the win-ocr-helper stdio protocol (ported from Omi, MIT).
// Request : [uint32 LE length][1 byte opcode][payload]
// Response: [uint32 LE length][UTF-8 JSON]
const OP_OCR = 1
const OP_WINDOW = 2

/** Build a length-prefixed, opcode-tagged request frame. */
function encodeRequest(opcode, payload) {
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length + 1, 0)
  return Buffer.concat([header, Buffer.from([opcode]), payload])
}

/** Streaming decoder for length-prefixed JSON response frames. */
class FrameDecoder {
  constructor(onFrame) {
    this.onFrame = onFrame
    this.buf = Buffer.alloc(0)
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk])
    for (;;) {
      if (this.buf.length < 4) return
      const len = this.buf.readUInt32LE(0)
      if (this.buf.length < 4 + len) return
      const json = this.buf.subarray(4, 4 + len).toString('utf8')
      this.buf = this.buf.subarray(4 + len)
      this.onFrame(json)
    }
  }
}

module.exports = { OP_OCR, OP_WINDOW, encodeRequest, FrameDecoder }
