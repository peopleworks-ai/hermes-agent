// Desktop Skills auto-sync — pulls file-based Hermes skill packs (SKILL.md +
// references/) from the hcos Desktop Skills registry into HERMES_HOME/skills,
// so an admin uploads a skill ONCE on /people/skills and every paired laptop
// gets it on next boot / daily tick. Versioned: a re-upload bumps the server
// version and the changed pack re-syncs; nothing is ever deleted locally.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')

// Mirrors hermes_constants.get_hermes_home(): HERMES_HOME env → platform default
// (%LOCALAPPDATA%\hermes on Windows, ~/.hermes elsewhere). Skills live under /skills.
function hermesSkillsDir() {
  const envHome = (process.env.HERMES_HOME || '').trim()
  const home = envHome
    ? envHome
    : process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes')
      : path.join(os.homedir(), '.hermes')
  return path.join(home, 'skills')
}

function manifestPath(userDataDir) {
  return path.join(userDataDir, 'sara-skills.json')
}
function readManifest(userDataDir) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(userDataDir), 'utf8'))
  } catch {
    return {}
  }
}
function writeManifest(userDataDir, m) {
  try {
    fs.writeFileSync(manifestPath(userDataDir), JSON.stringify(m, null, 2))
  } catch {}
}

// No zip library in the widget's deps — use the OS extractor (PowerShell on
// Windows, unzip elsewhere). Zips contain <skill_name>/SKILL.md at the top
// level, so extracting at the skills ROOT lands them as skills/<skill_name>/.
function extractZip(zipPath, destDir) {
  return fs.promises.mkdir(destDir, { recursive: true }).then(
    () =>
      new Promise((resolve, reject) => {
        const child =
          process.platform === 'win32'
            ? spawn(
                'powershell',
                ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath "${zipPath}" -DestinationPath "${destDir}"`],
                { windowsHide: true },
              )
            : spawn('unzip', ['-o', zipPath, '-d', destDir])
        child.on('error', reject)
        child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`extract exited ${code}`))))
      }),
  )
}

async function syncDesktopSkills({ base, key, secret, userDataDir, log = console.log }) {
  const auth = { Authorization: `token ${key}:${secret}` }
  const r = await fetch(`${base}/api/method/hros.api.desktop_skills.list_desktop_skills`, { headers: auth })
  if (!r.ok) throw Object.assign(new Error(`list_desktop_skills HTTP ${r.status}`), { status: r.status })
  const j = await r.json().catch(() => ({}))
  const skills = (j && j.message) || []
  const manifest = readManifest(userDataDir)
  const skillsDir = hermesSkillsDir()
  let changed = 0
  for (const s of skills) {
    const name = s && s.skill_name
    // Path safety: the name becomes a folder — refuse anything with separators.
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) continue
    if (manifest[name] === s.version) continue
    try {
      const dl = await fetch(`${base}${s.download}`, { headers: auth })
      if (!dl.ok) throw new Error(`download HTTP ${dl.status}`)
      const buf = Buffer.from(await dl.arrayBuffer())
      const tmp = path.join(os.tmpdir(), `sara-skill-${name}-v${s.version || 0}.zip`)
      await fs.promises.writeFile(tmp, buf)
      await extractZip(tmp, skillsDir)
      await fs.promises.unlink(tmp).catch(() => {})
      manifest[name] = s.version
      changed++
      log(`[sara] skill synced: ${name} v${s.version} → ${skillsDir}`)
    } catch (e) {
      // One bad pack must not block the rest; retried next tick since the
      // manifest keeps the old version.
      log(`[sara] skill sync failed for ${name}: ${(e && e.message) || e}`)
    }
  }
  writeManifest(userDataDir, manifest)
  return { total: skills.length, changed, dir: skillsDir }
}

module.exports = { syncDesktopSkills, hermesSkillsDir }
