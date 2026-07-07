'use strict'
// Ported from Omi (MIT). Resolve the on-disk path to win-ocr-helper.exe.
const { app } = require('electron')
const { join } = require('path')
const { existsSync } = require('fs')

function resolveHelperPath() {
  const exe = 'win-ocr-helper.exe'
  const candidates = [
    join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'win-ocr-helper', exe),
    join(process.resourcesPath, 'win-ocr-helper', exe),
    join(app.getAppPath(), 'resources', 'win-ocr-helper', exe),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  // Return the dev path so the supervisor surfaces a clear "helper not found"
  // error rather than spawning a nonexistent path.
  return candidates[candidates.length - 1]
}

module.exports = { resolveHelperPath }
